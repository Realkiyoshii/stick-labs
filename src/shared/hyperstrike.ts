/**
 * HyperStrike "Driver HID" codec + session (MI_02, usage page 0xFF60/0x61).
 * Frame layout and object map come from the HyperStrike Hub bundle and were
 * confirmed byte for byte on fw 2.66 (docs/hyperstrike-sampling.md).
 *
 * The request builder knows the reads plus the Hub's own writers: SET_VALUE,
 * the BUFFER_RESET/SET/COMMIT trio for objects over 48 bytes, SAVE_FLUSH, and
 * ACTION_START for the two USB re-plug changes (polling rate, USB mode) and
 * the Hub's three calibration steps. Factory reset is refused outright. Every
 * setting write is read back and restored on mismatch.
 */

export const HS_VENDOR_ID = 0x0170
export const HS_USAGE_PAGE = 0xff60
export const HS_USAGE = 0x61
/**
 * USB identities the pad takes per USB mode (the Hub's device filter): XInput
 * 0170:BB80, DS4 054C:09CC, Switch 057E:2009, PS4 1532:0401. All keep the
 * Driver interface (0xFF60/0x61); the HSR3 fingerprint confirms it is a HyperStrike.
 */
export const HS_IDENTITIES: ReadonlyArray<{ vendorId: number; productId: number }> = [
  { vendorId: 0x0170, productId: 0xbb80 },
  { vendorId: 0x054c, productId: 0x09cc },
  { vendorId: 0x057e, productId: 0x2009 },
  { vendorId: 0x1532, productId: 0x0401 }
]
export const isHsIdentity = (d: { vendorId?: number; productId?: number; usagePage?: number; usage?: number }): boolean =>
  d.usagePage === HS_USAGE_PAGE && d.usage === HS_USAGE && HS_IDENTITIES.some((i) => i.vendorId === d.vendorId && i.productId === d.productId)

export const HS_FRAME = 64
const HEADER = 16
const MAX_PAYLOAD = 48

export const HsCmd = { GetProtocol: 1, GetDeviceInfo: 2, GetValue: 3, SetValue: 4, SaveFlush: 6, ActionStart: 8, ActionStatus: 9, BufferGet: 10, BufferSet: 11, BufferCommit: 12, BufferReset: 13 } as const
const ALLOWED_COMMANDS: ReadonlySet<number> = new Set(Object.values(HsCmd))

export const HS_STATUS: Record<number, string> = {
  0: 'OK', 1: 'UNHANDLED', 2: 'BAD_CHANNEL', 3: 'BAD_ID', 4: 'BAD_LENGTH', 5: 'BAD_OFFSET', 6: 'BUSY',
  7: 'APPLY_FAILED', 8: 'READ_ONLY', 9: 'WRITE_ONLY', 10: 'LOCKED', 11: 'CRC_ERROR', 12: 'ACTION_RUNNING', 13: 'NOT_READY'
}

/** Object addresses (channel, id). The calibration channel is deliberately absent. */
export const HsObj = {
  UsbInputPolicy: [0, 2],
  UsbMode: [0, 3],
  ReportCoalesce: [0, 6],
  ProfileActive: [0, 7],
  StickResolution: [2, 1],
  AdcSampling: [2, 2],
  AxisInvert: [2, 3],
  SpeedLeft: [2, 4],
  SpeedRight: [2, 5],
  CurveLeft: [3, 1],
  CurveRight: [3, 2],
  AntiCurveRight: [3, 4],
  CircleClamp: [3, 5],
  ProfileNames: [0, 8],
  ExtraButtonMap: [4, 1],
  NativeButtonRemap: [4, 2],
  ExtraKeyboardMap: [5, 1],
  NativeKeyboardMap: [5, 2]
} as const satisfies Record<string, readonly [number, number]>
/** Calibration objects (channel 6). Kept out of HsObj so a snapshot never reads them blindly. */
export const HS_FINE_TUNE: readonly [number, number] = [6, 1]
export const HS_CAL_ACTION: readonly [number, number] = [6, 2]
/** The Hub's `ik` constants: [cmd, target, type]. */
export const HsCal = { Begin: 1, End: 2, Sample: 3, Controller: 1, Center: 1, Range: 2 } as const
export type HsCalType = 'center' | 'range'
export type HsCalStep = 'begin' | 'sample' | 'end'
/** The only three calibration payloads the Hub sends. */
export function calPayload(step: HsCalStep, type: HsCalType): number[] {
  const t = type === 'center' ? HsCal.Center : HsCal.Range
  if (step === 'sample') {
    if (type !== 'center') throw new Error('hyperstrike: only center calibration takes samples')
    return [HsCal.Sample, HsCal.Controller, HsCal.Center]
  }
  return [step === 'begin' ? HsCal.Begin : HsCal.End, HsCal.Controller, t]
}
const isCalPayload = (p: number[]): boolean =>
  p.length === 3 && p[1] === HsCal.Controller && ((p[0] === HsCal.Sample && p[2] === HsCal.Center) || ((p[0] === HsCal.Begin || p[0] === HsCal.End) && (p[2] === HsCal.Center || p[2] === HsCal.Range)))
export type HsObjName = keyof typeof HsObj

/** Objects written with SET_VALUE / the buffer trio. USB policy and mode go through ACTION_START instead. */
const WRITABLE: ReadonlySet<HsObjName> = new Set<HsObjName>(['ReportCoalesce', 'StickResolution', 'AdcSampling', 'AxisInvert', 'SpeedLeft', 'SpeedRight', 'CurveLeft', 'CurveRight', 'CircleClamp', 'ProfileActive', 'ProfileNames', 'ExtraButtonMap', 'NativeButtonRemap', 'ExtraKeyboardMap', 'NativeKeyboardMap'])
const isObj = (name: HsObjName, channel: number, id: number): boolean => HsObj[name][0] === channel && HsObj[name][1] === id

