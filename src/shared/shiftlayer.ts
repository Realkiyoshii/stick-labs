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
import { button, fun, parseProfile, serializeProfile, stick, trigger, type Packet, type Profile } from './profile'
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

/** Own key id of each hold key — output slot 1 when it keeps its normal job. */
export const HOLD_KEY_SELF: Record<HoldKey, number> = { L1: 5, R1: 6, L4: 17, R4: 18, L2: 19, R2: 20 }

const values = (pkt: Packet, isTrigger: boolean): number[] =>
  isTrigger ? (trigger.mapped(pkt) ? trigger.mapValues(pkt) : []) : button.mapValues(pkt)
const isShift = (pkt: Packet, isTrigger: boolean): boolean => values(pkt, isTrigger).includes(SHIFT_KEY)

/** Whether the hold key also keeps its own output (multi-bind "L2 + Shift"). */
export function holdKeepsOriginal(p: Profile, key: HoldKey): boolean {
  const { pkt, isTrigger } = slotOf(p, key)
  return !!pkt && values(pkt, isTrigger).includes(HOLD_KEY_SELF[key])
}

/** Every key that activates the Shift layer in this profile, in HOLD_KEYS order. */
export function holdKeysOf(p: Profile): HoldKey[] {
  return HOLD_KEYS.filter((key) => {
    const { pkt, isTrigger } = slotOf(p, key)
    return !!pkt && isShift(pkt, isTrigger)
  })
}

/** The first key (if any) that activates the Shift layer in this profile. */
export function holdKeyOf(p: Profile): HoldKey | null {
  return holdKeysOf(p)[0] ?? null
}

/** Single-key form of setHoldKeys. */
export function setHoldKey(p: Profile, key: HoldKey | null, keepOriginal = false): void {
  setHoldKeys(p, key ? [key] : [], keepOriginal)
}

/**
 * Clear every Shift mapping (back to the key's own function), then bind each
 * of `keys` to Shift — any of them held activates the layer. With
 * `keepOriginal`, each key is bound to its own output plus Shift (two output
 * slots pressed together) so L2 still aims while it switches layers.
 */
export function setHoldKeys(p: Profile, keys: readonly HoldKey[], keepOriginal = false): void {
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
  // Fun_Data shift_en with shift_value 0 (value 1 is Connect's left stick ↔ D-pad
  // swap, left alone). Set alongside the Shift key; untested whether required.
  if (!keys.length) {
    if (fun.extend.shiftEnable(p.funData) && fun.extend.shiftValue(p.funData) === 0) fun.extend.setShiftEnable(p.funData, false)
    return
  }
  if (!(fun.extend.shiftEnable(p.funData) && fun.extend.shiftValue(p.funData) === 1)) {
    fun.extend.setShiftEnable(p.funData, true)
    fun.extend.setShiftValue(p.funData, 0)
  }
  for (const key of keys) {
    const { pkt, isTrigger } = slotOf(p, key)
    if (!pkt) continue
    const map: [number, number, number] = keepOriginal ? [HOLD_KEY_SELF[key], SHIFT_KEY, 0] : [SHIFT_KEY, 0, 0]
    if (isTrigger) trigger.setMap(pkt, map)
    else button.setMap(pkt, map)
  }
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
