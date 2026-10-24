/**
 * Flydigi Apex 5 ("k5") over its vendor HID interface (MI_02, usage page
 * 0xFFA0 / usage 0x01). Read-only for now: the session only sends the reads
 * Space Station sends on connect (heartbeat, hardware status, UID, raw-data
 * status, mapping config). Field map: research_notes/Flydigi Apex 5 protocol.md,
 * from the decompiled Space Station SDK and checked against USB captures.
 *
 * Frames are 32-byte numbered reports. OUT: `03 5a a5 <cmd> <len> <args…> <sum>`
 * where len = 2 + args and sum is the 8-bit sum of cmd..last arg. IN: `04 5a a5
 * <cmd> …`. Offsets below index the frame without its report id (`5a` = 0), the
 * same way the SDK does.
 */

export const FD_VENDOR_ID = 0x37d7
export const FD_USAGE_PAGE = 0xffa0
export const FD_USAGE = 0x01
export const FD_FRAME = 32
export const FD_OUT_REPORT = 0x03
export const FD_IN_REPORT = 0x04

/** Match by VID + usage page + usage, never PID (see AGENTS.md). */
export const isFdIdentity = (d: { vendorId?: number; usagePage?: number; usage?: number }): boolean =>
  d.vendorId === FD_VENDOR_ID && d.usagePage === FD_USAGE_PAGE && d.usage === FD_USAGE

export const FdCmd = { Heartbeat: 0x01, HardwareStatus: 0x03, Uid: 0x04, RawDataStatus: 0x10, ReadConfig: 0xa3 } as const
/** The only commands this module will build. Anything else (writes, tests, firmware mode) is refused. */
const READS: ReadonlySet<number> = new Set(Object.values(FdCmd))

/** Space Station device types filed under k5 (Apex 5 variants). */
const APEX5_TYPES = new Set([128, 129, 133, 134, 135, 136])

export function fdRequest(cmd: number, args: number[] = []): number[] {
  if (!READS.has(cmd)) throw new Error(`flydigi: refusing to send command 0x${cmd.toString(16)} (read-only)`)
  return frame(cmd, args)
}

/**
 * Writes Space Station sends (SDK NewXInput classes): 0x13 hardware toggle
 * (stick debounce 5, auto-calibration 6, rebound 7 only), 0x15 stick precision,
 * 0x16 centre sensitivity, 0x17 sleep, and the mapping-config write
 * a4 start / a5 packet / a6 save. Firmware mode, tests and calibration are refused.
 */
export const FdWrite = { Toggle: 0x13, Precision: 0x15, Sensitivity: 0x16, Sleep: 0x17, ConfigStart: 0xa4, ConfigPacket: 0xa5, ConfigSave: 0xa6 } as const
const WRITES: ReadonlySet<number> = new Set(Object.values(FdWrite))
export const FdToggleId = { stickDebounce: 5, autoCalibration: 6, rebound: 7 } as const
export type FdToggleName = keyof typeof FdToggleId

export function fdWriteRequest(cmd: number, args: number[] = []): number[] {
  if (!WRITES.has(cmd)) throw new Error(`flydigi: refusing to send command 0x${cmd.toString(16)}`)
  if (cmd === FdWrite.Toggle && !Object.values(FdToggleId).includes(args[0] as 5 | 6 | 7)) throw new Error(`flydigi: refusing toggle ${args[0]}`)
  return frame(cmd, args)
}

function frame(cmd: number, args: number[]): number[] {
  if (args.length > FD_FRAME - 6) throw new Error('flydigi: frame too long')
  const b = new Array<number>(FD_FRAME).fill(0)
  b[0] = FD_OUT_REPORT
  b[1] = 0x5a
  b[2] = 0xa5
  b[3] = cmd
  b[4] = 2 + args.length
  args.forEach((a, i) => (b[5 + i] = a & 0xff))
  let sum = 0
  for (let i = 3; i < 3 + b[4]; i++) sum = (sum + b[i]) & 0xff
  b[3 + b[4]] = sum
  return b
}