export function hsRequest(cmd: number, seq: number, channel = 0, id = 0, offset = 0, length = 0, payload: number[] = [], arg = 0, crc = 0): number[] {
  if (!ALLOWED_COMMANDS.has(cmd)) throw new Error(`hyperstrike: refusing command ${cmd}`)
  // ACTION_START: the two USB re-plug changes (the Hub's kb() and Pg()) and the Hub's calibration steps, nothing else.
  const calAction = channel === HS_CAL_ACTION[0] && id === HS_CAL_ACTION[1]
  if (cmd === HsCmd.ActionStart && !isObj('UsbInputPolicy', channel, id) && !isObj('UsbMode', channel, id) && !calAction) throw new Error('hyperstrike: ACTION_START is only allowed for polling rate, USB mode and calibration')
  if (cmd === HsCmd.ActionStart && calAction && !isCalPayload(payload)) throw new Error('hyperstrike: not a Hub calibration step')
  const fineTune = channel === HS_FINE_TUNE[0] && id === HS_FINE_TUNE[1]
  if (cmd === HsCmd.SetValue && fineTune && payload.length !== 24) throw new Error('hyperstrike: fine-tune data is 12 × u16')
  if (cmd === HsCmd.SetValue && channel === HS_CAL_ACTION[0] && !fineTune) throw new Error('hyperstrike: refusing a calibration write')
  if ((cmd === HsCmd.BufferSet || cmd === HsCmd.BufferCommit) && !(Object.keys(HsObj) as HsObjName[]).some((n) => WRITABLE.has(n) && isObj(n, channel, id))) throw new Error('hyperstrike: buffer write to an object Stick Labs does not write')
  if (seq < 1 || seq > 255) throw new Error('hyperstrike: seq must be 1..255')
  if (payload.length > MAX_PAYLOAD) throw new Error(`hyperstrike: payload too large (${payload.length})`)
  if (payload.length && cmd !== HsCmd.SetValue && cmd !== HsCmd.ActionStart && cmd !== HsCmd.BufferSet) throw new Error('hyperstrike: only SET_VALUE, BUFFER_SET and ACTION_START carry a payload')
  const f = new Array<number>(HS_FRAME).fill(0)
  f[0] = cmd
  f[1] = seq
  f[2] = channel
  f[3] = id
  f[5] = payload.length || length
  f[8] = offset & 0xff
  f[9] = (offset >> 8) & 0xff
  f[10] = arg & 0xff
  f[11] = (arg >> 8) & 0xff
  f[12] = crc & 0xff
  f[13] = (crc >>> 8) & 0xff
  f[14] = (crc >>> 16) & 0xff
  f[15] = (crc >>> 24) & 0xff
  payload.forEach((b, i) => { f[HEADER + i] = b & 0xff })
  return f
}

/** CRC-32 (IEEE, reflected) — the Hub's Kh(), sent with BUFFER_COMMIT. */
export function hsCrc32(bytes: ReadonlyArray<number>): number {
  let c = 0xffffffff
  for (const b of bytes) {
    c = (c ^ b) >>> 0
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) !== 0 ? 0xedb88320 : 0)
  }
  return ~c >>> 0
}

export interface HsResponse {
  cmd: number
  seq: number
  channel: number
  id: number
  status: number
  flags: number
  detail: number
  payload: number[]
}

export function hsParse(raw: ArrayLike<number>): HsResponse | null {
  if (raw.length < HEADER) return null
  const len = raw[5]
  if (len > MAX_PAYLOAD || HEADER + len > raw.length) return null
  return {
    cmd: raw[0], seq: raw[1], channel: raw[2], id: raw[3], status: raw[4], flags: raw[6],
    detail: raw[8] | (raw[9] << 8),
    payload: Array.from(raw).slice(HEADER, HEADER + len)
  }
}

const u16 = (b: number[], i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
const s16 = (b: number[], i: number): number => { const v = u16(b, i); return v >= 0x8000 ? v - 0x10000 : v }
const put16 = (b: number[], i: number, v: number): void => { b[i] = v & 0xff; b[i + 1] = (v >> 8) & 0xff }
const text = (b: number[]): string => String.fromCharCode(...b.filter((c) => c !== 0))
const int = (v: number, lo: number, hi: number, name: string): number => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`hyperstrike: ${name} must be ${lo}..${hi}`)
  return v
}

export interface HsProtocol { major: number; minor: number; fingerprint: string; nvmGeneration: number }
export function decodeProtocol(p: number[]): HsProtocol {
  return { major: p[0] ?? 0, minor: p[1] ?? 0, fingerprint: text(p.slice(14, 18)), nvmGeneration: (u16(p, 10) | (u16(p, 12) << 16)) >>> 0 }
}

export interface HsDeviceInfo { firmware: string; currentMode: number; valueCount: number; bcdDevice: number }
export function decodeDeviceInfo(p: number[]): HsDeviceInfo {
  const n = p[8] ?? 0
  return { firmware: text(p.slice(9, 9 + n)), currentMode: p[4] ?? 0, valueCount: p[5] ?? 0, bcdDevice: u16(p, 6) }
}

