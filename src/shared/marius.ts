/**
 * MARIUS board protocol (Project Marius / MH4-MH5-XSX) — READ-ONLY scaffold.
 *
 * Reverse-engineered from the public devsetup.mariusheier.com web-app JS
 * (static modules: mh4-hid.js, upload-plan.js, lut.js, device-capabilities.js).
 * Statically mapped — NOT yet verified against hardware. This module contains
 * NO write paths on purpose: SET_CONFIG/BURN/RESTORE/LUT writes are listed in
 * the CMD enum for reference but nothing here (or in main/marius.ts) sends them.
 *
 * Two transports exist upstream: WebHID/DS4 (Sony VID 0x054C PID 0x05C4,
 * feature reports 0x90/0x91) and WebUSB/XInput (VID 0x39AE). Only the HID side
 * is scaffolded — node-hid cannot do WebUSB.
 *
 * NOTE: 0x054C:0x05C4 is also a real DualShock 4. Discovery must always be
 * followed by the family gate (GET_APP_INFO family byte decodes to
 * MH4/MH5/XSX) before treating a pad as Marius hardware.
 */

/** WebHID/DS4 transport IDs. */
export const MARIUS_HID_VID = 0x054c
export const MARIUS_HID_PID = 0x05c4
/** WebUSB/XInput transport IDs (not scaffolded — needs a WebUSB stack). */
export const MARIUS_USB_VID = 0x39ae
export const MARIUS_USB_LEGACY_VID = 0x1209
export const MARIUS_USB_LEGACY_PID = 0x0001

export const MARIUS_REPORT_OUT = 0x90
export const MARIUS_REPORT_IN = 0x91
export const MARIUS_HID_PAYLOAD = 63
export const MARIUS_CONFIG_LEN = 256
export const MARIUS_CONFIG_CHUNK = 57

/** Reply status bytes. */
export const MARIUS_OK = 0xaa
export const MARIUS_ERR = 0xff
export const MARIUS_DIRTY = 0xdd

/** Command set (mh4-hid.js CMD). Writes are reference-only — never sent. */
export enum MariusCmd {
  Echo = 0x01,
  GetAppInfo = 0x02,
  GetUid = 0x03,
  SetConfig = 0x10,
  GetConfig = 0x11,
  SetTriggerType = 0x12,
  GetTriggerType = 0x13,
  WriteLxLut = 0x30,
  WriteLyLut = 0x32,
  WriteRxLut = 0x34,
  WriteRyLut = 0x36,
  SetBInterval = 0x90,
  GetBInterval = 0x91,
  SetLed = 0x92,
  GetLed = 0x93,
  Burn = 0x94,
  Restore = 0x95,
  GetDirty = 0x96,
  Reboot = 0x97,
  Bootloader = 0x98,
  ReadJoyLeft = 0x70,
  ReadJoyRight = 0x71,
  ReadTriggers = 0x72,
}

export type MariusLine = 'MH4' | 'MH5' | 'XSX' | 'unknown'
export type MariusVariant = 'analog' | 'digital' | 'unknown'

export interface MariusFamily {
  line: MariusLine
  variant: MariusVariant
  /** bit resolution of raw stick reads: analog 12, digital 14. */
  bits: number
}

/** Family byte 38 = (product_line << 4) | stick_variant. */
export function decodeMariusFamily(byte: number): MariusFamily {
  const hi = (byte >> 4) & 0x0f
  const lo = byte & 0x0f
  const line: MariusLine = hi === 1 ? 'MH4' : hi === 2 ? 'MH5' : hi === 3 ? 'XSX' : 'unknown'
  const variant: MariusVariant = lo === 1 ? 'analog' : lo === 2 ? 'digital' : 'unknown'
  return { line, variant, bits: variant === 'digital' ? 14 : 12 }
}

export function isMariusFamily(f: MariusFamily): boolean {
  return f.line !== 'unknown' && f.variant !== 'unknown'
}

/**
 * Marketing-style display name, mirroring how GameSir pads show
 * "G7 Pro 8K": "Marius MH4 Digital", falling back to the firmware
 * device string when the family byte is unknown.
 */
