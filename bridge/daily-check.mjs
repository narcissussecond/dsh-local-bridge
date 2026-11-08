#!/usr/bin/env node
/**
 * wb-bridge daily health check.
 *
 * Answers three questions every day, unattended:
 *   1. Did the bridge work during the last 24h, and if not, why?
 *   2. Does it still work right now, end to end, against the real upstream?
 *   3. Has the upstream started imposing anything new that we have not handled yet?
 *
 * Writes a dated report to reports/wb-daily-YYYY-MM-DD.md, appends a one-line summary to
 * reports/daily-log.jsonl, and exits non-zero when something needs a human.
 *
 * Exit codes: 0 = healthy, 1 = warning (degraded but working), 2 = broken (needs action).
 *
 * Usage:
 *   node daily-check.mjs [--port 8791] [--no-probe] [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { BRIDGE_DIR as HERE, profileConfigPath, profileName, reportsDir, logPath } from './config.mjs'

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', process.env.WB_BRIDGE_PORT ?? '8791'))
const SKIP_PROBE = args.includes('--no-probe')
const AS_JSON = args.includes('--json')

// Paths come from config.mjs so that nothing here carries a machine-specific absolute
// path. `--profile-config` is honoured for the DSH profile check below.
const LOG_FILE = logPath()
const REPORT_DIR = reportsDir()
const MODEL_LIMITS = path.join(HERE, 'model-limits.json')
const ZERO_COST_MODEL = 'deepseek-v4.1-flash'

const now = new Date()
const localDate = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10) // Asia/Shanghai

const findings = []   // { level: 'info'|'warn'|'alert', code, text }
const add = (level, code, text) => findings.push({ level, code, text })
const worst = () => findings.some((f) => f.level === 'alert') ? 2 : findings.some((f) => f.level === 'warn') ? 1 : 0

// ---------------------------------------------------------------- 1. bridge alive?
async function checkHealth() {
  const out = { reachable: false }
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    Object.assign(out, await r.json(), { reachable: true })
    add('info', 'health', `bridge alive: ${out.models} models, region=${out.region}, appVersion=${out.appVersion}`)
  } catch (e) {
    add('alert', 'health', `bridge NOT reachable on port ${PORT}: ${e?.message ?? e}`)
    return out
  }

  // token expiry
  const exp = out.expiresAt ? Date.parse(out.expiresAt) : NaN
  if (Number.isFinite(exp)) {
    const daysLeft = (exp - Date.now()) / 86400_000
    out.daysLeft = Math.round(daysLeft * 10) / 10
    if (daysLeft < 0) add('alert', 'token', `access token EXPIRED at ${out.expiresAt}`)
    else if (daysLeft < 7) add('warn', 'token', `access token expires in ${out.daysLeft} days (${out.expiresAt})`)
    else add('info', 'token', `access token valid for ${out.daysLeft} more days`)
  }

  // model catalog must still yield the expected roster
  if (typeof out.models === 'number') {
    if (out.models < 15) add('alert', 'catalog', `only ${out.models} chat models upstream (expected ~19) — UA or catalog endpoint may have changed`)
    else add('info', 'catalog', `catalog healthy: ${out.models} chat models`)
  }
  return out
}

// ---------------------------------------------------------------- 2. last 24h of the log
function parseLog() {
  const stats = {
    requests: 0, ok: 0, failed: 0,
    variants: {}, upstreamErrors: {}, fingerprintHits: 0, learned: 0,
    archived: 0, retries: 0, gaveUp: 0,
    slowestMs: 0, largestUnknownTopLevel: [],
    firstLine: null, lastLine: null, lines: 0,
  }
  let text = ''
  try { text = fs.readFileSync(LOG_FILE, 'utf8') } catch {
    add('warn', 'log', `bridge log missing at ${LOG_FILE}`)
    return stats
  }
  const lines = text.split(/\r?\n/).filter(Boolean)
  stats.lines = lines.length
  stats.firstLine = lines[0] ?? null
  stats.lastLine = lines[lines.length - 1] ?? null

  for (const line of lines) {
    if (line.includes('chat: model=')) stats.requests++
    if (/chat done:.*status=200/.test(line)) stats.ok++
    if (/chat done:.*status=(?!200)\d+/.test(line)) stats.failed++
    if (line.includes('recovered via variant')) {
      const m = /variant "([^"]+)"/.exec(line)
      if (m) stats.variants[m[1]] = (stats.variants[m[1]] || 0) + 1
    }
    if (/variant ".*": upstream \d+/.test(line)) {
      const m = /upstream (\d+)/.exec(line)
      if (m) stats.upstreamErrors[m[1]] = (stats.upstreamErrors[m[1]] || 0) + 1
    }
    if (line.includes('11128')) stats.fingerprintHits++
    if (line.includes('learned:')) stats.learned++
    if (line.includes('body archived:')) stats.archived++
    if (/attempt \d+: upstream .* — retrying/.test(line)) stats.retries++
    if (line.includes('giving up after')) stats.gaveUp++
    const slow = /chat done:.*in (\d+)ms/.exec(line)
    if (slow) stats.slowestMs = Math.max(stats.slowestMs, Number(slow[1]))
  }

  // ---- verdicts
  const rate = stats.requests ? stats.ok / stats.requests : 1
  if (stats.requests === 0) {
    add('warn', 'usage', 'no chat requests in the current log window — bridge is idle (check that DSH is pointed at it)')
  } else {
    add(rate >= 0.99 ? 'info' : rate >= 0.95 ? 'warn' : 'alert', 'success-rate',
      `success rate ${(rate * 100).toFixed(1)}% (${stats.ok}/${stats.requests}), ${stats.failed} failed`)
  }

  // ---- fingerprint drift: THIS is the early warning that matters
  //
  // Careful with the judgement here. One 11128 per bridge start is EXPECTED, not a
  // regression: `systemRoleRejected` lives in memory, so after every restart the first
  // request re-probes the system role, gets refused, and re-learns the fold. The signal
  // that actually matters is a 11128 that was NOT followed by that learning line —
  // i.e. a rejection our fallback could not absorb.
  if (stats.fingerprintHits > 0) {
    const unabsorbed = stats.fingerprintHits - stats.learned
    const recoveries = stats.variants['system-as-user'] || 0
    if (unabsorbed > 0) {
      add('alert', 'fingerprint',
        `${stats.fingerprintHits} x 11128 but only ${stats.learned} were the expected post-restart probe ` +
        `(${unabsorbed} unexplained, ${recoveries} recoveries) — the upstream probably added a NEW check. ` +
        `Read bridge-stdout.log for "failed-body summary" and inspect failed-body-*.json, then extend CONTENT_SCRUBS or bodyVariants().`)
    } else {
      add('info', 'fingerprint',
        `${stats.fingerprintHits} x 11128, all of them the expected first-request probe after a bridge start ` +
        `(${stats.learned} restarts re-learned the fold); ${recoveries} requests served via system-as-user — no action`)
    }
  } else if ((stats.variants['system-as-user'] || 0) > 0) {
    add('info', 'fingerprint', `no 11128 today; ${stats.variants['system-as-user']} requests used the learned system-as-user shape`)
  }

  // ---- new upstream status codes we may not handle
  const KNOWN = new Set(['400', '401', '429', '500', '502', '503', '504'])
  for (const [code, n] of Object.entries(stats.upstreamErrors)) {
    if (!KNOWN.has(code)) {
      add('warn', 'new-status', `upstream returned HTTP ${code} x${n} — not in the known set; check whether the bridge should handle it`)
    }
  }
  if (stats.gaveUp > 0) {
    add(stats.gaveUp > 5 ? 'warn' : 'info', 'retry',
      `${stats.gaveUp} request(s) exhausted retries after ${stats.retries} backoff attempt(s)`)
  }

  if (stats.slowestMs > 300_000) {
    add('warn', 'latency', `slowest request took ${(stats.slowestMs / 1000).toFixed(0)}s — very long sessions are the top fingerprint risk`)
  }

  // Judge the archive by what is actually on disk now, not by what the log remembers:
  // an archived body from earlier today may already have been inspected and deleted.
  try {
    const archived = fs.readdirSync(HERE).filter((f) => /^failed-body-\d+\.json$/.test(f))
    if (archived.length) {
      const bytes = archived.reduce((n, f) => n + fs.statSync(path.join(HERE, f)).size, 0)
      add('warn', 'archived', `${archived.length} failed request body/bodies on disk (${(bytes / 1048576).toFixed(1)} MB) — inspect, then clear them`)
    } else if (stats.archived > 0) {
      add('info', 'archived', `${stats.archived} body/bodies were archived earlier today and have since been cleared`)
    }
  } catch { /* directory unreadable: health check already reported the bigger problem */ }

  return stats
}

