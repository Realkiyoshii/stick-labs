/**
 * GameSir G7 Pro 8K (internal: G7ProCE) — wire protocol.
 *
 * All values verified against hardware; see docs/PROTOCOL.md.
 * Reports are 64 bytes; byte 0 is the report ID.
 */

// ---------------------------------------------------------------------------
// Device identification
// ---------------------------------------------------------------------------

export const VENDOR_ID = 0x3537

/** Private vendor interface. NEVER match on productId — it varies by color/mode. */
export const VENDOR_USAGE_PAGE = 0xfff0
export const VENDOR_USAGE = 0x40

export const REPORT_LENGTH = 64

/** Chunk payload size for profile read/write (64 - 6 header bytes). */
export const OUT_CHUNK = 58

// ---------------------------------------------------------------------------
// Report IDs
// ---------------------------------------------------------------------------

/** OUT — host → device command. */
export const REPORT_COMMAND = 0x0f
/** IN  — device → host command response. */
export const REPORT_RESPONSE = 0x10
/** IN  — live input / status stream (~500 Hz). */
export const REPORT_INPUT = 0x12

// ---------------------------------------------------------------------------
// Command subcodes (byte 1 of an OUT report)
// ---------------------------------------------------------------------------

export const Cmd = {
  EnterProfileConfig: 0x01,
  ExitProfileConfig: 0x02,
  WriteProfile: 0x03,
  ReadProfile: 0x04,
  SwitchProfile: 0x07,
  ReadFirmwareVersion: 0x09,
  ReadCurrentProfile: 0x0b,
  ReadRGB: 0x0d,
  RefreshProfile: 0x10,
  MacroRecord: 0x16,
  QuickUpdate: 0x17,
  Rumble: 0x20,
  Extended: 0xe2,
  Heartbeat: 0xf2,
  EnterUpgrade: 0xfc,
  Calibration: 0xfd,
  /**
   * `[0x0F, 0xFE, calType, partMask]` — per-part calibration. **This is the one
   * the G7 Pro CE proxy sends**; {@link Cmd.Calibration} (`0xFD`) is the other
   * device families' builder. See PROTOCOL.md §12.6.
   */
  CalibrateParts: 0xfe
} as const

// ---------------------------------------------------------------------------
// Response types (byte 1 of an IN 0x10 report)
// ---------------------------------------------------------------------------

export const Resp = {
  EnterProfileConfig: 1,
  ExitProfileConfig: 2,
  WriteProfile: 3,
  ReadProfile: 4,
  ReadProfileAck: 5,
  Ack: 6,
  SwitchProfile: 7,
  WriteProfileToEEPRom: 8,
  ReadFirmwareVersion: 9,
  ReadFirmwareVersionAck: 10,
  ReadCurrentProfile: 11,
  ReadCurrentProfileAck: 12,
  ReadRGB: 13,
  ReadRGBAck: 14,
  ProfileChanged: 15,
  RefreshProfile: 16,
  RefreshProfileAck: 17,
  WriteEEPRom: 18,
  WriteEEPRomAck: 19,
  ReadEEPRom: 20,
  ReadEEPRomAck: 21,
  Download: 240,
  DownloadAck: 241,
  Heartbeat: 242,
  ReadKeyStatus: 243,
  ReadKeyStatusAck: 244,
  RequestToUpgrade: 252,
  /** Fixed id for report 0x12 live input. */
  Unknown: 0
} as const

export type ResponseName = keyof typeof Resp

// ---------------------------------------------------------------------------
// Profile indices
// ---------------------------------------------------------------------------

export const Profile = {
  /** User profiles 1–4. */
  Min: 1,
  Max: 4,
  Shift: 5,
  /** Light/RGB profile — 169 bytes, not 1070. */
  Light: 32,
  CurrentSelector: 48
} as const

// ---------------------------------------------------------------------------
// Profile blob geometry (total 1070)
// ---------------------------------------------------------------------------

export const PROFILE_LENGTH = 1070
export const LIGHT_PROFILE_LENGTH = 169

export const SECTION = {
  Name: { offset: 0x000, length: 32 },
  FunData: { offset: 0x020, length: 32 },
  /** 16 standard buttons × 7 bytes. */
  KeyProfiles: { offset: 0x040, length: 112 },
  /** 4 function keys × 169 bytes (FL1, FR1, FL2, FR2). */
  FunctionKeys: { offset: 0x0b0, length: 676 },
  /** 2 triggers × 32 bytes (L2, R2). */
  Triggers: { offset: 0x354, length: 64 },
  /** 2 sticks × 36 bytes (Left, Right). */
  Sticks: { offset: 0x394, length: 72 },
  /** 2 motion sensors × 41 bytes (Aim, Tilt). */
  Motion: { offset: 0x3dc, length: 82 }
} as const

