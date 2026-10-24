/**
 * WebHID transport — the browser counterpart of `src/main/hid.ts`.
 *
 * Same contract as the Electron Transport (isOpen/currentPath/stats, open,
 * close, write, heartbeat, onResponse/onInput/onError, on/emit events), but
 * backed by `navigator.hid`, which only exists in Chromium browsers.
 *
 * The browser only reveals devices the user has already granted in its picker,
 * so a "path" here is a synthetic handle into a registry rather than a device
 * path string. Chromium's picker is also the only way to discover anything, so
 * `discoverWeb()` falls back to the picker when nothing is granted yet — it
 * needs a user gesture (the Rescan button) and quietly does nothing without one.
 *
 * Wire shape is identical to Electron: reports are REPORT_LENGTH bytes with the
 * report id in byte 0 (node-hid's layout), which WebHID splits into
 * `sendReport(id, data)` on the way out and `event.reportId + event.data` in.
 */
import { REPORT_LENGTH, REPORT_INPUT, REPORT_RESPONSE, VENDOR_ID, VENDOR_USAGE, VENDOR_USAGE_PAGE } from '@shared/protocol'
import type { Candidate } from '../renderer/api'
import type { LjPort } from '@shared/leadjoy-session'
import { HS_IDENTITIES, HS_USAGE, HS_USAGE_PAGE, type HsPort } from '@shared/hyperstrike'
import { FD_USAGE, FD_USAGE_PAGE, FD_VENDOR_ID, type FdPort } from '@shared/flydigi'

// --- minimal WebHID typings (lib.dom ships none) ----------------------------
interface HidInputReportEvent extends Event {
  reportId: number
  data: DataView
}
interface HidDeviceLike {
  vendorId: number
  productId: number
  productName?: string
  manufacturerName?: string
  collections?: Array<{ usagePage?: number; usage?: number }>
  opened: boolean
  open(): Promise<void>
  close(): Promise<void>
  sendReport(reportId: number, data: BufferSource): Promise<void>
  addEventListener(type: 'inputreport', listener: (e: HidInputReportEvent) => void): void
  removeEventListener(type: 'inputreport', listener: (e: HidInputReportEvent) => void): void
}
interface HidLike {
  getDevices(): Promise<HidDeviceLike[]>
  requestDevice(options: {
    filters: Array<{ vendorId?: number; productId?: number; usagePage?: number; usage?: number }>
  }): Promise<HidDeviceLike[]>
}

function hidApi(): HidLike | null {
  const nav = navigator as unknown as { hid?: HidLike }
  return nav.hid ?? null
}

/**
 * The vendor config interfaces this app drives: GameSir 0xFFF0/0x40, LeadJoy
 * 0xFF80/0x01, and the HyperStrike Driver interface 0xFF60/0x61 under each of
 * its USB-mode identities (XInput, DS4, Switch, PS4).
 */
export const WEB_HID_FILTERS = [
  { vendorId: VENDOR_ID, usagePage: VENDOR_USAGE_PAGE, usage: VENDOR_USAGE },
  { vendorId: 0x4131, usagePage: 0xff80, usage: 0x01 },
  ...HS_IDENTITIES.map((i) => ({ vendorId: i.vendorId, productId: i.productId, usagePage: HS_USAGE_PAGE, usage: HS_USAGE })),
  { vendorId: FD_VENDOR_ID, usagePage: FD_USAGE_PAGE, usage: FD_USAGE }
]

/** A granted device is the HyperStrike Driver interface (any USB mode). */
function isHyperStrike(device: HidDeviceLike): boolean {
  return HS_IDENTITIES.some((i) => i.vendorId === device.vendorId && i.productId === device.productId) &&
    (device.collections ?? []).some((c) => c.usagePage === HS_USAGE_PAGE && c.usage === HS_USAGE)
}

/** A granted device is the Flydigi vendor interface (Apex 5). */
function isFlydigi(device: HidDeviceLike): boolean {
  return device.vendorId === FD_VENDOR_ID && (device.collections ?? []).some((c) => c.usagePage === FD_USAGE_PAGE && c.usage === FD_USAGE)
}

/** Only GameSir pads may be handed to the GameSir session (connect / auto-reconnect). */
export const isGameSirPath = (path: string): boolean => path.startsWith(`webhid:${VENDOR_ID.toString(16)}:`)

const registry = new Map<string, HidDeviceLike>()
/** Open ports per device: a second port (e.g. the Flydigi live listener next to a write) must not close the first one's device. */
const openCount = new Map<HidDeviceLike, number>()
let pathSeq = 0

function pathFor(device: HidDeviceLike): string {
  for (const [path, known] of registry) if (known === device) return path
  const path = `webhid:${device.vendorId.toString(16)}:${device.productId.toString(16)}:${pathSeq++}`
  registry.set(path, device)
  return path
}