export function mariusDisplayName(identity: MariusIdentity): string {
  if (identity.family.line !== 'unknown' && identity.family.variant !== 'unknown') {
    const variant = identity.family.variant === 'analog' ? 'Analog' : 'Digital'
    return `Marius ${identity.family.line} ${variant}`
  }
  return identity.name || 'Marius board'
}

export interface MariusIdentity {
  versionMajor: number
  versionMinor: number
  name: string
  family: MariusFamily
  familyByte: number
  hwRev: number
  buildDate: string
  uid: string
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset + length
  for (let i = offset; i < offset + length; i++) {
    if (bytes[i] === 0) {
      end = i
      break
    }
  }
  return new TextDecoder().decode(bytes.subarray(offset, end)).replace(/\0/g, '').trim()
}

function u16le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0
}

function s16le(bytes: Uint8Array, offset: number): number {
  const v = u16le(bytes, offset)
  return v >= 0x8000 ? v - 0x10000 : v
}

/**
 * Parse a GET_APP_INFO reply body (report id + status already stripped —
 * data starts at what the driver returns after offset 2).
 */
export function parseMariusAppInfo(data: Uint8Array, uid: string): MariusIdentity {
  const familyByte = data[38] ?? 0
  const hwRaw = data[39] ?? 0
  return {
    versionMajor: data[5] ?? 0,
    versionMinor: data[4] ?? 0,
    name: ascii(data, 6, 32),
    family: decodeMariusFamily(familyByte),
    familyByte,
    hwRev: hwRaw === 0xff ? 0 : hwRaw,
    buildDate: ascii(data, 40, 12),
    uid,
  }
}

