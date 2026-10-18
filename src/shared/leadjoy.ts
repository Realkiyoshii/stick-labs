/**
 * Shared LeadJoy Saber Plus / Xeno Pro protocol (VID 0x4131 PID 0x3519, config on MI_04
 * usage page 0xFF80/0001, 64B HID reports, MessagePack payloads).
 *
 * Proven against hardware from Stick Labs' own handle (node-hid, report ID 0
 * + 64B payload): every query below round-trips byte-exact against USBPcap
 * captures of the vendor app, and every reply fixture under
 * fixtures/leadjoy/ decodes end-to-end with checksum verification.
 *
 * Framing (all integers are single bytes):
 * - OUT: [0xA5][LEN][0xCC][msgpack][CK], zero-padded to 64B.
 *   LEN covers the whole frame including CK. CK is the additive checksum
 *   `sum(all preceding frame bytes) & 0xFF`.
 * - IN single-frame: [0xA5][LEN][0xCC][msgpack][CK] (+ zero pad).
 * - IN fragmented: first frame [0xA4][0x40][0xCC][0x80|total][chunk][CK],
 *   middle frames [0xA4][0x40][0xCC][remaining][chunk][CK], final frame
 *   [0xA4][LEN<0x40][0xCC][0x01][chunk][CK] (+ zero pad). LEN covers the
 *   meaningful bytes including CK. Concatenating the chunks yields one
 *   MessagePack document.
 *
 * Record catalog (c = record id, b = board 1, c-slot = Main/Sub1/Sub2 0/1/2):
 * - 12: firmware/board version string (single-frame, r = e.g. "36.16.12").
 * - 51: board info {b, d2:{a, n:"DEFAULT_BOARD", cfg:[{c,ko,at,k}x2]}}.
 * - 60: button table {b, c:slot, d1:[22x {k,a,dn,up}]}. Source ids are the
 *   query ids; a remap target reuses the same id space (proven: R5/M1 id
 *   0x18 -> X id 4 arrives as dn {t:2, v:[4,0,0,0]}; Origin is t:0 v:[0,0,0,0]).
 *   A=1, B=2, Y=5 (save-flush capture: k=26->1, k=25->2, k=27->5).
 * - 61: button WRITE, single-record {b, c:slot, d1:[{k,a,dn,up}]} under key
 *   `w`, fragmented OUT like reads; the pad acks each write with a
 *   single-frame {c:61,e:0}. Write action maps serialize t,v,n,r,sp,mr,ms,ri
 *   (reads come back t,n,mr,ms,r,sp,ri,v). Source and target may be any of
 *   the 22 table ids — framing, ack, and per-write readback are identical
 *   for all of them (proven live on M1).
 * - 70: per-stick tuning {b, c:slot, d, d1:{co:[x,y] center, ci, cv:[16x]
 *   EightPoint curve as [in0,out0..in7,out7] in 0..32767 (percent*327.68,
 *   32768 clamps to 32767), cpl/cpu/cpr/cpd stick-trigger radii, ...}}.
 *   d = 0 left, 1 right.
 * - 90: triggers {b, c:slot, d1:{mol,dzl:[in,out],vtl,mor,dzr,vtr}}.
 * - 100: global/motion {b, c:slot, d1:{sj,tm,tk,kao,cv,se,hvr,...,ec,el}}.
 * - 120: rumble {b, c:slot, d1:{enl,grl,trl,trml,enr,grr,trr,trmr}}.
 * - 220: motion-control device colors [{mkn,c:[r,g,b],s}].
 *
 * Status: reads and button/stick runtime writes are implemented and have live
 * readback proof. Trigger write codecs are fixture-tested, but runtime trigger
 * writes stay disabled until a live hardware proof is recorded.
 */

/** Shared USB identity of the Saber Plus / Xeno Pro configuration interface (MI_04). */
export const LJ_VID = 0x4131
export const LJ_PID_SABER_PLUS = 0x3519
export const LJ_USAGE_PAGE = 0xff80
export const LJ_USAGE = 0x01
/** HID payload length; node-hid adds the leading 0x00 report id. */
export const LJ_REPORT_LEN = 64
/** Frame marker after the length byte. */
export const LJ_MARKER = 0xcc
/** OUT class (host->pad) and single-frame IN class. */
export const LJ_OUT_CLASS = 0xa5
/** Fragmented IN class (pad->host, multi-frame). */
export const LJ_IN_CLASS = 0xa4

/** Record ids. */
export const LJ_REC_VERSION = 12
export const LJ_REC_BOARD = 51
export const LJ_REC_BUTTONS = 60
/** Button write record (single-record writes under key `w`). */
export const LJ_REC_BUTTONS_WRITE = 61
export const LJ_REC_STICK = 70
/** Stick write record (full side image under key `w`). */
export const LJ_REC_STICK_WRITE = 71
export const LJ_REC_TRIGGER = 90
/** Trigger write record (full d1 image, single-frame OUT). */
export const LJ_REC_TRIGGER_WRITE = 91
export const LJ_REC_GLOBAL = 100
export const LJ_REC_RUMBLE = 120
export const LJ_REC_MOTION_DEVICES = 220

/** Profile slots: Main, Sub1, Sub2. */
export const LJ_SLOTS = [0, 1, 2] as const
export type LjSlot = (typeof LJ_SLOTS)[number]

/** Curve scaling: wire = round(percent/100*32768), 100% clamps to 0x7FFF. */
export const LJ_WIRE_MAX = 0x7fff
export const LJ_CURVE_POINTS = 8

// ---------------------------------------------------------------------------
// Minimal MessagePack codec (only what this protocol uses).
// ---------------------------------------------------------------------------

/** Decoded document values. Binary blobs surface as number arrays. */
export type LjValue =
  | null
  | boolean
  | number
  | string
  | number[]
  | LjValue[]
  | { [key: string]: LjValue }

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

function utf8Text(bytes: ArrayLike<number>, start: number, len: number): string {
  const slice = new Uint8Array(len)
  for (let i = 0; i < len; i++) slice[i] = bytes[start + i] ?? 0
  return new TextDecoder().decode(slice)
}

