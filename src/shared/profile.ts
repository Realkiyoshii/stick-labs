/**
 * G7 Pro 8K profile codec — the 1070-byte blob.
 *
 * Design decision: packets are stored as **raw bytes** with accessor helpers,
 * rather than being destructured into a plain object and re-serialised.
 *
 * Packet boundaries are proven (32+32+112+676+64+72+82 = 1070, and section
 * starts match a live hexdump), so round-trip fidelity is exact by
 * construction. If an accessor's semantics are wrong, only that one UI field
 * reads oddly — the profile on disk is never corrupted.
 */

import {
  FUNCTION_KEYS,
  LIGHT_PROFILE_LENGTH,
  MACRO_STEP_MAX,
  MOTION_SENSORS,
  PACKET,
  PROFILE_LENGTH,
  SECTION,
  STANDARD_BUTTONS,
  STICKS,
  TRIGGERS,
  type FunctionKey,
  type MotionName,
  type StandardButton,
  type StickName,
  type TriggerName
} from './protocol'

// ---------------------------------------------------------------------------
// Packet — a slice of the blob with byte-level accessors
// ---------------------------------------------------------------------------

export class Packet {
  readonly bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  u8(offset: number): number {
    return this.bytes[offset] ?? 0
  }

  setU8(offset: number, value: number): void {
    if (offset >= 0 && offset < this.bytes.length) {
      this.bytes[offset] = value & 0xff
    }
  }

  /** 16-bit big-endian. Deadzone fields are BE: `03 e8` = 1000. */
  u16be(offset: number): number {
    return ((this.u8(offset) << 8) | this.u8(offset + 1)) >>> 0
  }

  setU16be(offset: number, value: number): void {
    this.setU8(offset, (value >> 8) & 0xff)
    this.setU8(offset + 1, value & 0xff)
  }

  bit(offset: number, index: number): boolean {
    return ((this.u8(offset) >> index) & 1) === 1
  }

  setBit(offset: number, index: number, on: boolean): void {
    const current = this.u8(offset)
    this.setU8(offset, on ? current | (1 << index) : current & ~(1 << index))
  }

  get length(): number {
    return this.bytes.length
  }

  /** Copy — used so callers can mutate without touching the source blob. */
  clone(): Packet {
    return new Packet(this.bytes.slice())
  }
}

// ---------------------------------------------------------------------------
// Profile model
// ---------------------------------------------------------------------------

export interface Profile {
  /** Geometry key into GEOMETRIES — set by parse, honoured by serialize. */
  model: string
  /** UTF-8, trimmed, max 32 bytes. */
  name: string
  /** Motor / audio / extend flags. */
  funData: Packet
  /** 16 standard buttons × 7 bytes. */
  buttons: Packet[]
  /** 4 function keys × 169 bytes (macro-capable). */
  functionKeys: Packet[]
  /** 2 triggers × 32 bytes (deadzone + hair trigger). */
  triggers: Packet[]
  /** 2 sticks × 36 bytes (deadzone + curve). */
  sticks: Packet[]
  /** 2 motion sensors × 41 bytes. */
  motion: Packet[]
  /** Anything trailing — never dropped. */
  tail: Uint8Array
}

/**
 * Copy a section into its own buffer.
 *
 * Deliberately `.slice()` (copy) rather than `.subarray()` (view): a parsed
 * Profile must never alias the caller's bytes, otherwise editing one field
 * silently mutates the source blob.
 */
function slice(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  const end = Math.min(offset + length, bytes.length)
  return bytes.slice(offset, end)
}

function decodeName(bytes: Uint8Array): string {
  const raw = bytes.subarray(0, PACKET.Name)
  let end = raw.indexOf(0)
  if (end < 0) end = raw.length
  return new TextDecoder().decode(raw.subarray(0, end)).replace(/\0/g, '').trim()
}

function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(PACKET.Name)
  const encoded = new TextEncoder().encode(name.slice(0, PACKET.Name))
  out.set(encoded.subarray(0, PACKET.Name))
  return out
}

/**
 * Per-model blob geometry. The packet *codecs* (Packet + accessors below)
 * are offset-agnostic; only section starts/counts differ per model.
 *
 * G7ProCE/G7ProS: 1070 bytes (proven against hardware fixtures).
 * T3CE (Tarantula): 1935 bytes — Name/Fun/Mapping/FunctionKeys/Triggers/
 *   Sticks/Motion/Ext8/Ext9, resolved from the GameSir bundle's own
 *   sequential parser (Name32, Fun32, 16x7, 9x169, 2x32, 2x36, 2x41,
 *   10, 10 = 1935) and confirmed against live dumps.
 */
