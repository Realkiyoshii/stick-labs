import { contextBridge, ipcRenderer } from 'electron'
import type { MariusConfig, MariusIdentity } from '../shared/marius'

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
  adjustCenter: (side: number, direction: import('../shared/center').CenterDirection) => call<boolean>('device:adjustCenter', side, direction),
  calibration: (state: number) => call<boolean>('device:calibration', state),
  openExternal: (url: string) => call<boolean>('system:openExternal', url),
  version: () => call<string>('system:version'),
  steamInfo: () =>
    call<{ steamPath: string | null; userId: string | null; apexInstalled: boolean; apexAppId: number; steamRunning: boolean }>('steam:info'),
  steamExport: (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) =>
    call<{ game: string; appId: number; files: string[]; backedUp: string[]; mapped: string[]; notTransferred: string[] }>('steam:export', left, right, mouseRate, curveExp),
  steamGames: () => call<Array<{ appId: number; name: string }>>('steam:games'),
  steamExportAll: (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) =>
    call<{ games: Array<{ appId: number; name: string }>; result: { games: Array<{ appId: number; name: string; ok: boolean; detail: string }> } }>('steam:exportAll', left, right, mouseRate, curveExp),
  ping: (count: number) =>
    call<{ count: number; samples: number[]; min: number; max: number; median: number; mean: number }>('diag:ping', count),
  mariusDiscover: () =>
    call<Array<{ path: string; productId: number; product: string | undefined; manufacturer: string | undefined }>>('marius:discover'),
  mariusConnect: (path: string) =>
    call<{ identity: MariusIdentity; bInterval: number; pollHz: number }>('marius:connect', path),
  mariusReadConfig: () =>
    call<{ bytes: string; parsed: MariusConfig }>('marius:read'),
  mariusReadRaw: () =>
    call<{ left: { x: number; y: number }; right: { x: number; y: number } }>('marius:raw'),
  mariusDisconnect: () => call<boolean>('marius:disconnect'),
  on: (channel: string, fn: (payload: any) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => fn(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

export type StickLabApi = typeof api
contextBridge.exposeInMainWorld('sticklab', api)
