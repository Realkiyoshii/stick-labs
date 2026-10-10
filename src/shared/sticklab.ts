/**
 * Stick Lab helpers — insane stick configuration on top of the proven codec.
 *
 * Hardware truth (see docs in g7-forge):
 * - stick resolution wire byte (Fun_Data +16) = 12 - bits, so 0..4 = 12..8 bit.
 *   12-bit = 4096 levels is the ADC max. Anything beyond is raw-byte
 *   experimentation, not a supported mode — the UI must say so.
 * - RC filter wire byte (Fun_Data +17/+18) = level + 11 (1..21), level -10..+10,
 *   0 = off. Wire 0 = never-written default (treated as 0/off).
 */

/** Standard hardware range. */
export const BITS_MIN = 8
export const BITS_MAX = 12

export function bitsToLevels(bits: number): number {
  return 2 ** Math.round(bits)
}

export function bitsToStep(bits: number): number {
  return 65536 / bitsToLevels(bits)
}

/** Wire byte for a standard bit depth. */
export function bitsToWire(bits: number): number {
  return 12 - Math.max(BITS_MIN, Math.min(BITS_MAX, Math.round(bits)))
}

/** Effective bits implied by a raw wire byte (may be outside 8-12). */
export function wireToBits(wire: number): number {
  return 12 - (wire & 0xff)
}

/** Wire byte implied by a requested bit depth, even past silicon (wraps u8). */
export function bitsToWireRaw(bits: number): number {
  return (12 - Math.round(bits)) & 0xff
}

/** Beyond-silicon quick picks — experimental, firmware will clamp/ignore. */
export const EXTENDED_BITS: ReadonlyArray<number> = [13, 14, 16]

export interface RawResolutionInfo {
  wire: number
  bits: number
  levels: number
  step: number
  standard: boolean
  label: string
}

export function describeRawResolution(wire: number): RawResolutionInfo {
  const w = Math.max(0, Math.min(255, Math.round(wire)))
  const bits = wireToBits(w)
  const standard = w >= 0 && w <= 4
  let levels: number
  let step: number
  let label: string
  if (bits >= 1 && bits <= 16) {
    levels = 2 ** bits
    step = 65536 / levels
    label = `${bits}-bit · ${levels.toLocaleString()} levels · step ${step}`
  } else {
    levels = NaN
    step = NaN
    label = `wire ${w} → ${bits}-bit (out of ADC range — experimental)`
  }
  return { wire: w, bits, levels, step, standard, label }
}

// ---------------------------------------------------------------------------
// RC filter model
// ---------------------------------------------------------------------------

export const RC_MIN = -10
export const RC_MAX = 10

export function rcLevelToWire(level: number): number {
  return Math.max(1, Math.min(21, Math.round(level) + 11))
}

export function rcWireToLevel(wire: number): number {
  if ((wire & 0xff) === 0) return 0
  return Math.max(RC_MIN, Math.min(RC_MAX, (wire & 0xff) - 11))
}

export interface RawRcInfo {
  wire: number
  level: number
  standard: boolean
  label: string
}

export function describeRawRc(wire: number): RawRcInfo {
  const w = Math.max(0, Math.min(255, Math.round(wire)))
  const standard = (w >= 1 && w <= 21) || w === 0
  const level = rcWireToLevel(w)
  const label =
    w === 0
      ? 'wire 0 = never-written default (treated as 0/off)'
      : standard
        ? `level ${level > 0 ? `+${level}` : `${level}`}${level === 0 ? ' (off)' : ''}`
        : `wire ${w} → level ${level} clamped (experimental, outside 1..21)`
  return { wire: w, level, standard, label }
}

/**
 * EMA smoothing factor for preview only. Maps level 0 → no smoothing
 * (alpha 1) and +10 → heavy (alpha ~0.15). Negative levels (sharpen) are
 * shown as alpha > 1 anticipation — visual aid, not firmware math.
 */
export function rcAlpha(level: number): number {
  if (level <= 0) return 1
  return Math.max(0.12, 1 - level * 0.088)
}

/** Step response preview: raw step vs EMA-smoothed step over N frames. */
export function rcStepResponse(level: number, frames = 60): number[] {
  const alpha = rcAlpha(level)
  const out: number[] = []
  let y = 0
  for (let i = 0; i < frames; i++) {
    const target = i < 8 ? 0 : 1
    y += alpha * (target - y)
    out.push(y)
  }
  return out
}

/** X grid of the 5 firmware curve slots (bytes +14..+23). */
export const HW_CURVE_XS: ReadonlyArray<number> = [0, 64, 128, 191, 255]

export const DESIGN_MIN_POINTS = 2
export const DESIGN_MAX_POINTS = 10

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

