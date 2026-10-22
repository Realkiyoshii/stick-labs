// Button remap: 1:1 key binding, same bytes Connect writes.
//
// Encoding (recovered from Connect 1.16.7: map_en = any target set, values
// padded to 3 with 0): byte2 bit0 = mapped, bytes 3-5 = target indices.
// Turbo (bytes 0-1) and toggle (byte 6) are never touched by this app.
import { Packet, button, stick } from '../src/shared/profile'
import { keyLabel, displayMapping, REMAP_TARGETS } from '../src/shared/keymap'

let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.log(`✗ FAIL: ${name}`)
    failed++
  }
}

function blankButton(): Packet {
  return new Packet(new Uint8Array(7))
}

// write path: A onto a blank packet
{
  const p = blankButton()
  button.setMap(p, [9, 0, 0])
  check('remap bytes are [0,0,1,9,0,0,0]', JSON.stringify(Array.from(p.bytes)) === JSON.stringify([0, 0, 1, 9, 0, 0, 0]))
  check('mapped reads back true', button.mapped(p))
  check('values read back [9,0,0]', JSON.stringify(button.mapValues(p)) === JSON.stringify([9, 0, 0]))
}

// unmap clears the bit and the values
{
  const p = blankButton()
  button.setMap(p, [9, 0, 0])
  button.setMap(p, [0, 0, 0])
  check('unmap clears mapped bit', !button.mapped(p))
  check('unmap zeroes values', JSON.stringify(button.mapValues(p)) === JSON.stringify([0, 0, 0]))
}

// turbo + toggle bytes survive a remap untouched
{
  const p = blankButton()
  button.setTurbo(p, true, 20)
  button.setToggle(p, true)
  button.setMap(p, [10, 0, 0])
  check('turbo preserved', button.turboEnabled(p) && button.turboSpeed(p) === 20)
  check('toggle preserved', button.toggleOnPress(p))
  check('map landed alongside', JSON.stringify(button.mapValues(p)) === JSON.stringify([10, 0, 0]))
}

// hardware case: Camera button holding 82 (T), as seen in profile_1.bin
{
  const p = new Packet(new Uint8Array([0x00, 0x00, 0x01, 0x52, 0x00, 0x00, 0x00]))
  check('fixture Camera maps to [82,0,0]', JSON.stringify(button.mapValues(p)) === JSON.stringify([82, 0, 0]))
  check('fixture Camera displays as T', displayMapping(button.mapValues(p)) === 'T')
}

// key labels (Connect 1.16.7 ko parity)
{
  check('0 is em-dash', keyLabel(0) === '—')
  check('9 is A (Xbox layout)', keyLabel(9) === 'A')
  check('16 is Camera', keyLabel(16) === 'Camera')
  check('17 is FL1', keyLabel(17) === 'FL1')
  check('20 is R2', keyLabel(20) === 'R2')
  check('82 is T', keyLabel(82) === 'T')
  check('204 is Mouse Button 4 (non-sequential)', keyLabel(204) === 'Mouse Button 4')
  check('203 is Mouse Button 5 (non-sequential)', keyLabel(203) === 'Mouse Button 5')
  check('255 is No change', keyLabel(255) === 'No change (NC)')
  check('29 shows raw (unverified TP)', keyLabel(29) === '#29')
  check('37 is Screenshot (observed on T3CE)', keyLabel(37) === 'Screenshot')
  check('unknown shows #n', keyLabel(999) === '#999')
}

// tournament-safe target list: single controller + keyboard keys
{
  check('128 targets (0–20 + 50–155 + Shift)', REMAP_TARGETS.length === 128 && REMAP_TARGETS.some((k) => k.value === 231))
  check('controller targets present', [0, 1, 16, 17, 20].every((v) => REMAP_TARGETS.some((k) => k.value === v)))
  check('every keyboard key present', Array.from({ length: 106 }, (_, i) => i + 50).every((v) => REMAP_TARGETS.some((k) => k.value === v)))
  check('no mouse/special targets except Shift', REMAP_TARGETS.every((k) => k.group === 'none' || k.group === 'controller' || k.group === 'function' || k.group === 'keyboard' || k.value === 231))
}

// keyboard target write path (Camera -> T, the hardware-verified case)
{
  const p = blankButton()
  button.setMap(p, [82, 0, 0])
  check('keyboard target bytes are [0,0,1,82,0,0,0]', JSON.stringify(Array.from(p.bytes)) === JSON.stringify([0, 0, 1, 82, 0, 0, 0]))
}

// display strings
{
  check('empty displays as em-dash', displayMapping([0, 0, 0]) === '—')
  check('10 is B, 11 is X, 12 is Y', keyLabel(10) === 'B' && keyLabel(11) === 'X' && keyLabel(12) === 'Y')
  check('single displays plain', displayMapping([9, 0, 0]) === 'A')
  check('multi (Connect-written) displays joined', displayMapping([9, 10, 0]) === 'A + B')
}

// function-key packets (FL1/FR1, 169 bytes) share the same 7-byte map head:
// turbo@0, speed@1, map_en@2, values@3-5, toggle@6 — macro storage (7+) untouched
{
  const p = new Packet(new Uint8Array(169))
  // simulate a macro tail so we can prove it survives
  p.setU8(7, 0x05)
  p.setU8(11, 0xab)
  p.setU8(168, 0xcd)
  button.setMap(p, [12, 0, 0])
  check('function packet map head written', p.u8(2) === 1 && p.u8(3) === 12 && p.u8(4) === 0 && p.u8(5) === 0)
  check('function packet macro tail preserved', p.u8(7) === 0x05 && p.u8(11) === 0xab && p.u8(168) === 0xcd)
  check('function packet map reads back', JSON.stringify(button.mapValues(p)) === JSON.stringify([12, 0, 0]))
}

// hardware case: profile_1.bin FL1 head [01 1e 01 04 ...] decodes per Connect
{
  const p = new Packet(new Uint8Array([0x01, 0x1e, 0x01, 0x04, 0x00, 0x00, 0x00, ...new Array(162).fill(0)]))
  check('fixture FL1 mapped bit set', button.mapped(p))
  check('fixture FL1 values [4,0,0] (D-pad Right)', JSON.stringify(button.mapValues(p)) === JSON.stringify([4, 0, 0]))
}

// output lock: Mouse output can never reach the pad on locked sticks
{
  const mk = (): Packet[] => {
    const l = new Packet(new Uint8Array(36))
    const r = new Packet(new Uint8Array(36))
    stick.setMapIndex(l, 4)
    stick.setMapIndex(r, 2)
    stick.setDeadzone(l, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 })
    return [l, r]
  }
  const both = mk()
  check('locked mouse stick forced to stick 1', stick.lockStickOutput(both, [true, false]) === true)
  check('left back to index 1', stick.mapIndex(both[0]) === 1)
  check('unlocked stick untouched', stick.mapIndex(both[1]) === 2)
  check('deadzone bytes untouched by lock', JSON.stringify(stick.deadzone(both[0])) === JSON.stringify({ begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 }))
  const clean = mk()
  stick.setMapIndex(clean[0], 1)
  check('no change reported when already stick', stick.lockStickOutput(clean, [true, true]) === false)
  const right = mk()
  stick.setMapIndex(right[1], 4)
  check('right stick forced to index 2', stick.lockStickOutput(right, [false, true]) === true && stick.mapIndex(right[1]) === 2)
}

if (failed > 0) {
  console.log(`${failed} FAILURES`)
  process.exit(1)
}
console.log('ALL BUTTON REMAP TESTS PASSED')
