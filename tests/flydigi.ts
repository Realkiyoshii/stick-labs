import { readFileSync } from 'node:fs'
import { FD_PRESET_P1, FdCmd, changedRuns, configWriteFrames, createFdSession, decodeStick, fdBuildCurve, fdParse, fdRequest, fdWriteRequest, fdZones, hardwareFrames, hardwareMatches, fdFromPoints, fdToPoints, decodeKeys, withKeys, FdKey, FD_KEY_SELF, decodeLive, isFdIdentity, nextVersion, withSticks, type FdPort } from '../src/shared/flydigi'

let failed = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const hex = (a: number[]): string => Buffer.from(a).toString('hex')
const bytes = (h: string): number[] => Array.from(Buffer.from(h, 'hex'))

// Live read-only capture from an Apex 5 (fw 7.0.4.5), 2026-10-24.
const fx = JSON.parse(readFileSync('fixtures/flydigi/apex5-read.json', 'utf8')) as {
  device: { vendorId: number; productId: number; usagePage: number; usage: number }
  exchanges: Array<{ request: string; replies: string[] }>
}

check('identity: VID + usage page + usage', isFdIdentity(fx.device) && !isFdIdentity({ ...fx.device, usagePage: 0xffef }))

// Requests are byte-exact with what the pad answered (and with Space Station's own capture: a3 04 00 14 bb).
const asks: Array<[number, number[]]> = [[FdCmd.Heartbeat, []], [FdCmd.HardwareStatus, []], [FdCmd.Uid, []], [FdCmd.RawDataStatus, []], [FdCmd.ReadConfig, [0, 20]]]
asks.forEach(([cmd, args], i) => check(`request 0x${cmd.toString(16)} byte-exact`, hex(fdRequest(cmd, args)) === fx.exchanges[i].request))
check('read-config frame matches the Space Station capture', hex(fdRequest(FdCmd.ReadConfig, [0, 20]).slice(3, 8)) === 'a3040014bb')

// Only reads can be built.
for (const cmd of [0xa4, 0xa5, 0xa6, 0x13, 0x14, 0x1f, 0xf0]) {
  let threw = false
  try { fdRequest(cmd) } catch { threw = true }
  check(`refuses 0x${cmd.toString(16)}`, threw)
}

check('parse strips report id', fdParse(bytes(fx.exchanges[1].replies[0]))?.[2] === 0x03)
check('parse rejects foreign frames', fdParse([0x04, 0x00, 0x01]) === null)

// Session replaying the capture.
function replayPort(): FdPort {
  const queue: number[][] = []
  return {
    async write(frame) {
      const ex = fx.exchanges.find((e) => e.request === hex(frame))
      if (!ex) throw new Error('unexpected request ' + hex(frame))
      queue.push(...ex.replies.map(bytes))
    },
    async read() { return queue.shift() ?? null },
    async close() {}
  }
}
const session = createFdSession(async () => replayPort())
const snap = await session.readSnapshot('fixture')
check('device name', snap.device.name === 'Flydigi Apex 5' && snap.device.deviceType === 0x80)
check('firmware 7.0.4.5', snap.device.firmware === '7.0.4.5')
check('screen firmware 0.1.2.8', snap.device.screenFirmware === '0.1.2.8')
check('battery level 5, not charging', snap.device.battery === 5 && !snap.device.charging)
check('wired', snap.device.connectType === 1)
check('uid is 26 hex chars', /^[0-9a-f]{26}$/.test(snap.device.uid))
const hw = snap.hardware
check('hardware: 12-bit, Middle, sleep 15', hw.stickBits === 12 && hw.centerSensitivity === 'Middle' && hw.sleepMinutes === 15)
check('hardware: debounce, auto-calibration, rebound and Xbox Home on', hw.stickDebounce.enabled && hw.autoCalibration.enabled && hw.rebound.enabled && hw.xboxHome.enabled)
check('hardware: quick switch and mapping switch off', !hw.quickSwitch.enabled && !hw.mappingSwitch.enabled)
check('hardware: motion debounce not offered', !hw.motionDebounce.usable)
check('L stick: Custom, square, edge 0', snap.sticks[0].type === 'Custom' && !snap.sticks[0].circular && snap.sticks[0].edge === 0)
check('L curve', same(snap.sticks[0].curve, [0, 15, 31, 46, 62, 72, 81, 91, 100]))
check('R curve', same(snap.sticks[1].curve, [0, 8, 16, 24, 32, 39, 50, 75, 100]))
check('curves end at 100 %', snap.sticks.every((s) => s.curve[8] === 100))

