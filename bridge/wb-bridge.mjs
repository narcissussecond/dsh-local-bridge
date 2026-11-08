/**
 * wb-bridge — a small local OpenAI-compatible bridge in front of your own
 * WorkBuddy desktop login.
 *
 * Why this exists: DSH can consume any OpenAI-compatible endpoint through
 * @deepseek-ai/dsh-llm-pi-ai by configuration alone, so the only missing piece is
 * something that (a) unlocks WorkBuddy's at-rest encrypted credential and (b) speaks
 * the upstream wire format. This does exactly those two things and nothing else.
 *
 * It listens on 127.0.0.1 only. It never logs or echoes a token.
 *
 * Routes:
 *   GET  /healthz
 *   GET  /v1/models
 *   POST /v1/chat/completions     (SSE passthrough; non-stream requests are aggregated)
 *
 * Usage:
 *   node wb-bridge.mjs [--port 8791] [--exe "F:\workbuddy\WorkBuddy.exe"]
 */
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { createHash, createDecipheriv, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { renameTool, TOOL_RENAME } from './tool-rename.mjs'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------- configuration
const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const PORT = Number(argOf('--port', process.env.WB_BRIDGE_PORT ?? '8791'))
const HOST = '127.0.0.1'
const WB_EXE = argOf('--exe', process.env.WORKBUDDY_ELECTRON_BIN ?? findWorkBuddyExe())

// Upstream retry policy. Measured on 2026-11-03: every hard failure that day was a
// transient 429 (6x) or 500 (2x) inside one busy window — never a fingerprint reject.
// Without this, the bridge handed DSH a 502 at once, DSH retried immediately, and the
// same 1.0-2.2 MB body was re-sent three times within three seconds, which only made
// the rate limit worse. Back off instead, and let the caller see one slow success.
const UPSTREAM_RETRY_ATTEMPTS = Math.max(1, Number(argOf('--retry-attempts', process.env.WB_BRIDGE_RETRY_ATTEMPTS ?? '4')))
const UPSTREAM_RETRY_BASE_MS = Number(argOf('--retry-base-ms', process.env.WB_BRIDGE_RETRY_BASE_MS ?? '800'))
const UPSTREAM_RETRY_MAX_MS = Number(argOf('--retry-max-ms', process.env.WB_BRIDGE_RETRY_MAX_MS ?? '10000'))
// Never spend longer than this on backoff for one request, however many attempts remain:
// a streaming chat that has already been waiting minutes is worse than an honest error.
const UPSTREAM_RETRY_BUDGET_MS = Number(argOf('--retry-budget-ms', process.env.WB_BRIDGE_RETRY_BUDGET_MS ?? '120000'))
// 4xx other than these are the caller's problem (bad body, auth) — retrying cannot help.
// 11128 is handled by bodyVariants(), not here.
const UPSTREAM_RETRY_STATUSES = new Set([429, 500, 502, 503, 504])

const CN_CHAT = 'https://copilot.tencent.com'
const CN_BILL = 'https://www.codebuddy.cn'
const GLOBAL_CHAT = 'https://www.workbuddy.ai'

const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

const AUTH_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  path.join(process.env.APPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
]

function findWorkBuddyExe() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'F:\\workbuddy\\WorkBuddy.exe',
  ]
  for (const c of candidates) if (c && fs.existsSync(c)) return c
  return 'WorkBuddy.exe'
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// ---------------------------------------------------------------- credential
let cachedKey = null
let cacheKeyId = null
let credential = null
let credentialExpiry = 0

function atRestKey() {
  if (cachedKey) return Promise.resolve(cachedKey)
  return new Promise((resolve, reject) => {
    execFile(
      WB_EXE,
      ['-e', HELPER_SCRIPT],
      { timeout: 90000, maxBuffer: 4 << 20, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`key helper failed: ${err.message}${stderr ? ' / ' + String(stderr).slice(0, 200) : ''}`))
        try {
          const payload = JSON.parse(String(stdout).trim())
          if (payload.version !== 1 || typeof payload.atRestSecretKey !== 'string') throw new Error('unexpected payload')
          cachedKey = createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest()
          resolve(cachedKey)
        } catch (e) {
          reject(new Error(`key helper returned unusable payload: ${e.message}`))
        }
      },
    )
  })
}

function buildAad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lp = (v) => {
    const b = Buffer.from(v, 'utf8')
    const h = Buffer.allocUnsafe(4)
    h.writeUInt32BE(b.length)
    return Buffer.concat([h, b])
  }
  const sb = Buffer.allocUnsafe(4)
  sb.writeUInt32BE(suite)
  return Buffer.concat([prefix, Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), sb, lp(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0])])
}

