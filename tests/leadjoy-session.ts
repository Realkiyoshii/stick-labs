// LeadJoy session over a fake port: proves the transport-neutral session (used by
// desktop node-hid and browser WebHID) sends the vendor-exact frames and parses
// the captured replies (fixtures/leadjoy/*.bin) into the same snapshot.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LJ_MARKER,
  LJ_OUT_CLASS,
  ljBoardQuery,
  ljBuildButtonWrite,
  ljBuildSnapshot,
  ljBuildStickWrite,
  ljButtonQuery,
  ljChecksum,
  ljDecodeStream,
  ljFragmentOut,
  ljMpEncode,
  ljParseBoard,
  ljParseButtonTable,
  ljParseStick,
  ljParseTrigger,
  ljReassemble,
  ljStickQuery,
  ljTriggerQuery,
  ljVersionQuery,
  type LjValue
} from '../src/shared/leadjoy'
import { createLjApi, createLjSession, type LjPort } from '../src/shared/leadjoy-session'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}
const fixture = (name: string): number[] => Array.from(readFileSync(join(process.cwd(), 'fixtures', 'leadjoy', name)))
const same = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.from(a).every((v, i) => v === b[i])

/** One 0xA5 single-frame IN report carrying `doc`. */
function single(doc: LjValue): number[] {
  const body = ljMpEncode(doc)
  const frame = [LJ_OUT_CLASS, body.length + 4, LJ_MARKER, ...body]
  frame.push(ljChecksum(frame, frame.length))
  while (frame.length < 64) frame.push(0)
  return frame
}

const version = { c: 12, e: 0, r: '36.16.12' }
const replies: Array<[number[], number[][]]> = [
  [ljVersionQuery(), [single(version)]],
  [ljBoardQuery(), ljFragmentOut(fixture('board.bin'))],
  [ljButtonQuery(0), ljFragmentOut(fixture('btn-main.bin'))],
  [ljStickQuery(0, 0), ljFragmentOut(fixture('stick-left-main.bin'))],
  [ljStickQuery(0, 1), ljFragmentOut(fixture('stick-right-main.bin'))],
  [ljTriggerQuery(0), ljFragmentOut(fixture('trigger-main.bin'))]
]

/** Fake pad: answers known queries with captures, acks complete write streams. */
function fakePad(sent: number[][]) {
  let pending: number[][] = []
  const queue: number[][] = []
  let opens = 0
  let closes = 0
  const open = async (path: string): Promise<LjPort> => {
    if (!path) throw new Error('no path')
    opens++
    return {
      async write(frame) {
        if (frame.length !== 64) throw new Error(`frame ${frame.length}B, expected 64 without a report id`)
        sent.push(frame)
        const hit = replies.find(([q]) => same(q, frame))
        if (hit) { queue.push(...hit[1]); return }
        pending.push(frame)
        if (pending.length === ((pending[0][3] ?? 0) & 0x7f)) {
          const doc = ljDecodeStream(ljReassemble(pending).stream) as { c: number }
          pending = []
          queue.push(single({ c: doc.c, e: 0 }))
        }
      },
      async read() { return queue.shift() ?? null },
      async close() { closes++ }
    }
  }
  return { open, counts: () => ({ opens, closes }) }
}

// Snapshot read matches the codec-built snapshot from the same captures.
{
  const sent: number[][] = []
  const pad = fakePad(sent)
  const api = createLjApi(createLjSession(pad.open))
  const snap = await api.readMain('fake')
  const expected = ljBuildSnapshot(
    version,
    ljParseBoard(ljDecodeStream(fixture('board.bin'))),
    ljParseButtonTable(ljDecodeStream(fixture('btn-main.bin'))),
    ljParseStick(ljDecodeStream(fixture('stick-left-main.bin'))),
    ljParseStick(ljDecodeStream(fixture('stick-right-main.bin'))),
    ljParseTrigger(ljDecodeStream(fixture('trigger-main.bin')))
  )
  check('snapshot over the port equals the codec snapshot', JSON.stringify(snap) === JSON.stringify(expected))
  check('reads send the six vendor queries in order', sent.length === 6 && replies.every(([q], i) => same(q, sent[i])))
  check('port opened once and closed', JSON.stringify(pad.counts()) === '{"opens":1,"closes":1}')
}

// Button write: exact fragments, ack, readback verified (no-op record keeps the capture valid).
{
  const sent: number[][] = []
  const pad = fakePad(sent)
  const session = createLjSession(pad.open)
  const record = ljParseButtonTable(ljDecodeStream(fixture('btn-main.bin'))).records[0]
  const result = await session.ljWriteButtonVerified('fake', 0, record)
  const writeFrames = ljFragmentOut(ljBuildButtonWrite(0, record))
  check('button write verified', result.verified && !result.restored)
  check('button write frames are byte-exact', writeFrames.every((f, i) => same(f, sent[1 + i])))
}

// Stick write: same path for a full side image.
{
  const sent: number[][] = []
  const pad = fakePad(sent)
  const session = createLjSession(pad.open)
  const before = ljParseStick(ljDecodeStream(fixture('stick-left-main.bin'))).d1
  const result = await session.ljWriteStickVerified('fake', 0, 0, {})
  const writeFrames = ljFragmentOut(ljBuildStickWrite(0, 0, before))
  check('stick write verified', result.verified && !result.restored)
  check('stick write frames are byte-exact', writeFrames.every((f, i) => same(f, sent[1 + i])))
}

// Request checks are shared by desktop IPC and the browser bridge.
{
  const api = createLjApi(createLjSession(fakePad([]).open))
  const refuses = async (fn: () => Promise<unknown>, text: string): Promise<boolean> => {
    try { await fn(); return false } catch (e) { return (e as Error).message.includes(text) }
  }
  check('bad slot refused', await refuses(() => api.readSlot({ path: 'fake', slot: 3 }), 'not Main/Sub1/Sub2'))
  check('missing path refused', await refuses(() => api.readSlot({ path: '', slot: 0 }), 'without a device path'))
  check('bad side refused', await refuses(() => api.writeStick({ path: 'fake', slot: 0, side: 2, patch: {} }), 'not left/right'))
}
console.log('ALL LEADJOY SESSION TESTS PASSED')