/** Encode a value with the same width choices the vendor firmware uses. */
export function ljMpEncode(value: LjValue): number[] {
  if (value === null || value === undefined) return [0xc0]
  if (typeof value === 'boolean') return [value ? 0xc3 : 0xc2]
  if (typeof value === 'number') {
    const n = Math.round(value)
    if (n >= 0 && n < 128) return [n]
    if (n >= 0 && n < 256) return [0xcc, n]
    if (n >= 0 && n < 65536) return [0xcd, (n >> 8) & 0xff, n & 0xff]
    if (n >= 0 && n < 4294967296) {
      return [0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    }
    if (n >= -32 && n < 0) return [n & 0xff]
    if (n >= -128 && n < 0) return [0xd0, n & 0xff]
    if (n >= -32768 && n < 0) return [0xd1, (n >> 8) & 0xff, n & 0xff]
    throw new Error(`ljMpEncode: int out of range ${value}`)
  }
  if (typeof value === 'string') {
    const raw = utf8Bytes(value)
    if (raw.length < 32) return [(0xa0 | raw.length) & 0xff, ...raw]
    if (raw.length < 256) return [0xd9, raw.length, ...raw]
    if (raw.length < 65536) return [0xda, (raw.length >> 8) & 0xff, raw.length & 0xff, ...raw]
    throw new Error(`ljMpEncode: string too long (${raw.length})`)
  }
  if (Array.isArray(value)) {
    const flat: number[] = []
    for (const item of value) flat.push(...ljMpEncode(item as LjValue))
    if (value.length < 16) return [(0x90 | value.length) & 0xff, ...flat]
    if (value.length < 65536) {
      return [0xdc, (value.length >> 8) & 0xff, value.length & 0xff, ...flat]
    }
    throw new Error(`ljMpEncode: array too long (${value.length})`)
  }
  const keys = Object.keys(value)
  const flat: number[] = []
  for (const key of keys) {
    flat.push(...ljMpEncode(key))
    flat.push(...ljMpEncode((value as Record<string, LjValue>)[key]))
  }
  if (keys.length < 16) return [(0x80 | keys.length) & 0xff, ...flat]
  if (keys.length < 65536) {
    return [0xde, (keys.length >> 8) & 0xff, keys.length & 0xff, ...flat]
  }
  throw new Error(`ljMpEncode: map too large (${keys.length})`)
}

export interface LjDecoded {
  value: LjValue
  next: number
}

/** Decode one value at an offset; `next` is the first unconsumed offset. */
export function ljMpDecode(bytes: ArrayLike<number>, pos = 0): LjDecoded {
  const prefix = bytes[pos] ?? -1
  if (prefix >= 0 && prefix < 0x80) return { value: prefix, next: pos + 1 }
  if (prefix >= 0x80 && prefix < 0x90) {
    const count = prefix & 0x0f
    let at = pos + 1
    const out: Record<string, LjValue> = {}
    for (let i = 0; i < count; i++) {
      const key = ljMpDecode(bytes, at)
      const val = ljMpDecode(bytes, key.next)
      if (typeof key.value !== 'string') throw new Error(`ljMpDecode: map key not a string at ${at}`)
      out[key.value] = val.value
      at = val.next
    }
    return { value: out, next: at }
  }
  if (prefix >= 0x90 && prefix < 0xa0) {
    const count = prefix & 0x0f
    let at = pos + 1
    const out: LjValue[] = []
    for (let i = 0; i < count; i++) {
      const item = ljMpDecode(bytes, at)
      out.push(item.value)
      at = item.next
    }
    return { value: out, next: at }
  }
  if (prefix >= 0xa0 && prefix < 0xc0) {
    const len = prefix & 0x1f
    return { value: utf8Text(bytes, pos + 1, len), next: pos + 1 + len }
  }
  if (prefix === 0xc0) return { value: null, next: pos + 1 }
  if (prefix === 0xc2) return { value: false, next: pos + 1 }
  if (prefix === 0xc3) return { value: true, next: pos + 1 }
  if (prefix === 0xc4 || prefix === 0xc5) {
    const len = prefix === 0xc4 ? (bytes[pos + 1] ?? 0) : (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0))
    const head = prefix === 0xc4 ? 2 : 3
    const out: number[] = []
    for (let i = 0; i < len; i++) out.push(bytes[pos + head + i] ?? 0)
    return { value: out, next: pos + head + len }
  }
  if (prefix === 0xcc) return { value: bytes[pos + 1] ?? 0, next: pos + 2 }
  if (prefix === 0xcd) {
    return { value: ((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0), next: pos + 3 }
  }
  if (prefix === 0xce) {
    const v =
      (((bytes[pos + 1] ?? 0) * 0x1000000) +
        ((bytes[pos + 2] ?? 0) << 16) +
        ((bytes[pos + 3] ?? 0) << 8) +
        (bytes[pos + 4] ?? 0)) >>>
      0
    return { value: v, next: pos + 5 }
  }
  if (prefix === 0xd0) {
    const raw = bytes[pos + 1] ?? 0
    return { value: raw > 127 ? raw - 256 : raw, next: pos + 2 }
  }
  if (prefix === 0xd1) {
    const raw = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    return { value: raw > 32767 ? raw - 65536 : raw, next: pos + 3 }
  }
  if (prefix === 0xd9) {
    const len = bytes[pos + 1] ?? 0
    return { value: utf8Text(bytes, pos + 2, len), next: pos + 2 + len }
  }
  if (prefix === 0xda) {
    const len = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    return { value: utf8Text(bytes, pos + 3, len), next: pos + 3 + len }
  }
  if (prefix === 0xdc) {
    const count = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    let at = pos + 3
    const out: LjValue[] = []
    for (let i = 0; i < count; i++) {
      const item = ljMpDecode(bytes, at)
      out.push(item.value)
      at = item.next
    }
    return { value: out, next: at }
  }
  if (prefix === 0xde) {
    const count = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    let at = pos + 3
    const out: Record<string, LjValue> = {}
    for (let i = 0; i < count; i++) {
      const key = ljMpDecode(bytes, at)
      const val = ljMpDecode(bytes, key.next)
      if (typeof key.value !== 'string') throw new Error(`ljMpDecode: map key not a string at ${at}`)
      out[key.value] = val.value
      at = val.next
    }
    return { value: out, next: at }
  }
  if (prefix === 0xca || prefix === 0xcb) {
    const raw = new Uint8Array(prefix === 0xca ? 4 : 8)
    for (let i = 0; i < raw.length; i++) raw[i] = bytes[pos + 1 + i] ?? 0
    const view = new DataView(raw.buffer)
    return {
      value: prefix === 0xca ? view.getFloat32(0, false) : view.getFloat64(0, false),
      next: pos + 1 + raw.length
    }
  }
  if (prefix >= 0xe0) return { value: prefix - 256, next: pos + 1 }
  throw new Error(`ljMpDecode: unknown prefix 0x${(prefix & 0xff).toString(16)} at offset ${pos}`)
}

/** Decode a whole reassembled stream; throws on trailing bytes. */
export function ljDecodeStream(stream: ArrayLike<number>): LjValue {
  const { value, next } = ljMpDecode(stream, 0)
  if (next !== stream.length) {
    throw new Error(`ljDecodeStream: ${stream.length - next} trailing bytes after offset ${next}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Framing.
// ---------------------------------------------------------------------------

/** Additive checksum: sum(bytes[0..end)) & 0xFF. */
export function ljChecksum(bytes: ArrayLike<number>, end: number): number {
  let sum = 0
  for (let i = 0; i < end; i++) sum = (sum + (bytes[i] ?? 0)) & 0xff
  return sum
}

/**
 * Build one 64B OUT frame for a document. LEN covers the frame including
 * the checksum; the rest is zero padding (ignored by the pad).
 */
export function ljFrameOut(doc: LjValue): number[] {
  return ljFrameBytes(ljMpEncode(doc))
}

/** Frame pre-encoded MessagePack bytes (LEN + checksum + zero pad). */
export function ljFrameBytes(stream: ReadonlyArray<number>): number[] {
  const len = 3 + stream.length + 1
  if (len > LJ_REPORT_LEN) throw new Error(`ljFrameBytes: document too large (${stream.length} bytes)`)
  const frame = [LJ_OUT_CLASS, len, LJ_MARKER, ...stream]
  frame.push(ljChecksum(frame, frame.length))
  while (frame.length < LJ_REPORT_LEN) frame.push(0)
  return frame
}

export interface LjReassembled {
  /** The concatenated MessagePack document bytes. */
  stream: number[]
  /** Total fragment count announced by the first frame (0x80|total). */
  total: number
}

/**
 * Reassemble fragmented IN frames (pcap/node-hid shape: each entry is one
 * 64B report starting with 0xA4). Verifies LEN/CK on every frame.
 */
export function ljReassemble(frames: ArrayLike<number>[]): LjReassembled {
  const stream: number[] = []
  let total = 0
  frames.forEach((frame, index) => {
    if (frame[0] !== LJ_IN_CLASS) throw new Error(`ljReassemble: frame ${index} class 0x${(frame[0] ?? 0).toString(16)}`)
    if (frame[2] !== LJ_MARKER) throw new Error(`ljReassemble: frame ${index} marker 0x${(frame[2] ?? 0).toString(16)}`)
    const len = frame[1] ?? 0
    if (len < 5 || len > LJ_REPORT_LEN) throw new Error(`ljReassemble: frame ${index} bad LEN ${len}`)
    const ck = frame[len - 1] ?? -1
    if (ljChecksum(frame, len - 1) !== ck) {
      throw new Error(`ljReassemble: frame ${index} checksum mismatch`)
    }
    const seq = frame[3] ?? 0
    if (index === 0) {
      if ((seq & 0x80) === 0) throw new Error('ljReassemble: first frame missing 0x80|total header')
      total = seq & 0x7f
      if (total !== frames.length) {
        throw new Error(`ljReassemble: announced ${total} frames, got ${frames.length}`)
      }
    } else if (seq !== total - index) {
      throw new Error(`ljReassemble: frame ${index} seq 0x${seq.toString(16)}, expected 0x${(total - index).toString(16)}`)
    }
    for (let i = 4; i < len - 1; i++) stream.push(frame[i] ?? 0)
  })
  return { stream, total }
}

/**
 * Split one MessagePack document into 64B fragmented OUT frames (A4 class):
 * first `[A4][40][CC][80|total][59B][CK]`, then full middles, then a final
 * `[A4][LEN<40][CC][01][rest][CK]`, zero-padded. Mirrors the pad's own
 * fragment layout, proven byte-exact against the vendor save-flush capture.
 */
export function ljFragmentOut(stream: ReadonlyArray<number>): number[][] {
  if (stream.length === 0) throw new Error('ljFragmentOut: refusing empty write')
  const chunks: number[][] = []
  for (let i = 0; i < stream.length; i += 59) chunks.push(stream.slice(i, i + 59))
  const total = chunks.length
  if (total > 127) throw new Error(`ljFragmentOut: ${total} fragments do not fit the 0x80|total header`)
  return chunks.map((payload, index) => {
    const seq = index === 0 ? 0x80 | total : total - index
    const len = payload.length + 5
    const frame = [LJ_IN_CLASS, len, LJ_MARKER, seq, ...payload]
    frame.push(ljChecksum(frame, frame.length))
    while (frame.length < LJ_REPORT_LEN) frame.push(0)
    return frame
  })
}

/**
 * Parse one single-frame (0xA5) IN report. Returns the document; verifies
 * LEN/CK the same way fragmented frames are verified.
 */
export function ljParseSingleFrame(frame: ArrayLike<number>): LjValue {
  if (frame[0] !== LJ_OUT_CLASS) throw new Error('ljParseSingleFrame: not a 0xA5 frame')
  if (frame[2] !== LJ_MARKER) throw new Error('ljParseSingleFrame: bad marker')
  const len = frame[1] ?? 0
  if (len < 5 || len > LJ_REPORT_LEN) throw new Error(`ljParseSingleFrame: bad LEN ${len}`)
  const ck = frame[len - 1] ?? -1
  if (ljChecksum(frame, len - 1) !== ck) throw new Error('ljParseSingleFrame: checksum mismatch')
  const body: number[] = []
  for (let i = 3; i < len - 1; i++) body.push(frame[i] ?? 0)
  return ljDecodeStream(body)
}

// ---------------------------------------------------------------------------
// Query builders (byte-exact against vendor captures).
// ---------------------------------------------------------------------------

/** Session probe: firmware/board version string. */
export function ljVersionQuery(): number[] {
  return ljFrameOut({ c: LJ_REC_VERSION })
}

/** Board info ({c:51, b:1}). */
export function ljBoardQuery(): number[] {
  return ljFrameOut({ c: LJ_REC_BOARD, b: 1 })
}

/**
 * The 22 button ids the vendor app requests, in capture order. The pad
 * answers with the same 22 records sorted ascending.
 */
export const LJ_BUTTON_QUERY_IDS: ReadonlyArray<number> = [
  26, 27, 24, 25, 1, 2, 4, 5, 14, 15, 17, 18, 19, 20, 7, 8, 9, 10, 11, 16, 12, 3
]

/** All 22 remappable button ids, ascending (the pad's answer order). */
export const LJ_ALL_BUTTON_IDS: ReadonlyArray<number> = [
  1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 24, 25, 26, 27
]

/** Button table query for one slot. */
export function ljButtonQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_BUTTONS, g: { b: 1, c: slot, k: [...LJ_BUTTON_QUERY_IDS] } })
}

/** Stick tuning query: d = 0 left, 1 right. */
export function ljStickQuery(slot: LjSlot, side: 0 | 1): number[] {
  return ljFrameOut({ c: LJ_REC_STICK, g: { b: 1, c: slot, d: side } })
}

/** Trigger (LT/RT deadzone + mode) query. */
export function ljTriggerQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_TRIGGER, g: { b: 1, c: slot } })
}

/** Global/motion query. */
export function ljGlobalQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_GLOBAL, g: { b: 1, c: slot } })
}

/** Rumble query. */
export function ljRumbleQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_RUMBLE, g: { b: 1, c: slot } })
}

/** Motion-control device colors (global, no slot). */
export function ljMotionDevicesQuery(): number[] {
  return ljFrameOut({ c: LJ_REC_MOTION_DEVICES })
}

// ---------------------------------------------------------------------------
// Buttons.
// ---------------------------------------------------------------------------

/**
 * Source-id -> pad label, mirroring the vendor JSON button keys. Only R5=M1
 * (id 24) is hardware-confirmed so far; the rest follow the JSON order
 * alignment (a=1,b=2,x=4,y=5,l1=7,...,m1=24,m2=25,m3=26,m4=27,c=3), which the
 * single proven flip (m1->X) anchors.
 */
export const LJ_BUTTON_NAMES: Readonly<Record<number, string>> = {
  1: 'A',
  2: 'B',
  4: 'X',
  5: 'Y',
  7: 'L1',
  8: 'R1',
  9: 'L2',
  10: 'R2',
  11: 'Select',
  12: 'Start',
  14: 'L3',
  15: 'R3',
  16: 'Capture',
  17: 'Up',
  18: 'Down',
  19: 'Left',
  20: 'Right',
  24: 'M1',
  25: 'M2',
  26: 'M3',
  27: 'M4',
  3: 'C'
}

/**
 * Wire id -> physical control, user-confirmed 2026-10-15 (R5->X, R4->A,
 * L5->B, L4->Y flips triangulated against JSON m1..m4 and the wire atoms).
 * R5/L5 are the rear paddles, R4/L4 the extra bumpers.
 */
export const LJ_PHYSICAL: Readonly<Record<number, string>> = {
  24: 'R5',
  25: 'L5',
  26: 'R4',
  27: 'L4'
}

/** Tournament 1:1 remap targets: stock (null) or any button id. */
export const LJ_REMAP_TARGETS: ReadonlyArray<number> = LJ_ALL_BUTTON_IDS

function ljOriginAction(): LjButtonAction {
  return { t: 0, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [0, 0, 0, 0] }
}

/**
 * map_to discriminator for a remap target. Proven from the pad + the vendor
 * app's own config, each by binding one and reading it back:
 *   0 = Origin (stock/unmapped), 2 = GamepadButton (gamepad-code space),
 *   3 = KeyboardKey (USB HID keyboard usage id), 4 = MouseButton (HID button 1..5).
 * Macro exists in the vendor protocol but its discriminator is not captured, so
 * it stays unwritable.
 */
export const LJ_MAP_ORIGIN = 0
export const LJ_MAP_GAMEPAD = 2
export const LJ_MAP_KEYBOARD = 3
export const LJ_MAP_MOUSE = 4

/** A remap target: which kind of output, and its code in that kind's space. */
export interface LjButtonTarget {
  t: number
  code: number
}

/**
 * USB HID Keyboard/Keypad usage ids (page 0x07) — the space this pad stores
 * keyboard targets in. Anchored on hardware: G = 10 (0x0A), O = 18 (0x12),
 * S = 22 (0x16), straight off the pad with the vendor app naming them.
 */
export const LJ_HID_KEYS: ReadonlyArray<{ code: number; label: string }> = [
  { code: 4, label: 'A' }, { code: 5, label: 'B' }, { code: 6, label: 'C' }, { code: 7, label: 'D' },
  { code: 8, label: 'E' }, { code: 9, label: 'F' }, { code: 10, label: 'G' }, { code: 11, label: 'H' },
  { code: 12, label: 'I' }, { code: 13, label: 'J' }, { code: 14, label: 'K' }, { code: 15, label: 'L' },
  { code: 16, label: 'M' }, { code: 17, label: 'N' }, { code: 18, label: 'O' }, { code: 19, label: 'P' },
  { code: 20, label: 'Q' }, { code: 21, label: 'R' }, { code: 22, label: 'S' }, { code: 23, label: 'T' },
  { code: 24, label: 'U' }, { code: 25, label: 'V' }, { code: 26, label: 'W' }, { code: 27, label: 'X' },
  { code: 28, label: 'Y' }, { code: 29, label: 'Z' },
  { code: 30, label: '1' }, { code: 31, label: '2' }, { code: 32, label: '3' }, { code: 33, label: '4' },
  { code: 34, label: '5' }, { code: 35, label: '6' }, { code: 36, label: '7' }, { code: 37, label: '8' },
  { code: 38, label: '9' }, { code: 39, label: '0' },
  { code: 40, label: 'Enter' }, { code: 41, label: 'Esc' }, { code: 42, label: 'Backspace' },
  { code: 43, label: 'Tab' }, { code: 44, label: 'Space' }, { code: 45, label: '-' }, { code: 46, label: '=' },
  { code: 47, label: '[' }, { code: 48, label: ']' }, { code: 49, label: '\\' }, { code: 51, label: ';' },
  { code: 52, label: "'" }, { code: 53, label: '`' }, { code: 54, label: ',' }, { code: 55, label: '.' },
  { code: 56, label: '/' }, { code: 57, label: 'Caps Lock' },
  { code: 58, label: 'F1' }, { code: 59, label: 'F2' }, { code: 60, label: 'F3' }, { code: 61, label: 'F4' },
  { code: 62, label: 'F5' }, { code: 63, label: 'F6' }, { code: 64, label: 'F7' }, { code: 65, label: 'F8' },
  { code: 66, label: 'F9' }, { code: 67, label: 'F10' }, { code: 68, label: 'F11' }, { code: 69, label: 'F12' },
  { code: 70, label: 'Print Screen' }, { code: 71, label: 'Scroll Lock' }, { code: 72, label: 'Pause' },
  { code: 73, label: 'Insert' }, { code: 74, label: 'Home' }, { code: 75, label: 'Page Up' },
  { code: 76, label: 'Delete' }, { code: 77, label: 'End' }, { code: 78, label: 'Page Down' },
  { code: 79, label: 'Right' }, { code: 80, label: 'Left' }, { code: 81, label: 'Down' }, { code: 82, label: 'Up' },
  { code: 83, label: 'Num Lock' }, { code: 84, label: 'Num /' }, { code: 85, label: 'Num *' },
  { code: 86, label: 'Num -' }, { code: 87, label: 'Num +' }, { code: 88, label: 'Num Enter' },
  { code: 89, label: 'Num 1' }, { code: 90, label: 'Num 2' }, { code: 91, label: 'Num 3' },
  { code: 92, label: 'Num 4' }, { code: 93, label: 'Num 5' }, { code: 94, label: 'Num 6' },
  { code: 95, label: 'Num 7' }, { code: 96, label: 'Num 8' }, { code: 97, label: 'Num 9' },
  { code: 98, label: 'Num 0' }, { code: 99, label: 'Num .' },
  { code: 224, label: 'Left Ctrl' }, { code: 225, label: 'Left Shift' }, { code: 226, label: 'Left Alt' },
  { code: 227, label: 'Left Win' }, { code: 228, label: 'Right Ctrl' }, { code: 229, label: 'Right Shift' },
  { code: 230, label: 'Right Alt' }, { code: 231, label: 'Right Win' }
]

/** HID mouse button numbers the pad stores (1 = left, 2 = right, 3 = middle…). */
export const LJ_MOUSE_BUTTONS: ReadonlyArray<{ code: number; label: string }> = [
  { code: 1, label: 'Left Click' },
  { code: 2, label: 'Right Click' },
  { code: 3, label: 'Middle Click' },
  { code: 4, label: 'Back' },
  { code: 5, label: 'Forward' }
]

const LJ_KEY_LABELS = new Map<number, string>([
  ...LJ_HID_KEYS.map((k) => [k.code, k.label] as const),
  ...LJ_MOUSE_BUTTONS.map((k) => [k.code, k.label] as const)
])

/** Human label for a target (null only for Origin/stock). */
export function ljTargetLabel(target: LjButtonTarget): string | null {
  if (target.t === LJ_MAP_ORIGIN) return null
  if (target.t === LJ_MAP_GAMEPAD) return ljButtonTargetName(target.code)
  if (target.t === LJ_MAP_KEYBOARD) return LJ_KEY_LABELS.get(target.code) ?? `key ${target.code}`
  if (target.t === LJ_MAP_MOUSE) return LJ_KEY_LABELS.get(target.code) ?? `mouse ${target.code}`
  return `t=${target.t} code=${target.code}`
}

/** Read the remap target back out of a record (the pad's `dn` action). */
export function ljButtonRecordTarget(record: LjButtonRecord): LjButtonTarget {
  const dn = record.dn
  if (dn.t === LJ_MAP_GAMEPAD) return { t: LJ_MAP_GAMEPAD, code: dn.v[0] ?? 0 }
  if (dn.t === LJ_MAP_KEYBOARD) return { t: LJ_MAP_KEYBOARD, code: dn.v[1] ?? 0 }
  if (dn.t === LJ_MAP_MOUSE) return { t: LJ_MAP_MOUSE, code: dn.v[0] ?? 0 }
  return { t: dn.t, code: dn.v[0] ?? 0 }
}

function ljTargetAction(target: LjButtonTarget): LjButtonAction {
  if (target.t === LJ_MAP_ORIGIN) return ljOriginAction()
  if (target.t === LJ_MAP_GAMEPAD) {
    if (!LJ_ALL_BUTTON_IDS.includes(target.code)) {
      throw new Error(`leadjoy: gamepad target ${target.code} is outside the 22-id table`)
    }
    return { t: LJ_MAP_GAMEPAD, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [target.code, 0, 0, 0] }
  }
  // Keyboard keys sit in v[1] and mouse buttons in v[0] — both read straight off
  // the pad with the vendor app naming them (G=10, O=18, S=22, right click=2).
  if (target.t === LJ_MAP_KEYBOARD) {
    if (!LJ_HID_KEYS.some((k) => k.code === target.code)) {
      throw new Error(`leadjoy: keyboard code ${target.code} is not a known HID usage`)
    }
    return { t: LJ_MAP_KEYBOARD, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [0, target.code, 0, 0] }
  }
  if (target.t === LJ_MAP_MOUSE) {
    if (!LJ_MOUSE_BUTTONS.some((k) => k.code === target.code)) {
      throw new Error(`leadjoy: mouse button ${target.code} is outside 1..5`)
    }
    return { t: LJ_MAP_MOUSE, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [target.code, 0, 0, 0] }
  }
  throw new Error(`leadjoy: map_to ${target.t} is not captured — refusing to write it`)
}

/**
 * Build one button write record: any of the 22 table ids as source, any proven
 * target kind as destination (stock, gamepad, keyboard key, mouse button).
 * Framing/ack/readback are identical for every id and kind — only the action
 * differs — so no id is special. Anything outside the proven spaces throws;
 * the main handler and any future caller share this gate, never just the UI.
 */
export function ljButtonWriteRecord(id: number, target: LjButtonTarget | null): LjButtonRecord {
  if (!LJ_ALL_BUTTON_IDS.includes(id)) {
    throw new Error(`leadjoy: button id ${id} is outside the 22-id table`)
  }
  return {
    k: id,
    a: 0,
    dn: target === null ? ljOriginAction() : ljTargetAction(target),
    up: ljOriginAction()
  }
}

/** Remap targets reuse the source-id space (proven: X = 4). */
export function ljButtonTargetName(code: number): string {
  return LJ_BUTTON_NAMES[code] ?? `ID ${code}`
}

/** dn/up action payload. Origin = all zeros; GamepadButton sets t + v. */
export interface LjButtonAction {
  t: number
  n: string
  mr: number
  ms: number
  r: number
  sp: number
  ri: number
  v: number[]
}

export interface LjButtonRecord {
  k: number
  a: number
  dn: LjButtonAction
  up: LjButtonAction
}

function asRecord(value: LjValue): Record<string, LjValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('leadjoy: expected a map')
  }
  return value as Record<string, LjValue>
}

function asNumber(value: LjValue, what: string): number {
  if (typeof value !== 'number') throw new Error(`leadjoy: ${what} is not a number`)
  return value
}

function asString(value: LjValue, what: string): string {
  if (typeof value !== 'string') throw new Error(`leadjoy: ${what} is not a string`)
  return value
}

function asNumberArray(value: LjValue, what: string): number[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number')) {
    throw new Error(`leadjoy: ${what} is not a number array`)
  }
  return value as number[]
}