/** A reply frame without its report id, or null when it isn't one. */
export function fdParse(raw: ArrayLike<number>): number[] | null {
  const a = Array.from(raw)
  const d = a[0] === FD_IN_REPORT && a[1] === 0x5a ? a.slice(1) : a
  return d[0] === 0x5a && d[1] === 0xa5 && d.length >= 5 ? d : null
}

const nibbles = (hi: number, lo: number): string => `${hi >> 4}.${hi & 15}.${lo >> 4}.${lo & 15}`

export interface FdHeartbeat {
  deviceType: number
  name: string
  /** 1 = USB cable (SDK ConnectType). */
  connectType: number
  /** 0..5, null while charging. */
  battery: number | null
  charging: boolean
  firmware: string
  screenFirmware: string | null
}

export function decodeHeartbeat(d: number[]): FdHeartbeat {
  // Single-frame reply: total at [3], index at [4], fields from [5].
  const deviceType = d[5]
  const bat = d[11]
  // [12] chip, [13] motion chip, [15..16] firmware, then dongle / switch / trigger / screen pairs.
  const screen = nibbles(d[23] ?? 0, d[24] ?? 0)
  return {
    deviceType,
    name: APEX5_TYPES.has(deviceType) ? 'Flydigi Apex 5' : 'Flydigi controller',
    connectType: d[6],
    battery: bat >> 4 === 1 ? null : bat & 15,
    charging: bat >> 4 === 1,
    firmware: nibbles(d[15], d[16]),
    screenFirmware: screen === '0.0.0.0' ? null : screen
  }
}

export const FD_REPORT_RATE: Record<number, number> = { 1: 1000, 2: 500, 4: 250, 8: 125 }
export const FD_PRECISION_BITS: Record<number, number> = { 1: 8, 2: 10, 3: 12, 4: 9, 5: 11, 6: 14, 7: 16 }
export const FD_SENSITIVITY = ['Highest', 'High', 'MiddleHigh', 'Middle', 'LowMiddle', 'Low', 'Lowest'] as const
export type FdSensitivity = (typeof FD_SENSITIVITY)[number]

export interface FdToggle { usable: boolean; enabled: boolean }
export interface FdHardware {
  quickSwitch: FdToggle
  xboxHome: FdToggle
  motionDebounce: FdToggle
  mappingSwitch: FdToggle
  stickDebounce: FdToggle
  autoCalibration: FdToggle
  rebound: FdToggle
  /** Minutes; 0 = never. */
  sleepMinutes: number
  reportRateHz: number | null
  stickBits: number | null
  centerSensitivity: FdSensitivity | null
}

export function decodeHardware(d: number[]): FdHardware {
  const t = (bit: number): FdToggle => ({ usable: ((d[5] >> bit) & 1) === 1, enabled: ((d[6] >> bit) & 1) === 1 })
  return {
    quickSwitch: t(0),
    xboxHome: t(1),
    motionDebounce: t(2),
    mappingSwitch: t(3),
    stickDebounce: t(4),
    autoCalibration: t(5),
    rebound: t(6),
    sleepMinutes: d[9],
    reportRateHz: FD_REPORT_RATE[d[10]] ?? null,
    stickBits: FD_PRECISION_BITS[d[11]] ?? null,
    centerSensitivity: FD_SENSITIVITY[d[12] - 14] ?? null
  }
}

export const decodeUid = (d: number[]): string => d.slice(5, 18).map((b) => b.toString(16).padStart(2, '0')).join('')

/** Mapping config: 20-byte packets; the stick extension (V31) lives at 790 (L) and 802 (R). */
export const FD_PACKET = 20
export const FD_STICK_EXT = [790, 802] as const
export const FD_CURVE_TYPES = ['Default', 'Quick', 'Slow', 'Custom'] as const
export type FdCurveType = (typeof FD_CURVE_TYPES)[number]

export interface FdStick {
  type: FdCurveType | null
  /** Output % (−50..100) at stick travel 0, 12.5, … 100 %. */
  curve: number[]
  circular: boolean
  /** >0 outer deadzone %, <0 output cap %. */
  edge: number
}

