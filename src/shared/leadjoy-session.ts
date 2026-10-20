/**
 * LeadJoy Saber Plus / Xeno Pro session logic, transport-neutral.
 *
 * Desktop (node-hid, src/main/leadjoy.ts) and browser (WebHID, src/web/hid.ts)
 * supply an `LjPort`; frames, timeouts, ack checks and restore-on-mismatch are
 * identical on both. Reads and verified button/stick writes use the builders
 * proven against vendor captures in tests/leadjoy.ts.
 */
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
  ljButtonWriteRecord,
  type LjButtonRecord,
  type LjButtonTarget,
  type LjButtonTable,
  type LjSlot,
  type LjSnapshot,
  type LjStickPatch,
  type LjStickSide,
} from './leadjoy'


/** One open LeadJoy interface. `write` takes a 64-byte frame without a report id. */
export interface LjPort {
  write(frame: number[]): Promise<void>
  /** Next input report, or null when nothing arrived within `timeoutMs`. */
  read(timeoutMs: number): Promise<number[] | null>
  close(): Promise<void>
}
export type LjOpen = (path: string) => Promise<LjPort>

export interface LjButtonWriteResult {
  /** The pad's read-back carries the record we sent. */
  verified: boolean
  /** On mismatch the original record was written back (single attempt). */
  restored: boolean
}

const QUERY_TIMEOUT_MS = 10000
const READ_TIMEOUT_MS = 1500
const MAX_FRAMES = 40