function parseButtonAction(value: LjValue, what: string): LjButtonAction {
  const m = asRecord(value)
  return {
    t: asNumber(m.t, `${what}.t`),
    n: asString(m.n, `${what}.n`),
    mr: asNumber(m.mr, `${what}.mr`),
    ms: asNumber(m.ms, `${what}.ms`),
    r: asNumber(m.r, `${what}.r`),
    sp: asNumber(m.sp, `${what}.sp`),
    ri: asNumber(m.ri, `${what}.ri`),
    v: asNumberArray(m.v, `${what}.v`)
  }
}

function parseButtonRecord(value: LjValue): LjButtonRecord {
  const m = asRecord(value)
  return {
    k: asNumber(m.k, 'button.k'),
    a: asNumber(m.a, 'button.a'),
    dn: parseButtonAction(m.dn, 'button.dn'),
    up: parseButtonAction(m.up, 'button.up')
  }
}

export interface LjButtonTable {
  board: number
  slot: number
  records: LjButtonRecord[]
}

/** Parse a reassembled record-60 document. */
export function ljParseButtonTable(doc: LjValue): LjButtonTable {
  const root = asRecord(doc)
  if (asNumber(root.c, 'buttons.c') !== LJ_REC_BUTTONS) throw new Error('leadjoy: not a button table')
  const r = asRecord(root.r)
  const d1 = r.d1
  if (!Array.isArray(d1)) throw new Error('leadjoy: button d1 is not a list')
  if (d1.length !== LJ_BUTTON_QUERY_IDS.length) {
    throw new Error(`leadjoy: button table has ${d1.length} records, expected ${LJ_BUTTON_QUERY_IDS.length}`)
  }
  return {
    board: asNumber(r.b, 'buttons.r.b'),
    slot: asNumber(r.c, 'buttons.r.c'),
    records: (d1 as LjValue[]).map(parseButtonRecord)
  }
}

