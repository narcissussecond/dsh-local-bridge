// Verify refresh-models.mjs rewrites the profile correctly and refuses to corrupt it.
// Runs against throwaway copies of a real profile; the live profile is never touched.
//
//   1. dry run writes nothing
//   2. --apply adds missing models, preserves entry order, keeps unrelated entries
//   3. the rewritten file still parses and keeps its non-model content
//   4. an idempotent second run reports "nothing to do"
//   5. --prune removes models upstream dropped
//   6. a profile whose model block cannot be parsed is refused, not half-written
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const SCRIPT = path.join(BRIDGE_DIR, 'refresh-models.mjs')

let failures = 0
const check = (label, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' :: ' + detail : ''}`)
}

function run(profilePath, extra = []) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [SCRIPT, '--profile', profilePath, ...extra], { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ code, out }))
  })
}

/** A minimal but realistic profile: two unrelated entries around the provider block. */
function makeProfile(dir, models, opts = {}) {
  const entries = models.map((m) => {
    const id = typeof m === 'string' ? m : m.id
    const efforts = typeof m === 'object' && m.efforts
      ? '\n              reasoningEfforts:\n' + Object.entries(m.efforts)
          .map(([k, v]) => `                ${k}: ${v === null ? 'null' : v}`).join('\n')
      : ''
    return `            - id: ${id}\n              name: "${id}"\n              contextWindow: 1000\n              maxTokens: 100\n              input: [ text ]${efforts}`
  }).join('\n')
  const text = `# test profile
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: verbose
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      local-gateway:
        displayName: WorkBuddy
        api: openai-completions
        baseURL: http://127.0.0.1:8791/v1
        headers:
          # a comment inside the block, must survive
          Authorization: Bearer placeholder
        models:
