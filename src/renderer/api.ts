export interface Candidate {
  path: string
  productId: number
  preferred: boolean
  product: string | undefined
  manufacturer: string | undefined
  live: boolean | null
}
export interface DeviceInfo {
  firmware: string
  dongle: string
  currentProfile: number
}
export interface DeviceStats {
  inputFrames: number
  responses: number
  rateHz: number
  live: boolean
}
export interface PingResult {
  count: number
  samples: number[]
  min: number
  max: number
  median: number
  mean: number
}
export interface LiveSample {
  lx: number
  ly: number
  rx: number
  ry: number
  lt: number
  rt: number
  battery: number
  live: boolean
  timestamp: number
}

interface LabApi {
  discover(): Promise<Candidate[]>
  connect(path: string): Promise<DeviceInfo>
  disconnect(): Promise<boolean>
  readProfile(profile: number, total?: number): Promise<{ bytes: string; length: number }>
  writeProfile(profile: number, dataB64: string, length?: number): Promise<{ verified: boolean; rolledBack: boolean }>
  switchProfile(profile: number): Promise<boolean>
  currentProfile(): Promise<number>
  calibration(state: number): Promise<boolean>
  ping(count: number): Promise<PingResult>
  openExternal(url: string): Promise<boolean>
  version(): Promise<string>
  setLanguage(lang: string): Promise<boolean>
  on(channel: string, fn: (payload: never) => void): () => void
}

declare global {
  interface Window {
    sticklab: LabApi
  }
}

export function api(): LabApi {
  if (!window.sticklab) throw new Error('sticklab bridge unavailable')
  return window.sticklab
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
export function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