/** Re-encode a button table (modified or not) for a slot. No writes ship yet. */
export function ljBuildButtonTable(slot: LjSlot, records: ReadonlyArray<LjButtonRecord>): number[] {
  return ljMpEncode({
    c: LJ_REC_BUTTONS,
    e: 0,
    r: {
      b: 1,
      c: slot,
      d1: records.map((rec) => ({ k: rec.k, a: rec.a, dn: { ...rec.dn, v: [...rec.dn.v] }, up: { ...rec.up, v: [...rec.up.v] } }))
    }
  })
}

/**
 * Build one single-record button write document: writes carry record id 61
 * under key `w` (reads use 60 under `g`), and the vendor serializes action
 * maps in t,v,n,r,sp,mr,ms,ri order (reads come back t,n,mr,ms,r,sp,ri,v).
 * Byte-exact against the save-flush capture. Fragment with ljFragmentOut;
 * the pad answers each write with a single-frame `{c:61,e:0}` ack.
 */
export function ljBuildButtonWrite(slot: LjSlot, record: LjButtonRecord): number[] {
  const action = (a: LjButtonAction): Record<string, LjValue> => ({
    t: a.t,
    v: [...a.v],
    n: a.n,
    r: a.r,
    sp: a.sp,
    mr: a.mr,
    ms: a.ms,
    ri: a.ri
  })
  return ljMpEncode({
    c: LJ_REC_BUTTONS_WRITE,
    w: {
      b: 1,
      c: slot,
      d1: [{ k: record.k, a: record.a, dn: action(record.dn), up: action(record.up) }]
    }
  })
}