export interface ModelGeometry {
  total: number
  funOffset: number
  buttons: { offset: number; count: number; len: number }
  functionKeys: Array<{ offset: number; count: number; len: number }>
  triggers: { offset: number; count: number; len: number }
  sticks: { offset: number; count: number; len: number }
  motion: { offset: number; count: number; len: number }
}

export const GEOMETRIES: Record<string, ModelGeometry> = {
  G7ProCE: {
    total: 1070,
    funOffset: 0x020,
    buttons: { offset: 0x040, count: 16, len: 7 },
    functionKeys: [{ offset: 0x0b0, count: 4, len: 169 }],
    triggers: { offset: 0x354, count: 2, len: 32 },
    sticks: { offset: 0x394, count: 2, len: 36 },
    motion: { offset: 0x3dc, count: 2, len: 41 }
  },
  G7ProS: {
    total: 1070,
    funOffset: 0x020,
    buttons: { offset: 0x040, count: 16, len: 7 },
    functionKeys: [{ offset: 0x0b0, count: 4, len: 169 }],
    triggers: { offset: 0x354, count: 2, len: 32 },
    sticks: { offset: 0x394, count: 2, len: 36 },
    motion: { offset: 0x3dc, count: 2, len: 41 }
  },
  T3CE: {
    total: 1935,
    funOffset: 0x020,
    buttons: { offset: 0x040, count: 16, len: 7 },
    functionKeys: [{ offset: 0x0b0, count: 9, len: 169 }],
    triggers: { offset: 0x6a1, count: 2, len: 32 },
    sticks: { offset: 0x6e1, count: 2, len: 36 },
    motion: { offset: 0x729, count: 2, len: 41 }
  }
}

/** Parse a full profile blob into structured packets. */
export function parseProfile(bytes: Uint8Array, modelId = 'G7ProCE'): Profile {
  const geo = GEOMETRIES[modelId] ?? GEOMETRIES.G7ProCE
  if (bytes.length < geo.total) {
    throw new Error(
      `profile too short: ${bytes.length}, expected ${geo.total}`
    )
  }

  const fun = new Uint8Array(PACKET.Name + PACKET.FunData)
  fun.set(bytes.subarray(SECTION.Name.offset, SECTION.Name.offset + PACKET.Name), 0)
  fun.set(
    bytes.subarray(geo.funOffset, geo.funOffset + PACKET.FunData),
    PACKET.Name
  )

  const buttons: Packet[] = []
  for (let i = 0; i < geo.buttons.count; i++) {
    buttons.push(new Packet(slice(bytes, geo.buttons.offset + i * geo.buttons.len, geo.buttons.len)))
  }
  const functionKeys: Packet[] = []
  for (const run of geo.functionKeys) {
    for (let i = 0; i < run.count; i++) {
      functionKeys.push(new Packet(slice(bytes, run.offset + i * run.len, run.len)))
    }
  }
  const triggers: Packet[] = []
  for (let i = 0; i < geo.triggers.count; i++) {
    triggers.push(new Packet(slice(bytes, geo.triggers.offset + i * geo.triggers.len, geo.triggers.len)))
  }
  const sticks: Packet[] = []
  for (let i = 0; i < geo.sticks.count; i++) {
    sticks.push(new Packet(slice(bytes, geo.sticks.offset + i * geo.sticks.len, geo.sticks.len)))
  }
  const motion: Packet[] = []
  for (let i = 0; i < geo.motion.count; i++) {
    motion.push(new Packet(slice(bytes, geo.motion.offset + i * geo.motion.len, geo.motion.len)))
  }

  const end = geo.motion.offset + geo.motion.count * geo.motion.len

  return {
    model: modelId,
    name: decodeName(bytes),
    // funData packet holds name(32) + fun(32); accessors use PACKET.Name as base
    funData: new Packet(fun),
    buttons,
    functionKeys,
    triggers,
    sticks,
    motion,
    tail: bytes.slice(end)
  }
}

/**
 * Serialise back to a full blob. Must be byte-identical to the input when
 * nothing changed — geometry (including split function-key runs and the
 * trailing Ext bytes) is preserved, never rebuilt.
 */