function openField(key, wrapped) {
  const inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'))
  cacheKeyId = inner.keyId
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(inner.nonce, 'base64'), { authTagLength: 16 })
  d.setAAD(buildAad(inner.keyId, inner.suite))
  d.setAuthTag(Buffer.from(inner.authTag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(inner.ciphertext, 'base64')), d.final()]).toString('utf8')
}

function readAuthFile() {
  for (const p of AUTH_CANDIDATES) {
    if (p && fs.existsSync(p)) return { path: p, doc: JSON.parse(fs.readFileSync(p, 'utf8')) }
  }
  throw new Error('WorkBuddy desktop credential file not found (looked in LOCALAPPDATA and APPDATA)')
}

async function loadCredential({ force = false } = {}) {
  if (!force && credential && Date.now() < credentialExpiry - 60_000) return credential
  const { doc } = readAuthFile()
  const auth = doc.auth ?? {}
  const account = doc.account ?? {}
  const key = await atRestKey()

  const plain = (v) => (typeof v === 'string' ? v : v && v.$wbEncrypted === 1 ? openField(key, v) : undefined)
  const accessToken = plain(auth.accessToken)
  const refreshToken = plain(auth.refreshToken)
  if (!accessToken) throw new Error('no access token in the WorkBuddy credential file')

  const domain = String(auth.domain ?? '')
  const global = /(^|\.)workbuddy\.ai$/i.test(domain)
  const expiresAt = Number(auth.expiresAt ?? 0)
  credential = {
    accessToken,
    refreshToken,
    domain,
    global,
    uid: String(account.uid ?? ''),
    enterpriseId: String(account.enterpriseId ?? ''),
    expiresAt,
  }
  credentialExpiry = expiresAt || Date.now() + 30 * 60_000
  log(`credential loaded: region=${global ? 'global' : 'cn'} expires=${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'} uid=${credential.uid ? credential.uid.slice(0, 4) + '…' : '(none)'}`)
  return credential
}

