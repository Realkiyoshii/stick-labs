/**
 * Protocol session on top of the HID transport.
 *
 * Owns:
 *   - request/response matching (a predicate + timeout per outstanding request)
 *   - enter/exit config sequencing
 *   - whole-profile reads and writes (19 chunks at 58 bytes)
 *   - decoding the 0x12 input report into a usable state object
 */
import { Transport, discover } from './hid'
import {
  PROFILE_LENGTH,
  LIGHT_PROFILE_LENGTH,
  Profile as ProfileIndex,
  calibrateParts,
  CalPart,
  enterProfileConfig,
  exitProfileConfig,
  macroRecord,
  parseFirmwareVersion,
  parseResponse,
  profileChunkPayload,
  readCurrentProfile,
  readFirmwareVersion,
  readProfileCommands,
  readRGB,
  rumble,
  setLightStatus,
  switchProfile,
  writeProfileCommands,
  type ParsedResponse
} from '../shared/protocol'

/** Outcome of a write that was read back rather than trusted. */
export interface WriteVerification {
  /** The pad's read-back matched the bytes we sent. */
  verified: boolean
  /** The write did not land, and the previous bytes were restored instead. */
  rolledBack: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Attempts the read-back will make before giving up, and the gap between them. */
const READ_BACK_ATTEMPTS = 4
const READ_BACK_RETRY_MS = 900

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export interface LiveInput {
  lx: number
  ly: number
  rx: number
  ry: number
  lt: number
  rt: number
  /** raw[5..], so `buttons[0]` is raw[5]. */
  buttons: Uint8Array
  battery: number
  charging: boolean
  dpad: number
  /** False for placeholder frames from an idle receiver. */
  live: boolean
  timestamp: number
}

export interface DeviceInfo {
  firmware: string
  dongle: string
  currentProfile: number
}

export type ControllerState = 'disconnected' | 'connecting' | 'ready' | 'error'

interface Pending {
  match: (parsed: ParsedResponse) => boolean
  resolve: (raw: Uint8Array) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_TIMEOUT = 2500

export class Controller {
  readonly transport = new Transport()

  private pending: Pending[] = []
  private inputListeners = new Set<(input: LiveInput) => void>()
  private lastInput: LiveInput | null = null
  /** Tearing down the previous decoder wiring; see `attachInputDecoder`. */
  private decoderOff: (() => void) | null = null

  state: ControllerState = 'disconnected'

  constructor() {
    this.transport.onResponse((raw) => this.dispatch(raw))
    this.transport.onError(() => this.failAll(new Error('device disconnected')))
  }

  get isOpen(): boolean {
    return this.transport.isOpen
  }

  get latestInput(): LiveInput | null {
    return this.lastInput
  }

  onInput(fn: (input: LiveInput) => void): () => void {
    this.inputListeners.add(fn)
    return () => this.inputListeners.delete(fn)
  }

  /**
   * Open and initialise a device: enter config mode, read identity.
   * Reads are ignored by the firmware until config mode is entered, so this
   * must happen before anything else.
   */
  async connect(path: string): Promise<DeviceInfo> {
    this.state = 'connecting'
    this.transport.open(path)
    this.transport.startHeartbeat(500)

    try {
      await this.request(enterProfileConfig(), (p) => p.type === 6, 3000)

      const fwRaw = await this.request(readFirmwareVersion(), (p) => p.type === 10, 3000)
      const { firmware, dongle } = parseFirmwareVersion(fwRaw)

      const currentRaw = await this.request(readCurrentProfile(), (p) => p.type === 12, 3000)

      this.state = 'ready'
      return { firmware, dongle, currentProfile: currentRaw[2] }
    } catch (err) {
      this.state = 'error'
      this.transport.close()
      throw err
    }
  }

  /** Drop config mode. Safe to call even if we never entered it. */
  async exitConfig(save = true): Promise<void> {
    if (!this.transport.isOpen) return
    try {
      await this.request(exitProfileConfig(save), (p) => p.type === 6, 2000)
    } catch {
      // Device may already have left config; not fatal.
    }
  }

  disconnect(): void {
    this.failAll(new Error('disconnected'))
    this.transport.close()
    this.state = 'disconnected'
  }

  // -------------------------------------------------------------------------
  // Request / response
  // -------------------------------------------------------------------------

