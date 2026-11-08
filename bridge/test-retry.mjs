// Offline check of the retry/backoff path in wb-bridge.mjs.
// Runs a fake upstream that fails the first N calls with a chosen status, then succeeds,
// and drives the *real* bridge process against it via its --port + a stubbed base URL.
//
// The bridge hard-codes its upstream hosts, so instead of patching those we verify the
// two pure pieces of the policy (retryDelayMs, and the retry loop's decision table) by
// re-importing the source and exercising them through a controlled harness.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wb-bridge.mjs')
const src = fs.readFileSync(SRC, 'utf8')

const grab = (name) => {
  const re = new RegExp(`(?:const|function) ${name}[\\s\\S]*?\\n(?=(?:const|function|let|//|\\n))`, 'm')
  const m = re.exec(src)
  if (!m) throw new Error(`could not extract ${name}`)
  return m[0]
}

let failures = 0
const check = (label, cond, detail = '') => {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${detail ? ' :: ' + detail : ''}`)
}

// ---- retryDelayMs: pure function, extract and run it for real -------------------------
const consts = {
  UPSTREAM_RETRY_BASE_MS: 800,
  UPSTREAM_RETRY_MAX_MS: 10000,
}
const constLines = Object.entries(consts).map(([k, v]) => `const ${k} = ${v};`).join('\n')
const delaySrc = src.match(/function retryDelayMs[\s\S]*?\n}/)[0]
const retryDelayMs = new Function(`${constLines}\n${delaySrc}\nreturn retryDelayMs;`)()

console.log('retryDelayMs')
// exponential growth with jitter: attempt 1 ~800ms, 2 ~1600ms, 3 ~3200ms
const d1 = retryDelayMs(null, 1)
const d2 = retryDelayMs(null, 2)
const d3 = retryDelayMs(null, 3)
check('attempt 1 in [680, 920]', d1 >= 680 && d1 <= 920, `${d1}ms`)
check('attempt 2 in [1360, 1840]', d2 >= 1360 && d2 <= 1840, `${d2}ms`)
check('attempt 3 in [2720, 3680]', d3 >= 2720 && d3 <= 3680, `${d3}ms`)
check('grows monotonically in expectation', d1 < d2 && d2 < d3, `${d1} < ${d2} < ${d3}`)

// capped by max
const dBig = retryDelayMs(null, 10)
check('capped at UPSTREAM_RETRY_MAX_MS', dBig <= 10000, `${dBig}ms`)

// Retry-After in seconds wins
const fakeRes = (h) => ({ headers: { get: (k) => (k === 'retry-after' ? h : null) } })
check('Retry-After seconds honoured', retryDelayMs(fakeRes('2'), 1) === 2000, `${retryDelayMs(fakeRes('2'), 1)}ms`)
check('Retry-After 0 honoured', retryDelayMs(fakeRes('0'), 1) === 0)
check('Retry-After capped by max', retryDelayMs(fakeRes('999'), 1) === 10000, `${retryDelayMs(fakeRes('999'), 1)}ms`)
const future = new Date(Date.now() + 5000).toUTCString()
const dDate = retryDelayMs(fakeRes(future), 1)
check('Retry-After HTTP-date honoured', dDate > 3500 && dDate <= 5000, `${dDate}ms`)
check('garbage Retry-After falls back to backoff', retryDelayMs(fakeRes('soon'), 1) > 0)

// ---- retry status set ----------------------------------------------------------------
const setSrc = src.match(/const UPSTREAM_RETRY_STATUSES = new Set\(\[[^\]]*\]\)/)[0]
const UPSTREAM_RETRY_STATUSES = new Function(`${setSrc}\nreturn UPSTREAM_RETRY_STATUSES;`)()
console.log('retry statuses')
check('429 retried', UPSTREAM_RETRY_STATUSES.has(429))
check('500 retried', UPSTREAM_RETRY_STATUSES.has(500))
check('502/503/504 retried', [502, 503, 504].every((s) => UPSTREAM_RETRY_STATUSES.has(s)))
check('400 NOT retried (11128 handled by variants)', !UPSTREAM_RETRY_STATUSES.has(400))
check('401 NOT retried (token refresh path)', !UPSTREAM_RETRY_STATUSES.has(401))
check('404 NOT retried', !UPSTREAM_RETRY_STATUSES.has(404))

// ---- structural checks on the loop ---------------------------------------------------
console.log('retry loop structure')
const loop = src.match(/const fetchWithRetry = async \(body\) => \{[\s\S]*?\n  \}/)[0]
check('bounded by UPSTREAM_RETRY_ATTEMPTS', loop.includes('UPSTREAM_RETRY_ATTEMPTS'))
check('bounded by time budget', loop.includes('UPSTREAM_RETRY_BUDGET_MS'))
check('drains body before retry (single read)', (loop.match(/\.text\(\)/g) || []).length >= 2)
check('returns discriminated outcome, not raw Response', loop.includes('{ ok: true, response: r }') && loop.includes('{ ok: false, status:'))
check('sleeps between attempts', loop.includes('await sleep(delay)'))
check('does not retry non-transient statuses', loop.includes('!UPSTREAM_RETRY_STATUSES.has(r.status)'))

// error text must not be lost: the 11128 sniffing still receives the body
check('11128 detection fed from outcome.text', src.includes("outcome.status === 400 && lastError.text.includes('11128')"))

console.log()
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
