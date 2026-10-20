// X/Y sensitivity scale: stick map block +24 enable, +27 ratio, +29 output (Connect map_module).
import { readFileSync } from 'node:fs'
import { describeProfileChanges } from '../src/shared/review'
import { Packet, parseProfile, serializeProfile, stick } from '../src/shared/profile'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}

const changed = (a: Uint8Array, b: Uint8Array): number[] => [...a].flatMap((v, i) => (v === b[i] ? [] : [i]))

for (const side of [0, 1] as const) {
  const p = new Packet(new Uint8Array(36))
  const before = p.bytes.slice()
  stick.setAxisScale(p, side, 30)
  check(`stick ${side}: unmapped gets map_en and its own output`, stick.mapped(p) && stick.mapIndex(p) === side + 1 && stick.axisRatio(p) === 30)
  check(`stick ${side}: only +24/+27/+29 change`, JSON.stringify(changed(before, p.bytes)) === '[24,27,29]')
}

const mouse = new Packet(new Uint8Array(36))
stick.setMapped(mouse, true)
stick.setMapIndex(mouse, 4)
stick.setAxisScale(mouse, 1, 70)
check('Mouse-mapped stick keeps output 4', stick.mapIndex(mouse) === 4 && stick.axisRatio(mouse) === 70)

const clamp = new Packet(new Uint8Array(36))
stick.setAxisScale(clamp, 0, 140)
check('ratio clamps to 100', stick.axisRatio(clamp) === 100)
stick.setAxisScale(clamp, 0, -5)
check('ratio clamps to 0', stick.axisRatio(clamp) === 0)

const pad = new Uint8Array(readFileSync('fixtures/profile-reset/T3CE.bin'))
const staged = parseProfile(pad, 'T3CE')
const was = stick.axisScale(staged.sticks[1])
stick.setAxisScale(staged.sticks[1], 1, 30)
const items = describeProfileChanges(pad, serializeProfile(staged), 'T3CE')
check('review reports the right-stick scale', items.some((i) => i.key === 'review.axisScale' && i.stick === 1 && i.from === String(was) && i.to === '30'))
const unmapped = new Packet(new Uint8Array(36))
check('unmapped stick reads as balanced 50', stick.axisScale(unmapped) === 50)
console.log('ALL AXIS SCALE TESTS PASSED')
