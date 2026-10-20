// Live dot on the curve graph. The 0x12 input report carries the pad's
// processed output (after deadzone and curve), so the dot's height is real
// and its input position is read back off the drawn curve.

export interface Point { x: number; y: number }
/** Stick deadzone fields, 0–1000 units (see `stick.deadzone`). */
export interface Zones { begin: number; end: number; beginAnti: number; endAnti: number }

/** Radial deflection of a 0–255 stick sample, 0 at centre to 1 at full. */
export function stickOutputMagnitude(x: number, y: number): number {
  const r = Math.hypot(x - 128, y - 128) / 127
  return Math.max(0, Math.min(1, r))
}

/**
 * Where `output` (0–1) sits on `line` (0–255 plot space, ascending x).
 * Output is mapped through the anti-deadzone range into curve space, then the
 * first segment that reaches that height gives the inferred input.
 */
export function dotOnCurve(line: ReadonlyArray<Point>, output: number, zones: Zones): Point | null {
  if (line.length < 2) return null
  const lo = zones.beginAnti / 1000
  const hi = zones.endAnti / 1000
  const span = hi - lo
  const level = span > 0 ? Math.max(0, Math.min(1, (output - lo) / span)) : 0
  const y = level * 255
  if (y <= line[0].y) return { x: line[0].x, y: line[0].y }
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    if (y <= b.y) {
      const t = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y)
      return { x: a.x + t * (b.x - a.x), y }
    }
  }
  const last = line[line.length - 1]
  return { x: last.x, y: last.y }
}