function toCandidate(device: HidDeviceLike, path: string): Candidate {
  return {
    path,
    productId: device.productId,
    // The user chose this device in the picker, so it is wanted as much as any
    // other granted pad — auto-reconnect may take the first one it finds.
    preferred: true,
    // In DS4/Switch/PS4 mode the HyperStrike borrows those pads' names; label it by its Driver interface.
    product: isHyperStrike(device) ? 'HyperStrike' : device.productName?.trim(),
    manufacturer: device.manufacturerName,
    live: null
  }
}

/**
 * Granted pads. With none granted yet, this raises the browser's device picker;
 * that only succeeds inside a user gesture, so callers that must not prompt
 * (the automatic refresh on load) simply get an empty list.
 */
export async function discoverWeb(): Promise<Candidate[]> {
  const hid = hidApi()
  if (!hid) {
    throw new Error('WebHID is unavailable — use Chrome or Edge, over https:// or localhost')
  }
  let devices = await hid.getDevices()
  // Inside a click (Rescan) also offer the picker, so a second pad — or the
  // HyperStrike under a new USB-mode identity — can be granted next to the first.
  const gesture = (navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation?.isActive === true
  if (devices.length === 0 || gesture) {
    try {
      const picked = await hid.requestDevice({ filters: WEB_HID_FILTERS })
      devices = [...devices, ...picked.filter((d) => !devices.includes(d))]
    } catch {
      /* no user gesture — the Rescan button retries with one */
    }
  }
  return devices.map((device) => toCandidate(device, pathFor(device)))
}

/**
 * LeadJoy port over WebHID, matching the node-hid adapter in main/leadjoy.ts:
 * unnumbered 64-byte reports (report id 0), queued input, open per session.
 */
export async function openLjPort(path: string): Promise<LjPort> {
  return openQueuedPort(path, 'leadjoy', 'the LeadJoy app')
}

/** HyperStrike Driver interface over WebHID: same unnumbered 64-byte frames as node-hid. */
export async function openHsPort(path: string): Promise<HsPort> {
  const device = registry.get(path)
  if (device && !isHyperStrike(device)) throw new Error('hyperstrike: not a HyperStrike Driver interface')
  return openQueuedPort(path, 'hyperstrike', 'HyperStrike Hub')
}

/** Flydigi vendor interface over WebHID: numbered 32-byte reports (OUT id 3, IN id 4), report id kept in the frame like node-hid. */
export async function openFdPort(path: string): Promise<FdPort> {
  const device = registry.get(path)
  if (device && !isFlydigi(device)) throw new Error('flydigi: not a Flydigi vendor interface')
  return openQueuedPort(path, 'flydigi', 'Flydigi Space Station', true)
}

async function openQueuedPort(path: string, tag: string, vendorApp: string, numbered = false): Promise<LjPort & HsPort & FdPort> {
  const device = registry.get(path)
  if (!device) throw new Error(`${tag}: device is no longer granted — pick it again in the browser prompt`)
  try {
    if (!device.opened) await device.open()
    openCount.set(device, (openCount.get(device) ?? 0) + 1)
  } catch (err) {
    throw new Error(`${tag}: cannot open device (close ${vendorApp} first) — ${(err as Error).message}`)
  }
  const queue: number[][] = []
  let waiter: ((bytes: number[] | null) => void) | null = null
  const onReport = (e: HidInputReportEvent): void => {
    const data = Array.from(new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength))
    const bytes = numbered ? [e.reportId, ...data] : data
    if (waiter) {
      const w = waiter
      waiter = null
      w(bytes)
    } else queue.push(bytes)
  }
  device.addEventListener('inputreport', onReport)
  return {
    async write(frame) {
      if (numbered) await device.sendReport(frame[0], Uint8Array.from(frame.slice(1)))
      else await device.sendReport(0, Uint8Array.from(frame))
    },
    read(timeoutMs) {
      const next = queue.shift()
      if (next) return Promise.resolve(next)
      return new Promise((resolve) => {
        const timer = setTimeout(() => { waiter = null; resolve(null) }, timeoutMs)
        waiter = (bytes) => { clearTimeout(timer); resolve(bytes) }
      })
    },
    async close() {
      device.removeEventListener('inputreport', onReport)
      if (waiter) { const w = waiter; waiter = null; w(null) }
      const left = (openCount.get(device) ?? 1) - 1
      openCount.set(device, left)
      if (left <= 0) await device.close()
    }
  }
}

export interface WebDeviceStats {
  inputFrames: number
  responses: number
  rateHz: number
  live: boolean
}

export class WebHidTransport {
  private device: HidDeviceLike | null = null
  private path: string | null = null
  private opening: Promise<void> | null = null
  private frameCount = 0
  private responseCount = 0
  private currentRate = 0
  private lastRateWindow = 0
  private lastRateAt = 0
  private live = false
  private heartbeatTimer: number | null = null
  private statsTimer: number | null = null
  private watchdogTimer: number | null = null
  private bytes = new Uint8Array(REPORT_LENGTH)