/** "2.96" ≥ "2.66" style compare; unknown strings count as old. */
export function firmwareAtLeast(fw: string, min: string): boolean {
  const a = fw.split('.').map(Number)
  const b = min.split('.').map(Number)
  if (a.some((n) => !Number.isFinite(n))) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/** USB_INPUT_POLICY: the Hub fixes rateCode at 6 and sets the rate with bIntervalHs (1 = 125 µs). */
export function pollingHz(policy: number[]): number | null {
  const b = policy[2] ?? 0
  return b >= 1 && b <= 6 ? 8000 >> (b - 1) : null
}
/** The Hub's six polling choices (bIntervalHs 1..6). */
export const HS_POLLING_HZ = [8000, 4000, 2000, 1000, 500, 250] as const
/**
 * Same bytes the Hub's kb() sends with ACTION_START: [2, rateCode 6, bIntervalHs,
 * current flags, smooth 0, 0]. Flags bit 0 says the firmware can change bInterval.
 */
export function encodePolling(hz: number, current: number[]): number[] {
  const b = HS_POLLING_HZ.indexOf(hz as (typeof HS_POLLING_HZ)[number]) + 1
  if (b < 1) throw new Error(`hyperstrike: unsupported polling rate ${hz}`)
  const flags = (current[3] ?? 0) || 3
  if (!(flags & 1)) throw new Error('hyperstrike: this firmware cannot change the polling rate')
  return [2, 6, b, flags, 0, 0]
}

const USB_MODES = ['DS4', 'XInput', 'Switch', 'PS4'] as const
export function usbModeName(mode: number[]): string {
  return USB_MODES[mode[1] ?? 255] ?? 'Unknown'
}

// --- Stick resolution (XINPUT_STICK_RESOLUTION): [bits, 0, 0, 0], wire 0 = 12.
export const HS_BITS_MIN = 8
export const HS_BITS_MAX = 12
export function stickBits(res: number[]): number {
  return (res[0] ?? 0) === 0 ? 12 : res[0]
}
export function encodeStickBits(bits: number): number[] {
  return [int(bits, HS_BITS_MIN, HS_BITS_MAX, 'stick resolution'), 0, 0, 0]
}

// --- ADC sampling: [version, mode, presetId, divCode, sampleTimeCode, flags].
export const HS_PRESETS = [
  { id: 1, name: 'Robust', div: 3, time: 1 },
  { id: 2, name: 'Good', div: 2, time: 1 },
  { id: 3, name: 'Excellent', div: 3, time: 0 },
  { id: 4, name: 'Extreme', div: 2, time: 0 },
  { id: 5, name: 'Tier D', div: 3, time: 2, minFw: '2.96' },
  { id: 6, name: 'Tier E', div: 3, time: 3, minFw: '2.96' },
  { id: 7, name: 'Tier F', div: 3, time: 6, minFw: '2.96' },
  { id: 8, name: 'Tier G', div: 3, time: 7, minFw: '2.96' }
] as const
export const HS_OVERSAMPLING = ['Off', '14-bit', '15-bit', '16-bit'] as const
const DIVIDERS: Record<number, number> = { 0: 2, 1: 4, 2: 6, 3: 8 }
const SAMPLE_CYCLES = [1.5, 7.5, 13.5, 28.5, 41.5, 55.5, 71.5, 239.5]

export interface HsSampling { version: number; manual: boolean; presetId: number; preset: string; divider: number | null; sampleCycles: number | null; oversample: number; oversampling: string; overspec: boolean }
export function decodeSampling(s: number[]): HsSampling {
  const flags = s[5] ?? 0
  const version = s[0] ?? 0
  const manual = s[1] === 2
  const oversample = version >= 2 ? (flags >> 5) & 3 : 0
  return {
    version,
    manual,
    presetId: manual ? 0 : s[2] ?? 0,
    preset: manual ? 'Custom' : HS_PRESETS.find((p) => p.id === s[2])?.name ?? `Preset ${s[2]}`,
    divider: DIVIDERS[s[3] ?? -1] ?? null,
    sampleCycles: SAMPLE_CYCLES[s[4] ?? -1] ?? null,
    oversample,
    oversampling: HS_OVERSAMPLING[oversample],
    overspec: (flags & 0x10) !== 0
  }
}
/** Same bytes the Hub's preset writer builds (op()): flags carry only the oversample bits. */
export function encodeSampling(presetId: number, oversample: number, version = 2, firmware = ''): number[] {
  const p = HS_PRESETS.find((x) => x.id === presetId)
  if (!p) throw new Error(`hyperstrike: unknown sampling preset ${presetId}`)
  if ('minFw' in p && !firmwareAtLeast(firmware, p.minFw)) throw new Error(`hyperstrike: ${p.name} needs firmware ${p.minFw}+`)
  const v = version === 1 ? 1 : 2
  return [v, 1, p.id, p.div, p.time, v >= 2 ? (int(oversample, 0, 3, 'oversampling') << 5) & 0x60 : 0]
}

// --- Curves: [apply flag, 10 × (x u16, y u16)] on a 0..1000 scale; reads back flag 0.
export const HS_CURVE_POINTS = 10
export const HS_CURVE_MAX = 1000
export function decodeCurve(c: number[]): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  for (let i = 1; i + 3 < c.length; i += 4) pts.push([u16(c, i), u16(c, i + 2)])
  return pts
}
export function encodeCurve(points: Array<[number, number]>): number[] {
  if (points.length !== HS_CURVE_POINTS) throw new Error(`hyperstrike: a curve needs ${HS_CURVE_POINTS} points`)
  const out = [1]
  points.forEach(([x, y], i) => {
    int(x, 0, HS_CURVE_MAX, 'curve x')
    int(y, 0, HS_CURVE_MAX, 'curve y')
    if (i > 0 && (x < points[i - 1][0] || y < points[i - 1][1])) throw new Error('hyperstrike: curve points must be monotonic')
    out.push(x & 0xff, x >> 8, y & 0xff, y >> 8)
  })
  if (points[HS_CURVE_POINTS - 1][1] !== HS_CURVE_MAX) throw new Error('hyperstrike: the last curve point must output 1000')
  return out
}

/** Clamp a sampled curve to what the pad accepts: whole numbers in 0..1000, x and y rising, last y = 1000. */
export function hsNormalizeCurve(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out = points.map(([x, y]) => [Math.max(0, Math.min(HS_CURVE_MAX, Math.round(x))), Math.max(0, Math.min(HS_CURVE_MAX, Math.round(y)))] as [number, number])
  for (let i = 1; i < out.length; i++) out[i][0] = Math.max(out[i][0], out[i - 1][0])
  out[out.length - 1][1] = HS_CURVE_MAX
  for (let i = out.length - 2; i >= 0; i--) out[i][1] = Math.min(out[i][1], out[i + 1][1])
  return out
}

