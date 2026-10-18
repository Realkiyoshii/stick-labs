/**
 * LeadJoy Saber Plus / Xeno Pro family session (MI_04, usage page 0xFF80/0001).
 *
 * Reads and verified button/stick writes use shared builders proven against
 * vendor captures in tests/leadjoy.ts. Trigger writes remain disabled until
 * live hardware proof is recorded.
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import {
  LJ_REC_BUTTONS_WRITE,
  LJ_REC_STICK_WRITE,
  LJ_REPORT_LEN,
  ljApplyStickPatch,
  ljBoardQuery,
  ljBuildButtonWrite,
  ljBuildSnapshot,
  ljBuildStickWrite,
  ljButtonQuery,
  ljDecodeStream,
  ljFragmentOut,
  ljParseBoard,
  ljParseButtonTable,
  ljParseSingleFrame,
  ljParseStick,
  ljParseTrigger,
  ljParseWriteAck,
  ljReassemble,
  ljStickQuery,
  ljTriggerQuery,
  ljValidateCurveWire,
  ljValidateShape,
  ljVersionQuery,
  type LjButtonRecord,
  type LjButtonTable,
  type LjSlot,
  type LjSnapshot,
  type LjStickPatch,
  type LjStickSide,
} from '../shared/leadjoy'

const QUERY_TIMEOUT_MS = 10000
const READ_TIMEOUT_MS = 1500
const MAX_FRAMES = 40

function toArray(raw: unknown): number[] {
  if (raw instanceof Buffer) return Array.from(raw.values())
  if (raw instanceof Uint8Array) return Array.from(raw)
  if (Array.isArray(raw)) return raw.map((v) => Number(v) & 0xff)
  throw new Error('leadjoy: unexpected report shape')
}

/**
 * Read one slot snapshot: version, board, buttons, both sticks, triggers.
 * Opens the interface, runs the vendor navigation reads, closes.
 * Throws when the handle is held (close the LeadJoy app) or a query times out.
 */
export async function ljReadSnapshot(path: string, slot: LjSlot): Promise<LjSnapshot> {
  const handle = openHandle(path)
  try {
    const version = ljDecodeStream(await queryStream(handle, ljVersionQuery()))
    const board = ljDecodeStream(await queryStream(handle, ljBoardQuery()))
    const table = await readButtonTable(handle, slot)
    const left = ljDecodeStream(await queryStream(handle, ljStickQuery(slot, 0)))
    const right = ljDecodeStream(await queryStream(handle, ljStickQuery(slot, 1)))
    const trigger = ljDecodeStream(await queryStream(handle, ljTriggerQuery(slot)))
    return ljBuildSnapshot(
      version,
      ljParseBoard(board),
      table,
      ljParseStick(left),
      ljParseStick(right),
      ljParseTrigger(trigger)
    )
  } finally {
    closeHandle(handle)
  }
}

/** Main-slot snapshot (the pad's default active slot). */
export function ljReadMainSnapshot(path: string): Promise<LjSnapshot> {
  return ljReadSnapshot(path, 0)
}

export interface LjButtonWriteResult {
  /** The pad's read-back carries the record we sent. */
  verified: boolean
  /** On mismatch the original record was written back (single attempt). */
  restored: boolean
}

/**
 * Write one button record and prove it landed (implemented, live proof
 * gated on explicit per-step user confirmation — never call this without it).
 *
 * Mirrors the vendor save-flush: the two OUT fragments go out back-to-back,
 * then the single-frame {c:61,e:0} ack is awaited before anything else.
 * The table is read first (rollback source) and read back after; on a
 * mismatch the original record is written back once and the call still
 * throws, reporting whether the restore verified.
 */
export async function ljWriteButtonVerified(
  path: string,
  slot: LjSlot,
  record: LjButtonRecord
): Promise<LjButtonWriteResult> {
  const handle = openHandle(path)
  try {
    const before = await readButtonTable(handle, slot)
    const original = before.records.find((r) => r.k === record.k)
    if (!original) throw new Error(`leadjoy: button id ${record.k} not in the table`)

    await writeRecord(handle, slot, record)
    const landed = await readButtonTable(handle, slot)
    if (recordsEqual(landed.records.find((r) => r.k === record.k), record)) {
      return { verified: true, restored: false }
    }

    await writeRecord(handle, slot, original)
    const afterRestore = await readButtonTable(handle, slot)
    const restored = recordsEqual(afterRestore.records.find((r) => r.k === record.k), original)
    throw new Error(
      `leadjoy: button id ${record.k} did not verify on readback (restore ${restored ? 'verified' : 'UNVERIFIED'} — re-read before writing again)`
    )
  } finally {
    closeHandle(handle)
  }
}

function openHandle(path: string): HIDInstance {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('leadjoy: refusing without a device path')
  }
  try {
    return new HIDModule.HID(path)
  } catch (err) {
    throw new Error(`leadjoy: cannot open device (close the LeadJoy app first) — ${(err as Error).message}`)
  }
}

function closeHandle(handle: HIDInstance): void {
  try {
    handle.close()
  } catch {
    /* already gone */
  }
}

async function readButtonTable(handle: HIDInstance, slot: LjSlot): Promise<LjButtonTable> {
  return ljParseButtonTable(ljDecodeStream(await queryStream(handle, ljButtonQuery(slot))))
}

/** Read one slot's button table (open / read / close). */
export async function ljReadButtonTable(path: string, slot: LjSlot): Promise<LjButtonTable> {
  const handle = openHandle(path)
  try {
    return await readButtonTable(handle, slot)
  } finally {
    closeHandle(handle)
  }
}

