import {
  CalMode,
  CalPart,
  CalSub,
  FineCalStep,
  calibrateParts,
  REPORT_LENGTH,
  isFineCalibrationStatus
} from '../src/shared/protocol.ts'
import { decodeInput } from '../src/main/controller.ts'
import { Controller } from '../src/main/controller.ts'

let failures = 0
const check = (name: string, ok: boolean): void => {
  if (ok) console.log(`✓ ${name}`)
  else {
    failures++
    console.error(`✗ ${name}`)
  }
}

const fineEnter = calibrateParts(CalSub.Enter, CalPart.Sticks, CalMode.FineSticks)
check('fine mode command carries target and mode',
  fineEnter.length === REPORT_LENGTH && fineEnter[0] === 0x0f && fineEnter[1] === 0xfe &&
  fineEnter[2] === 0 && fineEnter[3] === 3 && fineEnter[4] === 1)

const fineCommit = calibrateParts(CalSub.Complete, CalPart.Sticks, CalMode.FineSticks)
check('fine commit command', fineCommit[2] === 1 && fineCommit[3] === 3 && fineCommit[4] === 1)

const standard = calibrateParts(CalSub.Enter, CalPart.Sticks)
check('standard mode remains the default', standard[2] === 0 && standard[3] === 3 && standard[4] === 0)
for (const mask of [3, 12, 15, 16]) {
  const expected = new Array(REPORT_LENGTH).fill(0)
  expected.splice(0, 4, 0x0f, 0xfe, 0, mask)
  check(`website WebHID payload matches all bytes for parts ${mask}`,
    calibrateParts(0, mask, CalMode.Standard).every((value, index) => value === expected[index]))
}

const frame = new Uint8Array(REPORT_LENGTH)
frame[0] = 0x12
frame[1] = 128
frame[2] = 128
frame[3] = 128
frame[4] = 128
frame[25] = 3
frame[26] = FineCalStep.Left
frame[31] = 3
frame[32] = 0x80
const decoded = decodeInput(frame)
check('standard calibration accounts for the node-hid report ID prefix',
  decoded?.calibrationMode === 3 && decoded.calibrationPartMask === 0x80)
const idleFrame = frame.slice()
idleFrame[31] = 1
idleFrame[32] = 0
const idleDecoded = decodeInput(idleFrame)
check('standard calibration mode 1 is idle', idleDecoded?.calibrationActive === false)
const tarantulaFrame = frame.slice()
tarantulaFrame[25] = 0
tarantulaFrame[26] = 3
const tarantulaDecoded = decodeInput(tarantulaFrame, 'T3CE')
check('T3CE standard calibration state reads report-ID-inclusive bytes 25/26',
  tarantulaDecoded?.calibrationActive === true && tarantulaDecoded.calibrationPartMask === 3)
check('G7 Pro 8K fine target and completion status decode from bytes 31/32',
  decoded?.fineTarget === 3 && decoded.fineStep === 0x80)
check('G7 Pro 8K does not mistake generic bytes 25/26 for calibration status',
  decoded?.fineTarget !== 3 || decoded.fineStep !== FineCalStep.Left)
check('vendor-valid progress accepts target 3 and steps 0 through 4',
  [0, 1, 2, 3, 4].every((step) => isFineCalibrationStatus(3, step)))
check('vendor-valid completion accepts step 0x80', isFineCalibrationStatus(3, 0x80))
check('ordinary idle 0/0 input is not calibration progress', !isFineCalibrationStatus(0, 0))
check('unexpected fine step is ignored', !isFineCalibrationStatus(3, 5))

const inputListeners = new Set<(raw: Uint8Array) => void>()
const commandOrder: string[] = []
const writes: number[][] = []
const fakeTransport = {
  isOpen: true,
  onResponse: () => () => undefined,
  onError: () => () => undefined,
  onInput: (fn: (raw: Uint8Array) => void) => { inputListeners.add(fn); return () => inputListeners.delete(fn) },
  heartbeat: () => { commandOrder.push('heartbeat') },
  write: (packet: number[]) => { commandOrder.push('write'); writes.push(packet) },
  close: () => undefined
}
const controller = new Controller(fakeTransport as never, () => [])
controller.attachInputDecoder()
const emitStandardStatus = (mode: number, mask: number): void => {
  const report = new Uint8Array(REPORT_LENGTH)
  report[0] = 0x12
  report[1] = report[2] = report[3] = report[4] = 128
  report[31] = mode
  report[32] = mask
  for (const listener of inputListeners) listener(report)
}
const emitStatus = (target: number, step: number): void => {
  const report = new Uint8Array(REPORT_LENGTH)
  report[0] = 0x12
  report[1] = report[2] = report[3] = report[4] = 128
  report[31] = target
  report[32] = step
  for (const listener of inputListeners) listener(report)
}

await controller.calibration(CalSub.Enter, CalPart.Sticks, CalMode.Standard)
check('standard entry uses the website-compatible mode-zero command',
  writes[writes.length - 1]?.[0] === 0x0f && writes[writes.length - 1]?.[1] === 0xfe && writes[writes.length - 1]?.[2] === 0 && writes[writes.length - 1]?.[3] === 3 && writes[writes.length - 1]?.[4] === 0)
let standardCommitRefused = false
try { await controller.calibration(CalSub.Complete, 0, CalMode.Standard) } catch { standardCommitRefused = true }
check('standard calibration cannot commit before controller completion bits arrive', standardCommitRefused)
emitStandardStatus(3, 0)
let falseCompletionRefused = false
try { await controller.calibration(CalSub.Complete, 0, CalMode.Standard) } catch { falseCompletionRefused = true }
check('active mode 3 is not mistaken for a completed stick mask', falseCompletionRefused)
emitStandardStatus(0, CalPart.Sticks)
await controller.calibration(CalSub.Complete, 0, CalMode.Standard)
check('standard completion uses mask zero after the controller confirms both sticks',
  writes[writes.length - 1]?.[2] === CalSub.Complete && writes[writes.length - 1]?.[3] === 0 && writes[writes.length - 1]?.[4] === 0)
emitStandardStatus(1, 0)

const beforeFineEnterOrder = commandOrder.length
const entering = controller.calibration(CalSub.Enter, CalPart.Sticks, CalMode.FineSticks)
await entering
let enterResolved = true
check('vendor heartbeat is sent before calibration enter', commandOrder[beforeFineEnterOrder] === 'heartbeat' && commandOrder[beforeFineEnterOrder + 1] === 'write')
emitStatus(0, 0)
await new Promise((resolve) => setTimeout(resolve, 10))
check('fine calibration start does not block on a status acknowledgement', enterResolved)
emitStatus(3, FineCalStep.Up)
check('fine calibration enter command is sent before progress arrives', writes[0]?.[1] === 0xfe)

emitStatus(3, FineCalStep.Complete)
emitStatus(0, 0)
const committing = controller.calibration(CalSub.Complete, CalPart.Sticks, CalMode.FineSticks)
emitStatus(0, 0)
await committing
check('terminal idle status acknowledges calibration save', writes[1]?.[2] === CalSub.Complete)
controller.disconnect()

if (failures > 0) process.exit(1)
console.log('ALL CALIBRATION TESTS PASSED')