export const PACKET = {
  Name: 32,
  FunData: 32,
  Mapping: 7,
  FunctionKey: 169,
  Trigger: 32,
  Stick: 36,
  Sensor: 41
} as const

export const MACRO_STEP_MAX = 32

// ---------------------------------------------------------------------------
// Button order
// ---------------------------------------------------------------------------

/** Standard buttons: 7-byte mapping packets (profile offset 0x040). */
export const STANDARD_BUTTONS = [
  'Up', 'Under', 'Left', 'Right',
  'L1', 'R1', 'L3', 'R3',
  'CRO', 'CIR', 'SQU', 'TRI',
  'PS', 'Sel', 'Sta', 'Camera'
] as const

/** Function keys: 169-byte packets with macro storage. */
export const FUNCTION_KEYS = ['FL1', 'FR1', 'FL2', 'FR2'] as const

/** Triggers: 32-byte packets with deadzone + hair trigger. */
export const TRIGGERS = ['L2', 'R2'] as const

/** Sticks: 36-byte packets. */
export const STICKS = ['Left', 'Right'] as const

/** Motion sensors: 41-byte packets. */
export const MOTION_SENSORS = ['Aim', 'Tilt'] as const

export type StandardButton = (typeof STANDARD_BUTTONS)[number]
export type FunctionKey = (typeof FUNCTION_KEYS)[number]
export type TriggerName = (typeof TRIGGERS)[number]

/**
 * Remap indices (§10) of the four function keys — the `keyIndex` byte of `0x16`.
 *
 * FL2/FR2 are **not** 19 and 20. The `PROFILE_INDEX_*` table the command builder
 * looks names up in puts them at 31 and 32, inside the "Ext 1–9" range, while
 * 19 and 20 are L2 and R2. Using 19/20 would tell the pad to record into a
 * trigger.
 *
 * All four are now confirmed on hardware (`tests/macrorec.ts`): each index sent
 * as `0x16 <index> 1` lights byte 53 of the input report with exactly that
 * value, so the pad reads this table as documented. That includes 31 and 32,
 * which GameSir's own key table for G7ProCE does **not** contain — from the
 * source alone `getKeyMapValue("FL2")` returns `0`, so those two are never
 * sent. See PROTOCOL.md §12.1.
 */
export const FUNCTION_KEY_INDEX: Record<FunctionKey, number> = {
  FL1: 17,
  FR1: 18,
  FL2: 31,
  FR2: 32
}
export type StickName = (typeof STICKS)[number]
export type MotionName = (typeof MOTION_SENSORS)[number]

// ---------------------------------------------------------------------------
// Command builders — return a padded 64-byte report ready for hid.write()
// ---------------------------------------------------------------------------

function report(...bytes: number[]): number[] {
  const out = new Array<number>(REPORT_LENGTH).fill(0)
  out[0] = REPORT_COMMAND
  for (let i = 0; i < bytes.length && i < REPORT_LENGTH; i++) out[i + 1] = bytes[i]
  return out
}

/** Split a 16-bit offset into big-endian hi/lo. */
function offset16(offset: number): [number, number] {
  return [(offset >> 8) & 0xff, offset & 0xff]
}

export function heartbeat(n = 0): number[] {
  return report(Cmd.Heartbeat, n)
}

export function enterProfileConfig(): number[] {
  return report(Cmd.EnterProfileConfig)
}

export function exitProfileConfig(save = true): number[] {
  return report(Cmd.ExitProfileConfig, save ? 1 : 0)
}

export function readFirmwareVersion(): number[] {
  return report(Cmd.ReadFirmwareVersion)
}

export function readCurrentProfile(): number[] {
  return report(Cmd.ReadCurrentProfile)
}

export function switchProfile(profile: number): number[] {
  return report(Cmd.SwitchProfile, profile)
}

export function rumble(left: number, right: number): number[] {
  // Magic 0x66 0x55 identifies the motor command (from gamesir-linux-tools).
  return report(Cmd.Rumble, 0x66, 0x55, clamp8(left), clamp8(right))
}

export function readRGB(): number[] {
  return report(Cmd.ReadRGB)
}

/**
 * Control the lighting animation.
 *
 * From GameSir Connect's `getSetLightStatusCommand(isPlaying, frameIndex)`:
 *   [0x0F, 0x0D, isPlaying ? 1 : 0, frameIndex]
 *
 * Brightness and colours live in the light profile (169 bytes, index 32),
 * not in this command.
 */
export function setLightStatus(isPlaying: boolean, frameIndex: number): number[] {
  return report(Cmd.ReadRGB, isPlaying ? 1 : 0, clamp8(frameIndex))
}

