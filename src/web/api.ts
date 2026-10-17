/**
 * Browser build of the renderer bridge.
 *
 * In Electron this surface is `src/preload/index.ts` (IPC) + `src/main/index.ts`
 * (the holders). Here the same `LabApi` runs in the page: the GameSir session
 * (`src/main/controller.ts` — Node-free) sits on the WebHID transport instead of
 * node-hid, and the event glue below mirrors `main/index.ts` one-for-one so the
 * renderer needs no changes at all.
 *
 * Deliberately not available in the browser (they need the OS):
 *   - steamInfo/steamExport/steamGames/steamExportAll (Steam config folders)
 *   - deeppoll (kernel ETW trace)
 *   - ping (desktop round-trip harness)
 * LeadJoy support is the next stage; those calls say so plainly rather than
 * pretending.
 */
import { Controller } from '../main/controller'
import type { DeepPollResult } from '@shared/deeppoll'
import type { LjButtonTarget, LjSnapshot, LjStickPatch } from '@shared/leadjoy'
import type { LiveSample } from '../renderer/api'
import { WebHidTransport, discoverWeb } from './hid'

// The Controller only ever touches the transport surface both classes share.
const transport = new WebHidTransport()
// Sync candidate cache for the controller's reopen() — refreshed by discovery.
let knownPaths: ReadonlyArray<{ path: string }> = []
const controller = new Controller(
  transport as unknown as ConstructorParameters<typeof Controller>[0],
  () => knownPaths
)

type Listener = (payload: never) => void
const listeners = new Map<string, Set<Listener>>()

function send(channel: string, payload?: unknown): void {
  for (const fn of listeners.get(channel) ?? []) fn(payload as never)
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms))

// --- event glue (mirrors src/main/index.ts) ---------------------------------

const INPUT_SAMPLE_MS = 33
let lastSampleAt = 0
let samplePending = false

controller.onInput(() => {
  const now = Date.now()
  const emit = (): void => {
    lastSampleAt = Date.now()
    const input = controller.latestInput
    if (input) send('input:sample', input)
  }
  if (now - lastSampleAt < INPUT_SAMPLE_MS) {
    if (samplePending) return
    samplePending = true
    window.setTimeout(() => {
      samplePending = false
      emit()
    }, INPUT_SAMPLE_MS)
    return
  }
  emit()
})

transport.on('stats', (stats) => send('device:stats', stats))

let reconnecting = false
let sessionEpoch = 0

/**
 * The pad drops its USB interface for ~1-2 s when a change is applied live.
 * Chromium keeps the permission, so the device reappears in getDevices() and the
 * same auto-reconnect as the desktop build is possible.
 */
async function autoReconnect(reason: string): Promise<void> {
  if (reconnecting) return
  reconnecting = true
  const epoch = sessionEpoch
  try {
    send('device:reconnecting', reason)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (epoch !== sessionEpoch || transport.isOpen) return
      await sleepMs(800)
      if (epoch !== sessionEpoch || transport.isOpen) return
      const cands = await discoverWeb().catch(() => [])
      const target = cands.find((c) => c.preferred) ?? cands[0]
      if (!target) continue
      await sleepMs(600)
      if (epoch !== sessionEpoch || transport.isOpen) return
      try {
        const info = await controller.connect(target.path)
        controller.attachInputDecoder()
        transport.startWatchdog(4000, () => void autoReconnect('silent'))
        send('device:reconnected', info)
        return
      } catch {
        /* keep trying until the deadline */
      }
    }
    send('device:stale', transport.currentPath)
  } finally {
    reconnecting = false
  }
}

transport.on('disconnected', (err) => {
  void autoReconnect((err as Error)?.message ?? 'disconnected')
})

// --- the bridge --------------------------------------------------------------

const NOT_IN_BROWSER =
  'Not available in the browser build — this needs the desktop app (it reads local files or kernel traces).'

const basis = {
  discover: async () => {
    const found = await discoverWeb()
    knownPaths = found
    return found
  },
  connect: async (path: string) => {
    sessionEpoch++
    const info = await controller.connect(path)
    controller.attachInputDecoder()
    transport.startWatchdog(4000, () => void autoReconnect('silent'))
    return info
  },
  disconnect: async () => {
    sessionEpoch++
    controller.disconnect()
    return true
  },
  readProfile: async (profile: number, total?: number) => {
    const bytes = await controller.readProfile(profile, total)
    return { bytes: bytesToB64(bytes), length: bytes.length }
  },
  writeProfile: async (profile: number, dataB64: string, length?: number) =>
    controller.writeProfileVerified(profile, b64ToBytes(dataB64), length),
  switchProfile: (profile: number) => controller.switchProfile(profile).then(() => true),
  currentProfile: () => controller.getCurrentProfile(),
  calibration: (state: number, partMask?: number, mode?: number) =>
    Promise.resolve(controller.calibration(state, partMask, mode)),
  setStickCenter: (stick: number, direction: number) =>
    controller.nudgeCenter(stick, direction).then(() => true),
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener')
    return Promise.resolve(true)
  },
  version: () => Promise.resolve('web'),
  steamInfo: () => Promise.reject(new Error(NOT_IN_BROWSER)),
  steamExport: () => Promise.reject(new Error(NOT_IN_BROWSER)),
  steamGames: () => Promise.reject(new Error(NOT_IN_BROWSER)),
  steamExportAll: () => Promise.reject(new Error(NOT_IN_BROWSER)),
  ping: () => Promise.reject(new Error(NOT_IN_BROWSER)),
  deeppoll: () => Promise.reject(new Error(NOT_IN_BROWSER)) as Promise<DeepPollResult>,
  leadjoyReadMain: () => Promise.reject(new Error('LeadJoy support is landing next in the browser build.')),
  leadjoyReadSlot: () => Promise.reject(new Error('LeadJoy support is landing next in the browser build.')),
  leadjoyWriteButton: (_req: { path: string; slot: number; id: number; target: LjButtonTarget | null }) =>
    Promise.reject(new Error('LeadJoy support is landing next in the browser build.')),
  leadjoyWriteStick: (_req: { path: string; slot: number; side: number; patch: LjStickPatch }) =>
    Promise.reject(new Error('LeadJoy support is landing next in the browser build.')),
  on: (channel: string, fn: Listener): (() => void) => {
    const set = listeners.get(channel) ?? new Set<Listener>()
    set.add(fn)
    listeners.set(channel, set)
    return () => set.delete(fn)
  }
}

function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export type WebStickLabApi = typeof basis

/** Install the bridge on `window.sticklab` before the app mounts. */
export function installWebApi(): void {
  ;(window as unknown as { sticklab: WebStickLabApi }).sticklab = basis
}

export type { LiveSample }
