// Hold-to-switch curve: Shift key mapping on buttons/triggers and the Shift layer build.
import { readFileSync } from 'node:fs'
import { buildShiftLayer, holdKeepsOriginal, holdKeyOf, holdKeysOf, HOLD_KEYS, setHoldKey, setHoldKeys } from '../src/shared/shiftlayer'
import { button, parseProfile, serializeProfile, stick, trigger } from '../src/shared/profile'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}
const changed = (a: Uint8Array, b: Uint8Array): number[] => [...a.keys()].filter((i) => a[i] !== b[i])

for (const model of ['G7ProCE', 'T3CE']) {
  const base = new Uint8Array(readFileSync(`fixtures/profile-reset/${model}.bin`))
  const p = parseProfile(base, model)
  check(`${model}: reset profile has no hold key`, holdKeyOf(p) === null)

  setHoldKey(p, 'R2')
  const r2 = serializeProfile(p)
  const geo = model === 'T3CE' ? 0x6a1 : 0x354
  check(`${model}: R2 → Shift writes trigger +11/+12 like Connect`, r2[geo + 32 + 11] === 1 && r2[geo + 32 + 12] === 231 && holdKeyOf(parseProfile(r2, model)) === 'R2')
  check(`${model}: R2 touches only its map bytes and shift_en`, changed(base, r2).every((o) => (o >= geo + 32 + 11 && o <= geo + 32 + 14) || o === 0x20 + 9) && r2[0x20 + 9] === 1)

  for (const key of HOLD_KEYS) {
    const q = parseProfile(r2, model)
    setHoldKey(q, key)
    const shiftCount = [...q.buttons, ...q.functionKeys].filter((b) => button.mapValues(b)[0] === 231).length + q.triggers.filter((t) => trigger.mapped(t) && trigger.mapValues(t)[0] === 231).length
    check(`${model}: switching to ${key} leaves exactly one Shift key`, holdKeyOf(q) === key && shiftCount === 1)
  }

  const keep = parseProfile(base, model)
  setHoldKey(keep, 'L2', true)
  const kb = serializeProfile(keep)
  check(`${model}: L2 + Shift keeps L2 (19) and adds Shift (231)`, kb[geo + 11] === 1 && kb[geo + 12] === 19 && kb[geo + 13] === 231 && holdKeyOf(keep) === 'L2' && holdKeepsOriginal(keep, 'L2'))
  setHoldKey(keep, null)
  check(`${model}: clearing L2 + Shift restores the original bytes`, changed(base, serializeProfile(keep)).length === 0)

  const both = parseProfile(base, model)
  setHoldKeys(both, ['L2', 'R2'], true)
  const bb = serializeProfile(both)
  check(`${model}: L2 and R2 can both be Shift (each keeps its own output)`, bb[geo + 12] === 19 && bb[geo + 13] === 231 && bb[geo + 32 + 12] === 20 && bb[geo + 32 + 13] === 231 && JSON.stringify(holdKeysOf(parseProfile(bb, model))) === '["L2","R2"]')
  setHoldKeys(both, ['R2'], true)
  check(`${model}: dropping L2 leaves only R2 as Shift`, JSON.stringify(holdKeysOf(both)) === '["R2"]')
  setHoldKeys(both, [])
  check(`${model}: clearing both restores the original bytes`, changed(base, serializeProfile(both)).length === 0)

  const off = parseProfile(r2, model)
  setHoldKey(off, null)
  check(`${model}: Off restores the original bytes`, changed(base, serializeProfile(off)).length === 0)

  const curve = [{ x: 0, y: 0 }, { x: 64, y: 30 }, { x: 128, y: 80 }, { x: 191, y: 160 }, { x: 255, y: 255 }]
  const layer = parseProfile(buildShiftLayer(r2, model, curve), model)
  check(`${model}: Shift layer has the held curve on the right stick`, JSON.stringify(stick.curve(layer.sticks[1])) === JSON.stringify(curve))
  check(`${model}: Shift layer keeps the left stick and has no Shift key`, Buffer.from(layer.sticks[0].bytes).equals(Buffer.from(p.sticks[0].bytes)) && holdKeyOf(layer) === null && layer.name === 'Shift')
}

console.log('ALL SHIFT LAYER TESTS PASSED')