/**
 * Start or stop macro recording for one key.
 *
 *   [0x0F, 0x16, keyIndex, state]
 *
 * `keyIndex` is a §10 remap index (see {@link FUNCTION_KEY_INDEX}); `state`
 * is 1 = start, 0 = stop. Built exactly as GameSir's `Mm()` does for this pad.
 *
 * Fire-and-forget: this pad does not answer with type 23 `MacroStatusAck` —
 * only the K2_8K proxy parses that — so nothing may wait on a reply, which is
 * the same reason calibration writes are not awaited either.
 */
export function macroRecord(keyIndex: number, state: number): number[] {
  return report(Cmd.MacroRecord, keyIndex, state)
}

/**
 * `[0x0F, 0x17, 0x55, 0x88]` — **firmware update**, not a macro commit.
 *
 * Its only caller in GameSir Connect dispatches `setIsManualUpdating` and sits
 * beside `reqDfu`. Exposed here so it can be used by the DFU path and by
 * nothing else; see PROTOCOL.md §12.3.
 */
export function quickUpdate(): number[] {
  return report(Cmd.QuickUpdate, 0x55, 0x88)
}

export function calibrationState(state: number): number[] {
  return report(Cmd.Calibration, state)
}

/**
 * Parts of the pad a calibration can be scoped to — `partMask` of
 * {@link calibrateParts}, built from GameSir's `reqToCalibrate` handler for the
 * G7 Pro CE proxy. Bit for bit, this is the same field the pad reports back in
 * byte 32 of the input report (§5).
 */
export const CalPart = {
  LeftStick: 1 << 0,
  RightStick: 1 << 1,
  LeftTrigger: 1 << 2,
  RightTrigger: 1 << 3,
  Motion: 1 << 4,
  Sticks: (1 << 0) | (1 << 1),
  Triggers: (1 << 2) | (1 << 3)
} as const

/**
 * Sub-commands of {@link calibrateParts}, from GameSir's `SubCommand` enum.
 *
 * `Complete` **commits** — it is the step that writes whatever the sticks were
 * doing as the new reference. Never send it without deciding first that the
 * current position is what should be saved; `Cancel` discards instead.
 */
export const CalSub = {
  Enter: 0,
  Complete: 1,
  Cancel: 2
} as const

/**
 * `[0x0F, 0xFE, calType, partMask]` — per-part calibration.
 *
 * This is the report GameSir's **G7 Pro CE** proxy builds in `reqToCalibrate`:
 * it derives `partMask` from a `calPart` string (`sticks` → bits 0|1,
 * `triggers` → bits 2|3, `motion` → bit 4, `triggers_sticks` → 0..3) and writes
 * it immediately with no Ack, same as {@link calibrationState}.
 *
 * The pad answers in the input report rather than the command stream: byte 31
 * carries the calibration mode and byte 32 the part bitmask — the same two
 * offsets its fine-calibration session calls `statusTargetOffset` and
 * `statusStepOffset`. See PROTOCOL.md §12.6.
 */
export function calibrateParts(calType: number, partMask: number): number[] {
  return report(Cmd.CalibrateParts, calType, partMask)
}

export function enterUpgradeMode(): number[] {
  return report(Cmd.EnterUpgrade)
}

/** Read a chunk of a profile. `length` is clamped to OUT_CHUNK. */
export function readProfileChunk(profile: number, offset: number, length: number): number[] {
  const [hi, lo] = offset16(offset)
  return report(Cmd.ReadProfile, profile, hi, lo, Math.min(length, OUT_CHUNK))
}

/** Read every chunk needed to pull a whole profile. */
export function readProfileCommands(profile: number, total = PROFILE_LENGTH): number[][] {
  const cmds: number[][] = []
  for (let offset = 0; offset < total; offset += OUT_CHUNK) {
    cmds.push(readProfileChunk(profile, offset, Math.min(OUT_CHUNK, total - offset)))
  }
  return cmds
}

/** Write a profile chunk. Returns the padded report (data lives at bytes 6..63). */
export function writeProfileChunk(
  profile: number,
  offset: number,
  data: Uint8Array
): number[] {
  const [hi, lo] = offset16(offset)
  const len = Math.min(data.length, OUT_CHUNK)
  const out = report(Cmd.WriteProfile, profile, hi, lo, len)
  for (let i = 0; i < len; i++) out[6 + i] = data[i] & 0xff
  return out
}

