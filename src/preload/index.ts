import { contextBridge, ipcRenderer } from 'electron'
import type { DeepPollResult } from '../shared/deeppoll'
import type { LjButtonTarget, LjSnapshot, LjStickPatch } from '../shared/leadjoy'
import type { HsCalStep, HsCalType, HsEdit, HsSnapshot, HsWriteResult } from '../shared/hyperstrike'
import type { FdEdit, FdLive, FdSnapshot } from '../shared/flydigi'

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as {
    ok: boolean
    data?: T
    error?: string
  }
  if (!result?.ok) throw new Error(result?.error ?? `${channel} failed`)
  return result.data as T
}

const api = {
  discover: () =>
    call<Array<{ path: string; productId: number; preferred: boolean; product: string | undefined; manufacturer: string | undefined; live: boolean | null }>>('device:discover'),
  connect: (path: string) =>
    call<{ firmware: string; dongle: string; currentProfile: number }>('device:connect', path),
  disconnect: () => call<boolean>('device:disconnect'),
  readProfile: (profile: number, total?: number) => call<{ bytes: string; length: number }>('profile:read', profile, total),
  writeProfile: (profile: number, dataB64: string, length?: number) =>
    call<{ verified: boolean; rolledBack: boolean }>('profile:write', profile, dataB64, length),
  switchProfile: (profile: number) => call<boolean>('profile:switch', profile),
  currentProfile: () => call<number>('profile:current'),
  calibration: (state: number, partMask?: number, mode?: number) =>
    call<boolean>('device:calibration', state, partMask, mode),
  setStickCenter: (stick: number, direction: number) => call<boolean>('device:stickCenter', stick, direction),
  openExternal: (url: string) => call<boolean>('system:openExternal', url),
  version: () => call<string>('system:version'),
  youtubeLive: () => call<{ live: boolean; url: string | null }>('system:youtubeLive'),
  setUnsaved: (state: { dirty: boolean; hide?: { message: string; detail: string; confirm: string; cancel: string }; quit?: { message: string; detail: string; confirm: string; cancel: string } }) =>
    call<boolean>('system:setUnsaved', state),
  updateStatus: () =>
    call<{ state: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'; version?: string; percent?: number; message?: string }>('update:status'),
  updateCheck: () => call<boolean>('update:check'),
  updateInstall: () => call<boolean>('update:install'),
  steamInfo: () =>
    call<{ steamPath: string | null; userId: string | null; apexInstalled: boolean; apexAppId: number; steamRunning: boolean }>('steam:info'),
  steamExport: (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) =>
    call<{ game: string; appId: number; files: string[]; backedUp: string[]; mapped: string[]; notTransferred: string[] }>('steam:export', left, right, mouseRate, curveExp),
  steamGames: () => call<Array<{ appId: number; name: string }>>('steam:games'),
  steamExportAll: (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) =>
    call<{ games: Array<{ appId: number; name: string }>; result: { games: Array<{ appId: number; name: string; ok: boolean; detail: string }> } }>('steam:exportAll', left, right, mouseRate, curveExp),
  ping: (count: number) =>
    call<{ count: number; samples: number[]; min: number; max: number; median: number; mean: number }>('diag:ping', count),
  deeppoll: (vid: number, pid: number, seconds?: number) =>
    call<DeepPollResult>('diag:deeppoll', vid, pid, seconds),
  leadjoyReadMain: (path: string) => call<LjSnapshot>('leadjoy:readMain', path),
  leadjoyReadSlot: (req: { path: string; slot: number }) => call<LjSnapshot>('leadjoy:readSlot', req),
  leadjoyWriteButton: (req: { path: string; slot: number; id: number; target: LjButtonTarget | null }) =>
    call<{ verified: boolean; restored: boolean }>('leadjoy:writeButton', req),
  leadjoyWriteStick: (req: { path: string; slot: number; side: number; patch: LjStickPatch }) =>
    call<{ verified: boolean; restored: boolean }>('leadjoy:writeStick', req),
  hyperstrikeRead: (path: string) => call<HsSnapshot>('hyperstrike:read', path),
  flydigiRead: (path: string) => call<FdSnapshot>('flydigi:read', path),
  flydigiWrite: (path: string, edit: FdEdit) => call<FdSnapshot>('flydigi:write', path, edit),
  flydigiLive: (path: string) => call<FdLive | null>('flydigi:live', path),
  hyperstrikeWrite: (path: string, edit: HsEdit) => call<HsWriteResult>('hyperstrike:write', path, edit),
  hyperstrikeSwitch: (path: string, index: number) => call<{ snapshot: HsSnapshot | null; reconnecting: boolean }>('hyperstrike:switch', path, index),
  hyperstrikeCalibrate: (path: string, step: HsCalStep, type: HsCalType) => call<void>('hyperstrike:calibrate', path, step, type),
  hyperstrikeCalibrateCenter: (path: string) => call<void>('hyperstrike:calibrateCenter', path),
  hyperstrikeFineTuneRead: (path: string) => call<number[]>('hyperstrike:fineTuneRead', path),
  hyperstrikeFineTuneWrite: (path: string, values: number[]) => call<number[]>('hyperstrike:fineTuneWrite', path, values),
  on: (channel: string, fn: (payload: any) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

export type StickLabApi = typeof api
contextBridge.exposeInMainWorld('sticklab', api)