// ---------------------------------------------------------------- 3. upstream shape drift
/**
 * Compare what upstream offers right now against what DSH actually declares.
 *
 * The previous version compared upstream against model-limits.json — a snapshot the
 * author had captured by hand. Both sides were stale, so it cheerfully reported
 * "matches snapshot" on the day upstream had replaced hy4-preview with hy4free/hy4std.
 * A drift check has to compare one live source against the other.
 */
function declaredModelIds(profilePath) {
  let text
  try { text = fs.readFileSync(profilePath, 'utf8') } catch (e) {
    if (e?.code === 'ENOENT') return null
    throw e
  }
  const lines = text.split(/\r?\n/)
  const indentOf = (l) => l.length - l.trimStart().length
  let base = -1
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)models:\s*$/.exec(lines[i])
    if (!m) continue
    // confirm the owning provider is ours by walking up to the shallower key
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j]
      if (!l.trim() || l.trim().startsWith('#')) continue
      const ind = indentOf(l)
      if (ind < m[1].length) {
        if (/^\s*local-gateway:/.test(l)) { start = i; base = m[1].length }
        break
      }
    }
    if (start >= 0) break
  }
  if (start < 0) return null
  const ids = []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) continue
    if (indentOf(l) <= base) break
    const idM = /^\s*-\s+id:\s*(.+?)\s*$/.exec(l)
    if (idM) ids.push(idM[1].replace(/^["']|["']$/g, ''))
  }
  return ids
}

async function checkUpstreamShape() {
  const out = { ok: false, models: 0 }
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    const ids = (j.data ?? []).map((m) => m.id)
    out.models = ids.length
    out.ok = ids.length > 0

    // Live upstream vs live DSH config. This is the drift that actually breaks the UI.
    const profilePath = profileConfigPath(args)
    const declared = declaredModelIds(profilePath)
    if (declared === null) {
      add('info', 'models', `no DSH profile at ${profilePath} — skipped the provider comparison`)
    } else {
      const upstreamSet = new Set(ids)
      const declaredSet = new Set(declared)
      const notInDsh = ids.filter((id) => !declaredSet.has(id))
      const notUpstream = declared.filter((id) => !upstreamSet.has(id))
      out.declared = declared.length
      out.notInDsh = notInDsh
      if (notInDsh.length) {
        add('warn', 'models-drift',
          `upstream offers ${notInDsh.length} model(s) DSH does not declare: ${notInDsh.join(', ')} — run \`node refresh-models.mjs --apply\``)
      }
      // An id that disappears from the catalog often still answers as an alias, so this
      // is information, not a fault.
      if (notUpstream.length) {
        add('info', 'models-stale',
          `DSH declares ${notUpstream.length} model(s) upstream no longer lists: ${notUpstream.join(', ')} (usually a kept alias; --prune removes them)`)
      }
      if (!notInDsh.length && !notUpstream.length) {
        add('info', 'models', `DSH declares exactly what upstream offers (${ids.length} models)`)
      }
    }
  } catch (e) {
    add('alert', 'models', `GET /v1/models failed: ${e?.message ?? e}`)
  }
  return out
}