/** Split a profile into write reports. */
export function writeProfileCommands(
  profile: number,
  data: Uint8Array,
  baseOffset = 0
): number[][] {
  const cmds: number[][] = []
  for (let i = 0; i < data.length; i += OUT_CHUNK) {
    const slice = data.subarray(i, Math.min(i + OUT_CHUNK, data.length))
    cmds.push(writeProfileChunk(profile, baseOffset + i, slice))
  }
  return cmds
}

function clamp8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface ParsedResponse {
  type: number
  /** Derived type name — resolves ReadProfileComplete / ReadAudioAck / AckWithBusy. */
  name: string
  raw: Uint8Array
}

/** Map a raw response to its logical type, applying the derived cases. */
export function parseResponse(raw: Uint8Array): ParsedResponse {
  if (raw.length < 2) return { type: -1, name: 'Unknown', raw }
  const type = raw[1]

  let name = responseName(type)

  if (type === Resp.ReadProfileAck) {
    const profile = raw[2]
    const total =
      profile === Profile.Light ? LIGHT_PROFILE_LENGTH : PROFILE_LENGTH
    const end = 256 * raw[3] + raw[4] + raw[5]

    // Special audio probe: offset 0, length 40, marker 5.
    if (raw[6] === 0 && raw[7] === 40 && raw[8] === 5) {
      name = 'ReadAudioAck'
    } else if (end === total) {
      name = 'ReadProfileComplete'
    }
  } else if (type === Resp.Ack && raw[2] === 1) {
    name = 'AckWithBusy'
  }

  return { type, name, raw }
}

function responseName(type: number): string {
  for (const [key, value] of Object.entries(Resp)) {
    if (value === type) return key
  }
  return 'Unknown'
}

/** Extract profile chunk payload (data begins at byte 6). */
export function profileChunkPayload(raw: Uint8Array): {
  profile: number
  offset: number
  data: Uint8Array
} {
  const profile = raw[2]
  const offset = 256 * raw[3] + raw[4]
  const length = raw[5]
  return { profile, offset, data: raw.subarray(6, 6 + length) }
}

/**
 * Decode the firmware version report. GameSir stores it as UTF-16LE starting
 * at byte 2 (live device returned `30 00 32 00 32 00 39 00` → "0229").
 */
export function parseFirmwareVersion(raw: Uint8Array): { firmware: string; dongle: string } {
  const read16 = (start: number, end: number): string => {
    let out = ''
    for (let i = start; i + 1 < end && i + 1 < raw.length; i += 2) {
      const code = raw[i] | (raw[i + 1] << 8)
      if (code === 0) break
      out += String.fromCharCode(code)
    }
    return out
  }
  return { firmware: read16(2, 12), dongle: read16(12, 22) }
}

// ---------------------------------------------------------------------------
// Option tables — labels lifted from GameSir Connect's own renderer bundle
// ---------------------------------------------------------------------------

/**
 * Report-rate gears. The profile stores a gear index (Fun_Data +14), never Hz;
 * GameSir's `reportRateList` supplies the labels, and they differ per model:
 *
 *   G7ProS  `[{250Hz,0},{500Hz,1},{1000Hz,2}]`
 *   default `[{250Hz,0},{1000Hz,2},{4000Hz,4},{8000Hz,5}]`
 *
 * Gear 3 carries no label anywhere in their bundle. 2000 Hz is the only value
 * completing the doubling 250/500/1000/…/4000/8000 — and a different device in
 * the same bundle uses a literal `2000Hz` — so it is offered but flagged
 * `confirmed: false` until checked against the measured input rate.
 *
 * Note the pad reports gear 5 (8000 Hz) while emitting input at ~500 Hz, so the
 * gear likely selects the USB poll interval rather than the state rate. Switch
 * gear and watch the Diagnostics chart to confirm.
 */
export const REPORT_RATE_OPTIONS: ReadonlyArray<{
  gear: number
  hz: number
  confirmed: boolean
}> = [
  { gear: 0, hz: 250, confirmed: true },
  { gear: 1, hz: 500, confirmed: true },
  { gear: 2, hz: 1000, confirmed: true },
  { gear: 3, hz: 2000, confirmed: false },
  { gear: 4, hz: 4000, confirmed: true },
  { gear: 5, hz: 8000, confirmed: true }
]

/**
 * Stick ADC resolution. GameSir shows a step size rather than a bit count —
 * `["256","128","64","32","<16"]`, i.e. 2^16 / 2^bits — so index 0 is 8-bit and
 * index 4 is 12-bit. `step` is that divisor; their label for 12-bit is "<16".
 */
export const STICK_RESOLUTION_OPTIONS: ReadonlyArray<{ bits: number; step: number }> = [
  { bits: 8, step: 256 },
  { bits: 9, step: 128 },
  { bits: 10, step: 64 },
  { bits: 11, step: 32 },
  { bits: 12, step: 16 }
]