export function serializeProfile(profile: Profile): Uint8Array {
  const geo = GEOMETRIES[profile.model] ?? GEOMETRIES.G7ProCE
  const out = new Uint8Array(geo.total)

  out.set(encodeName(profile.name), SECTION.Name.offset)

  // funData packet is name||fun; write only its fun half (skip the name slot).
  out.set(profile.funData.bytes.subarray(PACKET.Name), geo.funOffset)

  profile.buttons.forEach((packet, i) =>
    out.set(packet.bytes, geo.buttons.offset + i * geo.buttons.len)
  )
  let fk = 0
  for (const run of geo.functionKeys) {
    for (let i = 0; i < run.count; i++, fk++) {
      const packet = profile.functionKeys[fk]
      if (packet) out.set(packet.bytes, run.offset + i * run.len)
    }
  }
  profile.triggers.forEach((packet, i) =>
    out.set(packet.bytes, geo.triggers.offset + i * geo.triggers.len)
  )
  profile.sticks.forEach((packet, i) =>
    out.set(packet.bytes, geo.sticks.offset + i * geo.sticks.len)
  )
  profile.motion.forEach((packet, i) =>
    out.set(packet.bytes, geo.motion.offset + i * geo.motion.len)
  )

  // Trailing bytes past the motion section (T3CE Ext8/Ext9) — preserved
  // verbatim, never parsed. Empty on G7ProCE, so this is a no-op there.
  out.set(profile.tail, geo.motion.offset + geo.motion.count * geo.motion.len)

  return out
}

// ---------------------------------------------------------------------------
// FUN_DATA accessors — offset relative to SECTION.FunData (inside funData packet
// these are shifted by PACKET.Name)
// ---------------------------------------------------------------------------

const FUN = PACKET.Name

/** Wire byte → RC-filter level (−10…+10). Mirrors GameSir's `wn`/`Di`. */
function rcLevel(wire: number): number {
  const effective = wire === 0 ? 11 : wire
  return Math.max(-10, Math.min(10, effective - 11))
}

/** RC-filter level → wire byte (1…21). Mirrors GameSir's `Fn`/`Li`. */
function rcWire(level: number): number {
  return Math.max(1, Math.min(21, Math.round(level) + 11))
}