/** Space Station's signed byte: values above 127 mean 127 − value. */
const signed = (b: number): number => (b > 127 ? 127 - b : b)

export function decodeStick(blob: number[], side: 0 | 1): FdStick {
  const o = FD_STICK_EXT[side]
  return {
    type: FD_CURVE_TYPES[blob[o]] ?? null,
    curve: blob.slice(o + 1, o + 10).map((v) => v - 50),
    circular: blob[o + 10] === 1,
    edge: signed(blob[o + 11])
  }
}

/** Travel % of curve point i (0, 12.5, … 100). */
export const fdCurveX = (i: number): number => i * 12.5

/**
 * Zones the 9-point curve implies, in % of travel / output: the inner deadzone
 * (where output first rises above 0), the anti-deadzone (output at rest when
 * the curve starts above 0) and the travel where output first reaches 100 %.
 */
export function fdZones(curve: number[]): { deadzone: number; anti: number; full: number } {
  const at = (i: number, target: number): number => {
    const [x0, x1, y0, y1] = [fdCurveX(i - 1), fdCurveX(i), curve[i - 1], curve[i]]
    return y1 === y0 ? x1 : x0 + ((target - y0) * (x1 - x0)) / (y1 - y0)
  }
  let deadzone = 0
  if (curve[0] <= 0) {
    const i = curve.findIndex((y) => y > 0)
    deadzone = i < 0 ? 100 : at(i, 0)
  }
  const j = curve.findIndex((y) => y >= 100)
  const full = j <= 0 ? (j === 0 ? 0 : 100) : at(j, 100)
  const r = (v: number): number => Math.round(v * 10) / 10
  return { deadzone: r(deadzone), anti: Math.max(0, curve[0]), full: r(full) }
}

/**
 * Button mapping: bytes 13.. hold 3 bytes per Space Station ControllerKey id —
 * [target, turbo mode, turbo rate]. Target 0xff = the key's own function,
 * 0xfe = a keyboard/multi-function binding (kept in a separate table),
 * 0x20 = macro, anything else = the ControllerKey it presses instead.
 */
export const FD_KEY_BASE = 13
export const FdKey = { Up: 0, Right: 1, Down: 2, Left: 3, A: 4, B: 5, Select: 6, X: 7, Y: 8, Start: 9, Lb: 10, Rb: 11, Lt: 12, Rt: 13, Thl: 14, Thr: 15, M1: 18, M2: 19, M3: 20, M4: 21, M5: 22, M6: 23, Home: 27 } as const
export type FdKeyName = keyof typeof FdKey
/** Keys the Apex 5 lets Space Station remap (SDK GenerateControllerApex5, minus Home/Menu/Turbo). */
export const FD_REMAPPABLE: readonly FdKeyName[] = ['A', 'B', 'X', 'Y', 'Up', 'Down', 'Left', 'Right', 'Lb', 'Rb', 'Lt', 'Rt', 'Thl', 'Thr', 'Select', 'Start', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']
/** Outputs a key can press. */
export const FD_TARGETS: readonly FdKeyName[] = ['A', 'B', 'X', 'Y', 'Up', 'Down', 'Left', 'Right', 'Lb', 'Rb', 'Lt', 'Rt', 'Thl', 'Thr', 'Select', 'Start']
export const FD_KEY_SELF = 0xff
export const FD_KEY_KEYBOARD = 0xfe
export const FD_KEY_MACRO = 0x20

/** Target byte per key id (0..28). */
export const decodeKeys = (blob: number[]): number[] => Array.from({ length: 29 }, (_, id) => blob[FD_KEY_BASE + id * 3])

/** The config with new key targets; a key set to its own id is stored as 0xff, and turbo is cleared like the SDK does. */
export function withKeys(blob: number[], keys: Record<number, number>): number[] {
  const next = blob.slice()
  for (const [idText, target] of Object.entries(keys)) {
    const id = Number(idText)
    if (!FD_REMAPPABLE.some((k) => FdKey[k] === id)) throw new Error(`flydigi: key ${id} is not remappable`)
    const t = target === id ? FD_KEY_SELF : target
    if (t !== FD_KEY_SELF && !FD_TARGETS.some((k) => FdKey[k] === t)) throw new Error(`flydigi: target ${t} is not supported`)
    const o = FD_KEY_BASE + id * 3
    next[o] = t
    next[o + 1] = 0
    next[o + 2] = 0
  }
  return next
}

/** Live stick position on the app's 0..255 cross (up = smaller Y). */
export interface FdLive { lx: number; ly: number; rx: number; ry: number }

/** Decode an 0xEF input frame (report id stripped): int16 LE sticks at [3..10], Y negated like the SDK. */
export function decodeLive(d: number[]): FdLive | null {
  if (d[2] !== 0xef || d.length < 11) return null
  const s16 = (lo: number, hi: number): number => { const v = lo | (hi << 8); return v > 32767 ? v - 65536 : v }
  const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round((v + 32768) / 257)))
  return { lx: to255(s16(d[3], d[4])), ly: to255(-s16(d[5], d[6])), rx: to255(s16(d[7], d[8])), ry: to255(-s16(d[9], d[10])) }
}

