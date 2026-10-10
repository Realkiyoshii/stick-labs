/**
 * MARIUS protocol unit tests — pure offline parsing, no hardware.
 *
 *   node scripts/test.mjs tests/marius.ts
 */
import {
  MARIUS_CONFIG_LEN,
  MARIUS_FLAGS_VALID,
  decodeMariusFamily,
  decodeMariusRaw,
  isMariusFamily,
  mariusChunkHeader,
  mariusHidFrame,
  mariusPollHz,
  parseMariusAppInfo,
  parseMariusConfig,
  uidToHex,
} from '../src/shared/marius.ts'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}`)
    failures++
  }
}

// --- family decode ---------------------------------------------------------
for (const [byte, line, variant] of [
  [0x11, 'MH4', 'analog'],
  [0x12, 'MH4', 'digital'],
  [0x21, 'MH5', 'analog'],
  [0x22, 'MH5', 'digital'],
  [0x31, 'XSX', 'analog'],
  [0x32, 'XSX', 'digital'],
] as const) {
  const f = decodeMariusFamily(byte)
  check(`family 0x${byte.toString(16)} = ${line}/${variant}`, f.line === line && f.variant === variant && isMariusFamily(f))
}
const ds4 = decodeMariusFamily(0x00)
check('family 0x00 rejected (real DualShock gate)', !isMariusFamily(ds4))
check('analog = 12-bit', decodeMariusFamily(0x11).bits === 12)
check('digital = 14-bit', decodeMariusFamily(0x12).bits === 14)

// --- identity ----------------------------------------------------------------
const info = new Uint8Array(64)
info[4] = 0x02
info[5] = 0x01
const nameBytes = new TextEncoder().encode('MH5-Analog-TestPad')
info.set(nameBytes, 6)
info[38] = 0x21
info[39] = 0x03
info.set(new TextEncoder().encode('2026-01-15'), 40)
const uid = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
const ident = parseMariusAppInfo(info, uidToHex(uid))
check('version 1.2 (BCD major=hi)', ident.versionMajor === 1 && ident.versionMinor === 2)
check('name parsed', ident.name === 'MH5-Analog-TestPad')
check('family MH5/analog', ident.family.line === 'MH5' && ident.family.variant === 'analog')
check('hwRev 3', ident.hwRev === 3)
check('build date', ident.buildDate === '2026-01-15')
check('uid 24-hex', ident.uid === '000102030405060708090a0b')

const ffHw = new Uint8Array(64)
ffHw[39] = 0xff
check('hwRev 0xFF treated as 0', parseMariusAppInfo(ffHw, '').hwRev === 0)

// --- config ------------------------------------------------------------------
function makeConfig(flags: number): Uint8Array {
  const c = new Uint8Array(MARIUS_CONFIG_LEN)
  c[0] = 0 // analog triggers
  c[1] = 2 // VERSION
  c[2] = flags
  const w16 = (off: number, v: number): void => {
    c[off] = v & 0xff
    c[off + 1] = (v >> 8) & 0xff
  }
  w16(3, 2048)
  w16(5, 2048)
  w16(7, 2048)
  w16(9, 2048)
  w16(11, 300)
  w16(13, 3800) // LxMin/LxMax
  w16(15, 280)
  w16(17, 3790)
  w16(19, 310)
  w16(21, 3810)
  w16(23, 290)
  w16(25, 3800)
  c[27] = 10
  c[28] = 0 // 5% / 0%
  c[29] = 8
  c[30] = 4
  w16(31, 2100)
  w16(33, 800)
  w16(35, 2100)
  w16(37, 800)
  c[39] = 50
  w16(46, 0x1234)
  w16(48, 0x0001)
  c[60] = 0xff // full 12-bit
  c[61] = 0xce
  c[62] = 0x01
  c[63] = 12
  c[211] = 0xe7
  c[212] = 11
  c[213] = 0xd7
  c[214] = 0x01
  const s16 = (off: number, v: number): void => w16(off, v < 0 ? v + 0x10000 : v)
  s16(215, 0)
  s16(217, 50)
  s16(219, -75)
  s16(221, 1000)
  return c
}

const cfg = parseMariusConfig(makeConfig(0xca))
check('config valid with 0xCA marker', cfg.valid)
check('config valid with 0xC0 marker', parseMariusConfig(makeConfig(0xc0)).valid)
check('config invalid without marker', !parseMariusConfig(makeConfig(0x00)).valid)
check('erased (all 0xFF) invalid', !parseMariusConfig(new Uint8Array(MARIUS_CONFIG_LEN).fill(0xff)).valid)
check('centers 2048', cfg.center.lx === 2048 && cfg.center.ry === 2048)
check('left range', cfg.rangeLeft.xMin === 300 && cfg.rangeLeft.xMax === 3800 && cfg.rangeLeft.yMin === 280 && cfg.rangeLeft.yMax === 3790)
check('right range', cfg.rangeRight.xMin === 310 && cfg.rangeRight.xMax === 3810)
check('legacy deadzone /2', cfg.deadzone.leftIn === 5 && cfg.deadzone.leftOut === 0 && cfg.deadzone.rightIn === 4 && cfg.deadzone.rightOut === 2)
check('triggers 2100/800', cfg.triggers.l2Start === 2100 && cfg.triggers.l2End === 800)
check('hair 50', cfg.hairPct === 50)
check('curves blob', cfg.curvesPresent && cfg.curvesLength === 12)
check('right eff bits + ext marker', cfg.rightEffectiveBits === 11 && cfg.rightEffectiveBitsPresent)
check(
  'ext deadzones signed /10',
  cfg.extDeadzone !== null &&
    cfg.extDeadzone.leftIn === 0 &&
    cfg.extDeadzone.leftOut === 5 &&
    cfg.extDeadzone.rightIn === -7.5 &&
    cfg.extDeadzone.rightOut === 100
)
const inv = parseMariusConfig(makeConfig(0xc0 | 0x05))
check('invert flags Lx+Rx', inv.invert.lx && !inv.invert.ly && inv.invert.rx && !inv.invert.ry)

// --- framing -----------------------------------------------------------------
const frame = mariusHidFrame(0x11, [0, 0, 0, 57])
check('hid frame 64B report 0x90', frame.length === 64 && frame[0] === 0x90 && frame[1] === 0x11)
check('chunk header BE', JSON.stringify(mariusChunkHeader(0x0100, 57)) === JSON.stringify([1, 0, 0, 57]))

// --- misc --------------------------------------------------------------------
check('bInterval 1 = 8000Hz', mariusPollHz(1) === 8000)
check('bInterval 4 = 1000Hz', mariusPollHz(4) === 1000)
const raw12 = decodeMariusRaw(new Uint8Array([0x08, 0x00, 0x07, 0xff]), 12)
check('raw 12-bit decode', raw12.x === 2048 && raw12.y === 2047)
const raw14 = decodeMariusRaw(new Uint8Array([0x3f, 0xff, 0x00, 0x00]), 14)
check('raw 14-bit mask 0x3F', raw14.x === 16383 && raw14.y === 0)

// --- reference vectors: fake-transport.js #buildAppInfo / #buildConfig ----
// (mh4-d-ds4 profile: 'MH4-D v1.36', family 0x12, hwRev 1, 'May 30 2026')
const refInfo = new Uint8Array(64)
refInfo[4] = 36
refInfo[5] = 1
refInfo.set(new TextEncoder().encode('MH4-D v1.36'), 6)
refInfo[38] = 0x12
refInfo[39] = 1
refInfo.set(new TextEncoder().encode('May 30 2026'), 40)
const refIdent = parseMariusAppInfo(refInfo, 'uid-here')
check('ref identity version 1.36', refIdent.versionMajor === 1 && refIdent.versionMinor === 36)
check('ref identity name', refIdent.name === 'MH4-D v1.36')
check('ref identity MH4/digital', refIdent.family.line === 'MH4' && refIdent.family.variant === 'digital')
check('ref identity 14-bit + hwRev 1', refIdent.family.bits === 14 && refIdent.hwRev === 1)
check('ref identity build date', refIdent.buildDate === 'May 30 2026')

const refCfg = new Uint8Array(256)
const w16 = (off: number, v: number): void => {
  refCfg[off] = v & 0xff
  refCfg[off + 1] = (v >> 8) & 0xff
}
refCfg[0] = 0
refCfg[1] = 2
refCfg[2] = 0xc0
w16(3, 2048)
w16(5, 2048)
w16(7, 2048)
w16(9, 2048)
w16(11, 300)
w16(13, 3800)
w16(15, 280)
w16(17, 3790)
w16(19, 310)
w16(21, 3810)
w16(23, 290)
w16(25, 3800)
w16(31, 600)
w16(33, 2000)
w16(35, 600)
w16(37, 2000)
refCfg[39] = 50
refCfg.fill(0xff, 40, 46)
refCfg[50] = 2
refCfg[51] = 255
refCfg[52] = 0
refCfg[53] = 255
refCfg[54] = 255
refCfg[55] = 255
refCfg[56] = 0
refCfg[57] = 255
w16(58, 3000)
const ref = parseMariusConfig(refCfg)
check('ref config valid (0xC0 canonical)', ref.valid)
check('ref centers', ref.center.lx === 2048 && ref.center.ry === 2048)
check('ref ranges', ref.rangeLeft.xMin === 300 && ref.rangeLeft.xMax === 3800 && ref.rangeRight.yMin === 290 && ref.rangeRight.yMax === 3800)
check('ref triggers 600/2000 + hair 50', ref.triggers.l2Start === 600 && ref.triggers.l2End === 2000 && ref.hairPct === 50)
check('ref buttonMap erased (0xFF)', ref.buttonMap.every((b) => b === 0xff))
check('ref LED mode 2 period 3000', ref.led.mode === 2 && ref.led.period === 3000)
check('ref full 12-bit (byte60=0)', ref.leftEffectiveBits === 0)
check('ref no curves/blob ext on fresh', !ref.curvesPresent && ref.extDeadzone === null && !ref.rightEffectiveBitsPresent)

if (failures > 0) {
  console.error(`${failures} FAILURES`)
  process.exit(1)
}
console.log('ALL MARIUS TESTS PASSED')