export const fun = {
  motor: {
    left: (p: Packet): number => p.u8(FUN + 0),
    right: (p: Packet): number => p.u8(FUN + 1),
    lt: (p: Packet): number => p.u8(FUN + 2),
    rt: (p: Packet): number => p.u8(FUN + 3),
    setLeft: (p: Packet, v: number): void => p.setU8(FUN + 0, v),
    setRight: (p: Packet, v: number): void => p.setU8(FUN + 1, v),
    setLt: (p: Packet, v: number): void => p.setU8(FUN + 2, v),
    setRt: (p: Packet, v: number): void => p.setU8(FUN + 3, v)
  },
  audio: {
    enable: (p: Packet): boolean => p.bit(FUN + 4, 0),
    setEnable: (p: Packet, v: boolean): void => p.setBit(FUN + 4, 0, v),
    volume: (p: Packet): number => p.u8(FUN + 5),
    setVolume: (p: Packet, v: number): void => p.setU8(FUN + 5, v),
    mixer: (p: Packet): number => p.u8(FUN + 6),
    micMute: (p: Packet): boolean => p.bit(FUN + 7, 0),
    micSensitivity: (p: Packet): number => p.u8(FUN + 8)
  },
  extend: {
    shiftEnable: (p: Packet): boolean => p.bit(FUN + 9, 0),
    setShiftEnable: (p: Packet, v: boolean): void => p.setBit(FUN + 9, 0, v),
    shiftValue: (p: Packet): number => p.u8(FUN + 10),
    setShiftValue: (p: Packet, v: number): void => p.setU8(FUN + 10, v),
    dpadDiagonalLock: (p: Packet): boolean => p.bit(FUN + 11, 0),
    setDpadDiagonalLock: (p: Packet, v: boolean): void => p.setBit(FUN + 11, 0, v),
    xinputAbxyChange: (p: Packet): boolean => p.bit(FUN + 12, 0),
    setXinputAbxyChange: (p: Packet, v: boolean): void => p.setBit(FUN + 12, 0, v),
    switchAbxyChange: (p: Packet): boolean => p.bit(FUN + 13, 0),
    setSwitchAbxyChange: (p: Packet, v: boolean): void => p.setBit(FUN + 13, 0, v),
    /** Report-rate gear — 0x05 observed on the live pad. */
    reportRateGear: (p: Packet): number => p.u8(FUN + 14),
    setReportRateGear: (p: Packet, v: number): void => p.setU8(FUN + 14, v),
    sensorQuickMode: (p: Packet): number => p.u8(FUN + 15),
    setSensorQuickMode: (p: Packet, v: number): void => p.setU8(FUN + 15, v),
    /** Raw wire byte — GameSir stores `4 - stickResolution`. Prefer the bit helpers. */
    stickResolution: (p: Packet): number => p.u8(FUN + 16),
    setStickResolution: (p: Packet, v: number): void => p.setU8(FUN + 16, v),

    /**
     * Stick ADC resolution in bits, 8–12, in the sense the official app uses.
     *
     * GameSir's UI shows a step size of `["256","128","64","32","<16"]`, which is
     * 2^16 / 2^bits — i.e. index 0 = 8-bit and index 4 = 12-bit — and stores
     * `stick_resolution = 4 - index`. Our raw accessor returns the wire byte, so
     * without this conversion the control reads backwards: dragging it up made
     * the stick *coarser*.
     */
    stickResolutionBits: (p: Packet): number => 12 - p.u8(FUN + 16),
    setStickResolutionBits: (p: Packet, bits: number): void => {
      const clamped = Math.max(8, Math.min(12, Math.round(bits)))
      p.setU8(FUN + 16, 12 - clamped)
    },

    /**
     * Anti-jitter ("RC filter") on a −10…+10 scale, 0 = off.
     *
     * The wire byte is `level + 11` (1…21); GameSir also treats a wire byte of 0
     * as level 0, and their writer clamps to 1…21 so 0 is only ever a never-written
     * default. Exposing the raw 0…21 byte in the UI hid the sign and shifted the
     * whole range by 11.
     */
    lsRcLevel: (p: Packet): number => rcLevel(p.u8(FUN + 17)),
    setLsRcLevel: (p: Packet, level: number): void => p.setU8(FUN + 17, rcWire(level)),
    rsRcLevel: (p: Packet): number => rcLevel(p.u8(FUN + 18)),
    setRsRcLevel: (p: Packet, level: number): void => p.setU8(FUN + 18, rcWire(level)),

    /** Raw anti-jitter bytes — kept for byte-level tests. */
    lsAntiJitter: (p: Packet): number => p.u8(FUN + 17),
    setLsAntiJitter: (p: Packet, v: number): void => p.setU8(FUN + 17, v),
    rsAntiJitter: (p: Packet): number => p.u8(FUN + 18),
    setRsAntiJitter: (p: Packet, v: number): void => p.setU8(FUN + 18, v)
  }
}

// ---------------------------------------------------------------------------
// Standard button accessors — 7 bytes
// ---------------------------------------------------------------------------

export const button = {
  turboEnabled: (p: Packet): boolean => p.bit(0, 0),
  turboSpeed: (p: Packet): number => p.u8(1),
  setTurbo: (p: Packet, on: boolean, speed: number): void => {
    p.setBit(0, 0, on)
    p.setU8(1, on ? speed : 0)
  },
  mapped: (p: Packet): boolean => p.bit(2, 0),
  /** Key indices for the three mapping slots (0 = unset). */
  mapValues: (p: Packet): [number, number, number] => [p.u8(3), p.u8(4), p.u8(5)],
  setMap: (p: Packet, keys: [number, number, number]): void => {
    p.setBit(2, 0, keys.some((k) => k !== 0))
    p.setU8(3, keys[0])
    p.setU8(4, keys[1])
    p.setU8(5, keys[2])
  },
  toggleOnPress: (p: Packet): boolean => p.bit(6, 0),
  setToggle: (p: Packet, on: boolean): void => p.setBit(6, 0, on)
}

// ---------------------------------------------------------------------------
// Macro accessors — 169 bytes
// ---------------------------------------------------------------------------

/**
 * Layout: header 11 bytes, then MACRO_STEP_MAX steps.
 * Steps 0..30 are 5 bytes (data, holdH, holdL, delayH, delayL); step 31 is
 * 3 bytes (no delay) → 11 + 31*5 + 3 = 169.
 */
