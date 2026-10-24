// HyperStrike Driver HID: codec and verified writes, checked against live fw 2.66 replies (docs/hyperstrike-sampling.md).
import { ljCurveZones, ljFitZones, ljLinearCurve, ljSampleDesign } from '../src/shared/leadjoy'
import { calPayload, createHsSession, decodeButtons, decodeProfiles, encodeCurve, encodeExtraKeys, encodeExtraMap, encodeNativeKeys, encodeNativeRemap, encodePolling, encodeProfileNames, encodeUsbMode, hsCrc32, hsNormalizeCurve, isHsIdentity, encodeSampling, encodeSpeed, encodeStickBits, hsParse, hsRequest, HsCmd, HsObj, planWrites, type HsPort, type HsSnapshot } from '../src/shared/hyperstrike'
import { identifyModel } from '../src/shared/models'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}
const throws = (fn: () => unknown): boolean => { try { fn() } catch { return true } return false }
const hex = (s: string): number[] => s.trim().split(/\s+/).map((b) => parseInt(b, 16))

// Live payloads read from the user's HyperStrike on 2026-10-23.
const LIVE: Record<string, string> = {
  '0/2': '02 06 01 03 00 00',
  '0/3': '01 01 01 07 07 00 00 00',
  '0/6': '01 00 64 00',
  '0/7': '00',
  '2/1': '0c 00 00 00',
  '2/2': '02 01 04 02 00 ee',
  '2/3': '00',
  '2/4': '01 00 05 00 20 00 00 50 00 00 80 00 00 c0 00 00 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00',
  '2/5': '01 00 05 00 20 00 00 50 00 00 80 00 00 c0 00 00 ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00',
  '3/1': '00 00 00 00 00 7d 00 7d 00 fb 00 fb 00 78 01 78 01 f6 01 f6 01 7b 02 7b 02 be 02 be 02 01 03 01 03 74 03 74 03 e8 03 e8 03',
  '3/2': '00 00 00 00 00 7d 00 7d 00 fb 00 fb 00 78 01 78 01 f6 01 f6 01 7b 02 7b 02 be 02 be 02 01 03 01 03 74 03 74 03 e8 03 e8 03',
  '3/4': '00',
  '3/5': '00',
  '0/8': '04 01 e9 85 8d e7 bd ae 31 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 e9 85 8d e7 bd ae 32 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 e9 85 8d e7 bd ae 33 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 e9 85 8d e7 bd ae 34 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 01 01 01',
  '4/1': '02' + ' 00'.repeat(34),
  '4/2': '02 24 00 01 00 02 00 03 00 04 00 05 00 06 00 07 00 08 00 09 00 0a 00 0b 00 0c 00 0d 00 0e 00 0f 00 10 00 11 00 00 00 12 0f 12',
  '5/1': '00 00 08' + ' 00'.repeat(28),
  '5/2': '00 01 12' + ' 00'.repeat(57)
}
const PROTOCOL = '04 00 10 40 30 00 02 01 02 03 14 00 00 00 48 53 52 33'
const DEVICE = '04 00 40 30 01 1b 66 02 04 32 2e 36 36' + ' 00'.repeat(28)

// --- Request builder: only reads, SET_VALUE and SAVE_FLUSH exist.
for (const cmd of [5, 7, 14, 255]) check(`request builder refuses command ${cmd} (save request, factory reset, unknown)`, throws(() => hsRequest(cmd, 1)))
check('only SET_VALUE may carry a payload', throws(() => hsRequest(HsCmd.GetValue, 1, 2, 1, 0, 0, [1])))
check('payload over 48 bytes is refused', throws(() => hsRequest(HsCmd.SetValue, 1, 3, 1, 0, 0, new Array(49).fill(0))))
const req = hsRequest(HsCmd.BufferGet, 9, 3, 1, 0x130, 48)
check('request frame layout matches the Hub', req.length === 64 && req[0] === 10 && req[1] === 9 && req[2] === 3 && req[3] === 1 && req[5] === 48 && req[8] === 0x30 && req[9] === 0x01)
const set = hsRequest(HsCmd.SetValue, 3, 2, 1, 0, 0, [11, 0, 0, 0])
check('SET_VALUE puts length at 5 and payload at 16', set[0] === 4 && set[5] === 4 && set[16] === 11 && set[20] === 0)
check('live GET_PROTOCOL reply parses', hsParse(hex('01 01 00 00 00 12 00 00 00 00 00 00 00 00 00 00 ' + PROTOCOL + ' 00'.repeat(30)))?.payload.length === 18)
check('model table names the Driver interface', identifyModel('HyperStrike', 0xbb80)?.id === 'HyperStrike')