${entries}
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    fontSize: 18
`
  const p = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(p, text, 'utf8')
  return { path: p, text }
}

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wbrm-'))

// ---- 1. dry run leaves the file byte-identical ----------------------------------------
{
  console.log('1. dry run writes nothing')
  const dir = sandbox()
  const { path: p, text } = makeProfile(dir, ['deepseek-v4.1-flash'])
  const r = await run(p)
  check('exit 0', r.code === 0, `exit=${r.code}`)
  check('reports the missing model', /hy4free/.test(r.out), '')
  check('file unchanged', fs.readFileSync(p, 'utf8') === text)
  check('says dry run', /dry run/.test(r.out))
}

// ---- 2 + 3. apply adds models and preserves the rest ---------------------------------
{
  console.log('2. --apply adds models, keeps order and unrelated content')
  const dir = sandbox()
  const { path: p, text } = makeProfile(dir, ['deepseek-v4.1-flash', 'glm-5.3'])
  const r = await run(p, ['--apply'])
  check('exit 0', r.code === 0, `exit=${r.code}`)
  const after = fs.readFileSync(p, 'utf8')
  check('added hy4free', /\-\s+id:\s*hy4free/.test(after))
  check('added hy4std', /\-\s+id:\s*hy4std/.test(after))
  check('kept deepseek-v4.1-flash', /\-\s+id:\s*deepseek-v4\.1-flash/.test(after))
  check('kept glm-5.3', /\-\s+id:\s*glm-5\.3/.test(after))

  check('unrelated entry ui-chat survives', /id:\s*ui-chat/.test(after))
  check('unrelated entry ui-theme survives', /id:\s*ui-theme/.test(after))
  check('comment inside provider block survives', /# a comment inside the block/.test(after))
  check('baseURL line survives', /baseURL: http:\/\/127\.0\.0\.1:8791\/v1/.test(after))

  // order: existing models must stay in their original relative order, before the new ones
  const idx = (id) => after.indexOf(`- id: ${id}`)
  check('order preserved: deepseek before glm', idx('deepseek-v4.1-flash') < idx('glm-5.3'))
  check('new models appended after existing', idx('glm-5.3') < idx('hy4free'))

  // every model entry must carry the fields pi-ai needs
  const rows = after.split('\n')
  for (const id of ['hy4free', 'hy4std']) {
    const i = rows.findIndex((l) => l.includes(`- id: ${id}`))
    const block = rows.slice(i, i + 8).join('\n')
    check(`${id} has contextWindow`, /contextWindow: \d+/.test(block))
    check(`${id} has maxTokens`, /maxTokens: \d+/.test(block))
    check(`${id} has input`, /input: \[ /.test(block))
  }

  check('a backup was written', fs.readdirSync(dir).some((f) => f.includes('.bak-models-')))
}

// ---- 4. second run is a no-op ---------------------------------------------------------
{
  console.log('3. second --apply is idempotent')
  const dir = sandbox()
  const { path: p } = makeProfile(dir, ['deepseek-v4.1-flash'])
  await run(p, ['--apply'])
  const first = fs.readFileSync(p, 'utf8')
  const r = await run(p, ['--apply'])
  check('exit 0', r.code === 0, `exit=${r.code}`)
  check('says nothing to do', /nothing to do/i.test(r.out), r.out.trim().split('\n').pop())
  check('file unchanged on second apply', fs.readFileSync(p, 'utf8') === first)
}

// ---- 5. --prune removes dropped models -----------------------------------------------
{
  console.log('4. --prune drops models upstream no longer lists')
  const dir = sandbox()
  const { path: p } = makeProfile(dir, ['deepseek-v4.1-flash', 'hy4-preview'])
  const dry = await run(p, ['--apply'])
  check('without --prune hy4-preview is kept', /-\s*id:\s*hy4-preview/.test(fs.readFileSync(p, 'utf8')))

  const dir2 = sandbox()
  const { path: p2 } = makeProfile(dir2, ['deepseek-v4.1-flash', 'hy4-preview'])
  const r = await run(p2, ['--prune', '--apply'])
  check('exit 0', r.code === 0, `exit=${r.code}`)
  check('hy4-preview removed', !/-\s*id:\s*hy4-preview/.test(fs.readFileSync(p2, 'utf8')))
  check('deepseek still there', /-\s*id:\s*deepseek-v4\.1-flash/.test(fs.readFileSync(p2, 'utf8')))
}

// ---- 6. broken profile is refused -----------------------------------------------------
{
  console.log('5. profile without a recognisable models block is refused')
  const dir = sandbox()
  const p = path.join(dir, 'cordis.patch.yml')
  const broken = '# nothing useful here\n- id: ui-chat\n  name: x\n'
  fs.writeFileSync(p, broken, 'utf8')
  const r = await run(p, ['--apply'])
  check('non-zero exit', r.code !== 0, `exit=${r.code}`)
  check('file untouched', fs.readFileSync(p, 'utf8') === broken)
  check('explains why', /could not find/.test(r.out + r.out) || /could not find/.test(r.out), '')
}

// ---- 6. existing entries must survive verbatim ---------------------------------------
// Regression: an early version re-rendered every entry from upstream metadata and
// dropped reasoningEfforts for models whose upstream payload only carried a single
// `reasoning.effort` (hy3, glm-5.2, ...). Seven models lost their thinking picker.
{
  console.log('6. existing entries are carried over verbatim (efforts must not be lost)')
  const dir = sandbox()
  const rich = [
    { id: 'deepseek-v4.1-flash', efforts: { low: 'low', high: 'high', max: 'max', off: null } },
    { id: 'hy3', efforts: { low: 'low', medium: 'medium', high: 'high' } },
    { id: 'glm-5.2', efforts: { low: 'low', medium: 'medium', high: 'high' } },
  ]
  const { path: p } = makeProfile(dir, rich)
  await run(p, ['--apply'])
  const after = fs.readFileSync(p, 'utf8')

  for (const m of rich) {
    const rows = after.split('\n')
    const i = rows.findIndex((l) => l.includes(`- id: ${m.id}`))
    const block = rows.slice(i, i + 12).join('\n')
    for (const [k, v] of Object.entries(m.efforts)) {
      check(`${m.id} keeps effort ${k}: ${v === null ? 'null' : v}`, new RegExp(`${k}:\\s*${v === null ? 'null' : v}`).test(block))
    }
  }
}

console.log()
console.log(failures === 0 ? 'ALL REFRESH CHECKS PASSED' : `${failures} REFRESH CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