export const macro = {
  headerLength: 11,
  stepLength: 5,
  lastStepLength: 3,

  macroEnabled: (p: Packet): boolean => p.bit(7, 0),
  keyOpenEnabled: (p: Packet): boolean => p.bit(7, 1),
  cycleEnabled: (p: Packet): boolean => p.bit(7, 2),
  setFlags: (p: Packet, { macro, keyOpen, cycle }: { macro?: boolean; keyOpen?: boolean; cycle?: boolean }): void => {
    if (macro !== undefined) p.setBit(7, 0, macro)
    if (keyOpen !== undefined) p.setBit(7, 1, keyOpen)
    if (cycle !== undefined) p.setBit(7, 2, cycle)
  },
  cycleTime: (p: Packet): number => (p.u8(8) << 8) | p.u8(9),
  setCycleTime: (p: Packet, value: number): void => {
    p.setU8(8, (value >> 8) & 0xff)
    p.setU8(9, value & 0xff)
  },
  stepCount: (p: Packet): number => p.u8(10),
  setStepCount: (p: Packet, n: number): void => p.setU8(10, Math.min(MACRO_STEP_MAX, n)),

  /**
   * Byte offset of step `index`.
   *
   * Every step begins after a run of full 5-byte steps, including the last —
   * the last one merely *occupies* 3 bytes instead of 5. The offset is
   * therefore always `header + index*stepLength`; only the length varies.
   * (Multiplying the last index by `lastStepLength` would land it at 104
   * instead of 166 and overwrite steps 18/19.)
   */
  stepOffset(index: number): number {
    if (index >= MACRO_STEP_MAX) throw new Error(`macro step ${index} out of range`)
    return this.headerLength + index * this.stepLength
  },

  /** Number of bytes step `index` occupies. */
  stepLengthAt(index: number): number {
    return index === MACRO_STEP_MAX - 1 ? this.lastStepLength : this.stepLength
  },

  step(p: Packet, index: number): { data: number; hold: number; delay: number } {
    const off = this.stepOffset(index)
    const isLast = index === MACRO_STEP_MAX - 1
    return {
      data: p.u8(off),
      hold: (p.u8(off + 1) << 8) | p.u8(off + 2),
      delay: isLast ? 0 : (p.u8(off + 3) << 8) | p.u8(off + 4)
    }
  },

  setStep(p: Packet, index: number, data: number, hold: number, delay: number): void {
    const off = this.stepOffset(index)
    const isLast = index === MACRO_STEP_MAX - 1
    p.setU8(off, data)
    p.setU8(off + 1, (hold >> 8) & 0xff)
    p.setU8(off + 2, hold & 0xff)
    if (!isLast) {
      p.setU8(off + 3, (delay >> 8) & 0xff)
      p.setU8(off + 4, delay & 0xff)
    }
  }
}

// ---------------------------------------------------------------------------
// Trigger accessors — 32 bytes
// Deadzones are 16-bit BE and expressed in tenths of a percent
// (0x0032 = 50 → 5%, 0x03b6 = 950 → 95%, 0x03e8 = 1000 → 100%).
// ---------------------------------------------------------------------------

export interface Deadzone {
  begin: number
  end: number
  beginAnti: number
  endAnti: number
}

const DEAD_OFFSET = 3

function readDeadzone(p: Packet): Deadzone {
  return {
    begin: p.u16be(DEAD_OFFSET),
    end: p.u16be(DEAD_OFFSET + 2),
    beginAnti: p.u16be(DEAD_OFFSET + 4),
    endAnti: p.u16be(DEAD_OFFSET + 6)
  }
}

function writeDeadzone(p: Packet, d: Deadzone): void {
  p.setU16be(DEAD_OFFSET, d.begin)
  p.setU16be(DEAD_OFFSET + 2, d.end)
  p.setU16be(DEAD_OFFSET + 4, d.beginAnti)
  p.setU16be(DEAD_OFFSET + 6, d.endAnti)
}