// --- Encoders mirror the Hub's writers.
check('stick resolution 8..12 only', encodeStickBits(11).join() === '11,0,0,0' && throws(() => encodeStickBits(7)) && throws(() => encodeStickBits(13)))
check('Extreme + 16-bit encodes like the Hub', encodeSampling(4, 3).join() === '2,1,4,2,0,96')
check('Robust + off encodes like the Hub', encodeSampling(1, 0).join() === '2,1,1,3,1,0')
check('tiers D–G refused on fw 2.66', throws(() => encodeSampling(5, 0, 2, '2.66')) && encodeSampling(5, 0, 2, '2.96')[2] === 5)
check('live curve round-trips with the apply flag set', encodeCurve(hex(LIVE['3/1']).length && [[0, 0], [125, 125], [251, 251], [376, 376], [502, 502], [635, 635], [702, 702], [769, 769], [884, 884], [1000, 1000]]).slice(1).join() === hex(LIVE['3/1']).slice(1).join())
check('curve must rise and end at 1000', throws(() => encodeCurve([[0, 0], [125, 125], [251, 100], [376, 376], [502, 502], [635, 635], [702, 702], [769, 769], [884, 884], [1000, 1000]])) && throws(() => encodeCurve([[0, 0], [125, 125], [251, 251], [376, 376], [502, 502], [635, 635], [702, 702], [769, 769], [884, 884], [1000, 900]])))
const tiers = [32, 80, 128, 192, 255].map((end) => ({ end, strength: 0 }))
check('live speed boost round-trips', encodeSpeed({ enabled: false, tiers }).join() === hex(LIVE['2/4']).join())
check('speed strength limited to ±500, last tier at 255', throws(() => encodeSpeed({ enabled: true, tiers: tiers.map((x) => ({ ...x, strength: 501 })) })) && throws(() => encodeSpeed({ enabled: true, tiers: tiers.map((x, i) => ({ ...x, end: i === 4 ? 250 : x.end })) })))

