/**
 * Every machine-specific path and setting used by the bridge tooling lives here.
 *
 * Why a module and not scattered constants: this project is published, so nothing may
 * carry the author's user name, home directory or account SID. Defaults are derived at
 * runtime (HOME, LOCALAPPDATA, the DSH install) and can always be overridden, in this
 * order of precedence:
 *
 *   1. command-line flag      --profile-config <path>
 *   2. environment variable   WB_BRIDGE_PROFILE_CONFIG=<path>
 *   3. config file            <bridge dir>/config.json
 *   4. derived default        ~/.dsh/profiles/<profile>/cordis.patch.yml
 *
 * See config.example.json for a starting point. config.json itself is git-ignored,
 * because it may contain the operator's own absolute paths.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** DSH home: honour DSH_HOME, else the conventional ~/.dsh. */
export function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

let cachedFileConfig = null
/** Read config.json once. A missing file is normal, not an error. */
export function fileConfig() {
  if (cachedFileConfig) return cachedFileConfig
  const p = path.join(BRIDGE_DIR, 'config.json')
  try {
    cachedFileConfig = JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      // A malformed config is worth knowing about, but must not stop the bridge:
      // every consumer below has a working default.
      console.error(`[config] ignoring unreadable ${p}: ${e?.message ?? e}`)
    }
    cachedFileConfig = {}
  }
  return cachedFileConfig
}

const flagValue = (argv, flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null
}

/** Path to the DSH profile patch file this bridge is configured in. */
export function profileConfigPath(argv = process.argv.slice(2)) {
  return (
    flagValue(argv, '--profile-config') ??
    process.env.WB_BRIDGE_PROFILE_CONFIG ??
    fileConfig().profileConfig ??
    path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml')
  )
}

/** DSH profile name the bridge is configured in (used only for reporting). */
export function profileName() {
  return process.env.WB_BRIDGE_PROFILE ?? fileConfig().profile ?? 'desktop'
}

/**
 * The Node binary to use for helper scripts and scheduled tasks.
 *
 * Preference order: explicit config, then the Node running this process (which is by
 * definition correct), then a PATH lookup. Never a hard-coded per-user path.
 */
export function nodeBinary() {
  const fromConfig = process.env.WB_BRIDGE_NODE ?? fileConfig().node
  if (fromConfig) return fromConfig
  // process.execPath is the interpreter actually running us — always right.
  return process.execPath || 'node'
}

/** Directory holding generated reports. */
export function reportsDir() {
  return process.env.WB_BRIDGE_REPORTS ?? fileConfig().reportsDir ?? path.join(BRIDGE_DIR, 'reports')
}

/** Where the running bridge appends its stdout log. */
export function logPath() {
  return process.env.WB_BRIDGE_LOG ?? fileConfig().logPath ?? path.join(BRIDGE_DIR, 'bridge-stdout.log')
}