export const trigger = {
  deadEnabled: (p: Packet): boolean => p.bit(2, 0),
  setDeadEnabled: (p: Packet, on: boolean): void => p.setBit(2, 0, on),
  deadzone: readDeadzone,
  setDeadzone: writeDeadzone,
  /** Deadzone as whole percent for the UI (5 → "5%"). */
  deadzonePercent(d: Deadzone): Deadzone {
    return { begin: d.begin / 10, end: d.end / 10, beginAnti: d.beginAnti / 10, endAnti: d.endAnti / 10 }
  },
  mapped: (p: Packet): boolean => p.bit(11, 0),
  mapValues: (p: Packet): [number, number, number] => [p.u8(12), p.u8(13), p.u8(14)],
  setMap: (p: Packet, keys: [number, number, number]): void => {
    p.setBit(11, 0, keys.some((k) => k !== 0))
    p.setU8(12, keys[0])
    p.setU8(13, keys[1])
    p.setU8(14, keys[2])
  },
  toggleOnPress: (p: Packet): boolean => p.bit(15, 0),
  setToggle: (p: Packet, on: boolean): void => p.setBit(15, 0, on),
  quickTrigger: {
    status: (p: Packet): number => p.u8(16),
    start: (p: Packet): number => p.u8(17),
    end: (p: Packet): number => p.u8(18),
    set: (p: Packet, status: number, start: number, end: number): void => {
      p.setU8(16, status)
      p.setU8(17, start)
      p.setU8(18, end)
    }
  }
}

// ---------------------------------------------------------------------------
// Stick accessors — 36 bytes
// ---------------------------------------------------------------------------

export const stick = {
  enabled: (p: Packet): boolean => p.bit(0, 0),
  setEnabled: (p: Packet, on: boolean): void => p.setBit(0, 0, on),
  squareGate: (p: Packet): boolean => p.bit(1, 0),
  setSquareGate: (p: Packet, on: boolean): void => p.setBit(1, 0, on),
  deadEnabled: (p: Packet): boolean => p.bit(2, 0),
  setDeadEnabled: (p: Packet, on: boolean): void => p.setBit(2, 0, on),
  deadzone: readDeadzone,
  setDeadzone: writeDeadzone,
  deadzonePercent: trigger.deadzonePercent,

  /** Curve sample points: 5 × (original, target), bytes 14..23. */
  curve(p: Packet): Array<{ x: number; y: number }> {
    const points: Array<{ x: number; y: number }> = []
    for (let i = 0; i < 5; i++) {
      points.push({ x: p.u8(14 + i * 2), y: p.u8(15 + i * 2) })
    }
    return points
  },
  setCurve(p: Packet, points: Array<{ x: number; y: number }>): void {
    points.slice(0, 5).forEach((pt, i) => {
      p.setU8(14 + i * 2, pt.x)
      p.setU8(15 + i * 2, pt.y)
    })
  },

  /** Map block begins at byte 24. */
  mapped: (p: Packet): boolean => p.bit(24, 0),
  setMapped: (p: Packet, on: boolean): void => p.setBit(24, 0, on),
  /**
   * Axis invert flags, bytes +25/+26 (bit 0 each, like every other `*_en`
   * flag in this packet). Always 0 in the captured fixtures, so the exact
   * polarity is vendor-undocumented — verify on the live sticks after
   * setting. Writes touch only bit 0 so neighbouring bits survive.
   */
  flipX: (p: Packet): boolean => p.bit(25, 0),
  setFlipX: (p: Packet, on: boolean): void => p.setBit(25, 0, on),
  flipY: (p: Packet): boolean => p.bit(26, 0),
  setFlipY: (p: Packet, on: boolean): void => p.setBit(26, 0, on),
  axisRatio: (p: Packet): number => p.u8(27),
  setAxisRatio: (p: Packet, v: number): void => p.setU8(27, v),
  mapIndex: (p: Packet): number => p.u8(29),
  setMapIndex: (p: Packet, v: number): void => p.setU8(29, v),

  /**
   * Mouse-mapping sensitivity, byte 28 (GameSir `map_module.mouse_dpi`).
   * Only has an effect once `mapIndex` is 4 (`Mouse`) — see PROTOCOL §12.4.
   * Neutral is 50.
   */
  mouseDpi: (p: Packet): number => p.u8(28),
  setMouseDpi: (p: Packet, v: number): void => p.setU8(28, v),

  /**
   * Zero dead zone, pure linear 1:1 — the "physics" preset.
   *
   * `dead_en` stays on with `begin = 0`, so the input window becomes
   * `[0,100] → [0,100]`: nothing is clipped at the bottom and full output still
   * arrives only at full deflection. The output window is left neutral and
   * `axis_ratio` neutral, so the composed transform is the identity end to end.
   *
   * These are EEPROM bytes in the stick packet, not an app-side transform —
   * PROTOCOL §4.5 and §12.5. Lives here rather than in the page so the exact
   * bytes it produces can be pinned by a test instead of eyeballed.
   */
  applyPhysics(p: Packet): void {
    p.setBit(2, 0, true)
    writeDeadzone(p, { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 })
    for (let i = 0; i < LINEAR_CURVE.length; i++) {
      p.setU8(14 + i * 2, LINEAR_CURVE[i].x)
      p.setU8(15 + i * 2, LINEAR_CURVE[i].y)
    }
    p.setU8(27, 50)
  }
}