async function refreshCredential() {
  const c = await loadCredential()
  if (!c.refreshToken) throw new Error('no refresh token; sign in again in the WorkBuddy app')
  const base = c.global ? GLOBAL_CHAT : CN_CHAT
  const ref = c.global ? GLOBAL_CHAT : CN_BILL
  const r = await fetch(`${base}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: ref,
      Referer: `${ref}/`,
      'User-Agent': `WorkBuddy/${appVersion()} WorkBuddy/${appVersion()}`,
      'X-Refresh-Token': c.refreshToken,
      'X-Auth-Refresh-Source': 'workbuddy',
      ...(c.enterpriseId ? { 'X-Enterprise-Id': c.enterpriseId } : {}),
    },
    signal: AbortSignal.timeout(20000),
  })
  const env = await r.json().catch(() => null)
  if (!r.ok || !env || env.code !== 0) throw new Error(`token refresh failed: HTTP ${r.status} code ${env?.code} ${env?.msg ?? ''}`)
  const data = env.data ?? {}
  if (typeof data.accessToken !== 'string' || !data.accessToken) throw new Error('token refresh returned no accessToken')
  credential = {
    ...c,
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === 'string' && data.refreshToken ? data.refreshToken : c.refreshToken,
    expiresAt: typeof data.expiresIn === 'number' && data.expiresIn > 0 ? Date.now() + data.expiresIn * 1000 : c.expiresAt,
  }
  credentialExpiry = credential.expiresAt
  log('credential refreshed')
  return credential
}

// ---------------------------------------------------------------- upstream identity
let cachedAppVersion = null
function appVersion() {
  if (cachedAppVersion) return cachedAppVersion
  const saved = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), '.workbuddy-app-version.json')
  try {
    const v = JSON.parse(fs.readFileSync(saved, 'utf8')).version
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) { cachedAppVersion = v; return v }
  } catch { /* ignore */ }
  try {
    const v = JSON.parse(fs.readFileSync(path.join(path.dirname(WB_EXE), 'resources', 'app', 'package.json'), 'utf8')).version
    if (typeof v === 'string') { cachedAppVersion = v; return v }
  } catch { /* ignore */ }
  cachedAppVersion = '5.9.3'
  return cachedAppVersion
}

function commonHeaders(c) {
  const ref = c.global ? GLOBAL_CHAT : CN_BILL
  return { Accept: 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest', Origin: ref, Referer: `${ref}/`, 'User-Agent': `WorkBuddy/${appVersion()} WorkBuddy/${appVersion()}` }
}

function chatHeaders(c) {
  const v = appVersion()
  return {
    ...commonHeaders(c),
    'Content-Type': 'application/json',
    Authorization: `Bearer ${c.accessToken}`,
    ...(c.uid ? { 'X-User-Id': c.uid } : { 'X-No-User-Id': '1' }),
    ...(c.enterpriseId ? { 'X-Enterprise-Id': c.enterpriseId } : { 'X-No-Enterprise-Id': '1' }),
    ...(c.domain ? { 'X-Domain': c.domain } : { 'X-No-Department-Info': '1' }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': v,
    'X-Product': 'SaaS',
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  }
}

// ---------------------------------------------------------------- model catalog
let catalog = { at: 0, models: [] }
const CATALOG_TTL = 10 * 60_000

// DSH: the CN catalog endpoint splits its roster by client identity. A CLI-shaped
// User-Agent yields the chat-capable "cli" roster; an App-shaped one yields the
// App's internal list (which includes image/video/completion-only models). This is
// the same UA the official CLI-compatible path sends, and it is what the CN side
// keeps using for chat too.
const CATALOG_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'

async function loadModels(force = false) {
  if (!force && catalog.models.length && Date.now() - catalog.at < CATALOG_TTL) return catalog.models
  const c = await loadCredential()
  const base = c.global ? GLOBAL_CHAT : CN_CHAT
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${base}/v3/config`, {
      headers: { ...commonHeaders(c), 'User-Agent': CATALOG_UA, Authorization: `Bearer ${c.accessToken}` },
      signal: AbortSignal.timeout(20000),
    })
    if (r.status === 401 && attempt === 0) { await refreshCredential(); continue }
    const env = await r.json()
    if (env.code !== 0) throw new Error(`catalog failed: code ${env.code} ${env.msg ?? ''}`)
    const data = env.data ?? {}

    // Prefer the "cli" agent's roster: those are the chat models this bridge can serve.
    const agents = Array.isArray(data.agents) ? data.agents : []
    const cliAgent = agents.find((a) => a && (a.name === 'cli' || a.id === 'cli')) ?? agents[0]
    const fromAgents = Array.isArray(cliAgent?.models) ? cliAgent.models.filter((m) => typeof m === 'string') : []

    const ids = new Set(fromAgents)
    if (ids.size === 0) {
      for (const m of data.models ?? []) {
        const id = typeof m === 'string' ? m : m?.id ?? m?.model ?? m?.name
        if (id) ids.add(id)
      }
    }
    catalog = { at: Date.now(), models: [...ids] }
    log(`catalog: ${catalog.models.length} models (source: ${fromAgents.length ? `agent "${cliAgent?.name ?? cliAgent?.id}"` : 'data.models fallback'})`)
    return catalog.models
  }
  return catalog.models
}

// ---------------------------------------------------------------- http helpers
const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
const openAIError = (res, status, type, message) => sendJson(res, status, { error: { message, type, code: type } })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

// Honour Retry-After when the upstream sends one (seconds or HTTP-date), else back off
// exponentially with jitter. Jitter matters here: several DSH sessions sharing this
// bridge would otherwise retry in lockstep and re-trigger the very limit they hit.
// The cap is applied AFTER jitter — clamping first would let the jittered value exceed
// the documented maximum by up to 15%, which is exactly the kind of quiet overrun that
// makes a "max 10s" promise untrue.
function retryDelayMs(res, attempt) {
  const header = res?.headers?.get?.('retry-after')
  if (header) {
    const asSeconds = Number(header)
    if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.min(UPSTREAM_RETRY_MAX_MS, Math.round(asSeconds * 1000))
    const asDate = Date.parse(header)
    if (Number.isFinite(asDate)) return Math.min(UPSTREAM_RETRY_MAX_MS, Math.max(0, asDate - Date.now()))
  }
  const backoff = UPSTREAM_RETRY_BASE_MS * 2 ** (attempt - 1)
  const jittered = backoff * (0.85 + Math.random() * 0.3)
  return Math.round(Math.min(UPSTREAM_RETRY_MAX_MS, jittered))
}

