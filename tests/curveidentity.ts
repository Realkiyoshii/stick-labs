// Curve identity: curve writes must reset the linear-module transform bytes,
// and the neutral state must be the calibrated identity (not a bare enable
// flip). The vendor's "Raw" is a different knob entirely — the `stick_square`
// trajectory — and GameSir's own app never clears `stick_en`.
import { Packet, stick, LINEAR_CURVE } from '../src/shared/profile'

let failed = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.log(`✗ FAIL: ${name}`)
    failed++
  }
}

function blankStick(): Packet {
  return new Packet(new Uint8Array(36))
}

// applyPhysics produces the full raw identity state
{
  const p = blankStick()
  stick.applyPhysics(p)
  const lm = stick.linearModule(p)
  check('physics: linear module en=1/type=0/rate=100', lm.en && lm.type === 0 && lm.rate === 100)
  const dz = stick.deadzone(p)
  check('physics: deadzone 0/1000/0/1000', dz.begin === 0 && dz.end === 1000 && dz.beginAnti === 0 && dz.endAnti === 1000)
  check('physics: dead_en on (else firmware falls back to 5%)', stick.deadEnabled(p))
  check('physics: linear points', JSON.stringify(stick.curve(p)) === JSON.stringify(LINEAR_CURVE.map((q) => ({ ...q }))))
  check('physics: axis ratio neutral 50', stick.axisRatio(p) === 50)
}

// a GameSir-shaped state (like profile_1 stick1: type=3/rate=74) is NOT raw,
// and rewriting identity over it heals it
{
  const p = blankStick()
  stick.setEnabled(p, true)
  stick.setDeadzone(p, { begin: 0, end: 1000, beginAnti: 0, endAnti: 1000 })
  stick.setCurve(p, [
    { x: 38, y: 46 }, { x: 77, y: 82 }, { x: 128, y: 122 }, { x: 179, y: 176 }, { x: 217, y: 219 }
  ])
  stick.setLinearModule(p, true, 3, 74)
  stick.setAxisRatio(p, 50)
  check('shaped state is not neutral', !stick.isNeutralState(p))
  check('shaped state is not identity curve', !stick.isIdentityCurve(p))
  // what every curve Send now does: points + identity mark
  stick.setCurve(p, LINEAR_CURVE.map((q) => ({ ...q })))
  stick.markCurveIdentity(p)
  check('rewritten linear is identity curve', stick.isIdentityCurve(p))
}

// legacy bypass (stick_en clear, written by older app versions) still counts as
// neutral for classification — but it is NOT GameSir's Raw, and this app no
// longer writes it (the UI reports it instead).
{
  const p = blankStick()
  stick.applyPhysics(p)
  stick.setEnabled(p, false)
  check('legacy stick_en=0 is neutral', stick.isNeutralState(p))
}

// full neutral write path: physics + enabled + round gate reads as neutral
{
  const p = blankStick()
  stick.setLinearModule(p, true, 1, 65)
  stick.setDeadzone(p, { begin: 50, end: 800, beginAnti: 80, endAnti: 1000 })
  stick.applyPhysics(p)
  stick.setEnabled(p, true)
  stick.setSquareGate(p, false)
  check('identity write path is neutral', stick.isNeutralState(p))
  const lm = stick.linearModule(p)
  check('identity write path: b11/b12/b13 = 1/0/100', p.u8(11) === 1 && lm.type === 0 && lm.rate === 100)
}