/** Send one single-record write and await its {c:61,e:0} ack. */
async function writeRecord(handle: HIDInstance, slot: LjSlot, record: LjButtonRecord): Promise<void> {
  for (const fragment of ljFragmentOut(ljBuildButtonWrite(slot, record))) {
    handle.write([0x00, ...fragment])
  }
  const deadline = Date.now() + QUERY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('leadjoy: timed out waiting for the write ack')
    const bytes = nextReport(handle)
    if (!bytes) continue
    if (bytes[0] === 0xa5) {
      ljParseWriteAck(ljParseSingleFrame(bytes), LJ_REC_BUTTONS_WRITE)
      return
    }
    throw new Error(`leadjoy: unexpected reply to write (class 0x${(bytes[0] ?? 0).toString(16)})`)
  }
}

/**
 * Write one full stick side and prove it landed (implemented, live proof
 * gated on explicit per-step user confirmation — never call this without it).
 * Same shape as the button path: read first, write, ack {c:71,e:0}, read
 * back, restore-on-mismatch with a throwing report either way.
 */
export async function ljWriteStickVerified(
  path: string,
  slot: LjSlot,
  side: 0 | 1,
  patch: LjStickPatch
): Promise<{ verified: boolean; restored: boolean }> {
  const handle = openHandle(path)
  try {
    const before = await readStick(handle, slot, side)
    const want = ljApplyStickPatch(before, patch)
    await writeStick(handle, slot, side, want)
    const landed = await readStick(handle, slot, side)
    if (JSON.stringify(landed) === JSON.stringify(want)) return { verified: true, restored: false }

    await writeStick(handle, slot, side, before)
    const afterRestore = await readStick(handle, slot, side)
    const restored = JSON.stringify(afterRestore) === JSON.stringify(before)
    throw new Error(
      `leadjoy: stick ${side} did not verify on readback (restore ${restored ? 'verified' : 'UNVERIFIED'} — re-read before writing again)`
    )
  } finally {
    closeHandle(handle)
  }
}

async function readStick(handle: HIDInstance, slot: LjSlot, side: 0 | 1): Promise<LjStickSide> {
  const tuning = ljParseStick(ljDecodeStream(await queryStream(handle, ljStickQuery(slot, side))))
  if (tuning.slot !== slot || tuning.side !== side) {
    throw new Error(`leadjoy: stick echo mismatch (slot ${tuning.slot}, side ${tuning.side})`)
  }
  return tuning.d1
}

/** Read one stick side image (open / read / close). */
export async function ljReadStickSide(path: string, slot: LjSlot, side: 0 | 1): Promise<LjStickSide> {
  const handle = openHandle(path)
  try {
    return await readStick(handle, slot, side)
  } finally {
    closeHandle(handle)
  }
}

/** Send one full-side stick write and await its {c:71,e:0} ack. */
async function writeStick(handle: HIDInstance, slot: LjSlot, side: 0 | 1, d1: LjStickSide): Promise<void> {
  for (const fragment of ljFragmentOut(ljBuildStickWrite(slot, side, d1))) {
    handle.write([0x00, ...fragment])
  }
  const deadline = Date.now() + QUERY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('leadjoy: timed out waiting for the stick write ack')
    const bytes = nextReport(handle)
    if (!bytes) continue
    if (bytes[0] === 0xa5) {
      ljParseWriteAck(ljParseSingleFrame(bytes), LJ_REC_STICK_WRITE)
      return
    }
    throw new Error(`leadjoy: unexpected reply to stick write (class 0x${(bytes[0] ?? 0).toString(16)})`)
  }
}

function recordsEqual(a: LjButtonRecord | undefined, b: LjButtonRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Send one 64B query frame, collect and reassemble its reply stream. */
async function queryStream(handle: HIDInstance, frame: number[]): Promise<number[]> {
  handle.write([0x00, ...frame])
  const frames: number[][] = []
  const deadline = Date.now() + QUERY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('leadjoy: query timed out waiting for a reply')
    const bytes = nextReport(handle)
    if (!bytes) continue
    if (bytes[0] === 0xa5) {
      if (frames.length > 0) throw new Error('leadjoy: single-frame reply inside a fragment chain')
      // Verified (LEN + checksum) by the shared codec; slice the body out.
      ljParseSingleFrame(bytes)
      const len = bytes[1] ?? 0
      return bytes.slice(3, len - 1)
    }
    if (bytes[0] === 0xa4) {
      frames.push(bytes)
      if (frames.length > MAX_FRAMES) throw new Error('leadjoy: reply chain too long')
      if ((bytes[1] ?? 0) < LJ_REPORT_LEN) return ljReassemble(frames).stream
      continue
    }
    throw new Error(`leadjoy: unexpected reply class 0x${(bytes[0] ?? 0).toString(16)}`)
  }
}

/** Next non-empty 64B input report, or null on timeout. Throws on transport errors. */
function nextReport(handle: HIDInstance): number[] | null {
  let raw: unknown
  try {
    raw = handle.readTimeout(READ_TIMEOUT_MS)
  } catch (err) {
    throw new Error(`leadjoy: read failed — ${(err as Error).message}`)
  }
  if (raw === null || raw === undefined) return null
  const bytes = toArray(raw)
  if (bytes.length === 0 || bytes.every((b) => b === 0)) return null
  if (bytes.length !== LJ_REPORT_LEN) {
    throw new Error(`leadjoy: ${bytes.length}B report, expected ${LJ_REPORT_LEN}B`)
  }
  return bytes
}