// --- Fake controller: answers like the live one, stores SET_VALUE, records every command.
function fakePad(opts: { corrupt?: string } = {}) {
  const store: Record<string, number[]> = Object.fromEntries(Object.entries(LIVE).map(([k, v]) => [k, hex(v)]))
  const sent: number[] = []
  const actions: string[] = []
  const queue: number[][] = []
  let staging: number[] = []
  store['6/1'] = [10, 0, 20, 0, 30, 0, 40, 0, 50, 0, 60, 0, 70, 0, 80, 0, 90, 0, 100, 0, 110, 0, 120, 0]
  let status = 0
  const reply = (frame: number[]): number[] => {
    const [cmd, seq, ch, id] = frame
    const key = `${ch}/${id}`
    let payload: number[] = []
    if (cmd === 1) payload = hex(PROTOCOL)
    else if (cmd === 2) payload = hex(DEVICE)
    else if (cmd === 3) payload = store[key] ?? []
    else if (cmd === 4) {
      const p = frame.slice(16, 16 + frame[5])
      // The firmware clears the curve apply flag; a corrupt object stores a wrong byte.
      store[key] = ch === 3 && (id === 1 || id === 2) ? [0, ...p.slice(1)] : p
      if (opts.corrupt === key) store[key] = store[key].map((b, i) => (i === 1 ? b ^ 1 : b))
    } else if (cmd === 8 && key === '6/2') actions.push(frame.slice(16, 16 + frame[5]).join(','))
    else if (cmd === 8) store[key] = frame.slice(16, 16 + frame[5])
    else if (cmd === 13) staging = []
    else if (cmd === 11) frame.slice(16, 16 + frame[5]).forEach((v, i) => { staging[(frame[8] | (frame[9] << 8)) + i] = v })
    else if (cmd === 12) {
      const len = frame[10] | (frame[11] << 8)
      const crc = (frame[12] | (frame[13] << 8) | (frame[14] << 16) | (frame[15] << 24)) >>> 0
      const data = staging.slice(0, len)
      if (hsCrc32(data) !== crc) status = 11
      else store[key] = ch === 5 ? [0, ...data.slice(1)] : ch === 0 && id === 8 ? [...data, ...store[key].slice(101)] : data
    }
    else if (cmd === 9) payload = new Array(40).fill(0)
    if (cmd === 3 && payload.length > 48) {
      // Too big for one frame: the pad answers BAD_LENGTH and the reader pages with BUFFER_GET.
      const out = new Array<number>(64).fill(0)
      out[0] = cmd; out[1] = seq; out[2] = ch; out[3] = id; out[4] = 4
      return out
    }
    if (cmd === 10) {
      const all = store[key] ?? []
      const off = frame[8] | (frame[9] << 8)
      const part = all.slice(off, off + 48)
      const out = new Array<number>(64).fill(0)
      out[0] = cmd; out[1] = seq; out[2] = ch; out[3] = id; out[5] = part.length; out[6] = off + part.length < all.length ? 1 : 0; out[8] = all.length & 0xff; out[9] = all.length >> 8
      out.splice(16, part.length, ...part)
      return out
    }
    const out = new Array<number>(64).fill(0)
    out[0] = cmd; out[1] = seq; out[2] = ch; out[3] = id; out[4] = status; out[5] = payload.length
    status = 0
    out.splice(16, payload.length, ...payload)
    return out
  }
  const port: HsPort = {
    async write(frame) { sent.push(frame[0]); queue.push([0x09, 0xff, ...new Array(62).fill(0)], reply(frame)) },
    async read() { return queue.shift() ?? null },
    async close() {}
  }
  return { port, sent, store, actions }
}

const pad = fakePad()
const session = createHsSession(async () => pad.port, async () => {})
const snap: HsSnapshot = await session.readSnapshot('fake')
check('reading sends only read commands', pad.sent.every((c) => [1, 2, 3, 10].includes(c)))
check('unrelated input reports are skipped', snap.protocol.fingerprint === 'HSR3')
check('firmware 2.66 and XInput mode', snap.device.firmware === '2.66' && snap.usbMode === 'XInput')
check('8 kHz from bIntervalHs, not rateCode 6', snap.pollingHz === 8000)
check('12-bit stick resolution', snap.stickBits === 12)
check('Extreme sampling with 16-bit oversampling, overspec off', snap.sampling.preset === 'Extreme' && snap.sampling.divider === 6 && snap.sampling.sampleCycles === 1.5 && snap.sampling.oversampling === '16-bit' && !snap.sampling.overspec)
check('curves decode as 10 linear points on 0..1000', snap.curves.left.length === 10 && snap.curves.left.every(([x, y]) => x === y) && snap.curves.right[9][0] === 1000)
check('speed boost decodes as off with five tiers', !snap.speed.left.enabled && snap.speed.left.tiers.length === 5 && snap.speed.left.tiers[4].end === 255)
check('coalesce off with 100 ms heartbeat, profile 1', !snap.coalesce.enabled && snap.coalesce.heartbeatMs === 100 && snap.profile === 1)

check('unchanged values plan no writes', planWrites(snap, { stickBits: 12, sampling: { presetId: 4, oversample: 3 }, curveLeft: snap.curves.left, axisInvert: 0 }).length === 0)
check('sampling with the same fields is unchanged despite firmware flag bits (0xEE)', planWrites(snap, { sampling: { presetId: 4, oversample: 3 } }).length === 0)

