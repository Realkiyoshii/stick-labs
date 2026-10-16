# Tarantula 8K (T3CE) — hardware research + app-claim audit

Researched 2026-10-14. Sources: gamesir.com product page, GameSir Connect
1.16.7 bundle (local RE), EnosTech + ETA Prime + Deegital Tech reviews,
r/Gamesir, gamepadla.com spec/test pages, VaktorTV (stick modules),
live hardware (PID 0x103d, firmware 0243, 1935-byte dumps).

## Public hardware facts

- Wired-only USB-C PC pad, $69.99, 180 g (no battery, no rumble motors),
  158×100×61 mm, symmetric PlayStation-style layout, orange shell.
- Sticks: Gen-2 Mag-Res TMR, 5M-cycle modules, 6 swappable caps.
  **Official product page: "12-bit industrial-grade ADC chip."**
  G7 Pro 8K uses custom 5-pin JS13 Pro angle-TMR modules (VaktorTV);
  Tarantula shares the Gen-2 family; per-chip part numbers are NOT public.
- Triggers: Hall analog + microswitch stops (rear hardware switches).
- ABXY: micro switches (5M clicks). D-pad: tactile switches.
- Extras: 9 remappable (FL1/FR1 rear lockable, C1–C4 front, T1–T3),
  32-step macros, turbo 10/20/30 Hz on up to 8 buttons, 4 profiles.
- 6-axis gyro, RGB (Static/Breathing/Colorful/Rainbow/Radar), 3.5 mm jack.
- Polling: 250/1000/4000/8000 gears in Connect (no 500/2000 offered).
- Modes: XInput primary; community reports DS4 and Switch modes exist
  (gyro ~800–1000 Hz there). Wired-only ⇒ no FCC filing exists.

## App-claim audit (all hold, gaps marked)

| Claim | Status |
|---|---|
| 1935-byte profile layout | ✅ proven vs live dumps |
| 9 function packets [FL1,FR1,C1–C4,T1–T3] | ✅ press tests + matches 9-button spec |
| Gear table 250/1000/4000/8000 | ✅ Connect dashboard (review screenshots) |
| 12-bit ceiling | ✅✅ official product page |
| Deadzone/curve/outer codec | ✅ fixtures + live writes |
| Macros 32-step layout | ✅ matches public spec (untouched by design) |
| Turbo bytes | ✅ deliberately untouched (tournament scope) |
| Center trim `0F E2` | ⚠️ UNPROVEN — implemented from Connect RE, never hardware-tested |
| Hair trigger Off/Adaptive/Fixed | ⚠️ exists in Connect, not exposed (deadzone-only by design) |
| DS4/Switch modes | ⚠️ out of scope (XInput/vendor channel only) |
| Gyro/motion/light | ⚠️ documented non-goals |

## Stick Trajectory: "Circle" / "Raw" (2026-10-15)

GameSir Connect 1.16.7 calls the gate switch **Stick Trajectory**
(`StickTrace`), with exactly two options — `StickTrace_Radial: "Circle"` and
`StickTrace_Raw: "Raw"` — described in its own tooltips as, respectively,
"an outer trajectory with a pure circular shape, suitable for some aiming
scenarios" and "an outer trajectory that uses the stick's raw data and presents
a square-circle shape, suitable for scenarios that need easier diagonal input"
(`dist/electron/renderer.js`, en-US block; the zh bundle keeps the label "Raw"
untranslated).

Its codec maps those to the byte this app calls `stick.squareGate` (stick byte
1, vendor name `stick_square`):

```
read:  rawEnabled = true;  if (stick_en) rawEnabled = (stick_square != 0)
write: stick_en = 1;       stick_square = rawEnabled ? 1 : 0
STICKCURVE_MODE = { Square: 0, Circle: 1 };  type = rawEnabled ? Square : Circle
```

So **Raw = `stick_square` 1**, **Circle = 0**, and every `stick_en` assignment
in the vendor bundle is `= 1` — there is **no** vendor mode that clears it, and
their reader treats `stick_en = 0` as `rawEnabled` true by default.

Consequences for this app (changed 2026-10-15 after a user report):

- The two buttons are labelled **Circle / Raw** in vendor wording instead of
  Circle / "Square gate", with hints quoting the vendor description.
- The third option, "Pure raw 1:1" (which wrote `stick_en = 0`), is **gone**.
  It was a legacy invention — `tests/curveidentity.ts` already called it
  "written by older app versions" — and the report that exposed it measured
  that state as a *corrected* outer path (~0% circularity error), the opposite
  of "untouched sensor output". A pad found with `stick_en = 0` now gets a
  one-line notice plus the two real trajectories.
- "No processing" in our UI is the **Physics** preset
  (`stick.applyPhysics`: zero deadzone + linear + identity transform), which
  deliberately leaves the trajectory bit alone — pinned by
  `tests/curveidentity.ts`.
- `stick.isRawState` was renamed `stick.isNeutralState` so the codebase stops
  describing the calibrated identity (or the legacy bypass) as "raw".

## Motherboard note

No public source names the MCU or ADC part numbers on the Tarantula 8K
board. Teardowns show assembly only; wired-only means no FCC internal
photos. The 12-bit figure is vendor-stated (product page), not inferred —
it is the strongest ceiling evidence available short of decapping.
