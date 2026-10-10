/**
 * MARIUS board read-only driver (WebHID/DS4 side) — UNVERIFIED, no hardware yet.
 *
 * Speaks feature reports 0x90/0x91 to VID 0x054C PID 0x05C4 and gates on the
 * family byte, so a real DualShock 4 on the same IDs is refused, never tuned.
 *
 * Deliberately exposes NO write path: no SET_CONFIG, no LUT writes, no BURN,
 * no RESTORE, no REBOOT. Every function here only ever sends commands
 * 0x01/0x02/0x03/0x11/0x70/0x71/0x72 (echo, identity, config read, raw reads).
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import {
  MARIUS_CONFIG_CHUNK,
  MARIUS_CONFIG_LEN,
  MARIUS_ECHO_PAYLOAD,
  MARIUS_HID_PID,
  MARIUS_HID_VID,
  MARIUS_OK,
  MARIUS_REPORT_IN,
  MariusCmd,
  decodeMariusRaw,
  isMariusFamily,
  mariusChunkHeader,
  mariusHidFrame,
  mariusPollHz,
  parseMariusAppInfo,
  parseMariusConfig,
  uidToHex,
  type MariusConfig,
  type MariusIdentity,
} from '../shared/marius'

export interface MariusCandidate {
  path: string
  productId: number
  product: string | undefined
  manufacturer: string | undefined
}

export interface MariusSession {
  identity: MariusIdentity
  /** bInterval echo value. */
  bInterval: number
  pollHz: number
}

const ROUNDTRIP_MS = 3000

/** Every 0x054C:0x05C4 interface — family gate happens after connect. */
export function discoverMarius(): MariusCandidate[] {
  let devices: Array<{ path?: string; vendorId: number; productId: number; product?: string; manufacturer?: string }> = []
  try {
    devices = HIDModule.devices() as typeof devices
  } catch {
    return []
  }
  return devices
    .filter((d) => typeof d.path === 'string' && d.path.length > 0 && d.vendorId === MARIUS_HID_VID && d.productId === MARIUS_HID_PID)
    .map((d) => ({ path: d.path as string, productId: d.productId, product: d.product, manufacturer: d.manufacturer }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export class MariusReader {
  private handle: HIDInstance | null = null
  session: MariusSession | null = null

  get isOpen(): boolean {
    return this.handle !== null
  }

  /**
   * Open + handshake: ECHO must report setup mode 0, then identity must
   * decode to a known Marius family. Anything else throws — including real
   * DualShocks sharing the VID/PID.
   */
  async connect(path: string): Promise<MariusSession> {
    this.close()
    const handle = new HIDModule.HID(path)
    this.handle = handle
    try {
      const echo = await this.feature(MariusCmd.Echo, MARIUS_ECHO_PAYLOAD)
      const mode = echo[0] ?? 0xff
      const bInterval = echo[1] ?? 0
      if (mode !== 0) {
        throw new Error(`not in setup mode (mode=${mode}) — hold PS while plugging USB, per devsetup`)
      }
      const infoRaw = await this.feature(MariusCmd.GetAppInfo, [])
      const uidRaw = await this.feature(MariusCmd.GetUid, [])
      const identity = parseMariusAppInfo(infoRaw, uidToHex(uidRaw))
      if (!isMariusFamily(identity.family)) {
        throw new Error(
          `family byte 0x${identity.familyByte.toString(16)} is not Marius hardware (line=${identity.family.line}) — refusing`
        )
      }
      // Cross-check done above via isMariusFamily — a shared VID/PID with a
      // real DualShock ends here, read-only and untouched.
      this.session = { identity, bInterval, pollHz: mariusPollHz(bInterval) }
      return this.session
    } catch (err) {
      this.close()
      throw err
    }
  }

  /** Full 256-byte config, 57-byte chunks. */
  async readConfig(): Promise<{ bytes: Uint8Array; parsed: MariusConfig }> {
    const out = new Uint8Array(MARIUS_CONFIG_LEN)
    for (let offset = 0; offset < MARIUS_CONFIG_LEN; offset += MARIUS_CONFIG_CHUNK) {
      const len = Math.min(MARIUS_CONFIG_CHUNK, MARIUS_CONFIG_LEN - offset)
      const data = await this.feature(MariusCmd.GetConfig, mariusChunkHeader(offset, len))
      out.set(data.subarray(0, len), offset)
    }
    return { bytes: out, parsed: parseMariusConfig(out) }
  }

  /** Live raw stick samples (12- or 14-bit per family). */
  async readRawSticks(): Promise<{ left: { x: number; y: number }; right: { x: number; y: number } }> {
    const bits = this.session?.identity.family.bits ?? 12
    const l = await this.feature(MariusCmd.ReadJoyLeft, [])
    const r = await this.feature(MariusCmd.ReadJoyRight, [])
    return { left: decodeMariusRaw(l, bits), right: decodeMariusRaw(r, bits) }
  }

  close(): void {
    const h = this.handle
    this.handle = null
    this.session = null
    if (!h) return
    try {
      h.removeAllListeners()
      h.close()
    } catch {
      /* already gone */
    }
  }

  /**
   * One feature-report round trip: send 0x90 [cmd, ...], poll 0x91 until the
   * status byte reads OK. Returns the data bytes (report id + status stripped).
   */
  private async feature(cmd: number, payload: ArrayLike<number>): Promise<Uint8Array> {
    const handle = this.handle
    if (!handle) throw new Error('marius device not open')
    handle.sendFeatureReport(mariusHidFrame(cmd, payload))
    const deadline = Date.now() + ROUNDTRIP_MS
    let lastError = 'no reply'
    while (Date.now() < deadline) {
      await sleep(25)
      let raw: Buffer | number[]
      try {
        raw = handle.getFeatureReport(MARIUS_REPORT_IN, 64) as Buffer | number[]
      } catch (err) {
        lastError = (err as Error).message
        continue
      }
      const bytes = Uint8Array.from(raw)
      if (bytes.length < 2 || bytes[0] !== MARIUS_REPORT_IN) continue
      if (bytes[1] === MARIUS_OK) return bytes.slice(2)
      lastError = `status=0x${(bytes[1] ?? 0).toString(16)}`
      if ((bytes[1] ?? 0) === 0xff) break
    }
    throw new Error(`marius cmd 0x${cmd.toString(16)} failed: ${lastError}`)
  }
}