/** Parse a button-write ack; throws unless it is `{c:expected,e:0}`. */
export function ljParseWriteAck(doc: LjValue, expected: number): { record: number } {
  const root = asRecord(doc)
  const record = asNumber(root.c, 'ack.c')
  if (record !== expected) throw new Error(`leadjoy: write ack for record ${record}, expected ${expected}`)
  if (asNumber(root.e, 'ack.e') !== 0) throw new Error('leadjoy: write ack reports an error')
  return { record }
}

/** Human-readable mapping for one record: null when unmapped (Origin). */
export function ljButtonTarget(record: LjButtonRecord): string | null {
  return ljTargetLabel(ljButtonRecordTarget(record))
}

// ---------------------------------------------------------------------------
// Sticks, triggers, board.
// ---------------------------------------------------------------------------

/** Percent (0..100) to wire (0..32767, 100% clamps from 32768). */
export function ljPercentToWire(percent: number): number {
  const raw = Math.round((percent / 100) * 32768)
  if (raw >= 32768) return LJ_WIRE_MAX
  return Math.max(0, raw)
}

/** Validate a 16-value stick curve image (ints 0..32767). Returns a copy. */
export function ljValidateCurveWire(cv: unknown): number[] {  if (!Array.isArray(cv) || cv.length !== LJ_CURVE_POINTS * 2) {
    throw new Error(`leadjoy: curve needs ${LJ_CURVE_POINTS * 2} values`)
  }
  return cv.map((v, i) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > LJ_WIRE_MAX) {
      throw new Error(`leadjoy: curve value ${i} (${String(v)}) is not a wire int 0..32767`)
    }
    return v
  })
}

