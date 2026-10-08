/**
 * Tarantula (T3CE) geometry proof — 1935-byte layout resolved from the
 * GameSir bundle's own sequential parser and first confirmed against live
 * dumps from PID 0x103D (firmware 0243).
 *
 * This file is SYNTHETIC on purpose: the live dumps contain the owner's
 * personal mappings, so they stay out of the public repo. Geometry is
 * pinned here; the live proof happened once and is recorded in git history.
 *
 *   node scripts/test.mjs tests/t3ce.ts
 */
import { GEOMETRIES, parseProfile, serializeProfile, stick, fun } from '../src/shared/profile.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const geo = GEOMETRIES.T3CE
check('sticks section at 0x6E1, 2x36', geo.sticks.offset === 0x6e1 && geo.sticks.count === 2 && geo.sticks.len === 36)
check('triggers at 0x6A1, 9x169 function keys', geo.triggers.offset === 0x6a1 && geo.functionKeys[0].count === 9)
check('total 1935', geo.total === 1935)

// Build a synthetic T3CE blob: gear 2 at Fun+14, identity sticks, Ext tail.
const blob = new Uint8Array(1935)
blob[0x20 + 14] = 2 // 1000 Hz gear
blob[0x20 + 16] = 0 // 12-bit
for (const s of [0, 1]) {
  const base = 0x6e1 + s * 36
  blob[base + 0] = 1 // enabled
  blob[base + 2] = 1 // dead_en
  blob[base + 3] = 0x00
  blob[base + 4] = 0x32 // front 50
  blob[base + 5] = 0x03
  blob[base + 6] = 0xe8 // back 1000
  blob[base + 7] = 0x00
  blob[base + 8] = 0x00 // anti front 0
  blob[base + 9] = 0x03
  blob[base + 10] = 0xe8 // anti back 1000
  const xs = [0, 64, 128, 191, 255]
  xs.forEach((x, i) => {
    blob[base + 14 + i * 2] = x
    blob[base + 15 + i * 2] = x
  })
  blob[base + 24] = 1 // map_en
  blob[base + 27] = 50 // axis
  blob[base + 28] = 50 // dpi
  blob[base + 29] = s + 1 // Left/Right
}
blob[1915] = 0xab // Ext8 tail marker
blob[1925] = 0xcd // Ext9 tail marker

const profile = parseProfile(blob, 'T3CE')
const rebuilt = serializeProfile(profile)
let diffs = 0
for (let i = 0; i < blob.length; i++) if (blob[i] !== rebuilt[i]) diffs++
check('synthetic blob round-trips byte-exact', diffs === 0, diffs ? `${diffs} differ` : '1935/1935')
check('parses 2 sticks + 9 function keys', profile.sticks.length === 2 && profile.functionKeys.length === 9)
check('tail preserves Ext8/9 (20B)', profile.tail.length === 20 && rebuilt[1915] === 0xab && rebuilt[1925] === 0xcd)

const dz = stick.deadzone(profile.sticks[0])
check('deadzone reads 5/100/0/100', dz.begin === 50 && dz.end === 1000 && dz.beginAnti === 0 && dz.endAnti === 1000)
const curve = stick.curve(profile.sticks[1])
check('curve reads identity', curve.map((p) => `${p.x}/${p.y}`).join(' ') === '0/0 64/64 128/128 191/191 255/255')
check('map fields read Left/Right + 50/50', stick.mapIndex(profile.sticks[0]) === 1 && stick.mapIndex(profile.sticks[1]) === 2)
check('gear reads back 2 (1000Hz)', fun.extend.reportRateGear(profile.funData) === 2)

// Mutating one stick must not disturb anything else.
stick.setDeadzone(profile.sticks[0], { begin: 0, end: 800, beginAnti: 80, endAnti: 1000 })
const edited = serializeProfile(profile)
let touched: number[] = []
for (let i = 0; i < blob.length; i++) if (blob[i] !== edited[i]) touched.push(i)
const inStick0 = touched.every((o) => o >= 0x6e1 && o < 0x6e1 + 36)
check('stick edit touches only its 36 bytes', touched.length > 0 && inStick0, `${touched.length} bytes @${touched[0]}`)

// CE default parse unaffected.
const blank = new Uint8Array(1070)
check('CE default parse unaffected', parseProfile(blank).model === 'G7ProCE' && serializeProfile(parseProfile(blank)).length === 1070)

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