// --- Stick speed boost (STICK_SPEED_RC_*): [1, enabled, 5, 0, 5 × (end u8, strength s16)], 32 bytes.
export const HS_SPEED_TIERS = 5
export const HS_SPEED_STRENGTH = 500
export interface HsSpeed { enabled: boolean; tiers: Array<{ end: number; strength: number }> }
export function decodeSpeed(s: number[]): HsSpeed {
  const n = Math.min(s[2] ?? 0, HS_SPEED_TIERS)
  const tiers: HsSpeed['tiers'] = []
  for (let k = 0; k < n; k++) tiers.push({ end: s[4 + k * 3] ?? 0, strength: s16(s, 5 + k * 3) })
  return { enabled: (s[1] ?? 0) !== 0, tiers }
}
export function encodeSpeed(sp: HsSpeed): number[] {
  if (sp.tiers.length !== HS_SPEED_TIERS) throw new Error(`hyperstrike: speed boost needs ${HS_SPEED_TIERS} tiers`)
  const out = new Array<number>(32).fill(0)
  out[0] = 1
  out[1] = sp.enabled ? 1 : 0
  out[2] = HS_SPEED_TIERS
  let prev = -1
  sp.tiers.forEach((t, i) => {
    const end = int(t.end, 0, 255, 'speed tier end')
    if (i < HS_SPEED_TIERS - 1 ? end <= prev || end >= 255 : end !== 255) throw new Error('hyperstrike: speed tier ends must rise and finish at 255')
    prev = end
    out[4 + i * 3] = end
    put16(out, 5 + i * 3, int(t.strength, -HS_SPEED_STRENGTH, HS_SPEED_STRENGTH, 'speed strength') & 0xffff)
  })
  return out
}

// --- Report merging (REPORT_COALESCE): [1, enabled, heartbeat u16 ms].
export interface HsCoalesce { enabled: boolean; heartbeatMs: number }
export const decodeCoalesce = (c: number[]): HsCoalesce => ({ enabled: (c[1] ?? 0) !== 0, heartbeatMs: u16(c, 2) })
export function encodeCoalesce(c: HsCoalesce): number[] {
  const hb = int(c.heartbeatMs, 0, 65535, 'heartbeat')
  return [1, c.enabled ? 1 : 0, hb & 0xff, hb >> 8]
}

// --- Bitmasks. Axis invert: LX 1, LY 2, RX 4, RY 8. Circle clamp: left 2, right 4.
export const HS_INVERT = { leftX: 1, leftY: 2, rightX: 4, rightY: 8 } as const
export const HS_CLAMP = { left: 2, right: 4 } as const
export const encodeInvert = (mask: number): number[] => [mask & 0x0f]
export const encodeClamp = (mask: number): number[] => [mask & 0x06]

// --- USB mode (USB_MODE): [schema 1, current, default, supportedMask, flags, 0, 0, 0]; changed with ACTION_START [1, mode, persist 1, 0…].
export const HS_USB_MODES = [
  { id: 0, name: 'DS4' },
  { id: 1, name: 'XInput' },
  { id: 2, name: 'Switch' },
  { id: 3, name: 'PS4' }
] as const
export const usbModeId = (mode: number[]): number => mode[1] ?? 1
export const usbModesSupported = (mode: number[]): number[] => HS_USB_MODES.filter((m) => ((mode[3] ?? 0) & (1 << m.id)) !== 0).map((m) => m.id)
export function encodeUsbMode(id: number, current: number[]): number[] {
  if (!usbModesSupported(current).includes(id)) throw new Error(`hyperstrike: USB mode ${id} is not supported by this pad`)
  return [1, id, 1, 0, 0, 0, 0, 0]
}

// --- Profiles: PROFILE_ACTIVE [0..3]; PROFILE_NAMES [count 4, 4 × (usbMode, name 24 B UTF-8)] + 4 × bIntervalHs (read only).
export const HS_PROFILES = 4
const NAME_BYTES = 24
export interface HsProfile { name: string; usbMode: number; pollingHz: number | null }
export function decodeProfiles(b: number[]): HsProfile[] {
  const out: HsProfile[] = []
  for (let i = 0; i < HS_PROFILES; i++) {
    const at = 1 + i * (1 + NAME_BYTES)
    let raw = b.slice(at + 1, at + 1 + NAME_BYTES)
    while (raw.length && raw[raw.length - 1] === 0) raw = raw.slice(0, -1)
    const bi = b[1 + HS_PROFILES * (1 + NAME_BYTES) + i] ?? 0
    out.push({ name: new TextDecoder().decode(new Uint8Array(raw)), usbMode: b[at] ?? 1, pollingHz: bi >= 1 && bi <= 6 ? 8000 >> (bi - 1) : null })
  }
  return out
}
/** Same 101 bytes the Hub's ib() builds; names are cut to 24 UTF-8 bytes on a character boundary. */
export function encodeProfileNames(profiles: ReadonlyArray<{ name: string; usbMode: number }>): number[] {
  const out = new Array<number>(1 + HS_PROFILES * (1 + NAME_BYTES)).fill(0)
  out[0] = HS_PROFILES
  for (let i = 0; i < HS_PROFILES; i++) {
    const at = 1 + i * (1 + NAME_BYTES)
    out[at] = (profiles[i]?.usbMode ?? 1) & 0xff
    let bytes = Array.from(new TextEncoder().encode(profiles[i]?.name ?? ''))
    if (bytes.length > NAME_BYTES) {
      let cut = NAME_BYTES
      while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
      bytes = bytes.slice(0, cut)
    }
    bytes.forEach((v, k) => { out[at + 1 + k] = v })
  }
  return out
}