  private subs: {
    response: Set<(raw: Uint8Array) => void>
    input: Set<(raw: Uint8Array) => void>
    error: Set<(err: Error) => void>
  } = { response: new Set(), input: new Set(), error: new Set() }

  private events = new Map<string, Set<(...args: unknown[]) => void>>()

  get isOpen(): boolean {
    return this.device !== null && this.device.opened
  }

  get currentPath(): string | null {
    return this.path
  }

  get stats(): WebDeviceStats {
    return {
      inputFrames: this.frameCount,
      responses: this.responseCount,
      rateHz: this.currentRate,
      live: this.live
    }
  }

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

  /** Subscribe to transport events ('stats', 'disconnected', …). */
  on(event: string, fn: (...args: unknown[]) => void): () => void {
    const set = this.events.get(event) ?? new Set()
    set.add(fn)
    this.events.set(event, set)
    return () => set.delete(fn)
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.events.get(event) ?? []) fn(...args)
  }

  /**
   * Open a granted interface. Async where Electron's is sync (the controller
   * awaits it), and throws when the device cannot be opened — another app such
   * as GameSir Connect holding it, or the permission having been revoked.
   */
  async open(path: string): Promise<void> {
    this.close()
    const device = registry.get(path)
    if (!device) {
      throw new Error('device is no longer granted — pick it again in the browser prompt')
    }
    this.device = device
    this.path = path
    this.frameCount = 0
    this.responseCount = 0
    this.live = false
    this.lastRateAt = Date.now()
    this.lastRateWindow = 0

    this.opening = device.open().then(() => {
      device.addEventListener('inputreport', this.handleReport)
      this.statsTimer = window.setInterval(() => {
        const now = Date.now()
        const elapsed = (now - this.lastRateAt) / 1000
        if (elapsed > 0) {
          this.currentRate = Math.round((this.frameCount - this.lastRateWindow) / elapsed)
        }
        this.lastRateWindow = this.frameCount
        this.lastRateAt = now
        this.emit('stats', this.stats)
      }, 1000)
    })
    try {
      await this.opening
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.device = null
      this.path = null
      this.opening = null
      throw error
    }
  }

  /** Send a raw 64-byte command report (byte 0 = report id). */
  write(report: number[] | Uint8Array): void {
    const device = this.device
    if (!device || !this.opening) throw new Error('device not open')
    const bytes = report instanceof Uint8Array ? report : new Uint8Array(report)
    const reportId = bytes[0] ?? 0
    const payload = bytes.slice(1, REPORT_LENGTH)
    // Emit before the write so a log shows intent even if the write fails.
    this.emit('tx', Array.from(bytes.subarray(0, 8)))
    void this.opening
      .then(() => device.sendReport(reportId, payload))
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        for (const fn of this.subs.error) fn(error)
      })
  }

  /** Keep the command channel alive (same frame Electron sends). */
  heartbeat(): void {
    if (!this.device) return
    try {
      this.write([0x0f, 0xf2, 0x00])
    } catch {
      /* device going away — the caller's error path will fire */
    }
  }

  startHeartbeat(intervalMs = 500): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), intervalMs)
    this.heartbeat()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  /**
   * Watchdog: no frames for `silenceMs` means the handle is stale (a USB
   * re-enumeration after a live write invalidates it).
   */
  startWatchdog(silenceMs = 4000, onSilence: () => void): void {
    this.stopWatchdog()
    let last = this.frameCount + this.responseCount
    this.watchdogTimer = window.setInterval(() => {
      const now = this.frameCount + this.responseCount
      if (now === last) onSilence()
      last = now
    }, silenceMs)
  }

  stopWatchdog(): void {
    if (this.watchdogTimer !== null) window.clearInterval(this.watchdogTimer)
    this.watchdogTimer = null
  }

  close(): void {
    this.stopHeartbeat()
    this.stopWatchdog()
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer)
    this.statsTimer = null

    const device = this.device
    this.device = null
    this.path = null
    this.opening = null
    if (!device) return
    try {
      device.removeEventListener('inputreport', this.handleReport)
      void device.close().catch(() => undefined)
    } catch {
      /* already gone */
    }
  }

  private handleReport = (event: HidInputReportEvent): void => {
    const view = this.bytes
    view.fill(0)
    view[0] = event.reportId
    const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
    view.set(data.subarray(0, REPORT_LENGTH - 1), 1)

    if (view[0] === REPORT_INPUT) {
      this.frameCount++
      if (view[1] || view[2] || view[3] || view[4]) this.live = true
      for (const fn of this.subs.input) fn(view)
    } else if (view[0] === REPORT_RESPONSE) {
      this.responseCount++
      const copy = view.slice()
      for (const fn of this.subs.response) fn(copy)
    }
  }
}