/**
 * Stick gate ("shape") codes — the only two the vendor app offers, verified by
 * reading the pad and the app's own config after switching each one:
 * RoundedRectangle = 0, Circle = 1. The library also carries a `LeftRight`
 * variant, but the app exposes no such option, so it stays unwritable.
 */
export const LJ_SHAPES = { RoundedRectangle: 0, Circle: 1 } as const
export type LjShapeCode = (typeof LJ_SHAPES)[keyof typeof LJ_SHAPES]

export function ljValidateShape(code: unknown): LjShapeCode {
  if (code !== LJ_SHAPES.RoundedRectangle && code !== LJ_SHAPES.Circle) {
    throw new Error(`leadjoy: shape ${String(code)} is not a proven code (0 rounded-rect, 1 circle)`)
  }
  return code
}

/**
 * Fields of a stick side image the app may change. Everything not listed is
 * read from the pad and written back untouched, so unknown fields survive.
 * `cv` = curve/deadzone, `ci` = gate, `mm`/`mse` = mouse mapping (enable/rate),
 * `xr`/`yr` = axis reverse, `asf` = anti-shake, `rjc` = release cut.
 */
export interface LjStickPatch {
  cv?: number[]
  ci?: number
  mm?: number
  mse?: number
  xr?: number
  yr?: number
  asf?: number
  rjc?: number
}

function ljFlag(v: unknown, what: string): number {
  if (v !== 0 && v !== 1) throw new Error(`leadjoy: ${what} must be 0 or 1`)
  return v
}

function ljRangeInt(v: unknown, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    throw new Error(`leadjoy: ${what} must be an int 0..${max}`)
  }
  return v
}

/** Apply a validated patch onto a pad-read side image. Returns a new object. */
export function ljApplyStickPatch(d1: LjStickSide, patch: LjStickPatch): LjStickSide {
  const out: LjStickSide = { ...d1, cv: [...d1.cv] }
  if (patch.cv !== undefined) out.cv = ljValidateCurveWire(patch.cv)
  if (patch.ci !== undefined) out.ci = ljValidateShape(patch.ci)
  if (patch.mm !== undefined) out.mm = ljFlag(patch.mm, 'mm')
  if (patch.rjc !== undefined) out.rjc = ljFlag(patch.rjc, 'rjc')
  if (patch.xr !== undefined) out.xr = ljFlag(patch.xr, 'xr')
  if (patch.yr !== undefined) out.yr = ljFlag(patch.yr, 'yr')
  if (patch.mse !== undefined) out.mse = ljRangeInt(patch.mse, 'mse', 100)
  if (patch.asf !== undefined) out.asf = ljRangeInt(patch.asf, 'asf', 100)
  return out
}

/** Wire back to percent. */
export function ljWireToPercent(wire: number): number {
  return (wire / 32768) * 100
}

// ---------------------------------------------------------------------------
// Stick zones — the GameSir deadzone card, expressed on the LJ 8-point curve.
//
// The GPU-style byte fields do not exist on this pad: the whole response is the
// 8 (in,out) pairs. The GameSir card's four numbers therefore land on the curve
// endpoints, which is where they already live on the wire:
//   START      -> point 1 input   (deadzone: output 0 below this)
//   ANTI-START -> point 1 output  (anti-deadzone floor)
//   END        -> point 8 input   (input above this = full output)
//   ANTI-END   -> point 8 output  (output ceiling)
// All values are on the 0.1% grid used by the renderer (0..1000).
// ---------------------------------------------------------------------------

export const LJ_ZONE_MAX = 1000

export interface LjStickZones {
  start: number
  antiStart: number
  end: number
  antiEnd: number
}

function normZone(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`leadjoy: zone ${what} (${String(v)}) is not a number`)
  }
  return Math.max(0, Math.min(LJ_ZONE_MAX, Math.round(v)))
}

/** Clamp + order a zone set; throws when start sits past end. */
export function ljNormZones(zones: LjStickZones): LjStickZones {
  const z = {
    start: normZone(zones.start, 'start'),
    antiStart: normZone(zones.antiStart, 'antiStart'),
    end: normZone(zones.end, 'end'),
    antiEnd: normZone(zones.antiEnd, 'antiEnd')
  }
  if (z.start > z.end) throw new Error(`leadjoy: zone start (${z.start}) is past end (${z.end})`)
  return z
}

/** Read the four zones out of a curve given on the 0.1% grid. */
export function ljCurveZones(curve: ReadonlyArray<readonly [number, number]>): LjStickZones {
  if (curve.length !== LJ_CURVE_POINTS) {
    throw new Error(`leadjoy: curve has ${curve.length} points, expected ${LJ_CURVE_POINTS}`)
  }
  const first = curve[0]
  const last = curve[curve.length - 1]
  return { start: first[0], antiStart: first[1], end: last[0], antiEnd: last[1] }
}

/** Apply zones to a curve, keeping the interior inputs ordered inside them. */
export function ljFitZones(
  curve: ReadonlyArray<readonly [number, number]>,
  zones: LjStickZones
): Array<[number, number]> {
  if (curve.length !== LJ_CURVE_POINTS) {
    throw new Error(`leadjoy: curve has ${curve.length} points, expected ${LJ_CURVE_POINTS}`)
  }
  const z = ljNormZones(zones)
  const out: Array<[number, number]> = curve.map((p) => [p[0], p[1]])
  out[0] = [z.start, z.antiStart]
  out[out.length - 1] = [z.end, z.antiEnd]
  for (let i = 1; i < out.length - 1; i++) {
    out[i][0] = Math.max(out[i - 1][0], Math.min(z.end, out[i][0]))
  }
  return out
}