export interface FdSnapshot {
  device: FdHeartbeat & { uid: string }
  hardware: FdHardware
  sticks: [FdStick, FdStick]
  /** Target byte per ControllerKey id (see decodeKeys). */
  keys: number[]
  /** Profile title stored in the config (UTF-16LE), when set. */
  title: string | null
}

export function decodeTitle(blob: number[]): string | null {
  const bytes = blob.slice(770, 790)
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i] | (bytes[i + 1] << 8)
    if (c === 0 || c === 0xffff) break
    s += String.fromCharCode(c)
  }
  return s.trim() || null
}

/** 12-byte stick extension, the inverse of decodeStick. */
export function encodeStick(s: FdStick): number[] {
  if (s.curve.length !== 9) throw new Error('flydigi: a curve has 9 points')
  const type = s.type ? FD_CURVE_TYPES.indexOf(s.type) : 3
  const edge = Math.max(-100, Math.min(100, Math.round(s.edge)))
  return [
    type < 0 ? 3 : type,
    ...s.curve.map((y) => Math.max(-50, Math.min(100, Math.round(y))) + 50),
    s.circular ? 1 : 0,
    edge < 0 ? 127 - edge : edge
  ]
}

/** The config with new stick extensions; every other byte is kept as read. */
export function withSticks(blob: number[], sticks: readonly [FdStick | null, FdStick | null]): number[] {
  const next = blob.slice()
  sticks.forEach((s, i) => s && encodeStick(s).forEach((b, k) => (next[FD_STICK_EXT[i] + k] = b)))
  return next
}

/** Curve parameters as Space Station's stick page edits them. */
export interface FdCurveParams {
  /** −100..100: >0 inner deadzone %, <0 anti-deadzone %. */
  center: number
  /** −100..100: >0 outer deadzone %, <0 output cap %. */
  edge: number
  /** Bend points inside the center→edge box, 0..127 per axis. */
  p1: { x: number; y: number }
  p2: { x: number; y: number }
}

/** Space Station's preset bend points (renderer: Quick "real_time", Slow "delay"). */
export const FD_PRESET_P1 = { Default: { x: 64, y: 64 }, Quick: { x: 64, y: 96 }, Slow: { x: 64, y: 32 } } as const
/** The pad's own linear default, as stored (9 points, output %). */
export const FD_LINEAR = [0, 12, 25, 37, 50, 62, 75, 87, 100]

/**
 * Space Station's 9-point sampler (renderer functions Ke/Xe/F/$, ported as-is):
 * the polyline center → p1 → p2 → edge sampled at 0, 12.5, … 100 % travel,
 * rounded and clamped to −50..100 (negative output = still inside the deadzone).
 */