const blob = await session.readConfig('fixture')
check('config is 42 × 20 bytes', blob.length === 840)

// Space Station's linear default and the signed edge encoding.
const lin = new Array(840).fill(0xff)
lin.splice(790, 12, 0, 0x32, 0x3e, 0x4b, 0x57, 0x64, 0x70, 0x7d, 0x89, 0x96, 1, 127 + 10)
check('linear default decodes', same(decodeStick(lin, 0), { type: 'Default', curve: [0, 12, 25, 37, 50, 62, 75, 87, 100], circular: true, edge: -10 }))

// Zones implied by the curve.
check('zones: linear', same(fdZones([0, 12, 25, 37, 50, 62, 75, 87, 100]), { deadzone: 0, anti: 0, full: 100 }))
check('zones: inner deadzone 11.4 %', fdZones([-50, 5, 20, 35, 50, 62, 75, 87, 100]).deadzone === 11.4)
check('zones: anti-deadzone 10 %', fdZones([10, 20, 30, 40, 50, 60, 70, 80, 100]).anti === 10)
check('zones: outer deadzone, full at 87.5 %', fdZones([0, 14, 28, 42, 57, 71, 85, 100, 100]).full === 87.5)

// --- writes: byte-exact against Space Station's own captured saves ---
const wx = JSON.parse(readFileSync('fixtures/flydigi/apex5-write-pcap.json', 'utf8')) as { saves: Array<{ frames: string[] }> }
const [curveSave, shapeSave] = wx.saves.map((s) => s.frames.map(bytes))
// Rebuild each captured packet + frame with our builders.
for (const save of [curveSave, shapeSave]) {
  for (const f of save) {
    const len = f[4]
    const rebuilt = fdWriteRequest(f[3], f.slice(5, 3 + len))
    check(`write frame 0x${f[3].toString(16)} ${hex(f).slice(6, 20)} byte-exact`, hex(rebuilt) === hex(f))
  }
}
// The shape save: L circularity on, one packet (40), version 0xf894.
{
  const before = new Array(840).fill(0xff)
  const pk40 = shapeSave[1].slice(6, 26)
  pk40.forEach((b, i) => (before[800 + i] = b))
  before[800] = 0
  const after = before.slice()
  after[800] = 1
  const frames = configWriteFrames(before, after, 0xf894)
  check('shape save: same frames as Space Station', same(frames.map(hex), shapeSave.map(hex)))
}
// The curve save writes packets 39 and 5; ours sends the same frames (packet order ascending).
{
  const before = new Array(840).fill(0)
  const after = before.slice()
  curveSave[1].slice(6, 26).forEach((b, i) => (after[780 + i] = b))
  curveSave[3].slice(6, 26).forEach((b, i) => (after[100 + i] = b))
  const frames = configWriteFrames(before, after, 0x6e59).map(hex)
  check('curve save: same frames as Space Station', same([...frames].sort(), curveSave.map(hex).sort()) && frames[frames.length - 1] === hex(curveSave[4]))
}
check('no change → no frames', configWriteFrames([1, 2, 3], [1, 2, 3], 5).length === 0)
check('runs merge consecutive packets', same(changedRuns(new Array(80).fill(0), [...new Array(20).fill(1), ...new Array(20).fill(1), ...new Array(40).fill(0)]).map((r) => [r.start, r.packets.length]), [[0, 2]]))
{ const seq = [0x1234 / 65535, 0.5]; let k = 0; check('new version differs from current', nextVersion(0x1234, () => seq[k++]) === Math.floor(0.5 * 65535)) }

