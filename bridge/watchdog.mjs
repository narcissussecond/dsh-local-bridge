#!/usr/bin/env node
/**
 * wb-bridge watchdog: keep the bridge listening.
 *
 * Why this exists: on 2026-11-03 a startup-script rewrite left the bridge down for
 * several minutes after a restart, and nothing noticed until a human did. A daily
 * report is too slow for "the model endpoint is gone right now".
 *
 * Run it from a Scheduled Task every few minutes. It is deliberately dull:
 *
 *   - probe GET /healthz with a short timeout
 *   - healthy  -> exit 0, say nothing
 *   - unhealthy -> start the bridge once via the platform launcher, wait, re-probe
 *   - still unhealthy -> exit 1 and append one line to reports/verdict.log
 *
 * It never kills a running bridge, and it rate-limits itself: if it had to restart the
 * bridge within COOLDOWN_MS of the previous restart, it backs off so a crash-loop does
 * not turn into a fork bomb.
 *
 * Usage:
 *   node watchdog.mjs [--port 8791] [--timeout-ms 4000] [--settle-ms 12000] [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BRIDGE_DIR, reportsDir, nodeBinary } from './config.mjs'

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', process.env.WB_BRIDGE_PORT ?? '8791'))
const PROBE_TIMEOUT_MS = Number(argOf('--timeout-ms', '4000'))
// How long to give a freshly started bridge before deciding it is unhealthy.
const SETTLE_MS = Number(argOf('--settle-ms', '12000'))
const SETTLE_POLL_MS = 1500
// Two restarts closer together than this mean the bridge is crash-looping.
const COOLDOWN_MS = 5 * 60_000
const DRY_RUN = args.includes('--dry-run')

const STATE_FILE = path.join(BRIDGE_DIR, '.watchdog-state.json')
const VERDICT_LOG = path.join(reportsDir(), 'verdict.log')

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

function note(line, { toVerdict = false } = {}) {
  const text = `${stamp()} [watchdog] ${line}`
  console.log(text)
  if (toVerdict) {
    try {
      fs.mkdirSync(reportsDir(), { recursive: true })
      fs.appendFileSync(VERDICT_LOG, `${stamp()} WATCHDOG ${line}\n`, 'utf8')
    } catch { /* reporting must never be the reason we fail */ }
  }
  return text
}

async function probe() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!r.ok) return { healthy: false, why: `HTTP ${r.status}` }
    const j = await r.json()
    // Reachable but not a bridge is still broken for our purposes.
    if (!j || j.service !== 'wb-bridge' || j.ok !== true) return { healthy: false, why: 'unexpected /healthz payload' }
    return { healthy: true, info: j }
  } catch (e) {
    return { healthy: false, why: String(e?.message ?? e) }
  }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8') } catch { /* best effort */ }
}

/**
 * Launch the bridge detached, exactly the way the login task does.
 *
 * On Windows we go through autostart-wb-bridge.cmd so that PATH/settle behaviour matches
 * the real startup path — testing one launcher and relying on another is how the
 * 2026-11-03 outage happened. Elsewhere, spawn node directly.
 */
function launch() {
  const cmd = process.platform === 'win32'
    ? path.join(BRIDGE_DIR, 'autostart-wb-bridge.cmd')
    : nodeBinary()
  const cmdArgs = process.platform === 'win32'
    ? []
    : [path.join(BRIDGE_DIR, 'wb-bridge.mjs'), '--port', String(PORT)]

  if (DRY_RUN) {
    note(`would launch: ${cmd} ${cmdArgs.join(' ')}`)
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: BRIDGE_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: process.platform === 'win32' && cmd.toLowerCase().endsWith('.cmd'),
    })
    child.on('error', (e) => { note(`launch failed: ${e?.message ?? e}`, { toVerdict: true }); resolve() })
    child.unref()
    // Do not wait for the launcher: it may run in the foreground for the life of the
    // bridge. We wait by polling /healthz instead.
    setTimeout(resolve, 500)
  })
}

async function waitUntilHealthy(deadlineMs) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    const r = await probe()
    if (r.healthy) return r
    await new Promise((res) => setTimeout(res, SETTLE_POLL_MS))
  }
  return probe()
}

const first = await probe()
if (first.healthy) {
  // Healthy: stay quiet. A watchdog that logs on every tick is noise nobody reads.
  if (DRY_RUN) note(`healthy on ${PORT}`)
  process.exit(0)
}

note(`bridge unhealthy on ${PORT}: ${first.why}`, { toVerdict: true })

if (DRY_RUN) {
  const state = readState()
  const sinceLast = state.lastRestartAt ? Date.now() - state.lastRestartAt : Infinity
  note(sinceLast < COOLDOWN_MS ? 'would back off (recent restart)' : 'would restart')
  process.exit(0)
}

const state = readState()
const sinceLast = state.lastRestartAt ? Date.now() - state.lastRestartAt : Infinity
if (sinceLast < COOLDOWN_MS) {
  note(`refusing to restart: last restart was ${Math.round(sinceLast / 1000)}s ago ` +
       `(cooldown ${COOLDOWN_MS / 1000}s). Crash loop? Check bridge-stderr.log.`, { toVerdict: true })
  process.exit(1)
}

note('restarting the bridge')
writeState({ ...state, lastRestartAt: Date.now() })
await launch()

const after = await waitUntilHealthy(SETTLE_MS)
if (after.healthy) {
  note('recovered: bridge is healthy again', { toVerdict: true })
  process.exit(0)
}

note(`still unhealthy after restart: ${after.why} — see bridge-stderr.log`, { toVerdict: true })
process.exit(1)
