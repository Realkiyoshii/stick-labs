/**
 * HyperStrike Driver HID (MI_02, 0xFF60/0x61) on node-hid. The codec in
 * shared/hyperstrike.ts only builds reads, SET_VALUE and SAVE_FLUSH. Kept out of
 * hid.ts discover() so the GameSir auto-reconnect never handshakes it.
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import { createHsSession, isHsIdentity, type HsPort } from '../shared/hyperstrike'

export function discoverHyperStrike(): Array<{ path: string; productId: number; preferred: boolean; product: string | undefined; manufacturer: string | undefined; live: boolean }> {
  let devices: HIDModule.Device[] = []
  try { devices = HIDModule.devices() } catch { /* no HID stack */ }
  return devices
    // Any USB mode's identity (XInput / DS4 / Switch / PS4) with the Driver interface.
    .filter((d) => typeof d.path === 'string' && isHsIdentity(d))
    // The Driver interface never streams, so liveness is taken from presence.
    .map((d) => ({ path: d.path as string, productId: d.productId, preferred: true, product: 'HyperStrike', manufacturer: d.manufacturer, live: true }))
}

async function openNodePort(path: string): Promise<HsPort> {
  if (!discoverHyperStrike().some((d) => d.path === path)) throw new Error('hyperstrike: not a HyperStrike Driver interface')
  let handle: HIDInstance
  try {
    handle = new HIDModule.HID(path)
  } catch (err) {
    throw new Error(`hyperstrike: cannot open device (close HyperStrike Hub first) — ${(err as Error).message}`)
  }
  return {
    async write(frame) { handle.write([0x00, ...frame]) },
    async read(timeoutMs) {
      const raw = handle.readTimeout(timeoutMs)
      return raw && raw.length ? Array.from(raw) : null
    },
    async close() { handle.close() }
  }
}

export const hyperstrikeSession = createHsSession(openNodePort)
