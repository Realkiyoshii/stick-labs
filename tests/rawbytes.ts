/**
 * Raw-byte unlock: standard 8-12 bit + RC -10..+10 must round-trip, and raw
 * wires outside the documented range must be stored byte-exact (the pad
 * decides what to do with them — we just must not corrupt neighbours).
 */
import { parseProfile, serializeProfile, fun, stick } from '../src/shared/profile.ts'
import { describeRawResolution, describeRawRc, resampleCurve, addDesignPoint, outerBufferToBytes, outerBufferFromBytes, isOuterUnlimited, bitsToWireRaw } from '../src/shared/sticklab.ts'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// Minimal 1070-byte blob (name + fun area is enough for these accessors).
const blank = new Uint8Array(1070)
const p = parseProfile(blank)

// Standard bits round-trip through the inverted wire byte.
for (const bits of [8, 9, 10, 11, 12]) {
  fun.extend.setStickResolutionBits(p.funData, bits)
  check(`${bits}-bit round-trips`, fun.extend.stickResolutionBits(p.funData) === bits, `wire=${fun.extend.stickResolution(p.funData)}`)
}
check('12-bit is wire 0', (() => { fun.extend.setStickResolutionBits(p.funData, 12); return fun.extend.stickResolution(p.funData) === 0 })())
check('8-bit is wire 4', (() => { fun.extend.setStickResolutionBits(p.funData, 8); return fun.extend.stickResolution(p.funData) === 4 })())

// Raw unlock: any wire 0-255 stored byte-exact.
for (const w of [0, 5, 9, 64, 255]) {
  fun.extend.setStickResolution(p.funData, w)
  check(`raw resolution wire ${w} stored`, fun.extend.stickResolution(p.funData) === w, describeRawResolution(w).label)
}

// RC levels round-trip, raw wires stored.
for (const lvl of [-10, -3, 0, 5, 10]) {
  fun.extend.setLsRcLevel(p.funData, lvl)
  fun.extend.setRsRcLevel(p.funData, lvl)
  check(`RC ${lvl} round-trips L/R`, fun.extend.lsRcLevel(p.funData) === lvl && fun.extend.rsRcLevel(p.funData) === lvl)
}
for (const w of [0, 1, 21, 22, 255]) {
  fun.extend.setLsAntiJitter(p.funData, w)
  check(`raw RC wire ${w} stored`, fun.extend.lsAntiJitter(p.funData) === w, describeRawRc(w).label)
}

// Neighbour isolation: raw writes must not touch adjacent bytes.
fun.extend.setStickResolution(p.funData, 200)
fun.extend.setLsAntiJitter(p.funData, 201)
fun.extend.setRsAntiJitter(p.funData, 202)
const bytes = serializeProfile(p)
check('raw wires land at Fun_Data +16/+17/+18', bytes[0x20 + 16] === 200 && bytes[0x20 + 17] === 201 && bytes[0x20 + 18] === 202)

// Curve resampling: free-point designs quantize to exactly 5 hardware slots.
{
  const linear5 = resampleCurve([{ x: 0, y: 0 }, { x: 255, y: 255 }])
  check('2-point linear resamples to identity grid', linear5.length === 5 && linear5.every((p, i) => p.x === [0, 64, 128, 191, 255][i] && Math.abs(p.y - p.x) <= 1), linear5.map((p) => `${p.x}/${p.y}`).join(' '))
  const eight = [{ x: 0, y: 0 }, { x: 32, y: 10 }, { x: 64, y: 38 }, { x: 96, y: 70 }, { x: 128, y: 100 }, { x: 160, y: 140 }, { x: 191, y: 185 }, { x: 255, y: 255 }]
  const q = resampleCurve(eight)
  check('8-point design quantizes to 5 slots', q.length === 5 && q[0].x === 0 && q[4].x === 255 && q[0].y === 0 && q[4].y === 255, q.map((p) => `${p.x}/${p.y}`).join(' '))
  check('mid-slot interpolation is sane', q[2].x === 128 && q[2].y === 100, `${q[2].x}/${q[2].y}`)
  const grown = addDesignPoint([{ x: 0, y: 0 }, { x: 255, y: 255 }])
  check('add point splits longest segment', grown.length === 3 && grown[1].x === 128, grown.map((p) => `${p.x}/${p.y}`).join(' '))
  check('add point grows 8 to 9', addDesignPoint(eight).length === 9)
  const ten = [...eight, { x: 200, y: 210 }, { x: 230, y: 240 }]
  check('add point caps at 10 (full)', addDesignPoint(ten).length === 10)
}
for (const gear of [0, 1, 2, 3, 4, 5]) {
  fun.extend.setReportRateGear(p.funData, gear)
  check(`gear ${gear} round-trips`, fun.extend.reportRateGear(p.funData) === gear)
}

// Outer threshold buffer: + = earlier max (End), − = soft cap (endAnti), 0/∞ = neutral.
{
  const t = (b: number): string => {
    const { end, endAnti } = outerBufferToBytes(b)
    return `${end}/${endAnti}`
  }
  check('buffer 0 is neutral 1000/1000', t(0) === '1000/1000', t(0))
  check('buffer +20 saturates at 80%', t(20) === '800/1000', t(20))
  check('buffer +95 floors at 5%', t(95) === '50/1000', t(95))
  check('buffer −10 caps output at 90%', t(-10) === '1000/900', t(-10))
  check('buffer −100 caps output at 0', t(-100) === '1000/0', t(-100))
  check('buffer clamps past limits', t(200) === t(95) && t(-200) === t(-100))
  check('read-back +20', outerBufferFromBytes(800, 1000) === 20)
  check('read-back −10', outerBufferFromBytes(1000, 900) === -10)
  check('neutral reads as unlimited', isOuterUnlimited(1000, 1000) === true && isOuterUnlimited(800, 1000) === false)
}
{
  const s = p.sticks[0]
  check('flip X/Y default off', stick.flipX(s) === false && stick.flipY(s) === false)
  stick.setFlipX(s, true)
  stick.setFlipY(s, true)
  check('flip X/Y round-trip', stick.flipX(s) === true && stick.flipY(s) === true)
  const bytes = serializeProfile(p)
  const base = 916
  check('flips land at +25/+26 bit0 only', (bytes[base + 25] & 0xfe) === 0 && (bytes[base + 26] & 0xfe) === 0 && (bytes[base + 25] & 1) === 1 && (bytes[base + 26] & 1) === 1)
  stick.setFlipX(s, false)
  stick.setFlipY(s, false)
}

// Extended bit picks: implied raw wires for past-silicon depths.
{
  const cases: Array<[number, number]> = [[13, 255], [14, 254], [16, 252], [20, 248], [24, 244]]
  for (const [bits, wire] of cases) {
    check(`${bits}-bit implies wire ${wire}`, bitsToWireRaw(bits) === wire)
  }
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