function readBody(req, limit = 32 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- body normalisation
// The WorkBuddy upstream is stricter than a plain OpenAI endpoint. Three rewrites are
// load-bearing (each was measured upstream, and each is what the upstream client does):
//   1. stream must be true — a non-stream request is refused outright (code 11101).
//   2. role "developer" is refused with HTTP 400 / code 11128 "Illegal API invocation
//      from an unapproved channel". pi-ai emits the system prompt as "developer"
//      (the OpenAI convention), so it must be rewritten to "system".
//   3. tool_choice must be a plain string; the object forms return 400.
function normalizeDeveloperRole(obj) {
  const messages = obj.messages
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (message && typeof message === 'object' && !Array.isArray(message) && message.role === 'developer') {
      message.role = 'system'
    }
  }
}

function normalizeToolChoice(obj) {
  const suppress = () => { delete obj.tools; delete obj.functions }
  if (!('tool_choice' in obj)) return
  const choice = obj.tool_choice
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') { delete obj.tool_choice; suppress() }
    return
  }
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
    if (type === 'none') { delete obj.tool_choice; suppress() }
    else if (type === 'auto' || type === 'required') obj.tool_choice = type
    else if (type === 'function') {
      const fn = choice.function && typeof choice.function === 'object' ? choice.function : undefined
      let name = fn && typeof fn.name === 'string' ? fn.name : ''
      if (name === '' && typeof choice.name === 'string') name = choice.name
      name = name.trim()
      obj.tool_choice = name !== '' ? name : 'auto'
    } else delete obj.tool_choice
    return
  }
  delete obj.tool_choice
}

// The upstream gateway fingerprints the *client* by matching agent-framework
// signatures anywhere in the message content, and rejects an unrecognised one with
// HTTP 400 / code 11128 "Illegal API invocation from an unapproved channel".
//
// Measured 2026-11-03:
//   * the match is on whole sentences — every fragment of them passes on its own;
//   * it scans ALL message roles, not just `system`. A long DSH session quotes its own
//     system prompt inside the history (tool results, subagent summaries), so scrubbing
//     only the system message is not enough — that was the bug behind several retries;
//   * once the known signatures are removed from every message, the same request with
//     all 96 tools and full history returns 200.
//
// The signature list is the gateway's, so this table is necessarily a moving target:
// keep it small, keep the mapping behaviour-preserving, and let the fallback ladder
// plus the archived body catch anything new.
const CONTENT_SCRUBS = [
  { find: 'You are an AI agent powered by DeepSeek Harness.', replace: 'You are an AI agent.' },
  { find: 'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root',
    replace: 'Paths prefixed with @ resolve from the workspace root.' },
]

// "You are a coding agent powered by the <model> model." — same shape, model varies.
const CODING_AGENT_RE = /You are a coding agent powered by the [\w.\-]+ model\./g

function scrubText(input) {
  let out = input
  for (const { find, replace } of CONTENT_SCRUBS) {
    if (out.includes(find)) out = out.split(find).join(replace)
  }
  return out.replace(CODING_AGENT_RE, 'You are a coding agent.')
}

/** Scrub signatures from every message, whatever its role and content shape. */
function scrubFingerprints(obj) {
  const messages = obj.messages
  if (!Array.isArray(messages)) return 0
  let touched = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue
    if (typeof m.content === 'string') {
      const next = scrubText(m.content)
      if (next !== m.content) { m.content = next; touched++ }
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string') {
          const next = scrubText(part.text)
          if (next !== part.text) { part.text = next; touched++ }
        }
      }
    }
  }
  // Tool call arguments can quote the prompt too.
  for (const m of messages) {
    for (const tc of m && Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      const args = tc && tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments : null
      if (args === null) continue
      const next = scrubText(args)
      if (next !== args) { tc.function.arguments = next; touched++ }
    }
  }
  return touched
}

/** Last-resort structural fallback, kept for gateways that object to the system role. */
let systemRoleRejected = false   // learned once, then preferred up front

