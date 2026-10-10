/**
 * Steam export — writes Stick Labs deadzones into Steam Input per-game
 * controller configs (plain VDF files, no Steam API involved).
 *
 * Provenance (all observed on this machine, Oct 2026):
 * - per-game personal configs: <steam>/userdata/<uid>/config/<appid>/
 *   controller_<padtype>.vdf  (see 241100/remotecache.vdf for the pattern)
 * - XInput pads (GameSir presents as one) match the xbox360/xboxone files;
 *   both are written identically so either detection path loads
 * - stick keys, from controller_base templates: `deadzone` and
 *   `deadzone_outer_radius` on a 0-32767 scale inside each stick group's
 *   `settings` block (left = group 3 joystick_move, right = groups 2+6)
 * - custom response-curve point keys are NOT in any base file, so curves
 *   are deliberately not exported — deadzones only, stated in the UI
 *
 * Steam must be CLOSED while writing: it flushes configs on exit and would
 * silently overwrite the export.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { injectStickSettings } from '../shared/steamcfg'

export interface SteamInfo {
  steamPath: string | null
  userId: string | null
  apexInstalled: boolean
  apexAppId: number
  steamRunning: boolean
}

export interface SteamGame {
  appId: number
  name: string
}

function parseAcfManifest(path: string): { appId: number; name: string } | null {
  try {
    const text = readFileSync(path, 'utf8')
    const id = text.match(/"appid"\s+"(\d+)"/)
    const name = text.match(/"name"\s+"([^"]+)"/)
    if (!id) return null
    return { appId: Number(id[1]), name: name ? name[1] : `App ${id[1]}` }
  } catch {
    return null
  }
}

/** Every installed game found across all Steam libraries. */
export function listInstalledGames(): SteamGame[] {
  const steamPath = findSteamPath()
  if (!steamPath) return []
  const games = new Map<number, string>()
  for (const lib of libraryPaths(steamPath)) {
    let files: string[] = []
    try {
      files = readdirSync(join(lib, 'steamapps')).filter((f) => /^appmanifest_\d+\.acf$/.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const parsed = parseAcfManifest(join(lib, 'steamapps', f))
      if (parsed && !games.has(parsed.appId)) games.set(parsed.appId, parsed.name)
    }
  }
  return [...games.entries()]
    .map(([appId, name]) => ({ appId, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface SteamExportResult {
  game: string
  appId: number
  files: string[]
  backedUp: string[]
  mapped: string[]
  notTransferred: string[]
}

export interface SteamBulkResult {
  games: Array<{ appId: number; name: string; ok: boolean; detail: string }>
}

const APEX_APP_ID = 1172470
const PAD_FILES = ['controller_xbox360.vdf', 'controller_xboxone.vdf'] as const

function steamPathCandidates(): string[] {
  const out: string[] = []
  try {
    const reg = execSync(
      'reg query "HKCU\\Software\\Valve\\Steam" /v SteamPath',
      { stdio: ['ignore', 'pipe', 'ignore'] }
    ).toString()
    const m = reg.match(/SteamPath\s+REG_SZ\s+(.+)/)
    if (m) out.push(m[1].trim().replace(/\//g, '\\'))
  } catch {
    /* no registry entry */
  }
  out.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam')
  return [...new Set(out)].filter((p) => existsSync(join(p, 'userdata')))
}

function findSteamPath(): string | null {
  for (const p of steamPathCandidates()) {
    try {
      if (existsSync(join(p, 'userdata'))) return p
    } catch {
      /* next */
    }
  }
  return null
}

function findUserId(steamPath: string): string | null {
  try {
    const entries = readdirSync(join(steamPath, 'userdata')).filter((e) => {
      try {
        return /^\d+$/.test(e) && statSync(join(steamPath, 'userdata', e)).isDirectory()
      } catch {
        return false
      }
    })
    if (entries.length === 0) return null
    // Prefer the profile that already syncs Steam Input (241100).
    return entries.find((e) => existsSync(join(steamPath, 'userdata', e, '241100'))) ?? entries[0]
  } catch {
    return null
  }
}

function libraryPaths(steamPath: string): string[] {
  const paths = [steamPath]
  try {
    const text = readFileSync(join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8')
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      paths.push(m[1].replace(/\\\\/g, '\\'))
    }
  } catch {
    /* default library only */
  }
  return [...new Set(paths)]
}

function isApexInstalled(steamPath: string): boolean {
  return libraryPaths(steamPath).some((lib) =>
    existsSync(join(lib, 'steamapps', `appmanifest_${APEX_APP_ID}.acf`))
  )
}

function steamRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq steam.exe" /FO CSV', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.split('\n').some((l) => l.toLowerCase().includes('steam.exe'))
  } catch {
    return false
  }
}

export function steamInfo(): SteamInfo {
  const steamPath = findSteamPath()
  const userId = steamPath ? findUserId(steamPath) : null
  return {
    steamPath,
    userId,
    apexInstalled: steamPath ? isApexInstalled(steamPath) : false,
    apexAppId: APEX_APP_ID,
    steamRunning: steamRunning()
  }
}

/**
 * Export left/right deadzone windows to Apex's controller configs.
 * Windows are whole percent (0-100). Writes nothing when Steam runs.
 */
export function exportApexDeadzones(
  left: { begin: number; end: number; anti?: number },
  right: { begin: number; end: number; anti?: number },
  mouseRate: number | null = null,
  curveExp: number | null = null
): SteamExportResult {
  const bulk = exportDeadzonesToGames(left, right, [{ appId: APEX_APP_ID, name: 'Apex Legends' }], mouseRate, curveExp)
  const first = bulk.games[0]
  if (!first || !first.ok) throw new Error(first?.detail ?? 'export failed')
  const antiOn = (left.anti ?? 0) > 0 || (right.anti ?? 0) > 0
  return {
    game: 'Apex Legends',
    appId: APEX_APP_ID,
    files: [],
    backedUp: [],
    mapped: [
      `left deadzone ${left.begin}% → inner, ${left.end}% → outer`,
      `right deadzone ${right.begin}% → inner, ${right.end}% → outer`,
      ...(mouseRate !== null ? [`mouse sensitivity → ${mouseRate}`] : []),
      ...(curveExp !== null ? [`curve exponent ≈ ${curveExp} (experimental fit)`] : []),
      ...(antiOn ? ['anti-deadzone → on'] : [])
    ],
    notTransferred: NOT_TRANSFERRED
  }
}

const NOT_TRANSFERRED = [
  'response curve (Steam point format unconfirmed — Steam default applies)',
  'Controller Rate firmware byte itself (GameSir-only — mapped to Steam mouse sensitivity instead)'
]

/** Write the patched template into one game's config dir. Throws on failure. */
function writeGameConfig(
  steamPath: string,
  userId: string,
  appId: number,
  patched: string
): { backedUp: boolean } {
  const dir = join(steamPath, 'userdata', userId, 'config', String(appId))
  mkdirSync(dir, { recursive: true })
  let backedUp = false
  for (const name of PAD_FILES) {
    const target = join(dir, name)
    if (existsSync(target)) {
      copyFileSync(target, `${target}.sticklabs.bak`)
      backedUp = true
    }
    writeFileSync(target, patched)
  }
  return { backedUp }
}

/**
 * Bulk export to every installed game. Games that fail (locked files,
 * odd setups) are reported per-game without stopping the rest.
 *
 * mouseRate carries the Controller Rate pick (0-255) into group 2's
 * joystick-mouse sensitivity; null (the default 50, i.e. untouched) leaves
 * Steam's default alone.
 */
export function exportDeadzonesToGames(
  left: { begin: number; end: number; anti?: number },
  right: { begin: number; end: number; anti?: number },
  games: SteamGame[],
  mouseRate: number | null = null,
  curveExp: number | null = null
): SteamBulkResult {
  const info = steamInfo()
  if (!info.steamPath || !info.userId) throw new Error('Steam install or user folder not found')
  if (info.steamRunning) {
    throw new Error('Close Steam first — it overwrites configs on exit and would silently eat this export.')
  }
  const template = readFileSync(join(info.steamPath, 'controller_base', 'templates', 'gamepad_fps.vdf'), 'utf8')
  const patched = injectStickSettings(
    template,
    {
      '2': { begin: right.begin, end: right.end, anti: right.anti },
      '3': { begin: left.begin, end: left.end, anti: left.anti },
      '6': { begin: right.begin, end: right.end, anti: right.anti }
    },
    mouseRate,
    curveExp
  )
  const results: SteamBulkResult['games'] = []
  for (const g of games) {
    try {
      const { backedUp } = writeGameConfig(info.steamPath, info.userId, g.appId, patched)
      results.push({ appId: g.appId, name: g.name, ok: true, detail: backedUp ? 'updated (old kept as .bak)' : 'written' })
    } catch (err) {
      results.push({ appId: g.appId, name: g.name, ok: false, detail: (err as Error).message })
    }
  }
  return { games: results }
}
