/**
 * LeadJoy Saber Plus / Xeno Pro family session (MI_04, usage page 0xFF80/0001)
 * on node-hid. The protocol logic lives in shared/leadjoy-session.ts so the
 * browser build runs the same frames over WebHID; this file only adapts
 * node-hid's synchronous handle. Trigger writes remain disabled until live
 * hardware proof is recorded.
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import { createLjSession, type LjPort } from '../shared/leadjoy-session'

export type { LjButtonWriteResult } from '../shared/leadjoy-session'

function toArray(raw: unknown): number[] {
  if (raw instanceof Buffer) return Array.from(raw.values())
  if (raw instanceof Uint8Array) return Array.from(raw)
  if (Array.isArray(raw)) return raw.map((v) => Number(v) & 0xff)
  throw new Error('leadjoy: unexpected report shape')
}

async function openNodePort(path: string): Promise<LjPort> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('leadjoy: refusing without a device path')
  }
  let handle: HIDInstance
  try {
    handle = new HIDModule.HID(path)
  } catch (err) {
    throw new Error(`leadjoy: cannot open device (close the LeadJoy app first) — ${(err as Error).message}`)
  }
  return {
    async write(frame) {
      handle.write([0x00, ...frame])
    },
    async read(timeoutMs) {
      let raw: unknown
      try {
        raw = handle.readTimeout(timeoutMs)
      } catch (err) {
        throw new Error(`leadjoy: read failed — ${(err as Error).message}`)
      }
      return raw === null || raw === undefined ? null : toArray(raw)
    },
    async close() {
      handle.close()
    }
  }
}

export const leadjoySession = createLjSession(openNodePort)
export const {
  ljReadSnapshot,
  ljReadMainSnapshot,
  ljWriteButtonVerified,
  ljReadButtonTable,
  ljWriteStickVerified,
  ljReadStickSide
} = leadjoySession
