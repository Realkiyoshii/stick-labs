// Review-before-Write: a readable summary of what a staged profile changes
// compared with the bytes last read from (or verified on) the pad.
import { parseProfile, stick, type Packet, type Profile } from './profile'

export interface ReviewItem {
  /** i18n key for the row label. */
  key: string
  /** 0 = left stick, 1 = right stick; absent for whole-profile sections. */
  stick?: 0 | 1
  from?: string
  to?: string
}

const CURVE_MODES = ['linear', 'smooth', 'delay', 'custom']

function mode(p: Packet): string {
  const lm = stick.linearModule(p)
  const type = lm.en && lm.type <= 3 ? lm.type : 0
  return type === 1 || type === 2 ? `${CURVE_MODES[type]}:${lm.rate}` : CURVE_MODES[type]
}

const pct = (v: number): string => `${(v / 10).toFixed(1)}%`
const points = (p: Packet): string => stick.curve(p).map((q) => `${q.x}/${q.y}`).join(' · ')
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** Sections other than the sticks, reported by name only. */
const SECTIONS: Array<{ key: string; pick: (p: Profile) => Uint8Array[] }> = [
  { key: 'review.name', pick: (p) => [new TextEncoder().encode(p.name)] },
  { key: 'review.device', pick: (p) => [p.funData.bytes] },
  { key: 'review.buttons', pick: (p) => p.buttons.map((b) => b.bytes) },
  { key: 'review.functionKeys', pick: (p) => p.functionKeys.map((b) => b.bytes) },
  { key: 'review.triggers', pick: (p) => p.triggers.map((b) => b.bytes) },
  { key: 'review.motion', pick: (p) => p.motion.map((b) => b.bytes) },
  { key: 'review.other', pick: (p) => [p.tail] }
]

export function describeProfileChanges(before: Uint8Array, after: Uint8Array, modelId: string): ReviewItem[] {
  const a = parseProfile(before, modelId)
  const b = parseProfile(after, modelId)
  const items: ReviewItem[] = []
  for (const s of [0, 1] as const) {
    const pa = a.sticks[s]
    const pb = b.sticks[s]
    if (!pa || !pb || same(pa.bytes, pb.bytes)) continue
    const da = stick.deadzone(pa)
    const db = stick.deadzone(pb)
    const before0 = items.length
    if (mode(pa) !== mode(pb)) items.push({ key: 'review.curveMode', stick: s, from: mode(pa), to: mode(pb) })
    if (points(pa) !== points(pb)) items.push({ key: 'review.curvePoints', stick: s, from: points(pa), to: points(pb) })
    if (da.begin !== db.begin || da.end !== db.end) {
      items.push({ key: 'review.deadzone', stick: s, from: `${pct(da.begin)}–${pct(da.end)}`, to: `${pct(db.begin)}–${pct(db.end)}` })
    }
    if (da.beginAnti !== db.beginAnti || da.endAnti !== db.endAnti) {
      items.push({ key: 'review.output', stick: s, from: `${pct(da.beginAnti)}–${pct(da.endAnti)}`, to: `${pct(db.beginAnti)}–${pct(db.endAnti)}` })
    }
    if (stick.axisScale(pa) !== stick.axisScale(pb)) {
      items.push({ key: 'review.axisScale', stick: s, from: String(stick.axisScale(pa)), to: String(stick.axisScale(pb)) })
    }
    if (items.length === before0) items.push({ key: 'review.stickOther', stick: s })
  }
  for (const section of SECTIONS) {
    const xa = section.pick(a)
    const xb = section.pick(b)
    if (xa.length !== xb.length || xa.some((v, i) => !same(v, xb[i]))) items.push({ key: section.key })
  }
  return items
}
