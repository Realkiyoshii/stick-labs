// Review before Write: readable change list between pad bytes and the staged blob.
import { readFileSync } from 'node:fs'
import { describeProfileChanges } from '../src/shared/review'
import { parseProfile, serializeProfile, stick } from '../src/shared/profile'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}

for (const model of ['G7ProCE', 'T3CE']) {
  const pad = new Uint8Array(readFileSync(`fixtures/profile-reset/${model}.bin`))
  check(`${model}: identical bytes report nothing`, describeProfileChanges(pad, pad.slice(), model).length === 0)

  const staged = parseProfile(pad, model)
  stick.setLinearModule(staged.sticks[1], true, 2, 60)
  stick.setDeadzone(staged.sticks[0], { ...stick.deadzone(staged.sticks[0]), begin: 30 })
  const items = describeProfileChanges(pad, serializeProfile(staged), model)
  check(`${model}: right-stick Delay 60 reported`, items.some((i) => i.key === 'review.curveMode' && i.stick === 1 && i.to === 'delay:60'))
  check(`${model}: left deadzone reported as percent`, items.some((i) => i.key === 'review.deadzone' && i.stick === 0 && i.to?.startsWith('3.0%')))
  check(`${model}: untouched sections stay quiet`, items.every((i) => i.stick !== undefined))

  const buttons = parseProfile(pad, model)
  buttons.buttons[0].bytes[1] ^= 1
  check(`${model}: button change named, not dumped`, JSON.stringify(describeProfileChanges(pad, serializeProfile(buttons), model)) === JSON.stringify([{ key: 'review.buttons' }]))
}
console.log('ALL REVIEW TESTS PASSED')
