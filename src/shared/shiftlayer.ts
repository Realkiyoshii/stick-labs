/**
 * Hold-to-switch curve on GameSir 8K pads, built on the firmware Shift layer.
 *
 * Holding a key mapped to Shift (231) makes the pad use profile 5 (the Shift
 * layer) until it is released. Stick Labs keeps that layer as a copy of the
 * normal profile with only the right-stick curve changed, so holding the key
 * changes the aim curve and nothing else.
 *
 * Storage (proven on T3CE): buttons and back buttons keep map_en at +2 and the
 * value at +3; triggers keep map_en at +11 and the value at +12 — GameSir
 * Connect writes "R2 → Shift" as trigger +11 = 1, +12 = 231.
 */
import { button, parseProfile, serializeProfile, stick, trigger, type Packet, type Profile } from './profile'
import { SHIFT_KEY } from './keymap'

export type HoldKey = 'L2' | 'R2' | 'L1' | 'R1' | 'L4' | 'R4'
export const HOLD_KEYS: readonly HoldKey[] = ['L2', 'R2', 'L1', 'R1', 'L4', 'R4']

/** The packet a hold key lives in, and whether it uses the trigger layout. */
function slotOf(p: Profile, key: HoldKey): { pkt: Packet | undefined; isTrigger: boolean } {
  switch (key) {
    case 'L2': return { pkt: p.triggers[0], isTrigger: true }
    case 'R2': return { pkt: p.triggers[1], isTrigger: true }
    case 'L1': return { pkt: p.buttons[4], isTrigger: false }
    case 'R1': return { pkt: p.buttons[5], isTrigger: false }
    case 'L4': return { pkt: p.functionKeys[0], isTrigger: false }
    case 'R4': return { pkt: p.functionKeys[1], isTrigger: false }
  }
}

const isShift = (pkt: Packet, isTrigger: boolean): boolean =>
  isTrigger ? trigger.mapped(pkt) && trigger.mapValues(pkt)[0] === SHIFT_KEY : button.mapValues(pkt)[0] === SHIFT_KEY

/** Which key (if any) activates the Shift layer in this profile. */
export function holdKeyOf(p: Profile): HoldKey | null {
  for (const key of HOLD_KEYS) {
    const { pkt, isTrigger } = slotOf(p, key)
    if (pkt && isShift(pkt, isTrigger)) return key
  }
  return null
}

/** Clear every Shift mapping (back to the key's own function), then set `key`. */
export function setHoldKey(p: Profile, key: HoldKey | null): void {
  const all = [
    ...p.buttons.map((pkt) => ({ pkt, isTrigger: false })),
    ...p.functionKeys.map((pkt) => ({ pkt, isTrigger: false })),
    ...p.triggers.map((pkt) => ({ pkt, isTrigger: true }))
  ]
  for (const { pkt, isTrigger } of all) {
    if (!isShift(pkt, isTrigger)) continue
    if (isTrigger) trigger.setMap(pkt, [0, 0, 0])
    else button.setMap(pkt, [0, 0, 0])
  }
  if (!key) return
  const { pkt, isTrigger } = slotOf(p, key)
  if (!pkt) return
  if (isTrigger) trigger.setMap(pkt, [SHIFT_KEY, 0, 0])
  else button.setMap(pkt, [SHIFT_KEY, 0, 0])
}

/**
 * The Shift layer for a profile: the same settings with the right-stick
 * curve replaced (5 pad points) and no Shift key of its own.
 */
export function buildShiftLayer(base: Uint8Array, modelId: string, rightCurve: Array<{ x: number; y: number }>): Uint8Array {
  const p = parseProfile(base, modelId)
  p.name = 'Shift'
  setHoldKey(p, null)
  stick.setCurve(p.sticks[1], rightCurve.map((q) => ({ ...q })))
  stick.markCurveIdentity(p.sticks[1])
  return serializeProfile(p)
}
