/**
 * Share codes: curves and profiles as short text people can paste.
 *
 *   SLC1.<base64url JSON>                  curve  { n?: name, s: 255 | 1000, p: [x0, y0, x1, y1, ...] }
 *   SLP1.<base64url zlib(tag || blob)>     profile (GameSir), tag = MODEL_TAGS index
 *
 * zlib carries an Adler-32, so a truncated or mistyped profile code fails to
 * inflate instead of decoding into wrong bytes. Importing a profile never
 * replaces the receiver's device settings (funData: polling, resolution,
 * lighting) or trailing bytes — only the sections people mean when they
 * share a setup: name, buttons, back buttons, triggers, sticks and motion.
 * No Node imports: runs in Electron's renderer and the browser build alike.
 */
import { parseProfile, serializeProfile, stick, GEOMETRIES, type Profile } from './profile'

export const CURVE_PREFIX = 'SLC1.'
export const PROFILE_PREFIX = 'SLP1.'
/** Wire tag per model; append only, never reorder. */
export const MODEL_TAGS = ['G7ProCE', 'T3CE'] as const

export interface SharedCurve {
  name?: string
  /** Point scale: 255 for GameSir designs, 1000 for LeadJoy percent×10. */
  scale: 255 | 1000
  pts: Array<{ x: number; y: number }>
}

/** Thrown for anything wrong with a pasted code; `code` keys the UI message (share.err.*). */
export class ShareCodeError extends Error {
  constructor(readonly code: 'notCurve' | 'isProfile' | 'notProfile' | 'isCurve' | 'damaged' | 'badPoints' | 'newer' | 'badStick' | 'unsupportedModel') {
    super(code)
  }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += B64[n & 63]
  }
  return out
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) throw new ShareCodeError('damaged')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const res = new Response(new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream))
  return new Uint8Array(await res.arrayBuffer())
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

export function encodeCurve(curve: SharedCurve): string {
  const body: { n?: string; s: number; p: number[] } = { s: curve.scale, p: curve.pts.flatMap((q) => [Math.round(q.x), Math.round(q.y)]) }
  if (curve.name) body.n = curve.name.slice(0, 24)
  return CURVE_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify(body)))
}

export function decodeCurve(code: string): SharedCurve {
  const text = code.trim()
  if (!text.startsWith(CURVE_PREFIX)) throw new ShareCodeError(text.startsWith(PROFILE_PREFIX) ? 'isProfile' : 'notCurve')
  let body: { n?: unknown; s?: unknown; p?: unknown }
  try {
    body = JSON.parse(new TextDecoder().decode(fromBase64Url(text.slice(CURVE_PREFIX.length))))
  } catch {
    throw new ShareCodeError('damaged')
  }
  const scale = body.s === 1000 ? 1000 : body.s === 255 ? 255 : null
  if (!scale) throw new ShareCodeError('damaged')
  const flat = Array.isArray(body.p) ? body.p : []
  if (flat.length % 2 !== 0 || flat.length < 4 || flat.length > 20 || !flat.every((v) => Number.isInteger(v) && v >= 0 && v <= scale)) {
    throw new ShareCodeError('badPoints')
  }
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < flat.length; i += 2) pts.push({ x: flat[i] as number, y: flat[i + 1] as number })
  for (let i = 1; i < pts.length; i++) if (pts[i].x < pts[i - 1].x) throw new ShareCodeError('badPoints')
  const name = typeof body.n === 'string' && body.n.trim() ? body.n.trim().slice(0, 24) : undefined
  return { name, scale, pts }
}

/** Rescale points between the 0..255 and 0..1000 editors. */
export function rescaleCurve(pts: Array<{ x: number; y: number }>, from: number, to: number): Array<{ x: number; y: number }> {
  if (from === to) return pts.map((q) => ({ ...q }))
  const k = to / from
  return pts.map((q) => ({ x: Math.max(0, Math.min(to, Math.round(q.x * k))), y: Math.max(0, Math.min(to, Math.round(q.y * k))) }))
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export async function encodeProfile(bytes: Uint8Array, modelId: string): Promise<string> {
  const tag = MODEL_TAGS.indexOf(modelId as (typeof MODEL_TAGS)[number])
  if (tag < 0) throw new ShareCodeError('unsupportedModel')
  const geo = GEOMETRIES[modelId]
  if (bytes.length !== geo.total) throw new Error(`expected ${geo.total} bytes, got ${bytes.length}`)
  const payload = new Uint8Array(1 + bytes.length)
  payload[0] = tag
  payload.set(bytes, 1)
  return PROFILE_PREFIX + toBase64Url(await pipe(payload, new CompressionStream('deflate')))
}

export async function decodeProfile(code: string): Promise<Profile> {
  const text = code.trim()
  if (!text.startsWith(PROFILE_PREFIX)) throw new ShareCodeError(text.startsWith(CURVE_PREFIX) ? 'isCurve' : 'notProfile')
  let payload: Uint8Array
  try {
    payload = await pipe(fromBase64Url(text.slice(PROFILE_PREFIX.length)), new DecompressionStream('deflate'))
  } catch {
    throw new ShareCodeError('damaged')
  }
  const modelId = MODEL_TAGS[payload[0]]
  if (!modelId) throw new ShareCodeError('newer')
  const blob = payload.subarray(1)
  if (blob.length !== GEOMETRIES[modelId].total) throw new ShareCodeError('damaged')
  const profile = parseProfile(blob, modelId)
  for (const s of profile.sticks) {
    const d = stick.deadzone(s)
    if (d.begin > 1000 || d.end > 1000 || d.beginAnti > 1000 || d.endAnti > 1000 || d.end <= d.begin || stick.mapIndex(s) > 4) {
      throw new ShareCodeError('badStick')
    }
  }
  return profile
}

/**
 * Overlay a shared profile onto the receiver's own slot bytes. Device
 * settings and trailing bytes stay the receiver's. Across models only the
 * sections with the same meaning travel: back buttons FL1/FR1 (packets 0/1)
 * but not the G7 L5/R5 vs Tarantula C/T keys that share later indices.
 */
export function applySharedProfile(targetBytes: Uint8Array, targetModel: string, shared: Profile): Uint8Array {
  const target = parseProfile(targetBytes, targetModel)
  const sameModel = shared.model === targetModel
  const copy = (to: Array<{ bytes: Uint8Array }>, from: Array<{ bytes: Uint8Array }>, limit = Infinity): void => {
    for (let i = 0; i < Math.min(to.length, from.length, limit); i++) {
      if (to[i].bytes.length === from[i].bytes.length) to[i].bytes.set(from[i].bytes)
    }
  }
  target.name = shared.name
  copy(target.buttons, shared.buttons)
  copy(target.functionKeys, shared.functionKeys, sameModel ? Infinity : 2)
  copy(target.triggers, shared.triggers)
  copy(target.sticks, shared.sticks)
  copy(target.motion, shared.motion)
  return serializeProfile(target)
}