/**
 * Identity curve: input == output at every control point. Matches GameSir's own
 * `linear` preset so a profile written here reads back as "Linear" there.
 */
export const LINEAR_CURVE: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 },
  { x: 64, y: 64 },
  { x: 128, y: 128 },
  { x: 191, y: 191 },
  { x: 255, y: 255 }
]

// ---------------------------------------------------------------------------
// Motion accessors — 41 bytes
// Orientation: 0 = X, 1 = Y, 2 = X+Y (stored in active_axis bits).
// ---------------------------------------------------------------------------

export const motion = {
  orientation: (p: Packet): number => {
    const axis = p.u8(2)
    if ((axis & 3) === 3) return 2
    if (axis & 1) return 1
    if (axis & 2) return 0
    return 0
  },
  setOrientation: (p: Packet, value: number): void => {
    let axis = p.u8(2) & ~3
    if (value === 2) axis |= 3
    else if (value === 1) axis |= 1
    else if (value === 0) axis |= 2
    p.setU8(2, axis)
  },
  triggerKeys: (p: Packet): [number, number, number] => [p.u8(3), p.u8(4), p.u8(5)],
  setTriggerKeys: (p: Packet, keys: [number, number, number]): void => {
    p.setU8(3, keys[0])
    p.setU8(4, keys[1])
    p.setU8(5, keys[2])
  }
}

// ---------------------------------------------------------------------------
// Convenience: named lookups
// ---------------------------------------------------------------------------

export function buttonIndex(name: string): number {
  return STANDARD_BUTTONS.indexOf(name as StandardButton)
}
export function functionKeyIndex(name: string): number {
  return FUNCTION_KEYS.indexOf(name as FunctionKey)
}
export function triggerIndex(name: string): number {
  return TRIGGERS.indexOf(name as TriggerName)
}
export function stickIndex(name: string): number {
  return STICKS.indexOf(name as StickName)
}
export function motionIndex(name: string): number {
  return MOTION_SENSORS.indexOf(name as MotionName)
}

/**
 * Family proof for unlisted PIDs (new color editions like Royal2): does a
 * 1070-byte blob read as a G7ProCE-family profile? Checks every structural
 * invariant a foreign layout (e.g. T3CE's first 1070 bytes) breaks: deadzone
 * windows within 0..100 with end above begin, output window sane, map index
 * in the output enum, gear and resolution wires in range, five curve points.
 * Never throws — false on anything short or misshapen.
 */
export function looksLikeCEProfile(bytes: Uint8Array): boolean {
  try {
    if (bytes.length < PROFILE_LENGTH) return false
    const profile = parseProfile(bytes, 'G7ProCE')
    if (profile.sticks.length !== 2) return false
    for (const s of profile.sticks) {
      const d = stick.deadzone(s)
      if (d.begin > 1000 || d.end > 1000 || d.beginAnti > 1000 || d.endAnti > 1000) return false
      if (d.end <= d.begin) return false
      if (stick.curve(s).length !== 5) return false
      if (stick.mapIndex(s) > 4) return false
    }
    const gear = fun.extend.reportRateGear(profile.funData)
    if (gear > 5) return false
    if (fun.extend.stickResolution(profile.funData) > 4) return false
    return true
  } catch {
    return false
  }
}

/** Light/RGB profile is a separate 169-byte blob. */
export function parseLightProfile(bytes: Uint8Array): Packet {  if (bytes.length < LIGHT_PROFILE_LENGTH) {
    throw new Error(`light profile too short: ${bytes.length}`)
  }
  return new Packet(bytes.slice(0, LIGHT_PROFILE_LENGTH))
}