// ---------------------------------------------------------------- 4. real end-to-end probe
async function checkProbe() {
  if (SKIP_PROBE) { add('info', 'probe', 'skipped (--no-probe)'); return { skipped: true } }
  const started = Date.now()
  try {
    const body = JSON.stringify({
      model: ZERO_COST_MODEL,
      stream: false,
      max_completion_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    })
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer probe' },
      body,
      signal: AbortSignal.timeout(180_000),
    })
    const ms = Date.now() - started
    const text = await r.text()

    // The whole point of the probe: it must be *real*. A 200 that carries no content
    // would mean the bridge answered without the upstream, which is a silent failure.
    if (!r.ok) {
      let hint = text.slice(0, 200)
      try { const j = JSON.parse(text); hint = `${j.error?.message ?? hint}` } catch {}
      if (text.includes('11128')) {
        add('alert', 'probe', `end-to-end probe REJECTED with 11128 — every variant shape failed; the upstream check changed. ${hint}`)
      } else {
        add('alert', 'probe', `end-to-end probe failed HTTP ${r.status} after ${ms}ms: ${hint}`)
      }
      return { ok: false, status: r.status, ms }
    }

    let content = ''
    let finish = ''
    try {
      const j = JSON.parse(text)
      content = j.choices?.[0]?.message?.content ?? ''
      finish = j.choices?.[0]?.finish_reason ?? ''
    } catch {
      add('warn', 'probe', `probe returned HTTP 200 but the body is not valid JSON: ${text.slice(0, 160)}`)
      return { ok: false, status: 200, ms }
    }

    if (!content && !finish) {
      add('alert', 'probe', `probe returned 200 but an EMPTY completion — upstream answered without content`)
      return { ok: false, status: 200, ms }
    }
    add('info', 'probe', `end-to-end probe OK in ${ms}ms (reply: ${JSON.stringify(content.slice(0, 20))})`)
    return { ok: true, status: 200, ms, content }
  } catch (e) {
    add('alert', 'probe', `probe threw after ${Date.now() - started}ms: ${e?.message ?? e}`)
    return { ok: false, ms: Date.now() - started }
  }
}