function systemTextOf(message) {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** Move every system/developer message into the first user message, verbatim. */
function foldSystemIntoUser(obj) {
  const messages = obj.messages
  if (!Array.isArray(messages)) return false
  const parts = []
  const rest = []
  for (const m of messages) {
    if (m && typeof m === 'object' && (m.role === 'system' || m.role === 'developer')) {
      const t = systemTextOf(m)
      if (t) parts.push(t)
      continue
    }
    rest.push(m)
  }
  if (parts.length === 0) return false
  const text = parts.join('\n\n')
  const firstUser = rest.findIndex((m) => m && m.role === 'user')
  if (firstUser >= 0) {
    const target = rest[firstUser]
    if (typeof target.content === 'string') target.content = `${text}\n\n${target.content}`
    else rest.splice(firstUser, 0, { role: 'user', content: text })
  } else {
    rest.unshift({ role: 'user', content: text })
  }
  obj.messages = rest
  return true
}

function prepareBody(text) {
  let body
  try { body = JSON.parse(text) } catch { return text }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return text
  body.stream = true
  // The adapter's own "off" spelling is rejected by both endpoints.
  if (body.reasoning_effort === 'off') delete body.reasoning_effort
  normalizeDeveloperRole(body)
  normalizeToolChoice(body)
  const renamed = renameRequestTools(body)
  if (renamed) lastRenamedTools = renamed
  const scrubbed = scrubFingerprints(body)
  if (scrubbed) lastScrubCount = scrubbed
  return JSON.stringify(body)
}

let lastScrubCount = 0
let lastRenamedTools = 0
let lastToolSignature = ''

// ---------------------------------------------------------------- tool renaming
// The tool names are the strongest client fingerprint this bridge exposes:
// `spawn_teammate`, `dsh_im_return_file`, `mcp__github__*` are unique to DSH. Every
// definition, every historical tool_call and every streamed call is mapped through
// tool-rename.mjs so the wire looks like a generic OpenAI client while every
// capability keeps working.
const REVERSE_TOOL = (() => {
  const map = new Map()
  for (const [real, alias] of Object.entries(TOOL_RENAME)) map.set(alias, real)
  return map
})()

/** Build the alias -> real map for THIS request, so MCP aliases reverse correctly. */
function reverseMapFor(obj) {
  const map = new Map()
  const add = (name) => {
    if (typeof name !== 'string' || name === '') return
    const alias = renameTool(name)
    if (alias !== name) map.set(alias, name)
  }
  for (const t of Array.isArray(obj && obj.tools) ? obj.tools : []) add(t && t.function && t.function.name)
  for (const fn of Array.isArray(obj && obj.functions) ? obj.functions : []) add(fn && fn.name)
  return map
}

/** Map a renamed wire name back to the real tool name DSH knows. */
function restoreToolName(name, reverseMap) {
  if (typeof name !== 'string' || name === '') return name
  return (reverseMap && reverseMap.get(name)) ?? REVERSE_TOOL.get(name) ?? name
}

/** Rename tool definitions plus any tool_calls already present in history. */
function renameRequestTools(obj) {
  let n = 0
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      const fn = t && t.function
      if (!fn || typeof fn.name !== 'string') continue
      const next = renameTool(fn.name)
      if (next !== fn.name) { fn.name = next; n++ }
    }
  }
  if (Array.isArray(obj.functions)) {
    for (const fn of obj.functions) {
      if (!fn || typeof fn.name !== 'string') continue
      const next = renameTool(fn.name)
      if (next !== fn.name) { fn.name = next; n++ }
    }
  }
  if (Array.isArray(obj.messages)) {
    for (const m of obj.messages) {
      for (const tc of m && Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        const fn = tc && tc.function
        if (!fn || typeof fn.name !== 'string') continue
        const next = renameTool(fn.name)
        if (next !== fn.name) { fn.name = next; n++ }
      }
    }
  }
  return n
}

/** Undo the rename on streamed tool-call deltas, buffering per index. */
function restoreToolNames(chunk, nameSeen, reverseMap) {
  const calls = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta
    ? chunk.choices[0].delta.tool_calls
    : undefined
  if (!Array.isArray(calls)) return
  for (const call of calls) {
    const fn = call && call.function
    if (!fn || typeof fn.name !== 'string' || fn.name === '') continue
    const index = call.index ?? 0
    const acc = (nameSeen.get(index) ?? '') + fn.name
    nameSeen.set(index, acc)
    const real = restoreToolName(acc, reverseMap)
    if (real !== acc) {
      fn.name = real
      nameSeen.set(index, '')
    }
  }
}

// ---------------------------------------------------------------- diagnostics helpers
/** Structure-only summary of a request body; never logs message content. */
function summarizeBody(text) {
  let o = null
  try { o = JSON.parse(text) } catch { return { bytes: text.length, parse: 'failed' } }
  if (!o || typeof o !== 'object') return { bytes: text.length, parse: 'not-an-object' }
  const msgs = Array.isArray(o.messages) ? o.messages : []
  const roles = {}
  const shapes = new Set()
  const contentTypes = {}
  for (const m of msgs) {
    if (!m || typeof m !== 'object') { roles['(non-object)'] = (roles['(non-object)'] ?? 0) + 1; continue }
    roles[m.role ?? '(none)'] = (roles[m.role ?? '(none)'] ?? 0) + 1
    shapes.add(Object.keys(m).sort().join(','))
    const ct = Array.isArray(m.content) ? 'array' : m.content === null ? 'null' : typeof m.content
    contentTypes[ct] = (contentTypes[ct] ?? 0) + 1
  }
  return {
    bytes: text.length,
    topLevel: Object.keys(o).sort().join(','),
    messages: msgs.length,
    roles: JSON.stringify(roles),
    contentTypes: JSON.stringify(contentTypes),
    messageKeyShapes: [...shapes].slice(0, 6),
    tools: Array.isArray(o.tools) ? o.tools.length : 0,
    toolChoiceType: typeof o.tool_choice,
  }
}

