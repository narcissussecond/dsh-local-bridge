/**
 * Refresh the DSH provider's model list from the live WorkBuddy catalog.
 *
 * The bridge only *serves* whatever upstream offers; it never edits DSH's config. That
 * leaves a gap: upstream adds/renames a model, the bridge knows within its 10-minute
 * catalog TTL, and DSH keeps showing yesterday's list until a human edits YAML. This
 * closes that gap.
 *
 * What it does:
 *   1. read the live catalog through the bridge (/v1/models)
 *   2. read the metadata the bridge cannot expose (window, output cap, image support,
 *      thinking levels) from upstream /v3/config via probe-models.mjs
 *   3. compare against `models[]` in the DSH profile patch
 *   4. print a diff, and with --apply rewrite just that block
 *
 * Safety rails, because this edits the file DSH boots from:
 *   - a timestamped backup is written first
 *   - the result is parsed with the same YAML library DSH uses
 *   - the entry count must still match (no silent truncation)
 *   - models DSH already had are preserved even if upstream dropped them, unless you
 *     pass --prune (an alias can disappear from the list but still answer)
 *   - default: dry run. Nothing is written without --apply.
 *
 *   node refresh-models.mjs                 # show the diff
 *   node refresh-models.mjs --apply         # write it
 *   node refresh-models.mjs --prune --apply # also drop models upstream no longer lists
 *   node refresh-models.mjs --profile C:/.../cordis.patch.yml
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BRIDGE_DIR, profileConfigPath, nodeBinary } from './config.mjs'

const execFileAsync = promisify(execFile)

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const APPLY = args.includes('--apply')
const PRUNE = args.includes('--prune')
// Recompute existing entries from upstream metadata instead of carrying them verbatim.
// Off by default on purpose — see the note where the new entry list is built.
const RESTYLE = args.includes('--restyle')
const PORT = Number(argOf('--port', process.env.WB_BRIDGE_PORT ?? '8791'))
const PROFILE = argOf('--profile', null) ?? profileConfigPath(args)

const log = (...a) => console.log(...a)

// ---------------------------------------------------------------- upstream catalog
async function liveCatalog() {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`bridge /v1/models returned HTTP ${r.status}`)
  const j = await r.json()
  const ids = (j.data ?? []).map((m) => m.id).filter(Boolean)
  if (!ids.length) throw new Error('bridge returned an empty model catalog')
  return ids
}

/** Full metadata for every id, via probe-models.mjs (it owns the credential logic). */
async function upstreamMeta() {
  const probe = path.join(BRIDGE_DIR, 'probe-models.mjs')
  if (!fs.existsSync(probe)) return new Map()
  try {
    const { stdout } = await execFileAsync(nodeBinary(), [probe, '--json'], {
      maxBuffer: 128 << 20,
      windowsHide: true,
      timeout: 120_000,
    })
    const raw = JSON.parse(stdout)
    const out = new Map()
    const walk = (node, depth = 0) => {
      if (!node || depth > 8) return
      if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return }
      if (typeof node !== 'object') return
      const id = node.id ?? node.model
      // Only objects that actually describe a model, not arbitrary payload fragments.
      if (typeof id === 'string' && (node.maxInputTokens != null || node.maxOutputTokens != null) && !out.has(id)) {
        out.set(id, node)
      }
      for (const v of Object.values(node)) walk(v, depth + 1)
    }
    for (const key of Object.keys(raw)) walk(raw[key]?.data)
    return out
  } catch (e) {
    log(`  ! could not read upstream metadata (${e?.message ?? e}); falling back to catalog ids + existing values`)
    return new Map()
  }
}

// ---------------------------------------------------------------- DSH profile
function readProfile(file) {
  if (!fs.existsSync(file)) throw new Error(`profile not found: ${file}`)
  return fs.readFileSync(file, 'utf8')
}