export function fdBuildCurve(p: FdCurveParams): number[] {
  const center = { x: p.center > 0 ? p.center : 0, y: p.center < 0 ? -p.center : 0 }
  const edge = { x: p.edge > 0 ? 100 - p.edge : 100, y: p.edge > 0 ? 100 : 100 + p.edge }
  const dx = edge.x - center.x
  const dy = edge.y - center.y
  const bend = (q: { x: number; y: number }): { x: number; y: number } => ({ x: Math.round(center.x + dx * (q.x / 127)), y: Math.round(center.y + dy * (q.y / 127)) })
  const p1 = bend(p.p1)
  const pts = [center, p1, bend(p.p2), edge]
  const zero = (q: { y: number }): boolean => q.y === 0
  const lerp = (x0: number, y0: number, x1: number, y1: number, x: number): number => (x0 === x1 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0))
  const sample = (x: number): number => {
    const first = pts[0]
    if (first.x === p1.x && zero(first) && x === first.x) return first.y
    let y = pts[pts.length - 1].y
    for (let i = zero(p1) ? 2 : 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      if (x <= b.x) {
        if (x === b.x && i + 1 < pts.length) {
          const c = pts[i + 1]
          if (b.x === c.x && b.y < c.y) { y = c.y; break }
        }
        y = a.x === b.x ? (zero(a) && !zero(b) ? (x < a.x ? a.y : b.y) : a.y) : lerp(a.x, a.y, b.x, b.y, x)
        break
      }
    }
    return y
  }
  return Array.from({ length: 9 }, (_, i) => Math.max(-50, Math.min(100, Math.round(sample(fdCurveX(i))))))
}

/**
 * The shared stick/curve cards edit 9 [x, y] points on a 0..1000 grid (first
 * point = deadzone / anti-deadzone, last = outer zone / max output). These map
 * the Apex 5's fixed 12.5 % samples to that form and back.
 */
export const FD_POINTS = 9
type Pair = [number, number]