  /**
   * Send a command and wait for the first response satisfying `match`.
   *
   * Responses arrive on the transport's single read loop interleaved with the
   * ~500 Hz input flood, so each outstanding request carries its own predicate
   * rather than assuming responses come back in order.
   */
  request(
    report: number[],
    match: (parsed: ParsedResponse) => boolean,
    timeout = DEFAULT_TIMEOUT
  ): Promise<Uint8Array> {
    if (!this.transport.isOpen) {
      return Promise.reject(new Error('device not open'))
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const entry: Pending = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.pending.indexOf(entry)
          if (i >= 0) this.pending.splice(i, 1)
          reject(
            new Error(
              `timed out waiting for response to cmd 0x${(report[1] ?? 0).toString(16)}` +
                ` (report 0x${(report[0] ?? 0).toString(16)})`
            )
          )
        }, timeout)
      }
      this.pending.push(entry)

      try {
        this.transport.write(report)
      } catch (err) {
        clearTimeout(entry.timer)
        const i = this.pending.indexOf(entry)
        if (i >= 0) this.pending.splice(i, 1)
        reject(err as Error)
      }
    })
  }

  private dispatch(raw: Uint8Array): void {
    const parsed = parseResponse(raw)

    for (let i = 0; i < this.pending.length; i++) {
      const entry = this.pending[i]
      if (entry.match(parsed)) {
        this.pending.splice(i, 1)
        clearTimeout(entry.timer)
        entry.resolve(raw)
        return
      }
      // Unmatched responses are dropped — stale acks from earlier commands.
    }
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.splice(0)) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
  }

  // -------------------------------------------------------------------------
  // Profile I/O
  // -------------------------------------------------------------------------

  /**
   * Read a whole profile blob. Requires config mode.
   *
   * Each 58-byte chunk is retried (4 attempts): a single dropped response
   * used to fail the entire 1070-byte read with `timed out waiting for
   * response to cmd 0x4`, even when the pad answers the retry immediately.
   */
  async readProfile(profile: number, total = PROFILE_LENGTH): Promise<Uint8Array> {
    const out = new Uint8Array(total)

    for (const cmd of readProfileCommands(profile, total)) {
      const wanted = 256 * cmd[3] + cmd[4]
      let lastError: Error = new Error('device not open')
      let done = false
      for (let attempt = 0; attempt < 4 && !done; attempt++) {
        if (attempt > 0) await sleep(300)
        try {
          const raw = await this.request(
            cmd,
            (p) =>
              p.type === 5 &&
              profileChunkPayload(p.raw).profile === profile &&
              profileChunkPayload(p.raw).offset === wanted,
            3000
          )
          const { offset, data } = profileChunkPayload(raw)
          out.set(data, offset)
          this.transport.heartbeat()
          done = true
        } catch (err) {
          lastError = err as Error
        }
      }
      if (!done) throw lastError
    }
    return out
  }

  /** Write a profile blob in chunks, waiting for each ack before the next. */
  async writeProfile(
    profile: number,
    data: Uint8Array,
    expectedLength = PROFILE_LENGTH
  ): Promise<void> {
    if (data.length !== expectedLength) {
      throw new Error(`profile payload is ${data.length} bytes, expected ${expectedLength}`)
    }

    for (const cmd of writeProfileCommands(profile, data)) {
      // Firmware answers Ack (6); some revisions answer WriteProfile (3).
      await this.request(cmd, (p) => p.type === 6 || p.type === 3, 3000)
      this.transport.heartbeat()
    }
  }

  /** Light/RGB profile — a separate 169-byte blob at index 32. */
  readLightProfile(): Promise<Uint8Array> {
    return this.readProfile(ProfileIndex.Light, LIGHT_PROFILE_LENGTH)
  }

  /**
   * Write a profile and prove it landed — the shipping write path.
   *
   * Every profile write is an EEPROM write, and §7.1 of PROTOCOL.md shows the
   * pad drops its `0x10C5` interface when a change is applied live. So this:
   *
   *   1. reads the current bytes **first** — they are the only rollback source
   *      there is, and a failed read refuses the write outright rather than
   *      proceeding blind
   *   2. writes
   *   3. reads back, re-opening the handle if the pad rebooted underneath us
   *   4. on a mismatch, puts the original bytes back and proves *that* too
   *
   * A rollback that also fails to verify throws rather than returning, because
   * at that point the slot's contents are genuinely unknown.
   */
  async writeProfileVerified(
    profile: number,
    data: Uint8Array,
    length = PROFILE_LENGTH
  ): Promise<WriteVerification> {
    let before: Uint8Array
    try {
      before = await this.readProfile(profile, length)
    } catch (err) {
      throw new Error(
        `refusing to write profile ${profile}: could not read it first to keep a ` +
          `rollback copy (${(err as Error).message})`
      )
    }

    await this.writeProfile(profile, data, length)

    const after = await this.readBack(profile, length)
    if (bytesEqual(after, data)) return { verified: true, rolledBack: false }

    await this.writeProfile(profile, before, length)
    const restored = await this.readBack(profile, length)
    if (!bytesEqual(restored, before)) {
      throw new Error(
        `profile ${profile} did not verify and the rollback did not either — ` +
          're-read the profile before writing again'
      )
    }
    return { verified: false, rolledBack: true }
  }

  /**
   * Read a profile, surviving the handle being yanked away.
   *
   * A mid-operation failure leaves a handle that is open but will never answer,
   * so each failed attempt closes it and forces a full re-discovery rather than
   * burning the remaining chunk timeouts against a dead device.
   */
  private async readBack(profile: number, length: number): Promise<Uint8Array> {
    let lastError: Error = new Error('device not open')

    for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        this.transport.close()
        await sleep(READ_BACK_RETRY_MS)
      }
      try {
        if (!this.transport.isOpen) await this.reopen()
        return await this.readProfile(profile, length)
      } catch (err) {
        lastError = err as Error
      }
    }
    throw lastError
  }

  /**
   * Re-discover and re-handshake after the pad re-enumerates.
   *
   * Emits `reopened` on the transport so the caller (which owns the watchdog and
   * input decoder wiring) can re-arm anything torn down by the drop.
   */
  private async reopen(): Promise<void> {
    let lastError: Error = new Error('controller disappeared')

    for (const candidate of discover()) {
      try {
        await this.connect(candidate.path)
        if (this.transport.isOpen) {
          this.transport.emit('reopened')
          return
        }
      } catch (err) {
        lastError = err as Error
        this.transport.close()
      }
    }
    throw lastError
  }

  async readFirmware(): Promise<string> {
    const raw = await this.request(readFirmwareVersion(), (p) => p.type === 10, 3000)
    return parseFirmwareVersion(raw).firmware
  }

  async getCurrentProfile(): Promise<number> {
    const raw = await this.request(readCurrentProfile(), (p) => p.type === 12, 3000)
    return raw[2]
  }

  async switchProfile(profile: number): Promise<void> {
    await this.request(switchProfile(profile), (p) => p.type === 6 || p.type === 7, 3000)
  }

  async readRGB(): Promise<Uint8Array> {
    const raw = await this.request(readRGB(), (p) => p.type === 13 || p.type === 14, 3000)
    return raw.slice(2)
  }

  vibrate(left: number, right: number): void {
    if (!this.transport.isOpen) return
    this.transport.write(rumble(left, right))
  }

  /**
   * Play or pause the lighting animation — `0x0F 0x0D <isPlaying> <frame>`.
   *
   * Fire-and-forget for the same reason calibration is: GameSir's G7ProCE proxy
   * hands `getSetLightStatusCommand` straight to `writeImmediately`, a bare
   * `hidDevice.write()`, so no Ack is on the way. Awaiting one would cost 2 s
   * per lighting change and then throw on a pad that had accepted the command
   * the whole time.
   *
   * The opcode reads back the current state when sent without a payload —
   * that is why GameSir's name for it is `getSet`, and why `readRGB()` and
   * this produce the same bytes.
   */
  setLightStatus(isPlaying: boolean, frameIndex: number): void {
    if (!this.transport.isOpen) {
      throw new Error('device not open')
    }
    this.transport.write(setLightStatus(isPlaying, frameIndex))
  }

  /**
   * Drive calibration: `0x0F 0xFE <calType> <partMask>` — **not** `0x0F 0xFD`.
   *
   * `calType` is `CalSub`: 0 enter, 1 commit, 2 cancel. `partMask` is `CalPart`
   * and this pad echoes it back byte-for-byte in byte 31 of the input report
   * while calibration is in force, 0 when it is not — so "did it hear me" is
   * observable without touching a stick (PROTOCOL.md §12.6,
   * `tests/calibration.ts`).
   *
   * The `0x0F 0xFD` form this used to send is GameSir's *other* device
   * families' `getSetCalibrationStateCommand`. On this pad both `0` and `2` of
   * it were observed to do nothing at all, while the button still reported
   * success — a fire-and-forget write cannot tell "accepted" from "ignored",
   * which is exactly why the state is read back from the input report now.
   *
   * Fire-and-forget on purpose: GameSir hands its own build straight to
   * `writeImmediately`, a bare `hidDevice.write()` with no acknowledgement.
   * Awaiting one costs the full timeout on every call and then throws on a pad
   * that had accepted the command the whole time — what the previous
   * implementation did.
   *
   * `calType` 1 (**Complete**) writes the current stick and trigger positions
   * as the new reference. Calibration data is not part of the profile blob, so
   * unlike a profile write there is no fixture to restore it from — callers
   * must only send it when those positions are deliberately the desired ones.
   *
   * Throws rather than silently returning when the handle is gone, because the
   * UI needs to distinguish "sent" from "nothing happened".
   */
  calibration(state: number, partMask: number = CalPart.Sticks | CalPart.Triggers): void {
    if (!this.transport.isOpen) {
      throw new Error('device not open')
    }
    this.transport.write(calibrateParts(state, partMask))
  }

  /**
   * Tell the pad macro recording has started (`state` 1) or stopped (`0`).
   *
   * Fire-and-forget for the same reason calibration is: this pad never answers
   * with type 23 `MacroStatusAck`, so awaiting a reply would cost a timeout
   * every time and still not confirm anything.
   *
   * The recorded steps themselves are captured by the renderer from the input
   * stream and written into the packet the normal way — see PROTOCOL.md §12.1.
   */
  macroRecord(keyIndex: number, state: number): void {
    if (!this.transport.isOpen) {
      throw new Error('device not open')
    }
    this.transport.write(macroRecord(keyIndex, state))
  }

  // -------------------------------------------------------------------------
  // Input decoding
  // -------------------------------------------------------------------------

  /**
   * Wire the transport's input stream into decoded LiveInput events.
   *
   * Idempotent: the transport keeps its subscriber set across `close()`/`open()`,
   * and `device:connect` calls this again on every reconnect — without dropping
   * the previous wiring, the Nth reconnect would decode every frame N times and
   * quietly inflate every rate the UI derives from it.
   */
  attachInputDecoder(): () => void {
    this.decoderOff?.()
    const off = this.transport.onInput((raw) => {
      const input = decodeInput(raw)
      if (!input) return
      this.lastInput = input
      for (const fn of this.inputListeners) fn(input)
    })
    this.decoderOff = off
    return off
  }
}

