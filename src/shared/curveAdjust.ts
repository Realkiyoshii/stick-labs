/** GameSir Connect's range endpoints, in its 0–1000 deadzone units. */
export interface CurvePoint { x: number; y: number }
export interface CurveZones { begin: number; end: number; beginAnti: number; endAnti: number }

/** GameSir Connect "Curve Adjustment" types, stored at stick +12; curvature 0–100 at +13. */
export const CURVE_TYPES = [
  { id: 0, key: 'linear' },
  { id: 1, key: 'smooth' },
  { id: 2, key: 'delay' },
  { id: 3, key: 'custom' }
] as const

/** Connect's slider only applies to Smooth and Delay. */
export function curveTypeHasSlider(type: number): boolean {
  return type === 1 || type === 2
}

/**
 * Connect's preview of a Linear/Smooth/Delay curve, in display percent:
 * a cubic Bézier from Point 1 to Point 7 whose control points follow
 * Connect 1.16.7's DeadzoneIndicator (curvature / 100 against half ranges).
 */
export function connectCurvePreview(type: number, curvature: number, zones: CurveZones, samples = 48): CurvePoint[] {
  const p0 = { x: zones.begin / 10, y: zones.beginAnti / 10 }
  const p3 = { x: zones.end / 10, y: zones.endAnti / 10 }
  const c = Math.max(0, Math.min(100, curvature)) / 100
  const hx = (p3.x - p0.x) / 2
  const hy = (p3.y - p0.y) / 2
  let c1 = p0
  let c2 = p3
  if (type === 1) c1 = { x: p0.x + hx * c, y: p0.y + hy * (1 - c) }
  if (type === 2) c1 = { x: p0.x + hx * (1 - c), y: p0.y + hy * c }
  if (type === 1 || type === 2) c2 = { x: p3.x - hx * (1 - c), y: p3.y - hy * c }
  const out: CurvePoint[] = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const u = 1 - t
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y
    })
  }
  return out
}