function polyAt(pts: Pair[], x: number): number {
  if (x <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    if (x <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
  }
  return pts[pts.length - 1][1]
}

export function fdToPoints(curve: number[]): Pair[] {
  const z = fdZones(curve)
  const samples: Pair[] = curve.map((y, i) => [fdCurveX(i) * 10, y * 10])
  const sx = Math.round(z.deadzone * 10)
  const ex = Math.max(sx, Math.round(z.full * 10))
  const clampY = (y: number): number => Math.max(0, Math.min(1000, Math.round(y)))
  const out: Pair[] = [[sx, Math.round(z.anti * 10)]]
  for (let k = 1; k < FD_POINTS - 1; k++) {
    const x = Math.round(sx + ((ex - sx) * k) / (FD_POINTS - 1))
    out.push([x, clampY(polyAt(samples, x))])
  }
  out.push([ex, clampY(polyAt(samples, ex))])
  return out
}

export function fdFromPoints(points: ReadonlyArray<readonly [number, number]>): number[] {
  const pts = points.map(([x, y]) => [x, y] as Pair).sort((a, b) => a[0] - b[0])
  const [x0, y0] = pts[0]
  const next = pts.find(([x]) => x > x0) ?? pts[pts.length - 1]
  const slope = next[0] > x0 ? (next[1] - y0) / (next[0] - x0) : 0
  return Array.from({ length: 9 }, (_, i) => {
    const x = fdCurveX(i) * 10
    // Inside the deadzone the firmware outputs 0 for any value ≤ 0: extend the first
    // segment below zero so the stored line still crosses 0 where the deadzone ends.
    const y = x < x0 ? (y0 > 0 ? 0 : y0 + slope * (x - x0)) : polyAt(pts, x)
    return Math.max(-50, Math.min(100, Math.round(y / 10)))
  })
}

/** Consecutive changed 20-byte packets: Space Station's partial write. */
export function changedRuns(before: number[], after: number[]): Array<{ start: number; packets: number[][] }> {
  const runs: Array<{ start: number; packets: number[][] }> = []
  const count = Math.ceil(after.length / FD_PACKET)
  for (let p = 0; p < count; p++) {
    const a = before.slice(p * FD_PACKET, (p + 1) * FD_PACKET)
    const b = after.slice(p * FD_PACKET, (p + 1) * FD_PACKET)
    if (a.every((v, i) => v === b[i])) continue
    const last = runs[runs.length - 1]
    if (last && last.start + last.packets.length === p) last.packets.push(b)
    else runs.push({ start: p, packets: [b] })
  }
  return runs
}

/** a4/a5 frames for every changed run, then a6 with the new data version. */
export function configWriteFrames(before: number[], after: number[], version: number, cfgId = 0): number[][] {
  const frames: number[][] = []
  for (const run of changedRuns(before, after)) {
    frames.push(fdWriteRequest(FdWrite.ConfigStart, [cfgId, run.start, run.packets.length, FD_PACKET]))
    run.packets.forEach((pk, i) => frames.push(fdWriteRequest(FdWrite.ConfigPacket, [i, ...pk])))
  }
  if (frames.length) frames.push(fdWriteRequest(FdWrite.ConfigSave, [version & 0xff, (version >> 8) & 0xff]))
  return frames
}

/** Data version at 225..226; a save uses a new random one (SDK ControllerRepository). */
export const dataVersion = (blob: number[]): number => blob[225] | (blob[226] << 8)
export function nextVersion(current: number, rand: () => number = Math.random): number {
  let v = current
  while (v === current) v = Math.floor(rand() * 65535)
  return v
}

/** Settings the Device page edits; each is one SDK command, verified with 0x03. */
export interface FdHardwareEdit {
  stickDebounce?: boolean
  autoCalibration?: boolean
  rebound?: boolean
  stickBits?: number
  centerSensitivity?: FdSensitivity
  sleepMinutes?: number
}

export function hardwareFrames(edit: FdHardwareEdit): number[][] {
  const out: number[][] = []
  for (const name of Object.keys(FdToggleId) as FdToggleName[]) {
    const v = edit[name]
    if (v !== undefined) out.push(fdWriteRequest(FdWrite.Toggle, [FdToggleId[name], v ? 1 : 0]))
  }
  if (edit.stickBits !== undefined) {
    const code = Object.entries(FD_PRECISION_BITS).find(([, b]) => b === edit.stickBits)?.[0]
    if (!code) throw new Error(`flydigi: unsupported precision ${edit.stickBits}`)
    out.push(fdWriteRequest(FdWrite.Precision, [Number(code)]))
  }
  if (edit.centerSensitivity !== undefined) out.push(fdWriteRequest(FdWrite.Sensitivity, [14 + FD_SENSITIVITY.indexOf(edit.centerSensitivity)]))
  if (edit.sleepMinutes !== undefined) out.push(fdWriteRequest(FdWrite.Sleep, [Math.max(0, Math.min(255, Math.round(edit.sleepMinutes)))]))
  return out
}

/** Does the read-back status match the edit? */
export function hardwareMatches(hw: FdHardware, edit: FdHardwareEdit): boolean {
  return (Object.keys(FdToggleId) as FdToggleName[]).every((n) => edit[n] === undefined || hw[n].enabled === edit[n]) &&
    (edit.stickBits === undefined || hw.stickBits === edit.stickBits) &&
    (edit.centerSensitivity === undefined || hw.centerSensitivity === edit.centerSensitivity) &&
    (edit.sleepMinutes === undefined || hw.sleepMinutes === edit.sleepMinutes)
}

export interface FdEdit {
  /** Only the sticks that changed (null = leave that stick exactly as the pad has it). */
  sticks?: [FdStick | null, FdStick | null]
  /** Key id → target key id (its own id = default). */
  keys?: Record<number, number>
  hardware?: FdHardwareEdit
}

export interface FdPort {
  /** One full frame including the report id. */
  write(frame: number[]): Promise<void>
  /** One input frame including the report id, or null on timeout. */
  read(timeoutMs: number): Promise<number[] | null>
  close(): Promise<void>
}

export function createFdSession(open: (path: string) => Promise<FdPort>) {
  /** Send one read and collect its reply frames (multi-frame replies carry total at [3] and index at [4]). */
  async function ask(port: FdPort, cmd: number, args: number[] = [], timeoutMs = 1500): Promise<number[][]> {
    return send(port, fdRequest(cmd, args), timeoutMs)
  }

  /** Send one built frame and collect the reply frames that echo its command. */
  async function send(port: FdPort, out: number[], timeoutMs = 1500): Promise<number[][]> {
    const cmd = out[3]
    await port.write(out)
    const frames = new Map<number, number[]>()
    let total = 1
    const deadline = Date.now() + timeoutMs
    while (frames.size < total && Date.now() < deadline) {
      const raw = await port.read(Math.max(1, deadline - Date.now()))
      const d = raw && fdParse(raw)
      if (!d || d[2] !== cmd) continue
      if (cmd === FdCmd.ReadConfig) {
        total = d[3]
        frames.set(d[4], d)
      } else frames.set(0, d)
    }
    if (frames.size < total) throw new Error(`flydigi: no reply to command 0x${cmd.toString(16)} (close Flydigi Space Station if it keeps failing)`)
    return [...frames.entries()].sort((a, b) => a[0] - b[0]).map(([, d]) => d)
  }

  async function readConfig(port: FdPort, cfgId = 0): Promise<number[]> {
    const frames = await ask(port, FdCmd.ReadConfig, [cfgId, FD_PACKET], 4000)
    return frames.flatMap((d) => d.slice(6, 6 + FD_PACKET))
  }

  /** Heartbeat, status, UID and (unless given) the config, all on one open port. */
  async function snapshotOn(port: FdPort, blob?: number[]): Promise<FdSnapshot> {
    const [hb] = await ask(port, FdCmd.Heartbeat)
    const [hw] = await ask(port, FdCmd.HardwareStatus)
    const [uid] = await ask(port, FdCmd.Uid)
    const cfg = blob ?? (await readConfig(port))
    return {
      device: { ...decodeHeartbeat(hb), uid: decodeUid(uid) },
      hardware: decodeHardware(hw),
      sticks: [decodeStick(cfg, 0), decodeStick(cfg, 1)],
      keys: decodeKeys(cfg),
      title: decodeTitle(cfg)
    }
  }

  async function readSnapshot(path: string): Promise<FdSnapshot> {
    const port = await open(path)
    try {
      return await snapshotOn(port)
    } finally {
      await port.close()
    }
  }

  /** Write one frame and wait for its ack: the same command echoed with status 0 at [4] (live: `5a a5 13 01 00 <value> <sum>`). */
  async function writeAcked(port: FdPort, out: number[]): Promise<void> {
    const [ack] = await send(port, out)
    if (ack[4] !== 0) throw new Error(`flydigi: command 0x${out[3].toString(16)} was refused (status ${ack[4]})`)
  }

  async function writeConfig(port: FdPort, before: number[], after: number[]): Promise<void> {
    for (const f of configWriteFrames(before, after, nextVersion(dataVersion(before)))) await writeAcked(port, f)
  }

  /** Bytes a stick/key edit owns: both stick extensions and every key slot. */
  const OWNED = [...FD_STICK_EXT.flatMap((o) => Array.from({ length: 12 }, (_, i) => o + i)), ...Array.from({ length: 29 * 3 }, (_, i) => FD_KEY_BASE + i)]

  /**
   * Read-modify-write with readback. Changed config packets are written,
   * saved, read back and compared; on a mismatch or a failed ack the previous
   * stick/key bytes are written back. Device settings go one at a time and are
   * checked with a fresh 0x03; on a mismatch or a refused command every setting
   * already sent is put back.
   */
  async function writeVerified(path: string, edit: FdEdit): Promise<FdSnapshot> {
    const port = await open(path)
    try {
      let blob: number[] | undefined
      if (edit.sticks || edit.keys) {
        const before = await readConfig(port)
        let after = edit.sticks ? withSticks(before, edit.sticks) : before.slice()
        if (edit.keys) after = withKeys(after, edit.keys)
        if (changedRuns(before, after).length) {
          let failure: Error | null = null
          try {
            await writeConfig(port, before, after)
            const back = await readConfig(port)
            if (OWNED.every((i) => back[i] === after[i])) blob = back
            else failure = new Error('flydigi: stick or button settings did not read back — the previous values were restored')
          } catch (e) {
            failure = new Error(`${(e as Error).message} — the previous stick and button values were restored`)
          }
          if (failure) {
            try {
              const now = await readConfig(port)
              const restore = now.slice()
              OWNED.forEach((i) => (restore[i] = before[i]))
              await writeConfig(port, now, restore)
            } catch { /* pad gone: nothing more to do */ }
            throw failure
          }
        }
      }
      if (edit.hardware) {
        const [old] = await ask(port, FdCmd.HardwareStatus)
        const prev = decodeHardware(old)
        const was: Required<FdHardwareEdit> = {
          stickDebounce: prev.stickDebounce.enabled,
          autoCalibration: prev.autoCalibration.enabled,
          rebound: prev.rebound.enabled,
          stickBits: prev.stickBits ?? 0,
          centerSensitivity: prev.centerSensitivity ?? 'Middle',
          sleepMinutes: prev.sleepMinutes
        }
        const sent: Array<keyof FdHardwareEdit> = []
        let failure: Error | null = null
        try {
          for (const k of Object.keys(edit.hardware) as Array<keyof FdHardwareEdit>) {
            if (edit.hardware[k] === undefined) continue
            sent.push(k)
            for (const f of hardwareFrames({ [k]: edit.hardware[k] })) await writeAcked(port, f)
          }
          const [now] = await ask(port, FdCmd.HardwareStatus)
          if (!hardwareMatches(decodeHardware(now), edit.hardware)) failure = new Error('flydigi: device settings did not read back — the previous values were restored')
        } catch (e) {
          failure = new Error(`${(e as Error).message} — the previous device settings were restored`)
        }
        if (failure) {
          for (const k of sent) {
            // A value the pad never reported (e.g. unknown precision) cannot be put back.
            if ((k === 'stickBits' && !prev.stickBits) || (k === 'centerSensitivity' && !prev.centerSensitivity)) continue
            try { for (const f of hardwareFrames({ [k]: was[k] })) await writeAcked(port, f) } catch { /* keep restoring the rest */ }
          }
          throw failure
        }
      }
      return await snapshotOn(port, blob)
    } finally {
      await port.close()
    }
  }

  /**
   * Live sticks from the pad's own input frame (cmd 0xEF, SDK OperatorDataParser),
   * so a second XInput pad can't stand in for it. The first call starts a
   * listener; it stops itself once nobody has asked for 2 s. Null until a frame
   * arrives (or when the pad doesn't stream), so callers can fall back.
   */
  let live: { path: string; sample: FdLive | null; at: number; polled: number; stop: boolean } | null = null
  async function pump(state: NonNullable<typeof live>): Promise<void> {
    let port: FdPort
    try { port = await open(state.path) } catch { if (live === state) live = null; return }
    try {
      while (!state.stop && Date.now() - state.polled < 2000) {
        // Drain what has arrived (keep the newest frame), then yield: node-hid reads are
        // synchronous, and a tight loop at ~560 frames/s would starve the main process.
        for (let n = 0; n < 256; n++) {
          const raw = await port.read(0)
          if (!raw) break
          const d = fdParse(raw)
          const s = d && decodeLive(d)
          if (s) { state.sample = s; state.at = Date.now() }
        }
        await new Promise((r) => setTimeout(r, 8))
      }
    } finally {
      await port.close()
      if (live === state) live = null
    }
  }
  function liveSample(path: string): FdLive | null {
    if (!live || live.path !== path) {
      if (live) live.stop = true
      live = { path, sample: null, at: 0, polled: Date.now(), stop: false }
      void pump(live)
    }
    live.polled = Date.now()
    return live.sample && Date.now() - live.at < 500 ? live.sample : null
  }

  return { readSnapshot, writeVerified, liveSample, readConfig: async (path: string, cfgId = 0) => { const p = await open(path); try { return await readConfig(p, cfgId) } finally { await p.close() } } }
}