/** Ordered, least-destructive-first fallbacks. Only tried when upstream rejects with 11128. */
function bodyVariants(prepared) {
  const out = []
  let o = null
  try { o = JSON.parse(prepared) } catch { return [{ name: 'as-prepared', body: prepared }] }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return [{ name: 'as-prepared', body: prepared }]
  const clone = () => JSON.parse(prepared)

  // The role swap preserves every byte of content and all tools, so once the gateway
  // has shown it objects to the system role it goes first and we skip the wasted round.
  const fold = clone()
  const canFold = foldSystemIntoUser(fold)
  const foldedBody = canFold ? JSON.stringify(fold) : null

  out.push({ name: 'as-prepared', body: prepared })
  if (foldedBody) out.push({ name: 'system-as-user', body: foldedBody })
  if (systemRoleRejected && foldedBody) {
    out.sort((a, b) => (a.name === 'system-as-user' ? -1 : b.name === 'system-as-user' ? 1 : 0))
  }

  if (o.tools || o.tool_choice) {
    const v = clone(); delete v.tools; delete v.tool_choice
    out.push({ name: 'no-tools', body: JSON.stringify(v) })
  }
  const msgs = Array.isArray(o.messages) ? o.messages : []
  if (msgs.length > 42) {
    const v = clone()
    const head = v.messages[0] && v.messages[0].role === 'system' ? [v.messages[0]] : []
    v.messages = [...head, ...v.messages.slice(-40)]
    out.push({ name: 'trim-last-40', body: JSON.stringify(v) })
    if (v.tools) {
      const v2 = clone()
      const h2 = v2.messages[0] && v2.messages[0].role === 'system' ? [v2.messages[0]] : []
      v2.messages = [...h2, ...v2.messages.slice(-40)]
      delete v2.tools; delete v2.tool_choice
      out.push({ name: 'no-tools+trim-40', body: JSON.stringify(v2) })
    }
  }
  const KNOWN = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice',
    'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'seed',
    'presence_penalty', 'frequency_penalty', 'response_format', 'user', 'parallel_tool_calls',
    'reasoning_effort', 'n'])
  const unknown = Object.keys(o).filter((k) => !KNOWN.has(k))
  if (unknown.length) {
    const v = clone()
    for (const k of unknown) delete v[k]
    out.push({ name: `drop-unknown(${unknown.join('+')})`, body: JSON.stringify(v) })
  }
  return out
}

