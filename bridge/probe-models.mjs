/**
 * Dump the upstream /v3/config model metadata verbatim.
 *
 * Why this exists: `/v1/models` on the bridge only returns ids, which is enough to
 * notice a change but not enough to know what a model IS (window, output cap, image
 * support, credit multiplier, thinking levels). Those live in /v3/config, which needs the
 * decrypted WorkBuddy credential.
 *
 * This duplicates the credential logic from wb-bridge.mjs deliberately: importing that
 * module would start a second server. Keep the two in sync if the AAD scheme changes.
 *
 *   node probe-models.mjs                 # table of every model
 *   node probe-models.mjs hy4free hy4std  # detail for specific ids
 *   node probe-models.mjs --json          # raw JSON
 */
import { execFile } from 'node:child_process'
import { createHash, createDecipheriv } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const CN_CHAT = 'https://copilot.tencent.com'
const CN_BILL = 'https://www.codebuddy.cn'
const GLOBAL_CHAT = 'https://www.workbuddy.ai'
const CATALOG_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'

const AUTH_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  path.join(process.env.APPDATA ?? '', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
]

function findWorkBuddyExe() {
  for (const c of [
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    'F:\\workbuddy\\WorkBuddy.exe',
  ]) if (c && fs.existsSync(c)) return c
  return 'WorkBuddy.exe'
}
const WB_EXE = process.env.WORKBUDDY_ELECTRON_BIN ?? findWorkBuddyExe()

function atRestKey() {
  return new Promise((resolve, reject) => {
    execFile(
      WB_EXE,
      ['-e', HELPER_SCRIPT],
      { timeout: 90000, maxBuffer: 4 << 20, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`key helper failed: ${err.message}${stderr ? ' / ' + String(stderr).slice(0, 200) : ''}`))
        try {
          const p = JSON.parse(String(stdout).trim())
          if (p.version !== 1 || typeof p.atRestSecretKey !== 'string') throw new Error('unexpected payload')
          resolve(createHash('sha256').update(p.atRestSecretKey, 'utf8').digest())
        } catch (e) { reject(new Error(`key helper payload unusable: ${e.message}`)) }
      },
    )
  })
}

function buildAad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii')
  const lp = (v) => { const b = Buffer.from(v, 'utf8'); const h = Buffer.allocUnsafe(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]) }
  const sb = Buffer.allocUnsafe(4); sb.writeUInt32BE(suite)
  return Buffer.concat([prefix, Buffer.from([1]), lp('WBEV1'), lp('sym-v1'), sb, lp(keyId), Buffer.from([2]), Buffer.from([0]), Buffer.from([0])])
}

function openField(key, wrapped) {
  const inner = JSON.parse(Buffer.from(wrapped.envelope, 'base64').toString('utf8'))
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(inner.nonce, 'base64'), { authTagLength: 16 })
  d.setAAD(buildAad(inner.keyId, inner.suite))
  d.setAuthTag(Buffer.from(inner.authTag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(inner.ciphertext, 'base64')), d.final()]).toString('utf8')
}

async function loadCredential() {
  let doc
  for (const p of AUTH_CANDIDATES) if (p && fs.existsSync(p)) { doc = JSON.parse(fs.readFileSync(p, 'utf8')); break }
  if (!doc) throw new Error('WorkBuddy credential file not found')
  const auth = doc.auth ?? {}
  const account = doc.account ?? {}
  const key = await atRestKey()
  const plain = (v) => (typeof v === 'string' ? v : v && v.$wbEncrypted === 1 ? openField(key, v) : undefined)
  const accessToken = plain(auth.accessToken)
  if (!accessToken) throw new Error('no access token')
  const domain = String(auth.domain ?? '')
  const global = /(^|\.)workbuddy\.ai$/i.test(domain)
  return {
    accessToken, domain, global,
    uid: String(account.uid ?? ''),
    enterpriseId: String(account.enterpriseId ?? ''),
  }
}

function appVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(path.dirname(WB_EXE), 'resources', 'app', 'package.json'), 'utf8')).version
    if (typeof v === 'string') return v
  } catch {}
  return '5.9.3'
}

function commonHeaders(c, ua) {
  const ref = c.global ? GLOBAL_CHAT : CN_BILL
  const v = appVersion()
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: ref, Referer: `${ref}/`,
    'User-Agent': ua ?? `WorkBuddy/${v} WorkBuddy/${v}`,
    ...(ua ? { Authorization: `Bearer ${c.accessToken}` } : {}),
  }
}

// ---------------------------------------------------------------- main
const c = await loadCredential()
const base = c.global ? GLOBAL_CHAT : CN_CHAT

// Fetch both identities: the CLI-shaped UA is what the bridge uses, the App-shaped one
// is what the WorkBuddy desktop client itself sees. Comparing them explains why the
// desktop UI shows a different roster.
const results = {}
for (const [label, ua] of [['cli', CATALOG_UA], ['app', `WorkBuddy/${appVersion()} WorkBuddy/${appVersion()}`]]) {
  const r = await fetch(`${base}/v3/config`, {
    headers: { ...commonHeaders(c, ua), Authorization: `Bearer ${c.accessToken}` },
    signal: AbortSignal.timeout(30000),
  })
  const env = await r.json()
  if (env.code !== 0) { console.error(`${label}: code ${env.code} ${env.msg ?? ''}`); continue }
  const data = env.data ?? {}
  const agents = Array.isArray(data.agents) ? data.agents : []
  results[label] = { data, agents }
  const cliAgent = agents.find((a) => a && (a.name === 'cli' || a.id === 'cli')) ?? agents[0]
  const fromAgents = Array.isArray(cliAgent?.models) ? cliAgent.models : []
  console.error(`${label}: agents=${agents.map((a) => a?.name ?? a?.id).join(',')}  cliModels=${fromAgents.length}  data.models=${(data.models ?? []).length}`)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2))
  process.exit(0)
}

// Find every model object anywhere in the payload, de-duplicated by id.
function collectModels(node, out = new Map(), depth = 0) {
  if (!node || depth > 6) return out
  if (Array.isArray(node)) { for (const v of node) collectModels(v, out, depth + 1); return out }
  if (typeof node !== 'object') return out
  const id = node.id ?? node.model
  if (typeof id === 'string' && (node.maxInputTokens != null || node.maxOutputTokens != null || node.name)) {
    if (!out.has(id)) out.set(id, node)
  }
  for (const v of Object.values(node)) collectModels(v, out, depth + 1)
  return out
}

const want = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const all = new Map()
for (const [label, { data }] of Object.entries(results)) {
  for (const [id, m] of collectModels(data)) {
    if (!all.has(id)) all.set(id, { ...m, _source: label })
  }
}

const rows = [...all.entries()].filter(([id]) => !want.length || want.some((w) => id.toLowerCase().includes(w.toLowerCase())))

if (!rows.length) {
  console.error('no model metadata found; try --json to inspect the payload shape')
  process.exit(1)
}

const pad = (s, n) => String(s ?? '').padEnd(n)
console.log('')
console.log(pad('id', 26) + pad('name', 22) + pad('in', 10) + pad('out', 8) + pad('img', 5) + pad('tools', 6) + 'credits')
console.log('-'.repeat(95))
for (const [id, m] of rows.sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(
    pad(id, 26) + pad(m.name ?? m.displayName ?? '', 22) +
    pad(m.maxInputTokens ?? m.maxAllowedSize ?? '?', 10) + pad(m.maxOutputTokens ?? '?', 8) +
    pad(m.supportsImages ? 'yes' : 'no', 5) + pad(m.supportsToolCall ? 'yes' : 'no', 6) +
    (m.credits ?? m.credit ?? ''),
  )
}