// ---------------------------------------------------------------- 5. provider config drift
function checkConfig() {
  // Resolved through config.mjs: flag > env > config.json > derived from DSH_HOME.
  const cfg = profileConfigPath(args)
  try {
    const t = fs.readFileSync(cfg, 'utf8')
    if (!t.includes('127.0.0.1:' + PORT)) add('warn', 'config', `profile "${profileName()}" does not point at port ${PORT}`)
    else add('info', 'config', `DSH profile "${profileName()}" points at port ${PORT}`)
    const baseUrl = /baseURL:\s*http:\/\/127\.0\.0\.1:(\d+)/.exec(t)
    if (baseUrl && Number(baseUrl[1]) !== PORT) add('alert', 'config', `DSH expects port ${baseUrl[1]} but this check ran against ${PORT}`)
  } catch (e) {
    // A missing/optional profile is not a fault of the bridge; say so quietly.
    if (e?.code === 'ENOENT') add('info', 'config', `no DSH profile at ${cfg} — skipped the profile check (set --profile-config or WB_BRIDGE_PROFILE_CONFIG to change this)`)
    else add('warn', 'config', `could not read ${cfg}: ${e?.message ?? e}`)
  }

  // scheduled task should still exist and be running
  const taskLog = path.join(HERE, '.last-task-state.json')
  try {
    const t = JSON.parse(fs.readFileSync(taskLog, 'utf8'))
    if (t.state !== 'Running') add('warn', 'task', `scheduled task wb-bridge state is ${t.state}, not Running`)
    else add('info', 'task', 'scheduled task wb-bridge is Running')
  } catch { /* written by the .ps1 wrapper; absence is not an error here */ }
}

