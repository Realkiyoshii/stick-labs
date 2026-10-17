import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildCleanProfile } from '../src/shared/clean-profile'
import { parseProfile, serializeProfile, stick, trigger, fun } from '../src/shared/profile'
for (const [model, length] of [['G7ProCE', 1070], ['T3CE', 1935]] as const) {
  const input = new Uint8Array(length).fill(0xa5)
  const saved = input.slice()
  const result = buildCleanProfile(input, model)
  const reference = new Uint8Array(readFileSync(`fixtures/profile-reset/${model}.bin`))
  reference.set(input.subarray(0x33, 0x40), 0x33)
  assert.deepEqual(result, reference, 'whole profile equals pure vendor encoder plus preserved reserved bytes')
  assert.deepEqual(input, saved, 'input is immutable')
  assert.deepEqual(buildCleanProfile(result, model), result, 'reset is idempotent')
  const profile = parseProfile(result, model)
  assert.deepEqual(serializeProfile(profile), result, 'full codec round trip')
  assert.equal(profile.name, 'Stick Labs Clean')
  for (const p of profile.sticks) {
    assert.equal(stick.isIdentityCurve(p), true)
    assert.equal(stick.squareGate(p), false)
    assert.deepEqual(stick.deadzone(p), { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 })
  }
  for (const p of profile.buttons) assert(p.bytes.every(v => v === 0), 'all standard bindings cleared')
  for (const p of profile.functionKeys) assert.equal(p.u8(10), 0, 'all macros cleared')
  for (const p of profile.triggers) {
    assert.deepEqual(trigger.deadzone(p), { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 })
    assert.equal(trigger.quickTrigger.status(p), 0)
  }
  for (const p of profile.motion) assert.equal(p.u8(0), 0, 'gyro activation disabled')
  assert.equal(fun.extend.shiftEnable(profile.funData), false)
  console.log(model + ': byte-exact neutral reference, no layering, idempotence, isolation, roundtrip passed')
}
assert.throws(() => buildCleanProfile(new Uint8Array(680), 'C2'))
assert.throws(() => buildCleanProfile(new Uint8Array(1070), 'T3CE'))
