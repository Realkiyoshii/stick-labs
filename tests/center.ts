import assert from 'node:assert/strict'
import { Controller, decodeInput } from '../src/main/controller'
import { centerNudge, centerPreview, checkCenterAck, type CenterDirection } from '../src/shared/center'

for (const side of [0, 1]) {
  for (const [direction, value] of Object.entries({ left: 0, right: 1, up: 2, down: 3 })) {
    const report = centerNudge(side, direction as CenterDirection)
    assert.equal(report.length, 64)
    assert.deepEqual(report.slice(0, 6), [15, 226, side, value, 0, 32])
    assert(report.slice(6).every((v) => v === 0))
  }
}
assert.throws(() => centerNudge(2, 'left'))
assert.throws(() => centerNudge(0, 'constructor' as CenterDirection))
assert.throws(() => centerNudge(0, 'diagonal' as CenterDirection))
const raw = new Uint8Array(64)
raw[0] = 0x12
for (let i = 0; i < 4; i++) raw[54 + i] = 128
assert.deepEqual(centerPreview(raw), { lx: 0, ly: 0, rx: 0, ry: 0 })
raw[26] = 1
assert.equal(centerPreview(raw)!.lx, 1 / 32767, 'preserves the original low byte')
raw[55] = 0
raw[56] = 255; raw[28] = 255
assert.equal(centerPreview(raw)!.ly, -1)
assert.equal(centerPreview(raw)!.rx, 1)
assert.equal(centerPreview(raw.slice(0, 63)), undefined)
checkCenterAck(Uint8Array.from([0x10, 0xe3, 0]))
for (const bytes of [[0x10, 0xe3, 1], [0x10, 6, 0], [0x10, 0xe3], [0x12, 0xe3, 0]]) {
  assert.throws(() => checkCenterAck(Uint8Array.from(bytes)))
}
console.log('Center offsets: eight commands, input validation, original-axis precision and acknowledgment handling passed.')

// Exercise the real session method with a fake request; never open a HID device.
const controller = Object.create(Controller.prototype) as Controller
let requests = 0
controller.request = async (report, matches, timeout) => {
  requests++
  assert.deepEqual(report, centerNudge(1, 'right'))
  assert.equal(timeout, 2000)
  const reply = Uint8Array.from([0x10, 0xe3, 0])
  assert(matches({ type: 0xe3, name: 'Unknown', raw: reply }))
  assert(!matches({ type: 6, name: 'Ack', raw: Uint8Array.from([0x10, 6, 0]) }))
  return reply
}
await controller.adjustCenter(1, 'right')
assert.equal(requests, 1)
await assert.rejects(controller.adjustCenter(2, 'right'), /Select left or right/)
assert.equal(requests, 1, 'invalid arguments must not send a command')
controller.request = async () => Uint8Array.from([0x10, 0xe3, 1])
await assert.rejects(controller.adjustCenter(0, 'up'), /rejected/)
controller.request = async () => { requests++; throw new Error('timeout') }
await assert.rejects(controller.adjustCenter(0, 'up'), /outcome is unknown.*timeout/)
assert.equal(requests, 2, 'an uncertain command must never be retried automatically')
assert.deepEqual(decodeInput(raw)?.centerRaw, centerPreview(raw))
console.log('Center session: dedicated reply, rejection, unknown outcome without retry, and live-axis forwarding passed.')