/** Build the LeadJoy session over a transport. */
export function createLjSession(open: LjOpen) {
  /**
   * Read one slot snapshot: version, board, buttons, both sticks, triggers.
   * Opens the interface, runs the vendor navigation reads, closes.
   * Throws when the handle is held (close the LeadJoy app) or a query times out.
   */
  async function ljReadSnapshot(path: string, slot: LjSlot): Promise<LjSnapshot> {
    const handle = await open(path)
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
      await closePort(handle)
    }
  }

  /** Main-slot snapshot (the pad's default active slot). */
  function ljReadMainSnapshot(path: string): Promise<LjSnapshot> {
    return ljReadSnapshot(path, 0)
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
  async function ljWriteButtonVerified(
    path: string,
    slot: LjSlot,
    record: LjButtonRecord
  ): Promise<LjButtonWriteResult> {
    const handle = await open(path)
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
      await closePort(handle)
    }
  }

  async function readButtonTable(handle: LjPort, slot: LjSlot): Promise<LjButtonTable> {
    return ljParseButtonTable(ljDecodeStream(await queryStream(handle, ljButtonQuery(slot))))
  }

  /** Read one slot's button table (open / read / close). */
  async function ljReadButtonTable(path: string, slot: LjSlot): Promise<LjButtonTable> {
    const handle = await open(path)
    try {
      return await readButtonTable(handle, slot)
    } finally {
      await closePort(handle)
    }
  }

  /** Send one single-record write and await its {c:61,e:0} ack. */
  async function writeRecord(handle: LjPort, slot: LjSlot, record: LjButtonRecord): Promise<void> {
    for (const fragment of ljFragmentOut(ljBuildButtonWrite(slot, record))) {
      await handle.write(fragment)
    }
    const deadline = Date.now() + QUERY_TIMEOUT_MS
    for (;;) {
      if (Date.now() > deadline) throw new Error('leadjoy: timed out waiting for the write ack')
      const bytes = await nextReport(handle)
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
  async function ljWriteStickVerified(
    path: string,
    slot: LjSlot,
    side: 0 | 1,
    patch: LjStickPatch
  ): Promise<{ verified: boolean; restored: boolean }> {
    const handle = await open(path)
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
      await closePort(handle)
    }
  }

  async function readStick(handle: LjPort, slot: LjSlot, side: 0 | 1): Promise<LjStickSide> {
    const tuning = ljParseStick(ljDecodeStream(await queryStream(handle, ljStickQuery(slot, side))))
    if (tuning.slot !== slot || tuning.side !== side) {
      throw new Error(`leadjoy: stick echo mismatch (slot ${tuning.slot}, side ${tuning.side})`)
    }
    return tuning.d1
  }

  /** Read one stick side image (open / read / close). */
  async function ljReadStickSide(path: string, slot: LjSlot, side: 0 | 1): Promise<LjStickSide> {
    const handle = await open(path)
    try {
      return await readStick(handle, slot, side)
    } finally {
      await closePort(handle)
    }
  }

  /** Send one full-side stick write and await its {c:71,e:0} ack. */
  async function writeStick(handle: LjPort, slot: LjSlot, side: 0 | 1, d1: LjStickSide): Promise<void> {
    for (const fragment of ljFragmentOut(ljBuildStickWrite(slot, side, d1))) {
      await handle.write(fragment)
    }
    const deadline = Date.now() + QUERY_TIMEOUT_MS
    for (;;) {
      if (Date.now() > deadline) throw new Error('leadjoy: timed out waiting for the stick write ack')
      const bytes = await nextReport(handle)
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
  async function queryStream(handle: LjPort, frame: number[]): Promise<number[]> {
    await handle.write(frame)
    const frames: number[][] = []
    const deadline = Date.now() + QUERY_TIMEOUT_MS
    for (;;) {
      if (Date.now() > deadline) throw new Error('leadjoy: query timed out waiting for a reply')
      const bytes = await nextReport(handle)
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
  async function nextReport(handle: LjPort): Promise<number[] | null> {
    const bytes = await handle.read(READ_TIMEOUT_MS)
    if (bytes === null || bytes.length === 0 || bytes.every((b) => b === 0)) return null
    if (bytes.length !== LJ_REPORT_LEN) {
      throw new Error(`leadjoy: ${bytes.length}B report, expected ${LJ_REPORT_LEN}B`)
    }
    return bytes
  }

  async function closePort(handle: LjPort): Promise<void> {
    try {
      await handle.close()
    } catch {
      /* already gone */
    }
  }

  return {
    ljReadSnapshot,
    ljReadMainSnapshot,
    ljWriteButtonVerified,
    ljReadButtonTable,
    ljWriteStickVerified,
    ljReadStickSide
  }
}

/**
 * The app-facing LeadJoy calls with their request checks, shared by the
 * Electron IPC handlers and the browser bridge. Button targets are a button id
 * (A=1 B=2 X=4 Y=5) or null for stock; anything else is refused by
 * `ljButtonWriteRecord`, not just in the UI.
 */
export function createLjApi(session: ReturnType<typeof createLjSession>) {
  const slotOf = (slot: unknown): LjSlot => {
    if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`leadjoy: slot ${slot} is not Main/Sub1/Sub2`)
    return slot
  }
  const pathOf = (path: unknown, what: string): string => {
    if (typeof path !== 'string' || path.length === 0) throw new Error(`leadjoy: refusing ${what} without a device path`)
    return path
  }
  return {
    readMain: (path: string) => session.ljReadMainSnapshot(path),
    readSlot: (req: { path: string; slot: number }) => session.ljReadSnapshot(pathOf(req?.path, 'read'), slotOf(req?.slot)),
    writeButton: (req: { path: string; slot: number; id: number; target: LjButtonTarget | null }) =>
      session.ljWriteButtonVerified(pathOf(req?.path, 'write'), slotOf(req?.slot), ljButtonWriteRecord(req.id, req.target)),
    writeStick: (req: { path: string; slot: number; side: number; patch: Record<string, unknown> }) => {
      const side = req?.side
      if (side !== 0 && side !== 1) throw new Error(`leadjoy: side ${side} is not left/right`)
      return session.ljWriteStickVerified(pathOf(req?.path, 'write'), slotOf(req?.slot), side, (req.patch ?? {}) as LjStickPatch)
    }
  }
}
