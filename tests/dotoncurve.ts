// Live dot: output magnitude and its position read back off the drawn curve.
import { connectCurvePreview } from '../src/shared/curveAdjust'
import { dotOnCurve, stickOutputMagnitude } from '../src/shared/liveDot'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}

const full = { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 }
const diagonal = [{ x: 0, y: 0 }, { x: 64, y: 64 }, { x: 128, y: 128 }, { x: 191, y: 191 }, { x: 255, y: 255 }]

check('rest is zero', stickOutputMagnitude(128, 128) === 0)
check('full deflection is one', stickOutputMagnitude(255, 128) === 1 && stickOutputMagnitude(0, 0) === 1)
const mid = dotOnCurve(diagonal, 0.5, full)
check('diagonal: input equals output', !!mid && Math.abs(mid.x - mid.y) < 1e-9 && Math.abs(mid.y - 127.5) < 1e-9)

const smooth = connectCurvePreview(1, 100, full, 400).map((p) => ({ x: p.x * 2.55, y: p.y * 2.55 }))
const sample = smooth[300]
const back = dotOnCurve(smooth, sample.y / 255, full)
check('Smooth 100: inferred input matches the curve', !!back && Math.abs(back.x - sample.x) < 0.5)

const zero = dotOnCurve(diagonal, 0, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 })
check('no output sits at the curve start', !!zero && zero.x === 0 && zero.y === 0)
const capped = dotOnCurve(diagonal, 1, { begin: 0, end: 1000, beginAnti: 0, endAnti: 800 })
check('output past max output stays at the curve end', !!capped && capped.x === 255 && capped.y === 255)
console.log('ALL LIVE DOT TESTS PASSED')