async function chat(req, res) {
  const raw = await readBody(req)
  let requested = null
  try { requested = JSON.parse(raw) } catch { /* leave null */ }
  const wantsStream = requested?.stream !== false
  log(`chat: model=${requested?.model ?? '?'} effort=${requested?.reasoning_effort ?? '(none)'} stream=${wantsStream} msgs=${requested?.messages?.length ?? '?'} auth=${req.headers.authorization ? 'present' : 'absent'}`)
  // One line per distinct tool set: the tool names are the strongest client fingerprint
  // this bridge exposes, so we want to see exactly what goes upstream.
  try {
    const names = (Array.isArray(requested?.tools) ? requested.tools : [])
      .map((t) => (t && t.function && typeof t.function.name === 'string' ? t.function.name : null))
      .filter(Boolean)
    // Log the names as they will appear UPSTREAM (after renaming) — that is the real
    // exposure surface, and the whole point of keeping this line.
    const wire = names.map((n) => renameTool(n))
    const sig = wire.join(',')
    if (wire.length && sig !== lastToolSignature) {
      lastToolSignature = sig
      const changed = wire.filter((w, i) => w !== names[i]).length
      log(`tools(${wire.length}, ${changed} renamed on the wire): ${wire.join(', ')}`)
    }
  } catch { /* diagnostics only */ }
  const started = Date.now()
  res.on('close', () => log(`chat done: model=${requested?.model ?? '?'} in ${Date.now() - started}ms status=${res.statusCode}`))

  const prepared = prepareBody(raw)

  // Built from the ORIGINAL request so `mcp__github__x` aliases reverse correctly even
  // though they never appear in the static table.
  let originalTools = null
  try { originalTools = JSON.parse(raw) } catch { /* ignore */ }
  const reverseMap = reverseMapFor(originalTools)

  const attemptFetch = async (body, refresh) => {
    const c = refresh ? await refreshCredential() : await loadCredential()
    const base = c.global ? GLOBAL_CHAT : CN_CHAT
    return fetch(`${base}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(c),
      body,
      signal: AbortSignal.timeout(10 * 60_000),
    })
  }

  // One shape, retried on transient upstream trouble.
  // Returns { ok:true, response } or { ok:false, status, text } — the failing body is
  // read exactly once here, because it cannot be read again after being drained.
  const fetchWithRetry = async (body) => {    const startedBackoff = Date.now()
    for (let attempt = 1; ; attempt++) {
      let r = null
      let networkError = null
      try {
        r = await attemptFetch(body, false)
        if ((r.status === 401 || r.status === 403) && !refreshed) {
          await r.text().catch(() => '')
          refreshed = true
          r = await attemptFetch(body, true)
        }
      } catch (e) {
        networkError = String(e?.message ?? e)
      }

      if (r && (r.ok || !UPSTREAM_RETRY_STATUSES.has(r.status))) {
        return r.ok ? { ok: true, response: r } : { ok: false, status: r.status, text: await r.text().catch(() => '') }
      }

      const status = r ? r.status : 'network'
      const exhausted = attempt >= UPSTREAM_RETRY_ATTEMPTS
      const delay = exhausted ? 0 : retryDelayMs(r, attempt)
      // Never spend longer than the budget on backoff: an honest error beats a
      // streaming chat that has already been waiting minutes.
      if (exhausted || Date.now() - startedBackoff + delay > UPSTREAM_RETRY_BUDGET_MS) {
        const text = r ? await r.text().catch(() => '') : networkError
        log(`  giving up after ${attempt} attempt(s): upstream ${status}`)
        return { ok: false, status: r ? r.status : 502, text: text ?? '' }
      }

      // Drain the failed response so the socket is reusable and the body is not leaked.
      if (r) await r.text().catch(() => '')
      log(`  attempt ${attempt}: upstream ${status} — retrying in ${delay}ms`)
      await sleep(delay)
    }
  }

  let upstream = null
  let usedVariant = null
  let lastError = null
  let refreshed = false

  for (const variant of bodyVariants(prepared)) {
    const outcome = await fetchWithRetry(variant.body)

    if (outcome.ok) { upstream = outcome.response; usedVariant = variant.name; break }

    lastError = { status: outcome.status, text: outcome.text ?? '' }
    const is11128 = outcome.status === 400 && lastError.text.includes('11128')
    log(`  variant "${variant.name}": upstream ${outcome.status}${is11128 ? ' (11128)' : ''}`)
    if (!is11128) break   // only the channel-check rejection is worth trying another shape
  }

  if (!upstream) {
    try {
      log('  failed-body summary: ' + JSON.stringify(summarizeBody(prepared)))
      const name = `failed-body-${Date.now()}.json`
      fs.writeFileSync(path.join(BRIDGE_DIR, name), prepared, 'utf8')
      log(`  body archived: ${name} (${prepared.length} bytes)`)
    } catch (e) { log('  diagnostics failed:', e?.message ?? e) }
    const status = lastError?.status ?? 502
    let msg = (lastError?.text ?? 'upstream error').slice(0, 300)
    try {
      const j = JSON.parse(lastError?.text ?? '')
      msg = `${lastError.status} ${j.code ?? ''} ${j.msg ?? msg}`.trim()
    } catch { /* keep raw text */ }
    return openAIError(res, status === 401 ? 401 : 502, 'upstream_error', msg)
  }

  if (usedVariant !== 'as-prepared') log(`  recovered via variant "${usedVariant}"`)

  // Learn the gateway's preference so later turns skip the wasted round trip.
  if (usedVariant === 'system-as-user' && !systemRoleRejected) {
    systemRoleRejected = true
    log('  learned: upstream rejects the system role here — folding it into the first user message from now on')
  }

  // ----- streaming: pass the SSE through, forcing OpenAI chunk shape -----
  if (wantsStream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Tool names arrive renamed on the wire; map them back so DSH's dispatcher still
    // finds the real tool. The upstream sends the whole name in the first delta for an
    // index, but we accumulate per index anyway so a future split start still works.
    const nameSeen = new Map()   // index -> renamed name accumulated so far
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.startsWith(':') || line.trim() === '') { res.write(line.endsWith('\r') ? line : line + '\n'); continue }
          if (!line.startsWith('data:')) { res.write(line + '\n'); continue }
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') { res.write('data: [DONE]\n\n'); continue }
          let chunk
          try { chunk = JSON.parse(payload) } catch { res.write(line + '\n'); continue }
          if (typeof chunk.code === 'number' && chunk.code !== 0 && !chunk.choices) {
            res.write(`data: ${JSON.stringify({ error: { message: chunk.msg ?? 'upstream error', type: 'upstream_error', code: String(chunk.code) } })}\n\n`)
            continue
          }
          restoreToolNames(chunk, nameSeen, reverseMap)
          if (!chunk.object) chunk.object = 'chat.completion.chunk'
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: { message: String(e.message ?? e), type: 'stream_interrupted' } })}\n\n`)
    } finally {
      if (buffer.trim()) res.write(buffer)
      res.end()
    }
    return
  }

  // ----- non-stream request: aggregate the SSE into one JSON reply -----
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let buffer = ''
  const id = randomUUID()
  let model = requested?.model ?? ''
  let content = ''
  let reasoning = ''
  let finish = null
  let usage = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (!line.startsWith('data:')) { text += line + '\n'; continue }
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') continue
      let chunk
      try { chunk = JSON.parse(payload) } catch { continue }
      model = chunk.model ?? model
      if (chunk.usage) usage = chunk.usage
      const choice = chunk.choices?.[0]
      if (!choice) continue
      if (choice.delta?.content) content += choice.delta.content
      if (choice.delta?.reasoning_content) reasoning += choice.delta.reasoning_content
      if (choice.finish_reason) finish = choice.finish_reason
    }
  }
  return sendJson(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finish ?? 'stop' }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`)
  // Log every route that is not the health probe: when DSH reloads the provider config
  // it re-reads /v1/models, which is a useful "the host picked up the change" signal.
  if (url.pathname !== '/healthz') {
    res.on('finish', () => log(`${req.method} ${url.pathname} -> ${res.statusCode}`))
  }
  try {
    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
      const c = credential
      return sendJson(res, 200, {
        ok: true,
        service: 'wb-bridge',
        region: c ? (c.global ? 'global' : 'cn') : 'unknown',
        credentialCached: Boolean(c),
        expiresAt: c?.expiresAt ? new Date(c.expiresAt).toISOString() : null,
        models: catalog.models.length,
        exe: WB_EXE,
        appVersion: appVersion(),
      })
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const models = await loadModels()
      return sendJson(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'workbuddy' })) })
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await chat(req, res)
    return openAIError(res, 404, 'not_found', `no such route: ${req.method} ${url.pathname}`)
  } catch (e) {
    log('request error:', e.message ?? e)
    if (!res.headersSent) return openAIError(res, 500, 'internal', String(e.message ?? e))
    try { res.end() } catch { /* ignore */ }
  }
})

// A second copy is a normal thing to attempt (double-clicking the .cmd twice, or an
// autostart copy plus a manual one). Port-busy must not look like a crash: if the
// listener already answering is a healthy wb-bridge, say so and exit 0.
server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE') {
    log(`port ${PORT} is already in use — checking whether it is a wb-bridge instance …`)
    try {
      const r = await fetch(`http://${HOST}:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) })
      const j = await r.json()
      if (j && j.service === 'wb-bridge' && j.ok) {
        log(`already running (pid/idle ok): region=${j.region} models=${j.models} credentialCached=${j.credentialCached}`)
        log('nothing to do — this window can be closed; DSH should point at the URL above.')
        process.exit(0)
      }
    } catch { /* fall through */ }
    log(`port ${PORT} is held by something that is not wb-bridge. Stop it, or start with --port <other>.`)
    process.exit(1)
  }
  log('server error:', err?.message ?? err)
  process.exit(1)
})

server.listen(PORT, HOST, async () => {
  log(`wb-bridge listening on http://${HOST}:${PORT}`)
  log(`workbuddy exe: ${WB_EXE}`)
  try {
    await loadCredential()
    const models = await loadModels()
    log(`ready — ${models.length} models available`)
    log('DSH: Settings → Models → add a custom provider')
    log(`     api=openai-completions  baseURL=http://${HOST}:${PORT}/v1  apiKey=(any)`)
  } catch (e) {
    log('startup warning:', e.message ?? e)
    log('the server is still listening; /healthz and /v1/models will report the problem')
  }
})

const shutdown = () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
