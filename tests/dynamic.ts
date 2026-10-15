// CoD-style Dynamic preset: byte shape + write-path quantization, pinned.
import { AIM_CURVES } from '../src/renderer/App'
import { resampleCurve } from '../src/shared/sticklab'

let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.log(`✗ FAIL: ${name}`)
    failed++
  }
}

const dyn = AIM_CURVES.dynamic
check('dynamic exists', !!dyn && dyn.label === 'Dynamic (CoD)')
const zam = AIM_CURVES.zamilitox
check('zamilitox exists', !!zam && zam.label === 'Zamilitox')
check(
  'zamilitox 7 points, ordered, pinned ends',
  zam.pts.length === 7 &&
    zam.pts[0].x === 0 && zam.pts[0].y === 0 &&
    zam.pts[6].x === 255 && zam.pts[6].y === 255 &&
    zam.pts.every((p, i) => p.x >= 0 && p.x <= 255 && p.y >= 0 && p.y <= 255 && (i === 0 || p.x > zam.pts[i - 1].x))
)
check(
  'zamilitox hot-start S shape',
  zam.pts[1].y > zam.pts[1].x && zam.pts[3].y === zam.pts[3].x && zam.pts[4].y < zam.pts[4].x
)
const pts = dyn.pts
// byte-safe: 5 pts, x strictly ascending in 0..255, y in 0..255, endpoints pinned
check('dynamic 5 points', pts.length === 5)
check('dynamic endpoints', pts[0].x === 0 && pts[0].y === 0 && pts[4].x === 255 && pts[4].y === 255)
check(
  'dynamic x-ordered in range',
  pts.every((p, i) => p.x >= 0 && p.x <= 255 && p.y >= 0 && p.y <= 255 && (i === 0 || p.x > pts[i - 1].x))
)
// reversed-S vs linear, digitized from the game's chart: hot above the
// diagonal early, crossing at mid, settled below it late
const lin = (x: number): number => x
check('dynamic hot start', pts[1].y > lin(pts[1].x))
check('dynamic crosses at mid', Math.abs(pts[2].y - lin(pts[2].x)) <= 5)
check('dynamic settled late', pts[3].y < lin(pts[3].x))
// what actually gets written: linear-mode resample of the design
const q = resampleCurve(pts.map((p) => ({ ...p })))
check('dynamic quantizes to 5 pad points', q.length === 5)
check(
  'dynamic quantized bytes exact',
  JSON.stringify(q) === JSON.stringify(resampleCurve([{ x: 0, y: 0 }, { x: 64, y: 89 }, { x: 128, y: 128 }, { x: 191, y: 173 }, { x: 255, y: 255 }]))
)
check('dynamic quantized monotonic', q.every((p, i) => i === 0 || (p.x >= q[i - 1].x && p.y >= q[i - 1].y)))

if (failed > 0) {
  console.error(`${failed} FAILURES`)
  process.exit(1)
} else console.log('ALL DYNAMIC TESTS PASSED')
