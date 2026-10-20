// GameSir Connect Curve Adjustment: type at +12, strength at +13, preview math.
import { connectCurvePreview, curveTypeHasSlider } from '../src/shared/curveAdjust'
import { Packet, stick } from '../src/shared/profile'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}

const zones = { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 }
const pts = [{ x: 26, y: 48 }, { x: 71, y: 89 }, { x: 128, y: 128 }, { x: 184, y: 166 }, { x: 230, y: 204 }]
const p = new Packet(new Uint8Array(36))
stick.setCurve(p, pts)
stick.setLinearModule(p, true, 2, 37)
check('type and strength land in +11/+12/+13, points untouched', p.bit(11, 0) && p.u8(12) === 2 && p.u8(13) === 37 &&
  JSON.stringify(stick.curve(p)) === JSON.stringify(pts))
check('slider only for Smooth and Delay', [0, 1, 2, 3].map(curveTypeHasSlider).join() === 'false,true,true,false')
check('linear preview is the diagonal', connectCurvePreview(0, 100, zones).every(q => Math.abs(q.x - q.y) < 1e-9))
const at = (type: number, c: number, x: number): number => connectCurvePreview(type, c, zones, 400).reduce((a, q) => Math.abs(q.x - x) < Math.abs(a.x - x) ? q : a).y
check('both shapes are linear at strength 50', Math.abs(at(1, 50, 50) - 50) < 0.5 && Math.abs(at(2, 50, 50) - 50) < 0.5)
check('smooth: low strength boosts, high strength slows', at(1, 0, 50) > 80 && at(1, 100, 50) < 20)
check('delay: S-curve pinned at 50, low strength slows the centre', at(2, 0, 25) < 15 && at(2, 100, 25) > 35)
console.log('ALL CURVE ADJUST TESTS PASSED')