/** Find the `models:` block under local-gateway and return its line range and entries. */
function locateModelsBlock(text) {
  const lines = text.split(/\r?\n/)
  const indentOf = (l) => l.length - l.trimStart().length

  // Walk up from each `models:` looking for the owning provider key. The distance can be
  // large (comments, headers, auth placeholder sit between), so bound by indentation
  // rather than by a fixed number of lines.
  const candidates = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)models:\s*$/.exec(lines[i])
    if (!m) continue
    const modelsIndent = m[1].length
    let owner = null
    for (let j = i - 1; j >= 0; j--) {
      const l = lines[j]
      if (!l.trim() || l.trim().startsWith('#')) continue
      const ind = indentOf(l)
      if (ind < modelsIndent) {
        const key = /^\s*([A-Za-z0-9_.\-]+):/.exec(l)
        owner = key ? key[1] : null
        if (owner === 'local-gateway') { candidates.push({ i, modelsIndent }); break }
        // Hit a provider that is not ours; keep looking at a shallower level.
        if (owner) break
      }
    }
  }

  if (!candidates.length) throw new Error('could not find `models:` under local-gateway in the profile')
  const { i: modelsLine, modelsIndent: baseIndent } = candidates[0]

  let end = modelsLine + 1
  for (let i = modelsLine + 1; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim()) { end = i + 1; continue }
    if (indentOf(l) <= baseIndent) break  // next sibling key ends the block
    end = i + 1
  }
  return { lines, modelsLine, baseIndent, end }
}

