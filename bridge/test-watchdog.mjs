// Verify watchdog.mjs actually revives a dead bridge, and refuses to thrash on a
// crash loop. Everything runs in a throwaway directory on a free port: the production
// bridge on 8791 is never touched.
//
// Case 1  healthy bridge            -> exit 0, no restart
// Case 2  dead port, --dry-run      -> exit 0, says it WOULD restart
// Case 3  dead port, real run       -> detects, launches, comes back healthy, exit 0
// Case 4  immediate second run      -> cooldown refuses, exit 1
// Case 5  launcher cannot succeed   -> stays unhealthy, exit 1, says why
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' :: ' + detail : ''}`)
}

/** A self-contained bridge dir: real sources, a launcher pinned to our test port. */
function makeSandbox(port, { launcherWorks = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwd-'))
  for (const f of ['watchdog.mjs', 'config.mjs', 'wb-bridge.mjs', 'tool-rename.mjs', 'model-limits.json']) {
    fs.copyFileSync(path.join(SRC_DIR, f), path.join(dir, f))
  }
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true })

  // The launcher the watchdog spawns. Mirrors autostart-wb-bridge.cmd but pinned to the
  // test port and using this process's Node, so no PATH assumptions leak into the test.
  const cmd = launcherWorks
    ? `@echo off\r\n"${NODE}" "${path.join(dir, 'wb-bridge.mjs')}" --port ${port} >> "${path.join(dir, 'test-out.log')}" 2>> "${path.join(dir, 'test-err.log')}"\r\n`
    : `@echo off\r\necho simulated launcher failure>> "${path.join(dir, 'test-err.log')}"\r\nexit /b 1\r\n`
  fs.writeFileSync(path.join(dir, 'autostart-wb-bridge.cmd'), cmd, 'utf8')
  return dir
}

function run(dir, port, extra = []) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [path.join(dir, 'watchdog.mjs'), '--port', String(port), ...extra], {
      cwd: dir, windowsHide: true,
    })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

const alive = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    const j = await r.json().catch(() => null)
    return Boolean(r.ok && j && j.service === 'wb-bridge')
  } catch { return false }
}

const killPort = (port) => {
  if (process.platform !== 'win32') return
  let out = ''
  try {
    out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return } // findstr exits 1 when nothing matches
  for (const line of out.split(/\r?\n/)) {
    const m = /LISTENING\s+(\d+)/.exec(line)
    if (m) { try { process.kill(Number(m[1])); } catch {} }
  }
}

const PORT_A = 38291
const PORT_B = 38292
const PORT_C = 38293
const PORT_D = 38294

// ---- Case 1: healthy bridge must not be touched ---------------------------------------
{
  console.log('1. healthy bridge -> quiet exit 0, no restart')
  const dir = makeSandbox(PORT_A)
  // Serve a compliant /healthz ourselves to stand in for a live bridge.
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'wb-bridge', models: 19 }))
  })
  await new Promise((r) => srv.listen(PORT_A, '127.0.0.1', r))
  const r = await run(dir, PORT_A)
  check('exit 0', r.code === 0, `exit=${r.code}`)
  check('said nothing (no restart)', r.out.trim() === '', JSON.stringify(r.out.trim()))
  srv.close()
}

// ---- Case 2: dry run on a dead port ---------------------------------------------------
{
  console.log('2. dead port + --dry-run -> reports intent, changes nothing')
  const dir = makeSandbox(PORT_B)
  const r = await run(dir, PORT_B, ['--dry-run'])
  check('exit 0', r.code === 0, `exit=${r.code}`)
  check('said "would restart"', /would restart/.test(r.out), r.out.trim().split('\n').pop())
  check('nothing started', !(await alive(PORT_B)))
}

// ---- Case 3: real revival ---------------------------------------------------------------
{
  console.log('3. dead port -> actually restarts and comes back')
  const dir = makeSandbox(PORT_C)
  check('was dead before', !(await alive(PORT_C)))
  const r = await run(dir, PORT_C)
  check('exit 0', r.code === 0, `exit=${r.code}`)
  check('logged the restart', /restarting the bridge/.test(r.out), '')
  check('logged recovery', /recovered/.test(r.out), r.out.trim().split('\n').pop())
  check('bridge is ALIVE now', await alive(PORT_C))
  killPort(PORT_C)
}

// ---- Case 4: cooldown stops a crash loop -----------------------------------------------
{
  console.log('4. second run inside cooldown -> refuses, exit 1')
  const dir = makeSandbox(PORT_D)
  // Prime the state as if we restarted a moment ago.
  fs.writeFileSync(path.join(dir, '.watchdog-state.json'), JSON.stringify({ lastRestartAt: Date.now() - 5000 }), 'utf8')
  const r = await run(dir, PORT_D)
  check('exit 1', r.code === 1, `exit=${r.code}`)
  check('explains cooldown', /cooldown/.test(r.out), r.out.trim().split('\n').pop())
  check('did NOT start anything', !(await alive(PORT_D)))
}

// ---- Case 5: launcher that cannot work -------------------------------------------------
{
  console.log('5. launcher fails -> watchdog reports, does not claim success')
  const dir = makeSandbox(PORT_A, { launcherWorks: false })
  // fresh state file so cooldown does not short-circuit
  fs.rmSync(path.join(dir, '.watchdog-state.json'), { force: true })
  const r = await run(dir, PORT_A, ['--settle-ms', '4000'])
  check('exit 1', r.code === 1, `exit=${r.code}`)
  check('says still unhealthy', /still unhealthy/.test(r.out), r.out.trim().split('\n').pop())
  check('wrote a verdict line', fs.existsSync(path.join(dir, 'reports', 'verdict.log')))
}

console.log()
console.log(failures === 0 ? 'ALL WATCHDOG CHECKS PASSED' : `${failures} WATCHDOG CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