pad.sent.length = 0
const res = await session.writeVerified('fake', { stickBits: 11, curveLeft: snap.curves.left.map(([x], i) => [x, i === 0 ? 0 : Math.min(1000, Math.round(x * 0.9 + (i === 9 ? 100 : 0)))] as [number, number]) })
check('verified write changed resolution and the left curve', res.written.join() === 'StickResolution,CurveLeft' && res.snapshot.stickBits === 11)
check('write sends SET_VALUE, then SAVE_FLUSH and status polls, nothing else', pad.sent.every((c) => [1, 2, 3, 4, 6, 9, 10].includes(c)) && pad.sent.filter((c) => c === 4).length === 2 && pad.sent.includes(6))
check('the right curve was not touched', pad.store['3/2'].join() === hex(LIVE['3/2']).join())

const bad = fakePad({ corrupt: '2/1' })
let failed = false
try { await createHsSession(async () => bad.port, async () => {}).writeVerified('fake', { stickBits: 10 }) } catch { failed = true }
check('a read-back mismatch fails, restores the old value and never saves', failed && bad.store['2/1'][0] === 0x0c && !bad.sent.includes(6))
check('USB policy, mode and profile cannot be written', !Object.keys(HsObj).includes('Calibration') && throws(() => planWrites(snap, { stickBits: 99 })))


// --- GameSir-style designs (0..255, any point count) sampled onto the 10 HyperStrike points.
const LIN10 = ljLinearCurve({ start: 0, antiStart: 0, end: 1000, antiEnd: 1000 }, 10)
const designs = [
  [{ x: 0, y: 0 }, { x: 255, y: 255 }],
  [{ x: 0, y: 0 }, { x: 64, y: 20 }, { x: 128, y: 70 }, { x: 192, y: 150 }, { x: 255, y: 255 }],
  [{ x: 0, y: 30 }, { x: 40, y: 120 }, { x: 255, y: 230 }],
  [{ x: 0, y: 0 }, { x: 100, y: 200 }, { x: 150, y: 150 }, { x: 255, y: 255 }]
]
check('a sampled design has 10 points and encodes for the pad', designs.every((d) => {
  const pts = hsNormalizeCurve(ljSampleDesign(d, { start: 30, antiStart: 50, end: 950, antiEnd: 1000 }, 10))
  return pts.length === 10 && !throws(() => encodeCurve(pts))
}))
check('zones on a 10-point curve: deadzone 5%, floor 8%, outer 90%', (() => {
  const z = ljCurveZones(ljFitZones(LIN10, { start: 50, antiStart: 80, end: 900, antiEnd: 1000 }, 10), 10)
  return z.start === 50 && z.antiStart === 80 && z.end === 900 && z.antiEnd === 1000
})())
check('normalize lifts the last output to 1000 and removes dips', hsNormalizeCurve([[0, 0], [500, 600], [600, 500], [1000, 900]]).join() === '0,0,500,500,600,500,1000,1000')

// --- Polling: ACTION_START on USB_INPUT_POLICY only, Hub bytes, pad re-plugs afterwards.
check('4 kHz encodes like the Hub (rateCode 6, bInterval 2, flags kept)', encodePolling(4000, hex(LIVE['0/2'])).join() === '2,6,2,3,0,0')
check('unknown polling rate refused', throws(() => encodePolling(3000, hex(LIVE['0/2']))))
check('firmware without bInterval support refused', throws(() => encodePolling(1000, [2, 6, 1, 2, 0, 0])))
check('ACTION_START refused for anything but polling and USB mode', throws(() => hsRequest(HsCmd.ActionStart, 1, 6, 2)) && throws(() => hsRequest(HsCmd.ActionStart, 1, 0, 7)) && !throws(() => hsRequest(HsCmd.ActionStart, 1, 0, 2, 0, 0, [2, 6, 2, 3, 0, 0])))
const poll = fakePad()
const pres = await createHsSession(async () => poll.port, async () => {}).writeVerified('fake', { pollingHz: 1000 })
check('polling change sends ACTION_START once and reports the re-plug', pres.reconnecting?.pollingHz === 1000 && pres.written.join() === 'UsbInputPolicy' && poll.sent.filter((c) => c === 8).length === 1 && poll.store['0/2'].join() === '2,6,4,3,0,0')
check('same polling rate sends nothing', (await createHsSession(async () => fakePad().port, async () => {}).writeVerified('fake', { pollingHz: 8000 })).written.length === 0)

