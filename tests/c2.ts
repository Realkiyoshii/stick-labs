/**
 * Cyclone 2 (C2) — third protocol family, mapped from the GameSir bundle's
 * own sequential parser (Name32, Fun32, 16x7, 2x159, 2x28, 2x32 @0x226,
 * 2x33 @0x266 = 680). Single-byte deadzones/curves, no resolution or
 * anti-jitter bytes, 0xFD calibration.
 *
 * Synthetic geometry test only: no semantic claims until a live dump from
 * a viewer proves them. The shared u16BE deadzone accessors must NEVER run
 * on C2 packets.
 *
 *   node scripts/test.mjs tests/c2.ts
 */
import { GEOMETRIES, parseProfile, serializeProfile } from '../src/shared/profile.ts'
import { MODELS, identifyModel } from '../src/shared/models.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const geo = GEOMETRIES.C2
check('total 680', geo.total === 680)
check('sticks 2x32 at 0x226', geo.sticks.offset === 0x226 && geo.sticks.count === 2 && geo.sticks.len === 32)
check('triggers 2x28 at 0x1EE', geo.triggers.offset === 0x1ee && geo.triggers.len === 28)
check('function keys 2x159', geo.functionKeys[0].count === 2 && geo.functionKeys[0].len === 159)
check('motion 2x33 at 0x266, ends exactly at 680', geo.motion.offset === 0x266 && geo.motion.offset + 2 * 33 === 680)

const blob = new Uint8Array(680)
blob[0x20 + 14] = 5 // report gear byte sits at the same offset
blob[0x226 + 0] = 1
blob[0x226 + 24] = 50
const profile = parseProfile(blob, 'C2')
const rebuilt = serializeProfile(profile)
let diffs = 0
for (let i = 0; i < blob.length; i++) if (blob[i] !== rebuilt[i]) diffs++
check('synthetic blob round-trips byte-exact', diffs === 0, diffs ? `${diffs} differ` : '680/680')
check('tail empty (sections end at 680)', profile.tail.length === 0)

const c2 = MODELS.find((m) => m.id === 'C2')
check('C2 locked with 680 dump length', !!c2 && c2.support === 'detect-only' && c2.dumpLength === 680)
check('C2 identified by PID 0x101D', identifyModel('Gamepad', 0x101d)?.id === 'C2')
check('C2 identified by name', identifyModel('CYCLONE 2')?.id === 'C2')
check('C2 gears default 250/1K/4K/8K', !!c2 && c2.reportRates.map((r) => r.hz).join(',') === '250,1000,4000,8000')

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
