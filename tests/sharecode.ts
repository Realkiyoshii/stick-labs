// Share codes: curve and profile round-trips, damage detection, safe overlay.
import { readFileSync } from 'node:fs'
import { applySharedProfile, decodeCurve, decodeProfile, encodeCurve, encodeProfile, fromBase64Url, rescaleCurve, toBase64Url } from '../src/shared/sharecode'
import { parseProfile, serializeProfile, stick } from '../src/shared/profile'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}
async function rejects(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn()
  } catch {
    console.log(`✓ ${name}`)
    return
  }
  throw new Error(name)
}

for (let n = 0; n < 8; n++) {
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) & 0xff)
  check(`base64url round-trip ${n} bytes`, JSON.stringify([...fromBase64Url(toBase64Url(bytes))]) === JSON.stringify([...bytes]))
}

const pts = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 10, y: 13 }, { x: 88, y: 88 }, { x: 255, y: 255 }]
const curveCode = encodeCurve({ name: 'Apex All-Round', scale: 255, pts })
const curve = decodeCurve(`  ${curveCode}\n`)
check('curve code starts with SLC1.', curveCode.startsWith('SLC1.'))
check('curve round-trips name, scale and points', curve.name === 'Apex All-Round' && curve.scale === 255 && JSON.stringify(curve.pts) === JSON.stringify(pts))
check('curve rescales 255 → 1000 endpoints', JSON.stringify(rescaleCurve(pts, 255, 1000).at(-1)) === '{"x":1000,"y":1000}')
await rejects('curve rejects a profile prefix', () => decodeCurve('SLP1.abc'))
await rejects('curve rejects garbage', () => decodeCurve('SLC1.!!!'))
await rejects('curve rejects out-of-range points', () => decodeCurve(encodeCurve({ scale: 255, pts: [{ x: 0, y: 0 }, { x: 300, y: 10 }] })))
await rejects('curve rejects points out of order', () => decodeCurve(encodeCurve({ scale: 255, pts: [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 50, y: 20 }] })))

for (const model of ['G7ProCE', 'T3CE']) {
  const bytes = new Uint8Array(readFileSync(`fixtures/profile-reset/${model}.bin`))
  const code = await encodeProfile(bytes, model)
  const shared = await decodeProfile(code)
  check(`${model}: profile code round-trips byte-exact (${code.length} chars)`, shared.model === model && Buffer.from(serializeProfile(shared)).equals(Buffer.from(bytes)))
  await rejects(`${model}: truncated code is rejected`, () => decodeProfile(code.slice(0, -6)))
  const flipped = code.slice(0, 40) + (code[40] === 'A' ? 'B' : 'A') + code.slice(41)
  await rejects(`${model}: one changed character is rejected`, () => decodeProfile(flipped))
}

// Overlay keeps the receiver's device settings and copies the setup.
const g7 = new Uint8Array(readFileSync('fixtures/profile-reset/G7ProCE.bin'))
const t3 = new Uint8Array(readFileSync('fixtures/profile-reset/T3CE.bin'))
const sender = parseProfile(t3, 'T3CE')
stick.setCurve(sender.sticks[1], [{ x: 0, y: 0 }, { x: 64, y: 60 }, { x: 128, y: 114 }, { x: 191, y: 213 }, { x: 255, y: 255 }])
sender.name = 'Shared'
const senderBytes = serializeProfile(sender)
const shared = await decodeProfile(await encodeProfile(senderBytes, 'T3CE'))

const same = parseProfile(applySharedProfile(t3, 'T3CE', shared), 'T3CE')
const t3Before = parseProfile(t3, 'T3CE')
check('same model: name and stick curve arrive', same.name === 'Shared' && stick.curve(same.sticks[1])[1].y === 60)
check('same model: device settings stay the receiver\'s', Buffer.from(same.funData.bytes.subarray(32)).equals(Buffer.from(t3Before.funData.bytes.subarray(32))))
check('same model: trailing bytes stay the receiver\'s', Buffer.from(same.tail).equals(Buffer.from(t3Before.tail)))

const cross = parseProfile(applySharedProfile(g7, 'G7ProCE', shared), 'G7ProCE')
const g7Before = parseProfile(g7, 'G7ProCE')
check('cross model: stick curve arrives on G7', stick.curve(cross.sticks[1])[1].y === 60)
check('cross model: output stays G7 length', serializeProfile(cross).length === 1070)
check('cross model: L5/R5 untouched', Buffer.from(cross.functionKeys[2].bytes).equals(Buffer.from(g7Before.functionKeys[2].bytes)) && Buffer.from(cross.functionKeys[3].bytes).equals(Buffer.from(g7Before.functionKeys[3].bytes)))
check('cross model: G7 device settings untouched', Buffer.from(cross.funData.bytes.subarray(32)).equals(Buffer.from(g7Before.funData.bytes.subarray(32))))