// --- Profiles, USB mode, buttons and keyboard (live fw 2.66 bytes).
check('CRC-32 matches the IEEE check value', hsCrc32([...'123456789'].map((c) => c.charCodeAt(0))) === 0xcbf43926)
check('USB identities: XInput, DS4, Switch and PS4 forms all match the Driver interface', [[0x170, 0xbb80], [0x54c, 0x9cc], [0x57e, 0x2009], [0x1532, 0x401]].every(([v, p]) => isHsIdentity({ vendorId: v, productId: p, usagePage: 0xff60, usage: 0x61 })) && !isHsIdentity({ vendorId: 0x54c, productId: 0x9cc, usagePage: 1, usage: 5 }))
const profiles = decodeProfiles(hex(LIVE['0/8']))
check('profiles decode: 4 named slots, P1 XInput, P2–P4 DS4, all 8 kHz', profiles.length === 4 && profiles[0].name === '配置1' && profiles[3].name === '配置4' && profiles.map((p) => p.usbMode).join() === '1,0,0,0' && profiles.every((p) => p.pollingHz === 8000))
check('profile names re-encode to the live 101 bytes', encodeProfileNames(profiles).join() === hex(LIVE['0/8']).slice(0, 101).join())
check('long names are cut on a UTF-8 boundary', encodeProfileNames([{ name: '配'.repeat(9), usbMode: 1 }]).slice(2, 26).filter((v) => v !== 0).length === 24)
check('USB mode encodes like the Hub; unsupported mode refused', encodeUsbMode(0, hex(LIVE['0/3'])).join() === '1,0,1,0,0,0,0,0' && throws(() => encodeUsbMode(3, hex(LIVE['0/3']))))
check('ACTION_START allowed for USB mode, still refused for calibration', !throws(() => hsRequest(HsCmd.ActionStart, 1, 0, 3, 0, 0, [1, 0, 1, 0, 0, 0, 0, 0])) && throws(() => hsRequest(HsCmd.ActionStart, 1, 6, 2)))
const raw = Object.fromEntries(Object.entries({ NativeButtonRemap: '4/2', ExtraButtonMap: '4/1', ExtraKeyboardMap: '5/1', NativeKeyboardMap: '5/2' }).map(([k, a]) => [k, hex(LIVE[a])]))
const btn = decodeButtons(raw)
check('buttons decode: identity map, XInput touchpad = View, nothing extra, keyboard off', btn.native.slice(0, 17).every(([a, b], i) => a === i + 1 && b === 0) && btn.touchpad.join() === '18,15,18' && btn.extra.every(([a]) => a === 0) && !btn.keyboardEnabled)
check('native remap re-encodes to the live 42 bytes', encodeNativeRemap(btn.native, btn.touchpad).join() === hex(LIVE['4/2']).join())
check('empty extra map re-encodes to the live 35 bytes', encodeExtraMap(btn.extra).join() === hex(LIVE['4/1']).join())
check('keyboard maps re-encode (apply flag 1 where the pad reads 0)', encodeExtraKeys(false, btn.extraKeys).slice(1).join() === hex(LIVE['5/1']).slice(1).join() && encodeNativeKeys(btn.nativeKeys).slice(1).join() === hex(LIVE['5/2']).slice(1).join())
check('buffer writes refused for objects Stick Labs does not write', throws(() => hsRequest(HsCmd.BufferSet, 1, 6, 1, 0, 0, [1])) && !throws(() => hsRequest(HsCmd.BufferSet, 1, 5, 2, 0, 0, [1], 60)))

