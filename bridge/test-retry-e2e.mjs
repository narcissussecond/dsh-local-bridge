// End-to-end proof that the retry loop actually retries and actually gives up.
// Spins a fake HTTP server that returns 429 (with Retry-After) twice then 200, and
// another that always 500s, then drives the REAL fetchWithRetry and retryDelayMs
// extracted from wb-bridge.mjs over real sockets.

import { createServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wb-bridge.mjs')
const src = fs.readFileSync(SRC, 'utf8')

const consts = {
  UPSTREAM_RETRY_ATTEMPTS: 4,
  UPSTREAM_RETRY_BASE_MS: 800,
  UPSTREAM_RETRY_MAX_MS: 10000,
  UPSTREAM_RETRY_BUDGET_MS: 120000,
}
const prelude = `
const UPSTREAM_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const logLines = [];
const log = (...a) => { const s = a.join(' '); logLines.push(s); console.log('    log>', s); };
${Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`).join('\n')}
${src.match(/function retryDelayMs[\s\S]*?\n}/)[0]}
`

// Extract the fetchWithRetry body and wrap it so we can call it directly.
const loopBody = src.match(/const fetchWithRetry = async \(body\) => \{([\s\S]*?)\n  \}/)[1]
const factory = new Function('attemptFetch', 'refreshedRef', `${prelude}
  let refreshed = refreshedRef.value;
  const fetchWithRetry = async (body) => {${loopBody}
  };
  return fetchWithRetry;`)

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' :: ' + detail : ''}`)
}

function startFake(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

// ---- scenario 1: 429 twice (with Retry-After: 0), then 200 ------------------------------
{
  let calls = 0
  const { srv, port } = await startFake((req, res) => {
    calls++
    if (calls <= 2) { res.writeHead(429, { 'retry-after': '0' }); res.end('{"code":429}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"ok":true}\n\n')
  })
  let attempts = 0
  const attemptFetch = async () => { attempts++; return fetch(`http://127.0.0.1:${port}/v2/chat/completions`, { method: 'POST', body: '{}' }) }
  const fetchWithRetry = factory(attemptFetch, { value: false })
  const t0 = Date.now()
  const out = await fetchWithRetry('{}')
  const ms = Date.now() - t0
  console.log('scenario 1: 429,429,200 (Retry-After: 0)')
  check('eventually succeeded', out.ok === true)
  check('upstream called 3 times', calls === 3, `${calls} calls, ${attempts} attempts`)
  check('did not hang (Retry-After 0 honoured)', ms < 3000, `${ms}ms`)
  srv.close()
}

// ---- scenario 2: always 500 → gives up after exactly UPSTREAM_RETRY_ATTEMPTS ------------
{
  let calls = 0
  const { srv, port } = await startFake((req, res) => { calls++; res.writeHead(500); res.end('{"code":500,"msg":"boom"}') })
  const attemptFetch = async () => fetch(`http://127.0.0.1:${port}/v2/chat/completions`, { method: 'POST', body: '{}' })
  const fetchWithRetry = factory(attemptFetch, { value: false })
  const out = await fetchWithRetry('{}')
  console.log('scenario 2: always 500')
  check('reports failure', out.ok === false)
  check('status preserved', out.status === 500, `status=${out.status}`)
  check('EXACTLY UPSTREAM_RETRY_ATTEMPTS calls (no runaway)', calls === consts.UPSTREAM_RETRY_ATTEMPTS, `${calls} calls`)
  check('error body preserved for diagnostics', typeof out.text === 'string' && out.text.includes('boom'), JSON.stringify(out.text))
  srv.close()
}

// ---- scenario 3: 400 must NOT be retried ------------------------------------------------
{
  let calls = 0
  const { srv, port } = await startFake((req, res) => { calls++; res.writeHead(400); res.end('{"code":11128,"msg":"unapproved channel"}') })
  const attemptFetch = async () => fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}' })
  const fetchWithRetry = factory(attemptFetch, { value: false })
  const out = await fetchWithRetry('{}')
  console.log('scenario 3: 400/11128 must not be retried')
  check('failed', out.ok === false)
  check('called exactly once', calls === 1, `${calls} calls`)
  check('11128 visible in text for variant logic', out.text.includes('11128'))
  srv.close()
}

// ---- scenario 4: 429 then 200, Retry-After honoured as a real delay ----------------------
{
  let calls = 0
  const { srv, port } = await startFake((req, res) => {
    calls++
    if (calls === 1) { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"ok":true}\n\n')
  })
  const attemptFetch = async () => fetch(`http://127.0.0.1:${port}/x`, { method: 'POST', body: '{}' })
  const fetchWithRetry = factory(attemptFetch, { value: false })
  const t0 = Date.now()
  const out = await fetchWithRetry('{}')
  const ms = Date.now() - t0
  console.log('scenario 4: Retry-After: 1 must actually wait ~1s')
  check('succeeded', out.ok === true)
  check('waited at least 900ms', ms >= 900, `${ms}ms`)
  srv.close()
}

console.log()
console.log(failures === 0 ? 'ALL E2E CHECKS PASSED' : `${failures} E2E CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
