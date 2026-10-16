import { type Packet } from './profile'

export function bounded(value: number, max = 100): number {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Expected a whole number from 0 to ${max}.`)
  return value
}

/** Connect 1.16.7 G7 Pro CE layout. Only the selected field is changed. */
export function setPercent(p: Packet, offset: number, value: number): void { p.setU8(offset, bounded(value)) }
export function setWindow(p: Packet, start: number, values: number[]): void {
  if (values.length !== 4) throw new Error('Expected input and output windows.')
  values.forEach((v) => bounded(v, 1000))
  if (values[0] >= values[1] || values[2] > values[3]) throw new Error('Minimum must be below maximum.')
  values.forEach((v, i) => p.setU16be(start + i * 2, v))
}
export function curvePoints(p: Packet, offset: number): { x: number; y: number }[] {
  return Array.from({ length: 5 }, (_, i) => ({ x: p.u8(offset + i * 2), y: p.u8(offset + i * 2 + 1) }))
}
export function setCustomCurve(p: Packet, offset: number, points: { x: number; y: number }[]): void {
  if (points.length !== 5) throw new Error('A curve needs five points.')
  points.forEach((pt, i) => { bounded(pt.x, 255); bounded(pt.y, 255); if (i && pt.x <= points[i - 1].x) throw new Error('Input points must increase.'); if (i && pt.y < points[i - 1].y) throw new Error('Output points must not decrease.') })
  if (points[0].x !== 0 || points[0].y !== 0 || points[4].x !== 255 || points[4].y !== 255) throw new Error('Curve endpoints must be 0 and 100%.')
  points.forEach((pt, i) => { p.setU8(offset + i * 2, pt.x); p.setU8(offset + i * 2 + 1, pt.y) })
  p.setBit(offset - 3, 0, true); p.setU8(offset - 2, 3)
}
export function setMotionActivation(packets: Packet[], index: number, value: number): void {
  bounded(index, 1); bounded(value, 3)
  if (value) packets[1 - index].setU8(0, 0)
  packets[index].setU8(0, value)
}