const kb = fakePad()
const kbs = createHsSession(async () => kb.port, async () => {})
const kbSnap = await kbs.readSnapshot('fake')
check('snapshot carries profiles and buttons', kbSnap.profiles[1].name === '配置2' && kbSnap.buttons.touchpad[1] === 15 && kbSnap.usbModes.join() === '0,1,2')
const nativeKeys = kbSnap.buttons.nativeKeys.map((k, i) => (i === 0 ? { keycode: 44, modifier: 0 } : k))
const kres = await kbs.writeVerified('fake', { buttons: { ...kbSnap.buttons, native: kbSnap.buttons.native.map((p, i) => (i === 0 ? [0, 0] as [number, number] : p)), nativeKeys, keyboardEnabled: true }, profileNames: ['Apex', '配置2', '配置3', '配置4'] })
check('A to Space: native map, 60-byte keyboard map via the buffer path, keyboard enabled, name saved', kres.snapshot.buttons.nativeKeys[0].keycode === 44 && kres.snapshot.buttons.native[0][0] === 0 && kres.snapshot.buttons.keyboardEnabled && kres.snapshot.profiles[0].name === 'Apex' && kb.sent.includes(11) && kb.sent.includes(12))
const sw = fakePad()
const swres = await createHsSession(async () => sw.port, async () => {}).switchProfile('fake', 2)
check('switching to a DS4 profile writes PROFILE_ACTIVE, does not save, and expects a re-plug', swres.reconnecting && swres.snapshot === null && sw.sent.includes(4) && !sw.sent.includes(6))
const same = fakePad()
for (const at of [26, 51, 76]) same.store['0/8'][at] = 1
const sameRes = await createHsSession(async () => same.port, async () => {}).switchProfile('fake', 2)
check('switching to a same-mode profile reads P3 back without a re-plug', sameRes.snapshot?.profile === 3 && !sameRes.reconnecting && !same.sent.includes(6))

// --- Calibration (Hub CalibrationPage chunk): ACTION_START on 6/2 with [cmd, 1, type] only.
check('calibration payloads match the Hub', calPayload('begin', 'range').join() === '1,1,2' && calPayload('end', 'range').join() === '2,1,2' && calPayload('begin', 'center').join() === '1,1,1' && calPayload('sample', 'center').join() === '3,1,1' && calPayload('end', 'center').join() === '2,1,1')
check('range has no sample step', throws(() => calPayload('sample', 'range')))
check('calibration action only takes the Hub payloads', !throws(() => hsRequest(HsCmd.ActionStart, 1, 6, 2, 0, 0, [1, 1, 2])) && throws(() => hsRequest(HsCmd.ActionStart, 1, 6, 2, 0, 0, [4, 1, 1])) && throws(() => hsRequest(HsCmd.ActionStart, 1, 6, 2, 0, 0, [3, 1, 2])) && throws(() => hsRequest(HsCmd.ActionStart, 1, 6, 2, 0, 0, [1, 2, 1])))
check('no SET_VALUE on the calibration action; fine-tune only as 24 bytes', throws(() => hsRequest(HsCmd.SetValue, 1, 6, 2, 0, 0, [1, 1, 1])) && throws(() => hsRequest(HsCmd.SetValue, 1, 6, 1, 0, 0, [1, 2])) && !throws(() => hsRequest(HsCmd.SetValue, 1, 6, 1, 0, 0, new Array(24).fill(0))))
check('factory reset is still refused', throws(() => hsRequest(7, 1)))
const cal = fakePad()
const cs = createHsSession(async () => cal.port, async () => {})
await cs.calibrate('fake', 'begin', 'range')
await cs.calibrate('fake', 'end', 'range')
await cs.calibrateCenterAuto('fake')
check('range then auto center sends exactly the Hub sequence', cal.actions.join(' | ') === '1,1,2 | 2,1,2 | 1,1,1 | 3,1,1 | 3,1,1 | 3,1,1 | 2,1,1')
check('calibration checks the action lane and never saves or resets', cal.sent.includes(9) && !cal.sent.includes(6) && !cal.sent.includes(7))
const ft = await cs.readFineTune('fake')
check('fine-tune reads 12 u16 values', ft.join() === '10,20,30,40,50,60,70,80,90,100,110,120')
const ft2 = await cs.writeFineTune('fake', ft.map((v) => v + 1))
check('fine-tune write reads back the new values', ft2[0] === 11 && ft2[11] === 121 && cal.store['6/1'][0] === 11)
let badFt = false
try { await cs.writeFineTune('fake', [1, 2, 3]) } catch { badFt = true }
check('fine-tune write refuses anything but 12 values', badFt)

console.log('ALL HYPERSTRIKE TESTS PASSED')