export function uidToHex(uid: Uint8Array): string {
  return Array.from(uid.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** bInterval → Hz: 8000 / 2^(n-1). */
export function mariusPollHz(bInterval: number): number {
  const n = Math.max(1, Math.round(bInterval))
  return 8000 / 2 ** (n - 1)
}

// ---------------------------------------------------------------------------
// 256-byte config map (all multi-byte fields little-endian)
// ---------------------------------------------------------------------------

export const MARIUS_CONFIG_VERSION = 2
/** FLAGS hi-nibble validity marker (0xCA observed; mask 0xF0 — same thing). */
export const MARIUS_FLAGS_MASK = 0xf0
export const MARIUS_FLAGS_VALID = 0xc0

export interface MariusConfig {
  triggerType: number
  version: number
  flags: number
  invert: { lx: boolean; ly: boolean; rx: boolean; ry: boolean }
  center: { lx: number; ly: number; rx: number; ry: number }
  rangeLeft: { xMin: number; xMax: number; yMin: number; yMax: number }
  rangeRight: { xMin: number; xMax: number; yMin: number; yMax: number }
  /** legacy deadzone bytes → percent (byte / 2). */
  deadzone: { leftIn: number; leftOut: number; rightIn: number; rightOut: number }
  triggers: { l2Start: number; l2End: number; r2Start: number; r2End: number }
  hairPct: number
  buttonMap: number[]
  timestamp: number
  led: { mode: number; intensity: number; r1: number; g1: number; b1: number; r2: number; g2: number; b2: number; period: number }
  leftEffectiveBits: number
  rightEffectiveBits: number
  rightEffectiveBitsPresent: boolean
  curvesPresent: boolean
  curvesLength: number
  /** signed ext deadzones in percent (value / 10), null when marker absent. */
  extDeadzone: { leftIn: number; leftOut: number; rightIn: number; rightOut: number } | null
  valid: boolean
}

export function parseMariusConfig(bytes: Uint8Array): MariusConfig {
  const flags = bytes[2] ?? 0
  const erased = bytes.length > 0 && bytes.every((b) => b === 0xff)
  const valid =
    !erased && (bytes[1] ?? 0) === MARIUS_CONFIG_VERSION && (flags & MARIUS_FLAGS_MASK) === MARIUS_FLAGS_VALID
  const extMarker = (bytes[211] ?? 0) === 0xe7
  const extDz = (bytes[213] ?? 0) === 0xd7 && (bytes[214] ?? 0) === 0x01
  return {
    triggerType: bytes[0] ?? 0,
    version: bytes[1] ?? 0,
    flags,
    valid,
    invert: {
      lx: (flags & 0x01) !== 0,
      ly: (flags & 0x02) !== 0,
      rx: (flags & 0x04) !== 0,
      ry: (flags & 0x08) !== 0,
    },
    center: { lx: u16le(bytes, 3), ly: u16le(bytes, 5), rx: u16le(bytes, 7), ry: u16le(bytes, 9) },
    rangeLeft: { xMin: u16le(bytes, 11), xMax: u16le(bytes, 13), yMin: u16le(bytes, 15), yMax: u16le(bytes, 17) },
    rangeRight: { xMin: u16le(bytes, 19), xMax: u16le(bytes, 21), yMin: u16le(bytes, 23), yMax: u16le(bytes, 25) },
    deadzone: {
      leftIn: (bytes[27] ?? 0) / 2,
      leftOut: (bytes[28] ?? 0) / 2,
      rightIn: (bytes[29] ?? 0) / 2,
      rightOut: (bytes[30] ?? 0) / 2,
    },
    triggers: { l2Start: u16le(bytes, 31), l2End: u16le(bytes, 33), r2Start: u16le(bytes, 35), r2End: u16le(bytes, 37) },
    hairPct: bytes[39] ?? 0,
    buttonMap: Array.from(bytes.subarray(40, 46)),
    timestamp: u16le(bytes, 46) | (u16le(bytes, 48) << 16),
    led: {
      mode: bytes[50] ?? 0,
      intensity: bytes[51] ?? 0,
      r1: bytes[52] ?? 0,
      g1: bytes[53] ?? 0,
      b1: bytes[54] ?? 0,
      r2: bytes[55] ?? 0,
      g2: bytes[56] ?? 0,
      b2: bytes[57] ?? 0,
      period: u16le(bytes, 58),
    },
    leftEffectiveBits: bytes[60] ?? 0,
    rightEffectiveBits: bytes[212] ?? 0,
    rightEffectiveBitsPresent: extMarker,
    curvesPresent: (bytes[61] ?? 0) === 0xce && (bytes[62] ?? 0) === 0x01,
    curvesLength: bytes[63] ?? 0,
    extDeadzone: extDz
      ? {
          leftIn: s16le(bytes, 215) / 10,
          leftOut: s16le(bytes, 217) / 10,
          rightIn: s16le(bytes, 219) / 10,
          rightOut: s16le(bytes, 221) / 10,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// Request framing (HID feature-report side)
// ---------------------------------------------------------------------------

/** ECHO probe payload. Reply data = [mode, bInterval]; mode 0 = setup. */
export const MARIUS_ECHO_PAYLOAD: ReadonlyArray<number> = [0x55, 0xaa]

/** Pad a command payload to the 63-byte HID feature body: [cmd, ...args]. */
export function mariusHidFrame(cmd: number, args: ArrayLike<number> = []): number[] {
  const out = new Array<number>(1 + MARIUS_HID_PAYLOAD).fill(0)
  out[0] = MARIUS_REPORT_OUT
  out[1] = cmd & 0xff
  const body = Array.from(args).slice(0, MARIUS_HID_PAYLOAD - 1)
  for (let i = 0; i < body.length; i++) out[2 + i] = body[i] & 0xff
  return out
}

/** GET_CONFIG/SET_CONFIG chunk header: BE [offHi, offLo, lenHi, lenLo]. */
export function mariusChunkHeader(offset: number, length: number): number[] {
  return [(offset >> 8) & 0xff, offset & 0xff, (length >> 8) & 0xff, length & 0xff]
}

/** Raw stick sample decode: 4B [XH,XL,YH,YL], 12- or 14-bit. */
export function decodeMariusRaw(data: Uint8Array, bits: number): { x: number; y: number } {
  const mask = bits >= 14 ? 0x3f : 0x0f
  return {
    x: (((data[0] ?? 0) & mask) << 8) | (data[1] ?? 0),
    y: (((data[2] ?? 0) & mask) << 8) | (data[3] ?? 0),
  }
}