/** Parse the current entries from the block's raw lines (id + the fields we rewrite). */
function parseEntries(lines) {
  const entries = []
  let cur = null
  let curKey = null       // the key whose nested mapping we are inside, if any
  let curKeyIndent = -1
  for (const l of lines) {
    const indent = l.length - l.trimStart().length
    const idM = /^\s*-\s+id:\s*(.+?)\s*$/.exec(l)
    if (idM) {
      cur = { id: idM[1].replace(/^["']|["']$/g, '') }
      entries.push(cur)
      curKey = null
      continue
    }
    if (!cur) continue

    // A nested mapping (e.g. `reasoningEfforts:` followed by indented `low: low`) must be
    // captured, otherwise the rewrite silently drops the model's thinking levels.
    const kv = /^(\s+)([A-Za-z][\w]*):\s*(.*)$/.exec(l)
    if (!kv) continue
    const [, ws, k, v] = kv
    const keyIndent = ws.length

    if (curKey && keyIndent > curKeyIndent) {
      if (!cur[curKey] || typeof cur[curKey] !== 'object') cur[curKey] = {}
      if (v !== '') cur[curKey][k] = v === 'null' ? null : v.replace(/^["']|["']$/g, '')
      continue
    }

    curKey = null
    if (v === '') { curKey = k; curKeyIndent = keyIndent; if ('id' !== k) cur[k] = {}; continue }
    if (v.startsWith('[')) cur[k] = v.replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    else cur[k] = v.replace(/^["']|["']$/g, '')
  }
  // Drop the empty placeholder objects created for scalar-only keys.
  for (const e of entries) {
    for (const [k, v] of Object.entries(e)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) delete e[k]
    }
  }
  return entries
}

/** Build the YAML text for one model entry. Indentation matches DSH's own style. */
function renderEntry(m, indent) {
  const pad = ' '.repeat(indent)
  const p2 = ' '.repeat(indent + 2)
  const out = []
  out.push(`${pad}- id: ${m.id}`)
  out.push(`${p2}name: ${JSON.stringify(m.name)}`)
  out.push(`${p2}contextWindow: ${m.contextWindow}`)
  out.push(`${p2}maxTokens: ${m.maxTokens}`)
  out.push(`${p2}input: [ ${m.input.join(', ')} ]`)
  if (m.reasoningEfforts && Object.keys(m.reasoningEfforts).length) {
    out.push(`${p2}reasoningEfforts:`)
    for (const [k, v] of Object.entries(m.reasoningEfforts)) {
      out.push(`${' '.repeat(indent + 4)}${k}: ${v === null ? 'null' : v}`)
    }
  }
  return out.join('\n')
}

/**
 * WorkBuddy effort names -> pi-ai effort keys.
 *
 * Two upstream shapes exist:
 *   newer: reasoning.supportedEfforts = ['low','high','max']  (explicit list)
 *   older: reasoning.effort = 'medium'                        (a single default only)
 *
 * For the older shape we do NOT invent a full ladder — but we must not return null
 * either, or the model silently loses its thinking-level control in the picker. We emit
 * the single supported level, which is the honest answer: one choice.
 */
const EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
function effortsFrom(meta) {
  const r = meta?.reasoning
  if (!r) return null

  const ordered = {}
  const list = Array.isArray(r.supportedEfforts) ? r.supportedEfforts : null
  if (list && list.length) {
    for (const e of list) if (EFFORT_ORDER.includes(e)) ordered[e] = e
  } else if (typeof r.effort === 'string' && EFFORT_ORDER.includes(r.effort)) {
    // Single known level. `defaultEffort` wins if upstream also sent it.
    const single = EFFORT_ORDER.includes(r.defaultEffort) ? r.defaultEffort : r.effort
    ordered[single] = single
  }

  if (r.canDisableThinking) ordered.off = null
  if (!Object.keys(ordered).length) return null

  // Deterministic order keeps diffs small across runs.
  const out = {}
  for (const k of EFFORT_ORDER) if (k in ordered) out[k] = ordered[k]
  return out
}

function toEntry(id, meta, existing) {
  const contextWindow = meta?.maxInputTokens ?? meta?.maxAllowedSize ?? existing?.contextWindow ?? 262144
  const maxTokens = meta?.maxOutputTokens ?? existing?.maxTokens ?? 8192
  const supportsImage = meta?.supportsImages ?? (existing?.input ?? []).includes('image')
  const efforts = effortsFrom(meta) ?? existing?.reasoningEfforts ?? null
  const name = meta?.name ?? existing?.name ?? id
  return {
    id,
    name: String(name),
    contextWindow: Number(contextWindow),
    maxTokens: Number(maxTokens),
    input: supportsImage ? ['text', 'image'] : ['text'],
    reasoningEfforts: efforts,
  }
}

// ---------------------------------------------------------------- main
const catalog = await liveCatalog()
log(`bridge catalog: ${catalog.length} models`)

const meta = await upstreamMeta()
if (meta.size) log(`upstream metadata: ${meta.size} model descriptors`)

const file = PROFILE
const original = readProfile(file)
const { lines, modelsLine, baseIndent, end } = locateModelsBlock(original)
const blockLines = lines.slice(modelsLine + 1, end)
const existing = parseEntries(blockLines)
log(`DSH profile: ${path.relative(process.cwd(), file) || file} — ${existing.length} models declared`)

const existingById = new Map(existing.map((e) => [e.id, e]))
const catalogSet = new Set(catalog)

const added = catalog.filter((id) => !existingById.has(id))
const missing = existing.map((e) => e.id).filter((id) => !catalogSet.has(id))
const kept = catalog.filter((id) => existingById.has(id))

log('')
if (added.length) log(`+ upstream offers, DSH lacks (${added.length}): ${added.join(', ')}`)
if (missing.length) log(`- DSH declares, upstream no longer lists (${missing.length}): ${missing.join(', ')}${PRUNE ? '  -> will be REMOVED' : '  -> kept (use --prune to remove)'}`)
if (!added.length && !missing.length) log('no differences — DSH is already in sync')

// A model whose window changed is worth knowing about even if the id did not change.
const changed = []
for (const id of kept) {
  const e = existingById.get(id)
  const m = meta.get(id)
  if (!m) continue
  if (m.maxInputTokens != null && Number(e.contextWindow) !== Number(m.maxInputTokens)) {
    changed.push(`${id}: contextWindow ${e.contextWindow} -> ${m.maxInputTokens}`)
  }
  if (m.maxOutputTokens != null && Number(e.maxTokens) !== Number(m.maxOutputTokens)) {
    changed.push(`${id}: maxTokens ${e.maxTokens} -> ${m.maxOutputTokens}`)
  }
}
if (changed.length) { log(''); log(`~ values changed upstream (${changed.length}):`); changed.forEach((c) => log(`    ${c}`)) }

if (!added.length && !missing.length && !changed.length) {
  log('')
  log('nothing to do.')
  process.exit(0)
}

// `changed` only matters under --restyle: without it existing entries are carried over
// verbatim, so reporting a value difference would promise an edit we are not going to
// make — and then "write" an identical file on every run.
if (!added.length && !missing.length && !RESTYLE) {
  log('')
  log('nothing to do (value differences are informational; pass --restyle to apply them).')
  process.exit(0)
}

// ---- build the new entry list, preserving DSH's existing order -----------------------
//
// Deliberate policy: an entry DSH already has is carried over VERBATIM. The operator (or
// an earlier refresh) may have tuned contextWindow/maxTokens/reasoningEfforts by hand,
// and the upstream metadata is often poorer — several older models report only a single
// `reasoning.effort` with no supportedEfforts list, so "refreshing" them would silently
// downgrade a three-level thinking picker to a one-level one. Metadata drives NEW
// entries; --restyle opts into recomputing existing ones.
const newEntries = []
for (const e of existing) {
  if (missing.includes(e.id) && PRUNE) continue
  const m = meta.get(e.id) ?? null
  newEntries.push(RESTYLE ? toEntry(e.id, m, e) : e)
}
for (const id of added) newEntries.push(toEntry(id, meta.get(id) ?? null, null))

log('')
log(`result: ${newEntries.length} models (was ${existing.length})`)

if (!APPLY) {
  log('')
  log('dry run — nothing written. Re-run with --apply to write.')
  if (added.length) {
    log('')
    log('entries that would be added:')
    for (const id of added) console.log(renderEntry(toEntry(id, meta.get(id) ?? null, null), baseIndent + 2).split('\n').map((l) => '  ' + l).join('\n'))
  }
  process.exit(0)
}

// ---- write ---------------------------------------------------------------------------
const indent = (blockLines.find((l) => l.trim()) ?? '').length - (blockLines.find((l) => l.trim()) ?? '').trimStart().length
const newBlock = newEntries.map((m) => renderEntry(m, indent)).join('\n')
const newLines = [...lines.slice(0, modelsLine + 1), ...newBlock.split('\n'), ...lines.slice(end)]
const updated = newLines.join('\n')

// Verify before touching the file: same YAML library DSH uses, same entry count.
const yamlPath = path.join(BRIDGE_DIR, '_yamlpkg', 'dist', 'index.js')
const before = { entries: null, models: null }
try {
  const yamlMod = await import(`file://${yamlPath.replace(/\\/g, '/')}`)
  const parse = yamlMod.parse ?? yamlMod.default?.parse
  if (typeof parse === 'function') {
    const parsedBefore = parse(original)
    const parsedAfter = parse(updated)
    before.entries = parsedBefore.length
    const afterEntries = parsedAfter.length
    if (afterEntries !== before.entries) throw new Error(`entry count changed: ${before.entries} -> ${afterEntries}`)
    const providerAfter = parsedAfter.find((e) => e && e.id === 'llm-pi-ai')
    const modelsAfter = providerAfter?.config?.providers?.['local-gateway']?.models
    if (!Array.isArray(modelsAfter) || modelsAfter.length !== newEntries.length) {
      throw new Error(`models[] after parse has ${modelsAfter?.length} entries, expected ${newEntries.length}`)
    }
    if (!modelsAfter.every((m) => m.id && m.contextWindow && m.maxTokens && Array.isArray(m.input))) {
      throw new Error('a rewritten model entry is missing id/contextWindow/maxTokens/input')
    }
    before.models = modelsAfter.length
  } else {
    log('  ! yaml parser not importable; skipping deep validation (backup still written)')
  }
} catch (e) {
  console.error(`refusing to write: validation failed — ${e?.message ?? e}`)
  process.exit(2)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backup = `${file}.bak-models-${stamp}`
fs.copyFileSync(file, backup)
fs.writeFileSync(file, updated, 'utf8')

log('')
log(`wrote ${file}`)
log(`backup: ${backup}`)
log(`validated: ${before.entries} profile entries, ${before.models} models`)
log('')
log('Next: reload DSH so it re-reads the provider (restart the app, or re-select the provider in Model settings).')
