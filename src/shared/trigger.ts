import { Packet, trigger } from './profile'

export type TriggerPoint = { x: number; y: number }
export type TriggerRangeField = 'begin' | 'end' | 'beginAnti' | 'endAnti'
export const TRIGGER_PRESETS = ['default', 'quick', 'precise', 'steady', 'digital', 'dynamic', 'custom'] as const
export type TriggerPreset = typeof TRIGGER_PRESETS[number]
// Observed preset parameters from Cluck Hub's public trigger implementation.
// Entries are [x, y, adjustment delta x, adjustment delta y].
const CONTROL: Record<Exclude<TriggerPreset, 'custom'>, number[][]> = {
  default: [[0, 0], [128, 128], [196, 196], [225, 225]],
  quick: [[0, 0], [38, 38], [107, 167, -3, 5.5], [255, 255]],
  precise: [[0, 0], [85, 40, 3, -3.5], [149, 83, 3, -6.5], [206, 140, 2, -7.5]],
  steady: [[0, 0], [57, 57, -1, -1], [100, 127, -4, -0.5], [210, 152, 2.5, -5.5]],
  digital: [[0, 0], [38, 38], [38, 165, 0, 18], [255, 255]],
  dynamic: [[0, 0], [82, 40, 2.5, -3.5], [161, 213, -4.5, 3], [255, 255]]
}
const byte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const assertPacket = (p: Packet): void => { if (p.length !== 32) throw new Error('Invalid trigger packet') }
export function triggerPresetPoints(preset: Exclude<TriggerPreset, 'custom'>, adjustment = 0): TriggerPoint[] {
  if (!CONTROL[preset] || !Number.isInteger(adjustment) || adjustment < -5 || adjustment > 5) throw new Error('Invalid trigger preset')
  const amount = preset === 'default' ? 0 : adjustment
  const points = CONTROL[preset].map(([x, y, dx = 0, dy = 0]) => ({
    x: Math.round(byte(x + dx * amount) * 1000 / 255),
    y: Math.round(byte(y + dy * amount) * 1000 / 255)
  }))
  let longest = -1; let insert = 0
  for (let i = 0; i < 3; i++) {
    const gap = Math.max(0, points[i + 1].x - points[i].x)
    if (gap > longest) { longest = gap; insert = i }
  }
  const a = points[insert]; const b = points[insert + 1]
  points.splice(insert + 1, 0, { x: Math.floor((a.x + b.x) / 2), y: Math.floor((a.y + b.y) / 2) })
  points[0] = { x: 0, y: 0 }; points[4] = { x: 1000, y: 1000 }
  const result = points.map(p => ({ x: byte(p.x * 255 / 1000), y: byte(p.y * 255 / 1000) }))
  for (const axis of ['x', 'y'] as const) for (let i = 1; i < 4; i++) {
    result[i][axis] = Math.max(result[i - 1][axis] + 1, Math.min(255 - (4 - i), result[i][axis]))
  }
  return result
}
export function readTriggerCurve(p: Packet): TriggerPoint[] {
  assertPacket(p)
  return Array.from({ length: 5 }, (_, i) => ({ x: p.u8(22 + i * 2), y: p.u8(23 + i * 2) }))
}
export function validTriggerCurve(points: TriggerPoint[]): boolean {
  return points.length === 5 && points.every((p, i) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 255 && p.y >= 0 && p.y <= 255 && (!i || (p.x > points[i - 1].x && p.y > points[i - 1].y)))
}
export function visibleTriggerCurve(p: Packet): TriggerPoint[] {
  return p.u8(19) ? readTriggerCurve(p) : triggerPresetPoints('default')
}
export function identifyTriggerPreset(points: TriggerPoint[]): { preset: TriggerPreset; adjustment: number } {
  if (points.length === 5 && points.every((p, i) => p.x === p.y && (!i || p.x > points[i - 1].x))) return { preset: 'default', adjustment: 0 }
  for (const preset of TRIGGER_PRESETS) {
    if (preset === 'default' || preset === 'custom') continue
    for (let adjustment = -5; adjustment <= 5; adjustment++) {
      if (triggerPresetPoints(preset, adjustment).every((p, i) => p.x === points[i]?.x && p.y === points[i]?.y)) return { preset, adjustment }
    }
  }
  return { preset: 'custom', adjustment: 0 }
}
function writePoints(p: Packet, points: TriggerPoint[]): void {
  p.setU8(19, 1); p.setU8(20, 3); p.setU8(21, 100)
  points.forEach((v, i) => { p.setU8(22 + i * 2, v.x); p.setU8(23 + i * 2, v.y) })
}
export function setTriggerPreset(p: Packet, preset: TriggerPreset, adjustment = 0): void {
  assertPacket(p)
  if (preset !== 'custom') { writePoints(p, triggerPresetPoints(preset, adjustment)); return }
  const points = readTriggerCurve(p)
  if (!validTriggerCurve(points)) writePoints(p, [0, 64, 128, 191, 255].map(v => ({ x: v, y: v })))
  else writePoints(p, points)
  p.setU8(22, 0); p.setU8(23, 0); p.setU8(30, 255); p.setU8(31, 255)
}
export function setTriggerPoint(p: Packet, index: number, percent: TriggerPoint): void {
  assertPacket(p)
  if (!Number.isInteger(index) || index <= 0 || index >= 4 || ![percent.x, percent.y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) throw new Error('Invalid trigger curve point')
  const points = visibleTriggerCurve(p)
  const point = { x: Math.round(percent.x * 255 / 100), y: Math.round(percent.y * 255 / 100) }
  for (const axis of ['x', 'y'] as const) if (point[axis] <= points[index - 1][axis] || point[axis] >= points[index + 1][axis]) throw new Error('Trigger points must increase on both axes')
  if (!p.u8(19)) setTriggerPreset(p, 'default')
  p.setU8(22 + index * 2, point.x); p.setU8(23 + index * 2, point.y)
  p.setU8(19, 1); p.setU8(20, 3)
}
export function setTriggerRangeEnabled(p: Packet, enabled: boolean): void {
  assertPacket(p)
  p.setU8(2, enabled ? 1 : 0)
  if (enabled) {
    const d = trigger.deadzone(p)
    if (d.begin >= d.end) { p.setU16be(3, 0); p.setU16be(5, 1000) }
    if (d.beginAnti >= d.endAnti) { p.setU16be(7, 0); p.setU16be(9, 1000) }
  }
}
export function setTriggerRange(p: Packet, field: TriggerRangeField, percent: number): void {
  assertPacket(p)
  const d = trigger.deadzone(p); const wire = Math.round(percent * 10)
  const next = { ...d, [field]: percent * 10 }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || next.begin >= next.end || next.beginAnti >= next.endAnti) throw new Error('Start must be below end; range is 0–100%')
  p.setU8(2, 1)
  p.setU16be(({ begin: 3, end: 5, beginAnti: 7, endAnti: 9 })[field], wire)
}
export function setTriggerRapidMode(p: Packet, mode: number): void {
  assertPacket(p)
  if (![0, 129, 130].includes(mode)) throw new Error('Invalid rapid trigger mode')
  p.setU8(16, mode)
}
export function setTriggerRapidRange(p: Packet, offset: 17 | 18, percent: number): void {
  assertPacket(p)
  if (![17, 18].includes(offset) || !Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('Rapid trigger range is 1–100%')
  p.setU8(offset, percent)
}