// Stick round-trip and the Space Station curve generator.
{
  const s = decodeStick(withSticks(new Array(840).fill(0xff), [{ type: 'Custom', curve: [-50, -10, 20, 40, 60, 75, 88, 100, 100], circular: true, edge: -12 }, decodeStick(lin, 0)]), 0)
  check('encode/decode stick round-trip', same(s, { type: 'Custom', curve: [-50, -10, 20, 40, 60, 75, 88, 100, 100], circular: true, edge: -12 }))
}
check('generator: Quick preset', same(fdBuildCurve({ center: 0, edge: 0, p1: FD_PRESET_P1.Quick, p2: { x: 127, y: 127 } }), [0, 19, 38, 57, 76, 82, 88, 94, 100]))
check('generator: 10 % deadzone starts later', (() => { const c = fdBuildCurve({ center: 10, edge: 0, p1: FD_PRESET_P1.Default, p2: { x: 127, y: 127 } }); return c[0] < 0 && c[1] > 0 && c[8] === 100 })())
check('generator: 20 % anti-deadzone lifts the start', fdBuildCurve({ center: -20, edge: 0, p1: FD_PRESET_P1.Default, p2: { x: 127, y: 127 } })[0] === 20)
check('generator: 15 % outer deadzone reaches 100 early', fdBuildCurve({ center: 0, edge: 15, p1: FD_PRESET_P1.Default, p2: { x: 127, y: 127 } })[7] === 100)
check('generator: 70 % cap', fdBuildCurve({ center: 0, edge: -30, p1: FD_PRESET_P1.Default, p2: { x: 127, y: 127 } })[8] === 70)

// Hardware frames follow the SDK classes (cmd, len, args, sum).
check('toggle debounce off', hex(hardwareFrames({ stickDebounce: false })[0]).slice(0, 16) === '035aa5130405001c')
check('precision 12-bit', hex(hardwareFrames({ stickBits: 12 })[0]).slice(0, 14) === '035aa5150303' + '1b')
check('sensitivity Middle', hex(hardwareFrames({ centerSensitivity: 'Middle' })[0]).slice(0, 14) === '035aa5160311' + '2a')
check('sleep 15 min', hex(hardwareFrames({ sleepMinutes: 15 })[0]).slice(0, 14) === '035aa517030f' + '29')
for (const bad of [[0x13, [1, 1]], [0x13, [2, 0]], [0x1f, []], [0xf0, [1]], [0x14, [1]]] as Array<[number, number[]]>) {
  let threw = false
  try { fdWriteRequest(bad[0], bad[1]) } catch { threw = true }
  check(`refuses write 0x${bad[0].toString(16)} ${bad[1].join(',')}`, threw)
}
check('hardware readback match', hardwareMatches(snap.hardware, { stickBits: 12, centerSensitivity: 'Middle', stickDebounce: true }) && !hardwareMatches(snap.hardware, { rebound: false }))

// Shared-card points <-> stored samples.
const near = (a: number[], b: number[], tol = 1): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol)
for (const c of [[0, 12, 25, 37, 50, 62, 75, 87, 100], snap.sticks[0].curve, snap.sticks[1].curve, [-50, -10, 20, 40, 60, 75, 88, 100, 100], [20, 30, 40, 50, 60, 70, 80, 90, 100], [0, 9, 18, 26, 35, 44, 53, 61, 70]]) {
  const pts = fdToPoints(c)
  check(`points round-trip ${c.join(',')}`, pts.length === 9 && near(fdFromPoints(pts), c.map((v) => Math.max(v, c[0] < 0 ? -50 : v)), 1) || near(fdFromPoints(pts).map((v) => Math.max(0, v)), c.map((v) => Math.max(0, v)), 1))
}
check('points: deadzone first point', same(fdToPoints([-50, -10, 20, 40, 60, 75, 88, 100, 100])[0], [Math.round(fdZones([-50, -10, 20, 40, 60, 75, 88, 100, 100]).deadzone * 10), 0]))
check('points: 10 % deadzone written as zero crossing', (() => { const c = fdFromPoints([[100, 0], [200, 125], [300, 250], [400, 375], [500, 500], [600, 625], [700, 750], [800, 875], [1000, 1000]]); return c[0] < 0 && c[1] > 0 && Math.abs(fdZones(c).deadzone - 10) <= 1.5 })())