// --- Buttons. Codes 1..18: cross, circle, square, triangle, up, down, left, right, L1, R1, L2, R2, L3, R3, create, options, home, touchpad.
export const HS_BUTTONS = ['cross', 'circle', 'square', 'triangle', 'dPadUp', 'dPadDown', 'dPadLeft', 'dPadRight', 'l1', 'r1', 'l2', 'r2', 'l3', 'r3', 'create', 'options', 'playStation', 'touchPadClick'] as const
export const HS_NATIVE = 17
export const HS_EXTRA = 8
export const HS_KEY_MAX = 101
/** Per button: up to two outputs. Native map is 18 × 2 (touchpad slot unused) + touchpad output per USB mode (DS4, XInput, Switch). */
export interface HsButtons {
  native: Array<[number, number]>
  touchpad: [number, number, number]
  extra: Array<[number, number]>
  keyboardEnabled: boolean
  nativeKeys: Array<{ keycode: number; modifier: number }>
  extraKeys: Array<{ keycode: number; modifier: number }>
}
const code = (v: number | undefined): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 18 ? (v as number) : 0)
const keyEntry = (b: number[], at: number): { keycode: number; modifier: number } => {
  const k = b[at] ?? 0
  return { keycode: k <= HS_KEY_MAX ? k : 0, modifier: b[at + 1] ?? 0 }
}
export function decodeButtons(raw: Record<string, number[]>): HsButtons {
  const n = raw.NativeButtonRemap ?? []
  const e = raw.ExtraButtonMap ?? []
  const ek = raw.ExtraKeyboardMap ?? []
  const nk = raw.NativeKeyboardMap ?? []
  const native: Array<[number, number]> = []
  for (let i = 0; i < 18; i++) native.push([code(n[3 + i * 2]), code(n[4 + i * 2])])
  const extra: Array<[number, number]> = []
  for (let i = 0; i < HS_EXTRA; i++) extra.push([code(e[3 + i * 2]), code(e[4 + i * 2])])
  return {
    native,
    touchpad: [code(n[39]), code(n[40]), code(n[41])],
    extra,
    keyboardEnabled: (ek[1] ?? 0) !== 0,
    nativeKeys: Array.from({ length: 18 }, (_, i) => (i < (nk[2] ?? 0) ? keyEntry(nk, 4 + i * 3) : { keycode: 0, modifier: 0 })),
    extraKeys: Array.from({ length: HS_EXTRA }, (_, i) => (i < (ek[2] ?? 0) ? keyEntry(ek, 4 + i * 3) : { keycode: 0, modifier: 0 }))
  }
}
/** The Hub's Ud(): [2, 36, 0, 36 outputs, 3 touchpad outputs] = 42 bytes. */
export function encodeNativeRemap(native: ReadonlyArray<readonly [number, number]>, touchpad: readonly [number, number, number]): number[] {
  const out = [2, 36, 0]
  for (let i = 0; i < 18; i++) out.push(code(native[i]?.[0]), code(native[i]?.[1]))
  out.push(code(touchpad[0]), code(touchpad[1]), code(touchpad[2]))
  return out
}
/** The Hub's Md(): [2, mapLen (0 when empty, else 16), 0, 16 outputs], padded to 35 bytes. */
export function encodeExtraMap(extra: ReadonlyArray<readonly [number, number]>): number[] {
  const map: number[] = []
  for (let i = 0; i < HS_EXTRA; i++) map.push(code(extra[i]?.[0]), code(extra[i]?.[1]))
  const out = new Array<number>(35).fill(0)
  out[0] = 2
  out[1] = map.every((v) => v === 0) ? 0 : 16
  map.forEach((v, i) => { out[3 + i] = v })
  return out
}
const keyBytes = (k: { keycode: number; modifier: number } | undefined): number[] => [(k?.keycode ?? 0) <= HS_KEY_MAX ? k?.keycode ?? 0 : 0, (k?.modifier ?? 0) & 0xff, 0]
/** The Hub's zd(): [1 apply, enabled, 8, 0, 8 × (key, modifier, 0)] padded to 31 bytes; reads back byte 0 = 0. */
export function encodeExtraKeys(enabled: boolean, keys: ReadonlyArray<{ keycode: number; modifier: number }>): number[] {
  const out = new Array<number>(31).fill(0)
  out[0] = 1
  out[1] = enabled ? 1 : 0
  out[2] = HS_EXTRA
  for (let i = 0; i < HS_EXTRA; i++) keyBytes(keys[i]).forEach((v, k) => { out[4 + i * 3 + k] = v })
  return out
}
/** The Hub's Wd(): [1 apply, version 1, 18, 0, 18 × (key, modifier, 0)] padded to 60 bytes; buffered (over 48). */
export function encodeNativeKeys(keys: ReadonlyArray<{ keycode: number; modifier: number }>): number[] {
  const out = new Array<number>(60).fill(0)
  out[0] = 1
  out[1] = 1
  out[2] = 18
  for (let i = 0; i < 18; i++) keyBytes(keys[i]).forEach((v, k) => { out[4 + i * 3 + k] = v })
  return out
}

export interface HsSnapshot {
  protocol: HsProtocol
  device: HsDeviceInfo
  pollingHz: number | null
  usbMode: string
  coalesce: HsCoalesce
  profile: number
  stickBits: number
  sampling: HsSampling
  axisInvert: number
  curves: { left: Array<[number, number]>; right: Array<[number, number]> }
  speed: { left: HsSpeed; right: HsSpeed }
  antiCurveRight: boolean
  circleClamp: number
  usbModeId: number
  usbModes: number[]
  profiles: HsProfile[]
  buttons: HsButtons
  raw: Record<string, number[]>
}

export function snapshotFrom(protocol: HsProtocol, device: HsDeviceInfo, raw: Record<string, number[]>): HsSnapshot {
  return {
    protocol,
    device,
    pollingHz: pollingHz(raw.UsbInputPolicy),
    usbMode: usbModeName(raw.UsbMode),
    coalesce: decodeCoalesce(raw.ReportCoalesce),
    profile: (raw.ProfileActive[0] ?? 0) + 1,
    stickBits: stickBits(raw.StickResolution),
    sampling: decodeSampling(raw.AdcSampling),
    axisInvert: (raw.AxisInvert[0] ?? 0) & 0x0f,
    curves: { left: decodeCurve(raw.CurveLeft), right: decodeCurve(raw.CurveRight) },
    speed: { left: decodeSpeed(raw.SpeedLeft), right: decodeSpeed(raw.SpeedRight) },
    antiCurveRight: (raw.AntiCurveRight[0] ?? 0) !== 0,
    circleClamp: (raw.CircleClamp[0] ?? 0) & 0x06,
    usbModeId: usbModeId(raw.UsbMode),
    usbModes: usbModesSupported(raw.UsbMode),
    profiles: decodeProfiles(raw.ProfileNames ?? []),
    buttons: decodeButtons(raw),
    raw
  }
}

/** A staged change set. Only the fields present are written. */
export interface HsEdit {
  stickBits?: number
  sampling?: { presetId: number; oversample: number }
  curveLeft?: Array<[number, number]>
  curveRight?: Array<[number, number]>
  speedLeft?: HsSpeed
  speedRight?: HsSpeed
  coalesce?: HsCoalesce
  axisInvert?: number
  circleClamp?: number
  /** Changed last, with ACTION_START: the pad re-plugs itself. */
  pollingHz?: number
  /** USB mode, also ACTION_START + re-plug; sent after the polling rate. */
  usbMode?: number
  profileNames?: string[]
  buttons?: HsButtons
}

