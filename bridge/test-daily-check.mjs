// Verify daily-check.mjs actually FIRES on bad conditions instead of always saying OK.
// We do this by running the real script against controlled fake conditions:
//   A. bridge down on a dead port        -> expect alert, exit 2
//   B. fake upstream that 11128s always  -> expect fingerprint alert
//   C. fake upstream that 429s always    -> expect probe alert (not silent pass)
//   D. fake upstream returning empty 200 -> expect "empty completion" alert
//   E. fake upstream returning garbage   -> expect "not valid JSON" warn/alert
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve everything relative to this file: no machine-specific absolute paths.
const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const CHECK = path.join(BRIDGE_DIR, 'daily-check.mjs')
// daily-check.mjs imports these siblings, so an isolated copy must carry them too.
const SIBLINGS = ['config.mjs', 'model-limits.json']

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' :: ' + detail : ''}`)
}

function runCheck(port, extra = []) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [CHECK, '--port', String(port), '--json', ...extra], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

function fake(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

const healthz = (res, extra = {}) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, service: 'wb-bridge', region: 'cn', credentialCached: true, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), models: 19, appVersion: '5.9.3', ...extra }))
}
const modelsOk = (res) => {
  const ids = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, 'model-limits.json'), 'utf8')).map((m) => m.id)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }))
}

// ---- A. nothing listening -------------------------------------------------------------
{
  console.log('A. bridge down (dead port)')
  const r = await runCheck(59117)
  check('exit code 2 (broken)', r.code === 2, `exit=${r.code}`)
  check('reports health alert', /"alert:health"/.test(r.out), r.out.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  check('probe also flagged', /"alert:probe"/.test(r.out))
}

// ---- B. always 11128 ------------------------------------------------------------------
{
  const { srv, port } = await fake((req, res) => {
    if (req.url.startsWith('/healthz')) return healthz(res)
    if (req.url.startsWith('/v1/models')) return modelsOk(res)
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 11128, msg: 'Illegal API invocation from an unapproved channel' }))
  })
  console.log('B. upstream always rejects with 11128')
  const r = await runCheck(port)
  check('exit code 2', r.code === 2, `exit=${r.code}`)
  check('probe marked failed', /"probeOk":\s*false/.test(r.out))
  check('probe raised an alert finding', /"alert:probe"/.test(r.out), r.out.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  srv.close()
}

// ---- C. always 429 --------------------------------------------------------------------
{
  const { srv, port } = await fake((req, res) => {
    if (req.url.startsWith('/healthz')) return healthz(res)
    if (req.url.startsWith('/v1/models')) return modelsOk(res)
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end('{"code":429}')
  })
  console.log('C. upstream always 429')
  const r = await runCheck(port)
  check('exit code 2', r.code === 2, `exit=${r.code}`)
  check('probe failure surfaced (not silent)', /"alert:probe"/.test(r.out) && /"probeOk":\s*false/.test(r.out))
  srv.close()
}

// ---- D. empty 200 ---------------------------------------------------------------------
{
  const { srv, port } = await fake((req, res) => {
    if (req.url.startsWith('/healthz')) return healthz(res)
    if (req.url.startsWith('/v1/models')) return modelsOk(res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: '' }] }))
  })
  console.log('D. upstream returns 200 with empty completion')
  const r = await runCheck(port)
  check('exit code 2', r.code === 2, `exit=${r.code}`)
  check('empty completion treated as probe failure', /"probeOk":\s*false/.test(r.out) && /"alert:probe"/.test(r.out))
  srv.close()
}

// ---- E. corrupted catalog -> models alert ---------------------------------------------
{
  const { srv, port } = await fake((req, res) => {
    if (req.url.startsWith('/healthz')) return healthz(res, { models: 3 })
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'only-one' }] }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }))
  })
  console.log('E. model catalog shrank (UA/catalog drift)')
  const r = await runCheck(port)
  check('catalog alert for too-few models', /"alert:catalog"/.test(r.out), r.out.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  // The provider comparison reports drift against the DSH profile now (see case H).
  check('provider drift detected', /"warn:models-drift"/.test(r.out))
  srv.close()
}

// ---- F. healthy path must NOT alert ---------------------------------------------------
{
  const { srv, port } = await fake((req, res) => {
    if (req.url.startsWith('/healthz')) return healthz(res)
    if (req.url.startsWith('/v1/models')) return modelsOk(res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }))
  })
  console.log('F. fully healthy (control)')
  const r = await runCheck(port)
  check('control does NOT alert on probe', !/"alert:probe"/.test(r.out), r.out.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  check('control does NOT alert on health/catalog', !/"alert:(health|catalog)"/.test(r.out))
  check('control probe ok', /"probeOk":\s*true/.test(r.out))
  srv.close()
}

// ---- G. fingerprint accounting --------------------------------------------------------
// The live log today holds 3 x 11128, each immediately followed by a `learned:` line,
// because the bridge re-probes the system role after every restart. That must be INFO,
// not an alert — otherwise every restart page-flags a healthy bridge.
{
  console.log('G. fingerprint judgement (restart re-probe must not alert)')
  const fsmod = fs
  const osmod = os
  const pathmod = path

  const mkLog = (lines) => {
    const dir = fsmod.mkdtempSync(pathmod.join(osmod.tmpdir(), 'wbdc-'))
    fsmod.writeFileSync(pathmod.join(dir, 'bridge-stdout.log'), lines.join('\n') + '\n')
    // daily-check resolves its own paths relative to its directory, so an isolated run
    // needs a copy of the script AND every module it imports.
    fsmod.copyFileSync(CHECK, pathmod.join(dir, 'daily-check.mjs'))
    for (const s of SIBLINGS) fsmod.copyFileSync(pathmod.join(BRIDGE_DIR, s), pathmod.join(dir, s))
    return dir
  }
  const runIn = (dir, port) => new Promise((resolve) => {
    const p = spawn(NODE, [pathmod.join(dir, 'daily-check.mjs'), '--port', String(port), '--json', '--no-probe'], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })

  // G1: three restarts, each 11128 then learned -> info only
  const healthy = mkLog([
    '01:20:58 wb-bridge listening on http://127.0.0.1:59101',
    '01:27:26   variant "as-prepared": upstream 400 (11128)',
    '01:27:33   learned: upstream rejects the system role here — folding it into the first user message from now on',
    '14:31:48   variant "as-prepared": upstream 400 (11128)',
    '14:31:51   learned: upstream rejects the system role here — folding it into the first user message from now on',
    '14:36:05   variant "as-prepared": upstream 400 (11128)',
    '14:36:08   learned: upstream rejects the system role here — folding it into the first user message from now on',
    '14:36:12   recovered via variant "system-as-user"',
    '14:36:15 chat: model=deepseek-v4.1-flash effort=max stream=true msgs=5 auth=present',
    '14:36:16 chat done: model=deepseek-v4.1-flash in 1200ms status=200',
  ])
  const g1 = await runIn(healthy, 59101)
  check('G1 restart re-probes are INFO, not alert', !/"alert:fingerprint"/.test(g1.out), g1.out.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  check('G1 still reports the count', /"fingerprintHits":\s*3/.test(g1.out))

  // G2: an 11128 with NO learning line = genuinely new check -> must alert
  const drifted = mkLog([
    '01:20:58 wb-bridge listening on http://127.0.0.1:59102',
    '01:27:26   variant "as-prepared": upstream 400 (11128)',
    '01:27:33   learned: upstream rejects the system role here — folding it into the first user message from now on',
    '09:10:00   variant "system-as-user": upstream 400 (11128)',
    '09:10:05   variant "no-tools": upstream 400 (11128)',
    '09:10:10 chat: model=deepseek-v4.1-flash effort=max stream=true msgs=5 auth=present',
    '09:10:12 chat done: model=deepseek-v4.1-flash in 900ms status=502',
  ])
  const g2 = await runIn(drifted, 59102)
  check('G2 unexplained 11128 DOES alert', /"alert:fingerprint"/.test(g2.out), g2.out.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
}

// ---- H. model drift must be judged against the DSH profile, not the stale snapshot ---
// Regression: this used to compare upstream against model-limits.json. Both sides were
// stale, so it reported "matches snapshot" on the day upstream replaced hy4-preview with
// hy4free/hy4std. It must now compare live upstream against the profile DSH boots from.
{
  console.log('H. model drift compares live upstream against the DSH profile')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbdch-'))
  for (const f of ['daily-check.mjs', 'config.mjs', 'model-limits.json']) {
    fs.copyFileSync(path.join(BRIDGE_DIR, f), path.join(dir, f))
  }
  fs.writeFileSync(path.join(dir, 'bridge-stdout.log'), '01:00:00 wb-bridge listening\n', 'utf8')

  const mkProfile = (ids, file) => {
    const entries = ids.map((id) => `            - id: ${id}\n              name: "${id}"\n              contextWindow: 1000\n              maxTokens: 100\n              input: [ text ]`).join('\n')
    const text = [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      local-gateway:',
      '        baseURL: http://127.0.0.1:8791/v1',
      '        models:',
      entries,
      '- id: ui-theme',
      '  config:',
      '    fontSize: 18',
      '',
    ].join('\n')
    fs.writeFileSync(file, text, 'utf8')
    return file
  }

  const srv = createServer((req, res) => {
    if (req.url.startsWith('/healthz')) return healthz(res)
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        object: 'list',
        data: ['deepseek-v4.1-flash', 'hy4free', 'hy4std'].map((id) => ({ id, object: 'model' })),
      }))
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }))
  })
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)))

  const runWith = (profile) => new Promise((resolve) => {
    const p = spawn(NODE, [path.join(dir, 'daily-check.mjs'), '--port', String(port), '--json',
      '--no-probe', '--profile-config', profile], { windowsHide: true })
    let o = ''
    p.stdout.on('data', (d) => (o += d))
    p.stderr.on('data', (d) => (o += d))
    p.on('close', () => resolve(o))
  })

  // Declares only one of the three upstream models -> two must show up as drift.
  const behind = await runWith(mkProfile(['deepseek-v4.1-flash'], path.join(dir, 'behind.yml')))
  check('H1 drift detected', /"warn:models-drift"/.test(behind), behind.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  check('H2 never claims "matches snapshot"', !/matches snapshot/.test(behind))

  // Declares exactly what upstream serves -> no drift.
  const inSync = await runWith(mkProfile(['deepseek-v4.1-flash', 'hy4free', 'hy4std'], path.join(dir, 'insync.yml')))
  check('H3 in-sync profile raises no drift', !/"warn:models-drift"/.test(inSync), inSync.match(/"findings":\[[^\]]*\]/)?.[0] ?? '')
  check('H4 in-sync profile says so', /"info:models"/.test(inSync))

  srv.close()
}

console.log()
console.log(failures === 0 ? 'ALL ALERT-PATH CHECKS PASSED' : `${failures} ALERT-PATH CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)