/** Straight response between the zones' floor and ceiling (8 points). */
export function ljLinearCurve(zones: LjStickZones): Array<[number, number]> {
  const z = ljNormZones(zones)
  const out: Array<[number, number]> = []
  for (let i = 0; i < LJ_CURVE_POINTS; i++) {
    const u = i / (LJ_CURVE_POINTS - 1)
    out.push([Math.round(z.start + u * (z.end - z.start)), Math.round(z.antiStart + u * (z.antiEnd - z.antiStart))])
  }
  return out
}

/**
 * Sample a 0..255 designer curve onto the 8 points, keeping the zones: input
 * runs from `start` to `end`, output from the floor to the ceiling.
 */
export function ljSampleDesign(
  design: ReadonlyArray<{ x: number; y: number }>,
  zones: LjStickZones
): Array<[number, number]> {
  const z = ljNormZones(zones)
  const pts = [...design]
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    .map((p) => ({ x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(255, p.y)) }))
    .sort((a, b) => a.x - b.x)
  if (pts.length < 2) return ljLinearCurve(z)
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
  const out: Array<[number, number]> = []
  for (let i = 0; i < LJ_CURVE_POINTS; i++) {
    const u = i / (LJ_CURVE_POINTS - 1)
    const dx = u * 255
    const dy = at(dx)
    out.push([
      Math.round(z.start + u * (z.end - z.start)),
      Math.round(z.antiStart + (dy / 255) * (z.antiEnd - z.antiStart))
    ])
  }
  return out
}

export interface LjStickTuning {
  board: number
  slot: number
  side: number
  /** Center offset in pad units. */
  center: [number, number]
  /** Shape code (1 = Circle in the current capture; enum otherwise open). */
  shape: number
  /** 8 [in,out] wire pairs, 0..32767. */
  curveWire: Array<readonly [number, number]>
  /** Same curve in percent for display. */
  curvePercent: Array<readonly [number, number]>
  /** Stick-trigger radii (left/up/right/down). */
  triggerRadius: { left: number; up: number; right: number; down: number }
  /** Full side image (round-trips through ljBuildStickWrite). */
  d1: LjStickSide
  raw: LjValue
}

/** One stick-trigger action (same atoms as button records). */
export interface LjStickTriple {
  a: number
  dn: LjButtonAction
  up: LjButtonAction
}

/** Full record-70 side image, in vendor key order. */
export interface LjStickSide {
  co: [number, number]
  ci: number
  rjc: number
  mm: number
  mse: number
  mom: number
  xr: number
  yr: number
  asf: number
  ct: number
  cv: number[]
  rt: number
  rc: number
  cpl: number
  cpu: number
  cpr: number
  cpd: number
  tkl: LjStickTriple
  tku: LjStickTriple
  tkr: LjStickTriple
  tkd: LjStickTriple
}

function parseStickTriple(value: LjValue, what: string): LjStickTriple {
  const m = asRecord(value)
  return {
    a: asNumber(m.a, `${what}.a`),
    dn: parseButtonAction(m.dn, `${what}.dn`),
    up: parseButtonAction(m.up, `${what}.up`)
  }
}

/** Parse a record-70/71 side image (reads and writes share the layout). */
export function ljParseStickSide(d1: LjValue): LjStickSide {
  const m = asRecord(d1)
  const co = asNumberArray(m.co, 'stick.co')
  const cv = asNumberArray(m.cv, 'stick.cv')
  if (co.length !== 2) throw new Error('leadjoy: stick.co is not a pair')
  if (cv.length !== LJ_CURVE_POINTS * 2) {
    throw new Error(`leadjoy: stick.cv has ${cv.length} values, expected ${LJ_CURVE_POINTS * 2}`)
  }
  return {
    co: [co[0] ?? 0, co[1] ?? 0],
    ci: asNumber(m.ci, 'stick.ci'),
    rjc: asNumber(m.rjc, 'stick.rjc'),
    mm: asNumber(m.mm, 'stick.mm'),
    mse: asNumber(m.mse, 'stick.mse'),
    mom: asNumber(m.mom, 'stick.mom'),
    xr: asNumber(m.xr, 'stick.xr'),
    yr: asNumber(m.yr, 'stick.yr'),
    asf: asNumber(m.asf, 'stick.asf'),
    ct: asNumber(m.ct, 'stick.ct'),
    cv: [...cv],
    rt: asNumber(m.rt, 'stick.rt'),
    rc: asNumber(m.rc, 'stick.rc'),
    cpl: asNumber(m.cpl, 'stick.cpl'),
    cpu: asNumber(m.cpu, 'stick.cpu'),
    cpr: asNumber(m.cpr, 'stick.cpr'),
    cpd: asNumber(m.cpd, 'stick.cpd'),
    tkl: parseStickTriple(m.tkl, 'stick.tkl'),
    tku: parseStickTriple(m.tku, 'stick.tku'),
    tkr: parseStickTriple(m.tkr, 'stick.tkr'),
    tkd: parseStickTriple(m.tkd, 'stick.tkd')
  }
}

/**
 * Build one full-side stick write document: record id 71 under key `w`,
 * same d1 layout and key order as reads (action maps in the write order
 * t,v,n,r,sp,mr,ms,ri). Byte-exact against the vendor curve-flip capture.
 * Fragment with ljFragmentOut; the pad acks each write with `{c:71,e:0}`.
 */
export function ljBuildStickWrite(slot: LjSlot, side: 0 | 1, d1: LjStickSide): number[] {
  const triple = (t: LjStickTriple): Record<string, LjValue> => ({
    a: t.a,
    dn: { t: t.dn.t, v: [...t.dn.v], n: t.dn.n, r: t.dn.r, sp: t.dn.sp, mr: t.dn.mr, ms: t.dn.ms, ri: t.dn.ri },
    up: { t: t.up.t, v: [...t.up.v], n: t.up.n, r: t.up.r, sp: t.up.sp, mr: t.up.mr, ms: t.up.ms, ri: t.up.ri }
  })
  return ljMpEncode({
    c: LJ_REC_STICK_WRITE,
    w: {
      b: 1,
      c: slot,
      d: side,
      d1: {
        co: [...d1.co],
        ci: d1.ci,
        rjc: d1.rjc,
        mm: d1.mm,
        mse: d1.mse,
        mom: d1.mom,
        xr: d1.xr,
        yr: d1.yr,
        asf: d1.asf,
        ct: d1.ct,
        cv: [...d1.cv],
        rt: d1.rt,
        rc: d1.rc,
        cpl: d1.cpl,
        cpu: d1.cpu,
        cpr: d1.cpr,
        cpd: d1.cpd,
        tkl: triple(d1.tkl),
        tku: triple(d1.tku),
        tkr: triple(d1.tkr),
        tkd: triple(d1.tkd)
      }
    }
  })
}