/**
 * Decode a 0x12 input report.
 *
 * Byte layout (from g7pro/src/protocol.rs, itself based on
 * gamesir-linux-tools enhanced.py):
 *   [1] lx  [2] ly  [3] rx  [4] ry
 *   [5] dpad nibble | X/A/B/Y in bits 4–7
 *   [6] LB RB LTdigital RTdigital View Menu LS RS
 *   [8] lt  [9] rt
 *   [35] charging bit 0   [36] battery %
 *   [60] Home Share (bit3) L4 (bit4) R4 (bit5) M
 *
 * `buttons` is raw[5..] so callers index it as `buttons[i] === raw[5 + i]`.
 */
export function decodeInput(raw: Uint8Array): LiveInput | null {
  if (raw.length <= 60 || raw[0] !== 0x12) return null

  const lx = raw[1]
  const ly = raw[2]
  const rx = raw[3]
  const ry = raw[4]
  const battery = raw[36]

  return {
    lx,
    ly,
    rx,
    ry,
    lt: raw[8],
    rt: raw[9],
    buttons: raw.slice(5),
    battery,
    charging: (raw[35] & 0x01) !== 0,
    dpad: raw[5] & 0x0f,
    /**
     * A placeholder frame from an idle receiver has all-zero sticks — which
     * collides with dpad value 0 (Up), so filter on liveness explicitly.
     */
    live: lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || battery !== 0,
    timestamp: Date.now()
  }
}

/** Dpad nibble → direction label; 8/15/out-of-range = neutral. */
export const DPAD_LABELS = [
  'Up',
  'Up-Right',
  'Right',
  'Down-Right',
  'Down',
  'Down-Left',
  'Left',
  'Up-Left'
] as const

export function dpadLabel(nibble: number): string | null {
  if (nibble === 8 || nibble === 15 || nibble > 7) return null
  return DPAD_LABELS[nibble]
}