/** Encode an edit against the current snapshot; objects already equal are dropped. */
export function planWrites(snap: HsSnapshot, edit: HsEdit): Array<{ name: HsObjName; payload: number[] }> {
  const plan: Array<{ name: HsObjName; payload: number[] }> = []
  const add = (name: HsObjName, payload: number[]): void => {
    if (!WRITABLE.has(name)) throw new Error(`hyperstrike: ${name} is read-only`)
    if (!matchesReadback(name, payload, snap.raw[name] ?? [])) plan.push({ name, payload })
  }
  if (edit.stickBits !== undefined) add('StickResolution', encodeStickBits(edit.stickBits))
  if (edit.sampling) add('AdcSampling', encodeSampling(edit.sampling.presetId, edit.sampling.oversample, snap.sampling.version, snap.device.firmware))
  if (edit.curveLeft) add('CurveLeft', encodeCurve(edit.curveLeft))
  if (edit.curveRight) add('CurveRight', encodeCurve(edit.curveRight))
  if (edit.speedLeft) add('SpeedLeft', encodeSpeed(edit.speedLeft))
  if (edit.speedRight) add('SpeedRight', encodeSpeed(edit.speedRight))
  if (edit.coalesce) add('ReportCoalesce', encodeCoalesce(edit.coalesce))
  if (edit.axisInvert !== undefined) add('AxisInvert', encodeInvert(edit.axisInvert))
  if (edit.circleClamp !== undefined) add('CircleClamp', encodeClamp(edit.circleClamp))
  if (edit.profileNames) add('ProfileNames', encodeProfileNames(snap.profiles.map((p, i) => ({ name: edit.profileNames?.[i] ?? p.name, usbMode: p.usbMode }))))
  if (edit.buttons) {
    const b = edit.buttons
    add('NativeButtonRemap', encodeNativeRemap(b.native, b.touchpad))
    add('ExtraButtonMap', encodeExtraMap(b.extra))
    add('NativeKeyboardMap', encodeNativeKeys(b.nativeKeys))
    add('ExtraKeyboardMap', encodeExtraKeys(b.keyboardEnabled, b.extraKeys))
  }
  return plan
}

/**
 * Does a read-back match what was written? Curves read back with the apply
 * flag cleared; sampling is compared on the fields the Hub writes (the
 * firmware may keep status bits in the flags byte).
 */
export function matchesReadback(name: HsObjName, written: number[], read: number[]): boolean {
  // Curve and keyboard objects carry an apply flag in byte 0 that reads back as 0 (the Hub's Nu()).
  if (name === 'CurveLeft' || name === 'CurveRight' || name === 'ExtraKeyboardMap' || name === 'NativeKeyboardMap') return read.length === written.length && written.every((b, i) => (i === 0 ? true : b === read[i]))
  // Names: the read adds the per-profile polling bytes after the 101 written ones.
  if (name === 'ProfileNames') return read.length >= written.length && written.every((b, i) => b === read[i])
  if (name === 'AdcSampling') return read.length >= 6 && [0, 1, 2, 3, 4].every((i) => written[i] === read[i]) && (written[5] & 0x60) === (read[5] & 0x60)
  if (name === 'StickResolution') return read.length === written.length && stickBits(read) === stickBits(written) && written.every((b, i) => i === 0 || b === read[i])
  return read.length === written.length && written.every((b, i) => b === read[i])
}

/** Restore payload for an object as read: curves need the apply flag set again. */
const restorePayload = (name: HsObjName, read: number[]): number[] =>
  name === 'CurveLeft' || name === 'CurveRight' || name === 'ExtraKeyboardMap' || name === 'NativeKeyboardMap' ? [1, ...read.slice(1)]
    : name === 'ProfileNames' ? read.slice(0, 1 + HS_PROFILES * (1 + NAME_BYTES))
      : read

export interface HsPort {
  write(frame: number[]): Promise<void>
  read(timeoutMs: number): Promise<number[] | null>
  close(): Promise<void>
}

export interface HsWriteResult {
  written: HsObjName[]
  snapshot: HsSnapshot
  /** Polling or USB-mode change sent: the pad re-enumerates; read it again once it is back and check this. */
  reconnecting?: { pollingHz?: number; usbMode?: number }
}