// Button mapping (live fixture: set in Space Station — LT→B, RT→A, M1→A, M2–M4→B, M5 keyboard, M6→A).
check('keys decoded from the pad', same([12, 13, 18, 19, 20, 21, 22, 23].map((i) => snap.keys[i]), [5, 4, 4, 5, 5, 5, 0xfe, 4]) && snap.keys[FdKey.A] === FD_KEY_SELF)
{
  const before = await session.readConfig('fixture')
  const after = withKeys(before, { [FdKey.M1]: FdKey.Y, [FdKey.Lt]: FdKey.Lt })
  const k = decodeKeys(after)
  check('withKeys: M1 → Y, LT back to default', k[FdKey.M1] === FdKey.Y && k[FdKey.Lt] === FD_KEY_SELF)
  check('withKeys clears turbo bytes', after[13 + FdKey.M1 * 3 + 1] === 0 && after[13 + FdKey.M1 * 3 + 2] === 0)
  check('key writes stay inside packets 0–4', changedRuns(before, after).every((r) => r.start + r.packets.length <= 5))
  let threw = 0
  try { withKeys(before, { 27: FdKey.A }) } catch { threw++ }
  try { withKeys(before, { [FdKey.M1]: 0x20 }) } catch { threw++ }
  check('refuses Home and macro targets', threw === 2)
}

// --- write safety with a simulated pad: 0x13 toggles work, precision is refused ---
{
  const sent: string[] = []
  let status = bytes(fx.exchanges[1].replies[0])
  const cfgReplies = fx.exchanges[4].replies.map(bytes)
  const fakePort = (refuse: (f: number[]) => boolean): FdPort => {
    const q: number[][] = []
    return {
      async write(f) {
        sent.push(hex(f.slice(3, 8)))
        if (f[3] === 0x03) q.push(status)
        else if (f[3] === 0xa3) q.push(...cfgReplies)
        else if (f[3] === 0x01 || f[3] === 0x04) q.push(bytes(fx.exchanges[f[3] === 0x01 ? 0 : 2].replies[0]))
        else {
          const ok = !refuse(f)
          if (ok && f[3] === 0x13) { const bit = f[5]; status = status.slice(); status[7] = (status[7] & ~(1 << bit)) | (f[6] << bit) }
          q.push([0x04, 0x5a, 0xa5, f[3], 1, ok ? 0 : 1, f[6] ?? 0])
        }
      },
      async read() { return q.shift() ?? null },
      async close() {}
    }
  }
  const s1 = createFdSession(async () => fakePort((f) => f[3] === 0x15))
  let err = ''
  try { await s1.writeVerified('x', { hardware: { stickDebounce: false, stickBits: 16 } }) } catch (e) { err = (e as Error).message }
  check('refused precision → error mentions restore', /refused/.test(err) && /restored/.test(err))
  check('debounce put back on after the refusal', sent.includes(hex([0x13, 0x04, 0x05, 0x01, 0x1d])))
  sent.length = 0
  const s2 = createFdSession(async () => fakePort((f) => f[3] === 0xa5 && sent.filter((x) => x.startsWith('a5')).length === 1))
  err = ''
  try { await s2.writeVerified('x', { keys: { [FdKey.M1]: FdKey.Y } }) } catch (e) { err = (e as Error).message }
  check('failed config ack → no save, restore reported', /restored/.test(err) && !sent.some((x) => x.startsWith('a6')))
}
check('unchanged stick is left alone', (() => { const b = new Array(840).fill(7); const a = withSticks(b, [null, decodeStick(lin, 0)]); return a.slice(790, 802).every((v) => v === 7) && a[802] === 0 })())
check('live frame decodes (centre, full right, full up)', same(decodeLive([0x5a, 0xa5, 0xef, 0, 0, 0, 0, 0xff, 0x7f, 0xff, 0x7f]), { lx: 128, ly: 128, rx: 255, ry: 0 }))
check('non-live frame ignored', decodeLive([0x5a, 0xa5, 0x03, 1, 0, 0, 0, 0, 0, 0, 0]) === null)

if (failed) {
  console.log(`${failed} FLYDIGI TEST(S) FAILED`)
  process.exit(1)
}
console.log('ALL FLYDIGI TESTS PASSED')