// the legacy bypass is non-destructive: only the enable bit flips, everything
// else is preserved, so leaving it restores the exact previous tune
{
  const p = blankStick()
  stick.setEnabled(p, true)
  stick.setSquareGate(p, true)
  stick.setDeadzone(p, { begin: 50, end: 800, beginAnti: 80, endAnti: 1000 })
  stick.setCurve(p, [
    { x: 38, y: 46 }, { x: 77, y: 82 }, { x: 128, y: 122 }, { x: 179, y: 176 }, { x: 217, y: 219 }
  ])
  stick.setLinearModule(p, true, 3, 74)
  stick.setAxisRatio(p, 46)
  const before = Array.from(p.bytes)
  // ...what the old raw button did:
  stick.setEnabled(p, false)
  check('bypass still classifies as neutral', stick.isNeutralState(p))
  const diffs = before.map((b, i) => (b === p.bytes[i] ? -1 : i)).filter((i) => i >= 0)
  check('bypass flips only the enable bit', JSON.stringify(diffs) === JSON.stringify([0]))
  // ...and leaving it restores the tune byte-for-byte:
  stick.setEnabled(p, true)
  check('leaving the bypass restores every byte', JSON.stringify(Array.from(p.bytes)) === JSON.stringify(before))
  check('restored tune is not neutral', !stick.isNeutralState(p))
}

// a non-neutral tune disqualifies the neutral state
{
  const p = blankStick()
  stick.applyPhysics(p)
  stick.setEnabled(p, true)
  stick.setSquareGate(p, true)
  check('square trajectory is not the neutral state', !stick.isNeutralState(p))
  stick.setSquareGate(p, false)
  stick.setDeadzone(p, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 })
  check('5% deadzone is not the neutral state', !stick.isNeutralState(p))
}

// GameSir parity: their "Stick Trajectory" is the stick_square byte alone, with
// stick_en kept at 1 in every vendor code path. The card's two buttons must
// produce exactly those two byte states, and never a cleared stick_en.
{
  const p = blankStick()
  // Circle
  stick.setEnabled(p, true)
  stick.setSquareGate(p, false)
  check('Circle = stick_en 1 / stick_square 0', p.u8(0) === 1 && p.u8(1) === 0)
  // Raw
  stick.setEnabled(p, true)
  stick.setSquareGate(p, true)
  check('Raw = stick_en 1 / stick_square 1', p.u8(0) === 1 && p.u8(1) === 1)
  check('Raw is not a bypass', !stick.isProfileBypassed(p))
  stick.setEnabled(p, false)
  check('bypass is detected', stick.isProfileBypassed(p) && stick.enabled(p) === false)
}

// the Physics preset must leave the trajectory choice alone: a Raw stick stays
// Raw, and nothing in it clears stick_en
{
  const p = blankStick()
  stick.setEnabled(p, true)
  stick.setSquareGate(p, true)
  stick.applyPhysics(p)
  check('physics keeps Raw (stick_square 1)', stick.squareGate(p) && p.u8(1) === 1)
  check('physics leaves stick_en at 1', p.u8(0) === 1 && !stick.isProfileBypassed(p))
  const q = blankStick()
  stick.setEnabled(p, true)
  stick.setSquareGate(q, false)
  stick.applyPhysics(q)
  check('physics keeps Circle (stick_square 0)', !stick.squareGate(q) && q.u8(1) === 0)
}

// Regression: selecting the exact same points must still remove Connect's transform.
for (const [en, type, rate] of [[true, 3, 74], [true, 1, 65], [false, 0, 100], [true, 0, 50]] as const) {
  const p = blankStick()
  stick.applyPhysics(p)
  stick.setLinearModule(p, en, type, rate)
  const points = stick.curve(p)
  const before = Array.from(p.bytes)
  check(`same points with vendor transform ${en}/${type}/${rate} need replacement`, !stick.matchesCurveIdentity(p, points))
  if (!stick.matchesCurveIdentity(p, points)) {
    stick.setCurve(p, points)
    stick.markCurveIdentity(p)
  }
  check('replacement removes vendor shaping', stick.matchesCurveIdentity(p, points))
  check('replacement preserves every unrelated stick byte', Array.from(p.bytes).every((v, i) => (i >= 11 && i <= 13) || v === before[i]))
  const stable = JSON.stringify(Array.from(p.bytes))
  check('a repeated curve selection is now a true no-op', stick.matchesCurveIdentity(p, points) && JSON.stringify(Array.from(p.bytes)) === stable)
}

if (failed > 0) {
  console.log(`${failed} FAILURES`)
  process.exit(1)
}
console.log('ALL CURVE IDENTITY TESTS PASSED')
