/**
 * Low-level HID transport for the GameSir vendor interface.
 *
 * Responsibilities:
 *   - discover candidate interfaces (never match on productId)
 *   - pick the interface that actually has a live pad behind it
 *   - own the single node-hid handle and its read loop
 *   - classify incoming reports (0x10 command response vs 0x12 input)
 *
 * Protocol/session logic lives in controller.ts.
 */
import { EventEmitter } from 'node:events'
import HIDModule, { type Device, type HID as HIDInstance } from 'node-hid'
import {
  REPORT_INPUT,
  REPORT_LENGTH,
  REPORT_RESPONSE,
  VENDOR_ID,
  VENDOR_USAGE,
  VENDOR_USAGE_PAGE
} from '../shared/protocol'

export interface Candidate {
  path: string
  productId: number
  /** Heuristic: 0x10c5/0x10c6 look like the wired pad rather than a receiver. */
  preferred: boolean
  product: string | undefined
  manufacturer: string | undefined
}

export interface DeviceStats {
  inputFrames: number
  responses: number
  /** Measured input report rate, Hz. */
  rateHz: number
  /** True once a frame with non-zero stick data has been seen. */
  live: boolean
}

interface ReportedInput {
  reportId: number
  data: Uint8Array
}

/** Matches the receiver-vs-pad ambiguity in the wild. */
const PREFERRED_PIDS = new Set([
  0x10c5, 0x10c6, 0x10b7, 0x10b9, 0x10cd, 0x10ce,
  // G7 Pro (G7ProS): wired/wireless, black/white
  0x0908, 0x0909, 0x0921, 0x0922,
  // Tarantula (T3CE)
  0x103d, 0x10ff, 0x090d
])

function listDevices(): Device[] {
  try {
    return HIDModule.devices()
  } catch {
    return []
  }
}

/** All vendor interfaces, no handle opened. */
export function discover(): Candidate[] {
  return listDevices()
    .filter(
      (d) =>
        typeof d.path === 'string' &&
        d.path.length > 0 &&
        d.vendorId === VENDOR_ID &&
        d.usagePage === VENDOR_USAGE_PAGE &&
        d.usage === VENDOR_USAGE
    )
    .map((d) => ({
      path: d.path as string,
      productId: d.productId,
      preferred: PREFERRED_PIDS.has(d.productId),
      product: d.product,
      manufacturer: d.manufacturer
    }))
    // Preferred first, but callers still verify liveness.
    .sort((a, b) => Number(b.preferred) - Number(a.preferred))
}

export class Transport extends EventEmitter {
  private handle: HIDInstance | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private statsTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null

  private path: string | null = null
  private frameCount = 0
  private responseCount = 0
  private lastRateWindow = 0
  private lastRateAt = 0
  private live = false
  private bytes = new Uint8Array(REPORT_LENGTH)

  // Named `subs`, not `listeners` — EventEmitter already owns that name.
  private subs: {
    response: Set<(raw: Uint8Array) => void>
    input: Set<(raw: Uint8Array) => void>
    error: Set<(err: Error) => void>
  } = { response: new Set(), input: new Set(), error: new Set() }

  get isOpen(): boolean {
    return this.handle !== null
  }

  get currentPath(): string | null {
    return this.path
  }

  get stats(): DeviceStats {
    return {
      inputFrames: this.frameCount,
      responses: this.responseCount,
      rateHz: this.currentRate,
      live: this.live
    }
  }

  private currentRate = 0

  onResponse(fn: (raw: Uint8Array) => void): () => void {
    this.subs.response.add(fn)
    return () => this.subs.response.delete(fn)
  }

  onInput(fn: (raw: Uint8Array) => void): () => void {
    this.subs.input.add(fn)
    return () => this.subs.input.delete(fn)
  }

  onError(fn: (err: Error) => void): () => void {
    this.subs.error.add(fn)
    return () => this.subs.error.delete(fn)
  }

  /**
   * Open an interface and start streaming.
   * Throws if the handle cannot be opened (e.g. PermissionDenied — another
   * app such as GameSir Connect already holds it).
   */
  open(path: string): void {
    if (this.handle) this.close()

    const handle = new HIDModule.HID(path)
    this.handle = handle
    this.path = path
    this.frameCount = 0
    this.responseCount = 0
    this.live = false
    this.lastRateAt = Date.now()
    this.lastRateWindow = 0

    handle.on('data', (raw: Buffer) => this.handleFrame(raw))
    handle.on('error', (err: Error) => {
      this.emit('device-error', err)
      for (const fn of this.subs.error) fn(err)
      this.close()
      this.emit('disconnected', err)
    })

    // Measure input rate once a second.
    this.statsTimer = setInterval(() => {
      const now = Date.now()
      const elapsed = (now - this.lastRateAt) / 1000
      if (elapsed > 0) {
        this.currentRate = Math.round((this.frameCount - this.lastRateWindow) / elapsed)
      }
      this.lastRateWindow = this.frameCount
      this.lastRateAt = now
      this.emit('stats', this.stats)
    }, 1000)
  }

  /** Send a raw 64-byte command report. */
  write(report: number[] | Uint8Array): void {
    if (!this.handle) throw new Error('device not open')
    const buf = Buffer.alloc(REPORT_LENGTH)
    const source = report instanceof Uint8Array ? report : new Uint8Array(report)
    buf.set(source.subarray(0, REPORT_LENGTH))
    // Emit before the write so the log shows intent even if the write throws.
    this.emit('tx', Array.from(source.subarray(0, 8)))
    this.handle.write(buf)
  }

  /** Send the heartbeat. Call every 500 ms to keep the command channel alive. */
  heartbeat(): void {
    if (!this.handle) return
    try {
      this.write([0x0f, 0xf2, 0x00])
    } catch {
      /* device going away — the error handler will fire */
    }
  }

  startHeartbeat(intervalMs = 500): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs)
    this.heartbeat()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  /**
   * Watchdog: if nothing arrives for `silenceMs`, the handle is stale
   * (USB re-enumeration after a power cycle invalidates it).
   */
  startWatchdog(silenceMs = 4000, onSilence: () => void): void {
    this.stopWatchdog()
    let last = this.frameCount + this.responseCount
    this.watchdogTimer = setInterval(() => {
      const now = this.frameCount + this.responseCount
      if (now === last) onSilence()
      last = now
    }, silenceMs)
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
  }

  close(): void {
    this.stopHeartbeat()
    this.stopWatchdog()
    if (this.statsTimer) clearInterval(this.statsTimer)
    this.statsTimer = null

    const handle = this.handle
    this.handle = null
    this.path = null
    if (!handle) return
    try {
      handle.removeAllListeners()
      handle.close()
    } catch {
      /* already gone */
    }
  }

  private handleFrame(raw: Buffer): void {
    if (raw.length === 0) return

    // Copy into a stable view — node-hid reuses its internal buffer.
    const view = this.bytes.length === raw.length ? this.bytes : new Uint8Array(raw.length)
    view.set(raw)

    if (view[0] === REPORT_INPUT) {
      this.frameCount++
      if (view[1] || view[2] || view[3] || view[4]) this.live = true
      for (const fn of this.subs.input) fn(view)
    } else if (view[0] === REPORT_RESPONSE) {
      this.responseCount++
      const copy = view.slice()
      for (const fn of this.subs.response) fn(copy)
    }
    // Anything else is unexpected — surfaced by callers if needed.
  }
}