/** Parse a reassembled record-70 document (one stick side). */
export function ljParseStick(doc: LjValue): LjStickTuning {
  const root = asRecord(doc)
  if (asNumber(root.c, 'stick.c') !== LJ_REC_STICK) throw new Error('leadjoy: not a stick record')
  const r = asRecord(root.r)
  const side = ljParseStickSide(r.d1)
  const pairs: Array<readonly [number, number]> = []
  for (let i = 0; i < LJ_CURVE_POINTS; i++) {
    pairs.push([side.cv[i * 2] ?? 0, side.cv[i * 2 + 1] ?? 0])
  }
  return {
    board: asNumber(r.b, 'stick.r.b'),
    slot: asNumber(r.c, 'stick.r.c'),
    side: asNumber(r.d, 'stick.r.d'),
    center: side.co,
    shape: side.ci,
    curveWire: pairs,
    curvePercent: pairs.map(([x, y]) => [ljWireToPercent(x), ljWireToPercent(y)] as const),
    triggerRadius: {
      left: side.cpl,
      up: side.cpu,
      right: side.cpr,
      down: side.cpd
    },
    d1: side,
    raw: doc
  }
}

export interface LjTriggerTuning {
  board: number
  slot: number
  left: { mode: number; inner: number; outer: number; vibration: number }
  right: { mode: number; inner: number; outer: number; vibration: number }
  /** Full d1 image (round-trips through ljBuildTriggerWrite). */
  d1: LjTriggerD1
}

/** Full record-90/91 trigger image, in vendor key order. */
export interface LjTriggerD1 {
  mol: number
  dzl: [number, number]
  vtl: number
  mor: number
  dzr: [number, number]
  vtr: number
}

function asIntPair(value: LjValue, what: string): [number, number] {
  const arr = asNumberArray(value, what)
  if (arr.length !== 2) throw new Error(`leadjoy: ${what} is not a pair`)
  return [arr[0] ?? 0, arr[1] ?? 0]
}

/** Parse a record-90/91 trigger image (reads and writes share the layout). */
export function ljParseTriggerD1(d1: LjValue): LjTriggerD1 {
  const m = asRecord(d1)
  return {
    mol: asNumber(m.mol, 'trigger.mol'),
    dzl: asIntPair(m.dzl, 'trigger.dzl'),
    vtl: asNumber(m.vtl, 'trigger.vtl'),
    mor: asNumber(m.mor, 'trigger.mor'),
    dzr: asIntPair(m.dzr, 'trigger.dzr'),
    vtr: asNumber(m.vtr, 'trigger.vtr')
  }
}

/** Editable deadzones: ints 0..100 (percent). Modes/vibration pass through. */
export interface LjTriggerZones {
  leftInner: number
  leftOuter: number
  rightInner: number
  rightOuter: number
}

function asZone(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`leadjoy: trigger ${what} (${String(value)}) is not an int 0..100`)
  }
  return value
}

/**
 * Build one trigger write document: record id 91 under key `w`, same d1
 * layout and key order as reads. Only deadzone ints travel from the caller
 * (validated 0..100); the caller passes mode/vibration back from the pad
 * read, never invented. Single-frame OUT; the pad acks with `{c:91,e:0}`.
 */
export function ljBuildTriggerWrite(slot: LjSlot, d1: LjTriggerD1): number[] {
  const dz = (pair: [number, number], what: string): [number, number] => [
    asZone(pair[0], `${what}[0]`),
    asZone(pair[1], `${what}[1]`)
  ]
  return ljMpEncode({
    c: LJ_REC_TRIGGER_WRITE,
    w: {
      b: 1,
      c: slot,
      d1: {
        mol: d1.mol,
        dzl: dz(d1.dzl, 'dzl'),
        vtl: d1.vtl,
        mor: d1.mor,
        dzr: dz(d1.dzr, 'dzr'),
        vtr: d1.vtr
      }
    }
  })
}

/** Parse a reassembled record-90 document (LT/RT). */
export function ljParseTrigger(doc: LjValue): LjTriggerTuning {
  const root = asRecord(doc)
  if (asNumber(root.c, 'trigger.c') !== LJ_REC_TRIGGER) throw new Error('leadjoy: not a trigger record')
  const r = asRecord(root.r)
  const d1 = ljParseTriggerD1(r.d1)
  return {
    board: asNumber(r.b, 'trigger.r.b'),
    slot: asNumber(r.c, 'trigger.r.c'),
    left: { mode: d1.mol, inner: d1.dzl[0], outer: d1.dzl[1], vibration: d1.vtl },
    right: { mode: d1.mor, inner: d1.dzr[0], outer: d1.dzr[1], vibration: d1.vtr },
    d1
  }
}

export interface LjBoardInfo {
  board: number
  name: string
}

/** Parse a reassembled record-51 document. */
export function ljParseBoard(doc: LjValue): LjBoardInfo {
  const root = asRecord(doc)
  if (asNumber(root.c, 'board.c') !== LJ_REC_BOARD) throw new Error('leadjoy: not a board record')
  const r = asRecord(root.r)
  const d2 = asRecord(r.d2)
  return { board: asNumber(r.b, 'board.r.b'), name: asString(d2.n, 'board.n') }
}

// ---------------------------------------------------------------------------
// Read-only snapshot for the app preview (plain JSON, no writes involved).
// ---------------------------------------------------------------------------

export interface LjSnapshotButton {
  id: number
  label: string
  /** Display label for the current target (null = stock/unmapped). */
  target: string | null
  /** Structured target so the UI can re-pick keyboard/mouse too. */
  map: LjButtonTarget
}

export interface LjSnapshotStick {
  side: number
  sideName: string
  deadzonePct: number
  center: [number, number]
  shape: number
  /** Mouse mapping — this pad's "controller rate" (only meaningful in Mouse output). */
  mouse: { enabled: boolean; rate: number }
  curvePct: Array<readonly [number, number]>
}

export interface LjSnapshotTriggerSide {
  mode: number
  inner: number
  outer: number
}

export interface LjSnapshot {
  version: string
  board: string
  slot: number
  buttons: LjSnapshotButton[]
  sticks: LjSnapshotStick[]
  trigger: { left: LjSnapshotTriggerSide; right: LjSnapshotTriggerSide }
}

function snapshotStick(tuning: LjStickTuning): LjSnapshotStick {
  return {
    side: tuning.side,
    sideName: tuning.side === 0 ? 'Left' : 'Right',
    deadzonePct: tuning.curvePercent[0]?.[0] ?? 0,
    center: tuning.center,
    shape: tuning.shape,
    mouse: { enabled: tuning.d1.mm === 1, rate: tuning.d1.mse },
    curvePct: tuning.curvePercent
  }
}

/** Assemble one read-only snapshot from parsed Main-slot records. */
export function ljBuildSnapshot(
  versionDoc: LjValue,
  board: LjBoardInfo,
  buttons: LjButtonTable,
  left: LjStickTuning,
  right: LjStickTuning,
  trigger: LjTriggerTuning
): LjSnapshot {
  const version = asRecord(versionDoc)
  return {
    version: asString(version.r, 'version.r'),
    board: board.name,
    slot: buttons.slot,
    buttons: buttons.records.map((rec) => ({
      id: rec.k,
      label: LJ_BUTTON_NAMES[rec.k] ?? `ID ${rec.k}`,
      target: ljButtonTarget(rec),
      map: ljButtonRecordTarget(rec)
    })),
    sticks: [snapshotStick(left), snapshotStick(right)],
    trigger: {
      left: { mode: trigger.left.mode, inner: trigger.left.inner, outer: trigger.left.outer },
      right: { mode: trigger.right.mode, inner: trigger.right.inner, outer: trigger.right.outer }
    }
  }
}
