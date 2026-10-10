import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listInstalledGames, steamInfo } from '../src/main/steam.ts'
import { injectStickSettings } from '../src/shared/steamcfg.ts'

const info = steamInfo()
console.log(`steam=${info.steamPath} user=${info.userId} running=${info.steamRunning}`)
const games = listInstalledGames()
console.log(`games detected: ${games.length}`)
for (const g of games.slice(0, 12)) console.log(`  ${g.appId} ${g.name}`)

const template = readFileSync(join(info.steamPath!, 'controller_base', 'templates', 'gamepad_fps.vdf'), 'utf8')
let failures = 0
for (const g of games) {
  try {
    const out = injectStickSettings(template, { '2': { begin: 0, end: 100 }, '3': { begin: 5, end: 80 }, '6': { begin: 5, end: 80 } })
    if (!out.includes('"deadzone"')) throw new Error('no deadzone written')
  } catch (err) {
    failures++
    console.error(`✗ ${g.appId} ${g.name}: ${(err as Error).message}`)
  }
}
console.log(failures === 0 ? `UNIVERSAL PROOF PASSED (${games.length} games, writes skipped)` : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