export function createHsSession(open: (path: string) => Promise<HsPort>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let seq = 0
  const nextSeq = (): number => (seq = (seq % 255) + 1)

  async function ask(port: HsPort, cmd: number, channel = 0, id = 0, offset = 0, length = 0, payload: number[] = [], arg = 0, crc = 0): Promise<HsResponse> {
    for (let busy = 0; busy < 4; busy++) {
      const s = nextSeq()
      await port.write(hsRequest(cmd, s, channel, id, offset, length, payload, arg, crc))
      const deadline = Date.now() + 1000
      let res: HsResponse | null = null
      while (!res && Date.now() < deadline) {
        const raw = await port.read(Math.max(1, deadline - Date.now()))
        const r = raw && hsParse(raw)
        if (r && r.cmd === cmd && r.seq === s) res = r
      }
      if (!res) throw new Error(`hyperstrike: no reply to command ${cmd} (close HyperStrike Hub first)`)
      if (res.status === 6) { await sleep(20 + busy * 30); continue }
      return res
    }
    throw new Error('hyperstrike: controller stayed busy')
  }

  async function readObject(port: HsPort, [channel, id]: readonly [number, number]): Promise<number[]> {
    const r = await ask(port, HsCmd.GetValue, channel, id)
    if (r.status === 0) return r.payload
    if (r.status !== 4) throw new Error(`hyperstrike: read ${channel}/${id} failed — ${HS_STATUS[r.status] ?? r.status}`)
    const out: number[] = []
    let total: number | null = null
    while (total === null || out.length < total) {
      const b = await ask(port, HsCmd.BufferGet, channel, id, out.length, MAX_PAYLOAD)
      if (b.status !== 0) throw new Error(`hyperstrike: block read ${channel}/${id} failed — ${HS_STATUS[b.status] ?? b.status}`)
      if (total === null) total = b.detail
      if (!b.payload.length) break
      out.push(...b.payload)
      if (!(b.flags & 1) && out.length >= total) break
    }
    return out.slice(0, total ?? out.length)
  }

  async function setObject(port: HsPort, name: HsObjName, payload: number[]): Promise<void> {
    const [channel, id] = HsObj[name]
    const refused = (r: HsResponse, what: string): Error => new Error(`hyperstrike: ${name} ${what} refused — ${HS_STATUS[r.status] ?? r.status}`)
    if (payload.length <= MAX_PAYLOAD) {
      const r = await ask(port, HsCmd.SetValue, channel, id, 0, 0, payload)
      if (r.status !== 0) throw refused(r, 'write')
      return
    }
    // Over 48 bytes: the Hub's buffer path — reset, 48-byte blocks (arg = total), commit with CRC-32.
    await ask(port, HsCmd.BufferReset).catch(() => undefined)
    try {
      for (let at = 0; at < payload.length; at += MAX_PAYLOAD) {
        const r = await ask(port, HsCmd.BufferSet, channel, id, at, 0, payload.slice(at, at + MAX_PAYLOAD), payload.length)
        if (r.status !== 0) throw refused(r, 'block write')
      }
      const c = await ask(port, HsCmd.BufferCommit, channel, id, 0, 0, [], payload.length, hsCrc32(payload))
      if (c.status !== 0) throw refused(c, 'commit')
    } catch (err) {
      await ask(port, HsCmd.BufferReset).catch(() => undefined)
      throw err
    }
  }

  async function handshake(port: HsPort): Promise<{ protocol: HsProtocol; device: HsDeviceInfo }> {
    const protocol = decodeProtocol((await ask(port, HsCmd.GetProtocol)).payload)
    if (protocol.fingerprint !== 'HSR3') throw new Error(`hyperstrike: unexpected protocol fingerprint "${protocol.fingerprint}"`)
    const device = decodeDeviceInfo((await ask(port, HsCmd.GetDeviceInfo)).payload)
    return { protocol, device }
  }

  async function readAll(port: HsPort): Promise<HsSnapshot> {
    const { protocol, device } = await handshake(port)
    const raw: Record<string, number[]> = {}
    for (const [name, addr] of Object.entries(HsObj)) raw[name] = await readObject(port, addr)
    return snapshotFrom(protocol, device, raw)
  }

  /** SAVE_FLUSH, then poll ACTION_STATUS until the NVM copy matches RAM (Hub: ≤12 s). */
  async function flush(port: HsPort): Promise<void> {
    const r = await ask(port, HsCmd.SaveFlush)
    if (r.status !== 0) throw new Error(`hyperstrike: save refused — ${HS_STATUS[r.status] ?? r.status}`)
    const deadline = Date.now() + 12000
    for (;;) {
      const st = (await ask(port, HsCmd.ActionStatus)).payload
      if ((st[33] ?? 0) !== 0 || (st[34] ?? 0) !== 0) throw new Error(`hyperstrike: save failed (save ${st[33]}, nvm ${st[34]})`)
      const pending = (st[1] ?? 0) !== 0 || (st[35] ?? 0) !== 0 || u16(st, 6) !== u16(st, 8)
      if (!pending) return
      if (Date.now() >= deadline) throw new Error('hyperstrike: save timed out')
      await sleep(150)
    }
  }

  async function readSnapshot(path: string): Promise<HsSnapshot> {
    const port = await open(path)
    try { return await readAll(port) } finally { await port.close().catch(() => {}) }
  }

  /**
   * Write an edit: re-read everything, write each changed object, read it back,
   * and restore every touched object if any check fails. Saved to flash only
   * after all read-backs pass.
   */
  async function writeVerified(path: string, edit: HsEdit): Promise<HsWriteResult> {
    const port = await open(path)
    try {
      const before = await readAll(port)
      const plan = planWrites(before, edit)
      const polling = edit.pollingHz !== undefined && edit.pollingHz !== before.pollingHz ? encodePolling(edit.pollingHz, before.raw.UsbInputPolicy) : null
      const mode = edit.usbMode !== undefined && edit.usbMode !== before.usbModeId ? encodeUsbMode(edit.usbMode, before.raw.UsbMode) : null
      if (polling && mode) throw new Error('hyperstrike: change the polling rate and the USB mode one at a time')
      if (!plan.length && !polling && !mode) return { written: [], snapshot: before }
      const touched: HsObjName[] = []
      try {
        for (const { name, payload } of plan) {
          touched.push(name)
          await setObject(port, name, payload)
          const back = await readObject(port, HsObj[name])
          if (!matchesReadback(name, payload, back)) throw new Error(`hyperstrike: ${name} read back different bytes — restored`)
        }
      } catch (err) {
        for (const name of touched.reverse()) {
          try { await setObject(port, name, restorePayload(name, before.raw[name])) } catch { /* keep restoring the rest */ }
        }
        throw err
      }
      let after = before
      if (plan.length) {
        await flush(port)
        after = await readAll(port)
        for (const { name, payload } of plan) {
          if (!matchesReadback(name, payload, after.raw[name] ?? [])) throw new Error(`hyperstrike: ${name} changed after saving`)
        }
      }
      const written = plan.map((p) => p.name)
      if (mode) {
        // Same re-plug as polling; the pad comes back under the new mode's USB identity.
        try {
          const r = await ask(port, HsCmd.ActionStart, HsObj.UsbMode[0], HsObj.UsbMode[1], 0, 0, mode)
          if (r.status !== 0) throw new Error(`hyperstrike: USB mode change refused — ${HS_STATUS[r.status] ?? r.status}`)
        } catch (err) {
          if ((err as Error).message.includes('refused')) throw err
        }
        written.push('UsbMode')
        return { written, snapshot: after, reconnecting: { usbMode: edit.usbMode } }
      }
      if (polling) {
        // The pad answers and then drops off USB to come back at the new rate;
        // a lost reply here is the re-plug, not a failure (Hub: willReenumerate).
        try {
          const r = await ask(port, HsCmd.ActionStart, HsObj.UsbInputPolicy[0], HsObj.UsbInputPolicy[1], 0, 0, polling)
          if (r.status !== 0) throw new Error(`hyperstrike: polling change refused — ${HS_STATUS[r.status] ?? r.status}`)
        } catch (err) {
          if ((err as Error).message.includes('refused')) throw err
        }
        written.push('UsbInputPolicy')
        return { written, snapshot: after, reconnecting: { pollingHz: edit.pollingHz } }
      }
      return { written, snapshot: after }
    } finally {
      await port.close().catch(() => {})
    }
  }

  /**
   * Switch the active profile the way the Hub does (SET_VALUE, not saved:
   * the firmware keeps the choice). A slot with a different USB mode or
   * polling rate makes the pad re-plug, so the caller reads it again.
   */
  async function switchProfile(path: string, index: number): Promise<{ snapshot: HsSnapshot | null; reconnecting: boolean }> {
    if (!Number.isInteger(index) || index < 0 || index >= HS_PROFILES) throw new Error('hyperstrike: profile must be 1..4')
    const port = await open(path)
    try {
      const before = await readAll(port)
      if (before.profile === index + 1) return { snapshot: before, reconnecting: false }
      const target = before.profiles[index]
      const replug = !!target && (target.usbMode !== before.usbModeId || (target.pollingHz !== null && target.pollingHz !== before.pollingHz))
      try {
        await setObject(port, 'ProfileActive', [index])
      } catch (err) {
        if (!replug) throw err
      }
      if (replug) return { snapshot: null, reconnecting: true }
      const deadline = Date.now() + 1500
      for (;;) {
        const now = await readObject(port, HsObj.ProfileActive)
        if (now[0] === index) break
        if (Date.now() >= deadline) throw new Error('hyperstrike: the pad did not switch profile')
        await sleep(80)
      }
      return { snapshot: await readAll(port), reconnecting: false }
    } finally {
      await port.close().catch(() => {})
    }
  }

  /** The Hub's waitForCalibrationActionLane(): idle mailbox, no write in flight, not re-plugging. */
  async function waitActionLane(port: HsPort): Promise<void> {
    let last: Error | null = null
    for (const delay of [0, 30, 70]) {
      if (delay) await sleep(delay)
      try {
        const st = (await ask(port, HsCmd.ActionStatus)).payload
        if ((st[11] ?? 0) !== 0) throw new Error('hyperstrike: the pad is re-plugging')
        if ((st[3] ?? 0) !== 0) { await ask(port, HsCmd.BufferReset).catch(() => undefined); continue }
        if ((st[5] ?? 0) === 0 && (st[10] ?? 0) === 0 && (st[4] ?? 0) === 0) return
      } catch (err) {
        last = err as Error
      }
    }
    if (last) throw last
  }

  async function sendCal(port: HsPort, payload: number[], retries: number[]): Promise<void> {
    let last: Error | null = null
    for (const delay of retries) {
      if (delay) await sleep(delay)
      try {
        const r = await ask(port, HsCmd.ActionStart, HS_CAL_ACTION[0], HS_CAL_ACTION[1], 0, 0, payload)
        if (r.status === 0) return
        last = new Error(`hyperstrike: calibration step refused — ${HS_STATUS[r.status] ?? r.status}`)
      } catch (err) {
        last = err as Error
      }
      await waitActionLane(port).catch(() => undefined)
    }
    throw last ?? new Error('hyperstrike: calibration step failed')
  }

  /**
   * One calibration step, exactly as the Hub sends it. `begin` first waits for
   * an idle action lane; the pad stores the result itself on `end`.
   */
  async function calibrate(path: string, step: HsCalStep, type: HsCalType): Promise<void> {
    const payload = calPayload(step, type)
    const port = await open(path)
    try {
      await handshake(port)
      if (step === 'begin') await waitActionLane(port)
      await sendCal(port, payload, step === 'begin' ? [0, 60, 140] : [0, 50, 120])
    } finally {
      await port.close().catch(() => {})
    }
  }

  /** The Hub's automatic center pass: begin, three samples 20 ms apart, end. Sticks must be still. */
  async function calibrateCenterAuto(path: string): Promise<void> {
    const port = await open(path)
    try {
      await handshake(port)
      await waitActionLane(port)
      await sendCal(port, calPayload('begin', 'center'), [0, 60, 140])
      for (let i = 0; i < 3; i++) {
        await sleep(20)
        await sendCal(port, calPayload('sample', 'center'), [0, 50, 120])
      }
      await sleep(20)
      await sendCal(port, calPayload('end', 'center'), [0, 50, 120])
    } finally {
      await port.close().catch(() => {})
    }
  }

  /** FINE_TUNE_DATA: 12 × u16 LE center fine-tune values. */
  async function readFineTune(path: string): Promise<number[]> {
    const port = await open(path)
    try {
      await handshake(port)
      const b = await readObject(port, HS_FINE_TUNE)
      if (b.length !== 24) throw new Error(`hyperstrike: fine-tune data is ${b.length} bytes, expected 24`)
      return Array.from({ length: 12 }, (_, i) => u16(b, i * 2))
    } finally {
      await port.close().catch(() => {})
    }
  }

  /** Write fine-tune values the Hub's way (SET_VALUE, saved by the pad), then read them back. */
  async function writeFineTune(path: string, values: number[]): Promise<number[]> {
    if (values.length !== 12 || values.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffff)) throw new Error('hyperstrike: fine-tune data is 12 values 0..65535')
    const payload: number[] = []
    values.forEach((v) => payload.push(v & 0xff, (v >> 8) & 0xff))
    const port = await open(path)
    try {
      await handshake(port)
      const r = await ask(port, HsCmd.SetValue, HS_FINE_TUNE[0], HS_FINE_TUNE[1], 0, 0, payload)
      if (r.status !== 0) throw new Error(`hyperstrike: fine-tune write refused — ${HS_STATUS[r.status] ?? r.status}`)
      const back = await readObject(port, HS_FINE_TUNE)
      const got = Array.from({ length: 12 }, (_, i) => u16(back, i * 2))
      if (got.join() !== values.join()) throw new Error('hyperstrike: fine-tune data read back different values')
      return got
    } finally {
      await port.close().catch(() => {})
    }
  }

  return { readSnapshot, writeVerified, switchProfile, calibrate, calibrateCenterAuto, readFineTune, writeFineTune }
}
