/**
 * Flydigi Apex 5 vendor HID (MI_02, 0xFFA0/0x01) on node-hid. The codec in
 * shared/flydigi.ts only builds reads. Kept out of hid.ts discover() so the
 * GameSir auto-reconnect never handshakes it.
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import { createFdSession, isFdIdentity, type FdPort } from '../shared/flydigi'

export function discoverFlydigi(): Array<{ path: string; productId: number; preferred: boolean; product: string | undefined; manufacturer: string | undefined; live: boolean }> {
  let devices: HIDModule.Device[] = []
  try { devices = HIDModule.devices() } catch { /* no HID stack */ }
  return devices
    .filter((d) => typeof d.path === 'string' && isFdIdentity(d))
    // The vendor interface only answers requests, so liveness is taken from presence.
    .map((d) => ({ path: d.path as string, productId: d.productId, preferred: true, product: d.product?.trim(), manufacturer: d.manufacturer, live: true }))
}

async function openNodePort(path: string): Promise<FdPort> {
  if (!discoverFlydigi().some((d) => d.path === path)) throw new Error('flydigi: not a Flydigi vendor interface')
  let handle: HIDInstance
  try {
    handle = new HIDModule.HID(path)
  } catch (err) {
    throw new Error(`flydigi: cannot open device (close Flydigi Space Station first) — ${(err as Error).message}`)
  }
  return {
    // Numbered reports: the frame already starts with report id 0x03.
    async write(frame) { handle.write(frame) },
    async read(timeoutMs) {
      const raw = handle.readTimeout(timeoutMs)
      return raw && raw.length ? Array.from(raw) : null
    },
    async close() { handle.close() }
  }
}

export const flydigiSession = createFdSession(openNodePort)
