import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { Packet, trigger, GEOMETRIES, parseProfile, serializeProfile } from '../src/shared/profile'
import { identifyTriggerPreset, readTriggerCurve, setTriggerPoint, setTriggerPreset, setTriggerRange, setTriggerRangeEnabled, setTriggerRapidMode, setTriggerRapidRange, validTriggerCurve, type TriggerPreset, type TriggerRangeField } from '../src/shared/trigger'

const fixture = JSON.parse(readFileSync('fixtures/gamesir-trigger/website-vectors.json', 'utf8')) as {
  presets: Array<{ preset: TriggerPreset; adjustment: number; input: number[]; expected: number[] }>
  ranges: Array<{ field: TriggerRangeField; value: number; input: number[]; expected: number[] }>
}
for (const vector of fixture.presets) {
  const packet = new Packet(Uint8Array.from(vector.input))
  setTriggerPreset(packet, vector.preset, vector.adjustment)
  assert.deepEqual([...packet.bytes], vector.expected, `${vector.preset} ${vector.adjustment}: all 32 bytes match website`)
  assert(validTriggerCurve(readTriggerCurve(packet)))
  const detected = identifyTriggerPreset(readTriggerCurve(packet))
  assert.equal(detected.preset, vector.preset)
  if (vector.preset !== 'default') assert.equal(detected.adjustment, vector.adjustment)
}
console.log(`PASS: ${fixture.presets.length} byte-exact website preset fixtures and preset detection`)
for (const vector of fixture.ranges) {
  const packet = new Packet(Uint8Array.from(vector.input))
  setTriggerRange(packet, vector.field, vector.value)
  assert.deepEqual([...packet.bytes], vector.expected, `${vector.field} ${vector.value}: all 32 bytes match website`)
}
console.log(`PASS: ${fixture.ranges.length} byte-exact website deadzone fixtures`)
const packet = new Packet(Uint8Array.from(fixture.ranges[0].input))
const unchangedOnFailure = (action: () => void): void => {
  const before = [...packet.bytes]
  assert.throws(action)
  assert.deepEqual([...packet.bytes], before, 'invalid edits leave packet untouched')
}
unchangedOnFailure(() => setTriggerRange(packet, 'begin', 100))
unchangedOnFailure(() => setTriggerRange(packet, 'endAnti', 0))
unchangedOnFailure(() => setTriggerRange(packet, 'begin', NaN))
unchangedOnFailure(() => setTriggerPreset(packet, 'quick', 6))
unchangedOnFailure(() => setTriggerRapidMode(packet, 1))
unchangedOnFailure(() => setTriggerRapidRange(packet, 17, 0))
unchangedOnFailure(() => setTriggerRapidRange(packet, 18, 100.5))
setTriggerRangeEnabled(packet, false)
assert.equal(packet.u8(2), 0)
packet.setU16be(3, 1000); packet.setU16be(5, 10)
packet.setU16be(7, 1000); packet.setU16be(9, 0)
setTriggerRangeEnabled(packet, true)
assert.deepEqual(trigger.deadzone(packet), { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 })
const beforeRapid = packet.bytes.slice()
setTriggerRapidMode(packet, 129); setTriggerRapidRange(packet, 17, 10); setTriggerRapidRange(packet, 18, 90)
assert.deepEqual([...packet.bytes.slice(16, 19)], [129, 10, 90])
packet.bytes.forEach((v, i) => { if (i < 16 || i > 18) assert.equal(v, beforeRapid[i]) })
setTriggerRapidMode(packet, 130); assert.equal(packet.u8(16), 130)
setTriggerRapidMode(packet, 0); assert.equal(packet.u8(16), 0)
setTriggerPreset(packet, 'default')
unchangedOnFailure(() => setTriggerPoint(packet, 0, { x: 0, y: 0 }))
unchangedOnFailure(() => setTriggerPoint(packet, 4, { x: 100, y: 100 }))
unchangedOnFailure(() => setTriggerPoint(packet, 2, { x: 0, y: 100 }))
const prefix = packet.bytes.slice(0, 19)
setTriggerPoint(packet, 2, { x: 50, y: 60 })
assert.deepEqual(readTriggerCurve(packet)[2], { x: 128, y: 153 })
assert.deepEqual(packet.bytes.slice(0, 19), prefix)
assert.deepEqual(readTriggerCurve(packet)[0], { x: 0, y: 0 })
assert.deepEqual(readTriggerCurve(packet)[4], { x: 255, y: 255 })
assert.equal(identifyTriggerPreset(readTriggerCurve(packet)).preset, 'custom')
const empty = new Packet(new Uint8Array(32))
setTriggerPreset(empty, 'custom')
assert.deepEqual(readTriggerCurve(empty), [0, 64, 128, 191, 255].map(v => ({ x: v, y: v })))
console.log('PASS: strict range validation, disabled/invalid range repair, rapid bytes, locked endpoints, custom editing, unrelated byte preservation')
for (const model of ['G7ProCE', 'T3CE']) {
  const geometry = GEOMETRIES[model]
  const original = new Uint8Array(geometry.total)
  // Valid UTF-8 name; patterned non-name bytes catch unintended writes.
  for (let i = 32; i < original.length; i++) original[i] = (i * 17 + 3) & 255
  for (const side of [0, 1]) {
    const profile = parseProfile(original.slice(), model)
    const offset = geometry.triggers.offset + side * 32
    setTriggerPreset(profile.triggers[side], 'quick', 1)
    const encoded = serializeProfile(profile)
    const expectedPacket = new Packet(original.slice(offset, offset + 32))
    setTriggerPreset(expectedPacket, 'quick', 1)
    const expected = original.slice(); expected.set(expectedPacket.bytes, offset)
    assert.deepEqual(encoded, expected, `${model} ${side}: whole-profile edit changes selected trigger only`)
  }
}
console.log('PASS: left/right trigger edits preserve all other bytes in G7ProCE and T3CE profiles')
const live = JSON.parse(readFileSync('fixtures/gamesir-trigger/t3ce-0243-readback.json', 'utf8'))
const replay = new Packet(Uint8Array.from(live.triggerBefore))
trigger.setDeadzone(replay, { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 })
setTriggerRangeEnabled(replay, true)
setTriggerRange(replay, 'begin', 10); setTriggerRange(replay, 'end', 95)
setTriggerRange(replay, 'beginAnti', 5); setTriggerRange(replay, 'endAnti', 90)
setTriggerPreset(replay, 'quick', 1)
setTriggerRapidMode(replay, 129); setTriggerRapidRange(replay, 17, 10); setTriggerRapidRange(replay, 18, 90)
assert.deepEqual([...replay.bytes], live.triggerReadback, 'generated trigger packet equals actual firmware readback')
assert.deepEqual(live.triggerBefore, live.triggerRestored)
assert.equal(live.beforeProfileSha256, live.restoredProfileSha256)
assert(live.activeProfileUnchanged && live.testVerified && live.originalRestored)
console.log('PASS: actual T3CE 0243 trigger readback fixture and restoration proof')