// ---------------------------------------------------------------- report
function render(health, log, models, probe) {
  const icon = { info: '·', warn: '!', alert: 'X' }
  const lines = []
  lines.push(`# wb-bridge 每日自检 · ${localDate}`)
  lines.push('')
  lines.push(`检查时间：${now.toISOString()}（本地 ${new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} Asia/Shanghai）`)
  lines.push('')
  const code = worst()
  lines.push(`## 结论：${code === 0 ? '✅ 正常' : code === 1 ? '⚠️ 有告警（仍可用）' : '❌ 需要处理'}`)
  lines.push('')
  lines.push('| 级别 | 项目 | 说明 |')
  lines.push('|---|---|---|')
  for (const f of findings) lines.push(`| ${icon[f.level]} ${f.level} | \`${f.code}\` | ${f.text.replace(/\|/g, '\\|')} |`)
  lines.push('')

  lines.push('## 当天运行情况')
  lines.push('')
  if (log.requests) {
    lines.push(`- 请求 **${log.requests}** 次，成功 **${log.ok}**，失败 **${log.failed}**`)
    lines.push(`- 成功率 **${((log.ok / log.requests) * 100).toFixed(1)}%**`)
    const v = Object.entries(log.variants).sort((a, b) => b[1] - a[1])
    if (v.length) lines.push(`- 变体恢复：${v.map(([k, n]) => `${k} ×${n}`).join('，')}`)
    const e = Object.entries(log.upstreamErrors)
    if (e.length) lines.push(`- 上游错误：${e.map(([k, n]) => `HTTP ${k} ×${n}`).join('，')}`)
    lines.push(`- 最慢请求：**${(log.slowestMs / 1000).toFixed(1)}s**`)
    lines.push(`- 日志窗口：\`${log.firstLine ?? ''}\` → \`${log.lastLine ?? ''}\``)
  } else {
    lines.push('- 日志为空或没有 chat 请求')
  }
  lines.push('')

  lines.push('## 上游是否新增检查')
  lines.push('')
  if (log.fingerprintHits === 0) {
    lines.push('- 今日 **0** 次 11128 指纹拒绝 —— 现有清洗与角色折叠仍然有效')
  } else {
    lines.push(`- 今日 **${log.fingerprintHits}** 次 11128 —— 见上表判定`)
  }
  lines.push(`- 上游状态码分布：${Object.keys(log.upstreamErrors).length ? Object.entries(log.upstreamErrors).map(([k, n]) => `HTTP ${k} ×${n}`).join('，') : '无错误'}`)
  lines.push(`- 模型目录：${models.ok ? `${models.models} 个（与快照比对见上表）` : '读取失败'}`)
  lines.push('')

  lines.push('## 端到端探针')
  lines.push('')
  if (probe.skipped) lines.push('- 已跳过')
  else if (probe.ok) lines.push(`- ✅ 真实请求打通，耗时 ${probe.ms}ms`)
  else lines.push(`- ❌ 失败（status=${probe.status ?? 'n/a'}，${probe.ms}ms）`)
  lines.push('')

  lines.push('## 维护提示')
  lines.push('')
  lines.push('- 若出现新的 11128：看 `bridge-stdout.log` 的 `failed-body summary`，把新特征句加进 `CONTENT_SCRUBS`')
  lines.push('- 若 `system-as-user` 也失效：改 `bodyVariants()`（候选 `no-tools`、`trim-last-40` 已在表内）')
  lines.push('- 若模型目录有变化：`node refresh-models.mjs` 看差异，`--apply` 写入（自动备份 + YAML 校验）')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- main
const health = await checkHealth()
const log = parseLog()
const models = await checkUpstreamShape()
checkConfig()
const probe = await checkProbe()

const report = render(health, log, models, probe)
fs.mkdirSync(REPORT_DIR, { recursive: true })
const reportPath = path.join(REPORT_DIR, `wb-daily-${localDate}.md`)
fs.writeFileSync(reportPath, report, 'utf8')

const summary = {
  date: localDate,
  at: now.toISOString(),
  verdict: worst(),
  requests: log.requests,
  ok: log.ok,
  failed: log.failed,
  successRate: log.requests ? Number(((log.ok / log.requests) * 100).toFixed(2)) : null,
  fingerprintHits: log.fingerprintHits,
  failedArchived: log.archived,
  probeOk: probe.ok ?? null,
  report: path.basename(reportPath),
  findings: findings.map((f) => `${f.level}:${f.code}`),
}
fs.appendFileSync(path.join(REPORT_DIR, 'daily-log.jsonl'), JSON.stringify(summary) + '\n', 'utf8')

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(report)
  console.log('---')
  console.log(`report: ${reportPath}`)
}

process.exit(worst())