/**
 * Resample a free-point design polyline down to the 5 firmware slots.
 *
 * The pad stores exactly 5 (x, y) pairs, so a design with more/fewer points
 * is piecewise-linearly interpolated at the hardware X grid. Fewer points in
 * → same math, no special cases. A degenerate design (<2 distinct points)
 * falls back to linear.
 */
export function resampleCurve(
  design: Array<{ x: number; y: number }>,
  xs: ReadonlyArray<number> = HW_CURVE_XS
): Array<{ x: number; y: number }> {
  const pts = [...design]
    .map((p) => ({ x: clampByte(p.x), y: clampByte(p.y) }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x)
  if (pts.length < 2) return HW_CURVE_XS.map((x) => ({ x, y: x }))
  const at = (x: number): number => {
    if (x <= pts[0].x) return pts[0].y
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].x) {
        const a = pts[i - 1]
        const b = pts[i]
        const t = (x - a.x) / (b.x - a.x)
        return a.y + t * (b.y - a.y)
      }
    }
    return pts[pts.length - 1].y
  }
  return xs.map((x) => ({ x, y: clampByte(at(x)) }))
}

/** Insert a point at the middle of the longest segment (up to MAX). */export function addDesignPoint(design: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (design.length >= DESIGN_MAX_POINTS) return design
  const pts = [...design].sort((a, b) => a.x - b.x)
  let best = 0
  let bestGap = -1
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].x - pts[i - 1].x
    if (gap > bestGap) {
      bestGap = gap
      best = i
    }
  }
  const a = pts[best - 1] ?? { x: 0, y: 0 }
  const b = pts[best] ?? { x: 255, y: 255 }
  const mid = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
  return [...pts.slice(0, best), mid, ...pts.slice(best)]
}

export const RC_PRESETS: ReadonlyArray<{ name: string; level: number; hint: string }> = [
  { name: 'Raw −10', level: -10, hint: 'most jitter, sharpest' },
  { name: 'Crisp −5', level: -5, hint: 'light jitter, fast' },
  { name: 'Off 0', level: 0, hint: 'no filtering — the centre start point' },
  { name: 'Light +3', level: 3, hint: 'tiny smoothing' },
  { name: 'Balanced +5', level: 5, hint: 'default feel' },
  { name: 'Heavy +8', level: 8, hint: 'calm, slight lag' },
  { name: 'Max +10', level: 10, hint: 'smoothest, laggiest' }
]

/**
 * Outer threshold as a signed buffer %, Steam-style:
 * "width of the outer buffer defining the boundary of max stick input".
 *
 * Positive buffer B: max output starts at (100−B)% deflection — hotter rim.
 *   → End = (100−B)%, output ceiling untouched.
 * Negative buffer −B: max output is soft-capped at (100−B)% — tames the rim,
 *   exactly the zone where extra yaw/pitch-style effects bite.
 *   → End stays 100%, output ceiling (endAnti) = (100−B)%.
 * Zero / infinite: no software boundary — the pad's full physical range.
 *   → End 100%, ceiling 100%. "Infinite" is just these neutral bytes.
 *
 * All values in percent; bytes are tenths. begin/beginAnti untouched.
 */
export const OUTER_MIN = -100
export const OUTER_MAX = 95

export function outerBufferToBytes(bufferPct: number): { end: number; endAnti: number } {
  const b = Math.max(OUTER_MIN, Math.min(OUTER_MAX, bufferPct))
  if (b >= 0) return { end: Math.round((100 - b) * 10), endAnti: 1000 }
  return { end: 1000, endAnti: Math.round((100 + b) * 10) }
}

/** Recover the buffer from pad bytes. Neutral (1000/1000) reads as 0 = unlimited. */
export function outerBufferFromBytes(end: number, endAnti: number): number {
  if (endAnti < 1000) return endAnti / 10 - 100
  return 100 - end / 10
}

export function isOuterUnlimited(end: number, endAnti: number): boolean {
  return end === 1000 && endAnti === 1000
}

export const OUTER_PRESETS: ReadonlyArray<{ name: string; buffer: number; hint: string }> = [
  { name: 'Flick +35', buffer: 35, hint: 'max at 65% deflection' },
  { name: 'Hot +20', buffer: 20, hint: 'max at 80% deflection' },
  { name: 'Mild +10', buffer: 10, hint: 'max at 90% deflection' },
  { name: 'Neutral 0', buffer: 0, hint: 'full physical range' },
  { name: 'Cap −10', buffer: -10, hint: 'output tops at 90%' },
  { name: 'Cap −25', buffer: -25, hint: 'output tops at 75%' }
]
