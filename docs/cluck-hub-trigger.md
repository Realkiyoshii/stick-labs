# Trigger settings compatibility

Reference inspected 2026-10-17: https://gs.evua.cc/#/trigger.

Public bundles: index-Dp35FMMT.js, TriggerPage-ETi4JGt6.js,
AxisSettings.vue_vue_type_script_setup_true_lang-B-cDwRUc.js.
These are the current bundles, rather than the earlier calibration snapshot.

## Interface and value mapping

- Left/right selection; independent Basic and Advanced parameter tabs.
- Basic: custom deadzone enable; start deadzone, full-range position, starting
  output, maximum output. All four fields are 0–100%, step 0.1; both start
  values must be strictly smaller than their corresponding end values.
- Enable sets byte 2 to 1 and repairs invalid input/output pairs to 0/1000.
  Disable sets byte 2 to 0. Valid stored ranges otherwise remain unchanged.
- Advanced rapid-trigger mode: Off=0, Mode 1=129, Mode 2=130 at byte 16.
  Start/end are integer 1–100 at bytes 17/18, editable only when bit 7 is set.
  Selecting Off preserves the stored start/end values. No invented adaptive
  or fixed names are assigned to these modes.
- Curves: Default, Quick, Precise, Steady, Digital, Dynamic, Custom. Adjustment
  -5..+5 is disabled for Default/Custom. Changing an adjustable preset retains
  the previous adjustment. There are exactly five encoded points; endpoints
  P1/P5 are locked. X and Y must both strictly increase, with byte resolution.
- Dragging quantizes to byte steps, prevents crossings, supports keyboard
  arrows (Shift moves five steps), and never adds/removes points.

## Profile offsets (relative to each 32-byte trigger packet)

| Bytes | Meaning |
|---|---|
| 2 | Custom deadzone enabled |
| 3–4 / 5–6 | Input start / full range, unsigned big endian, 0–1000 |
| 7–8 / 9–10 | Output start / maximum output, unsigned big endian, 0–1000 |
| 16 | Rapid mode 0 / 129 / 130 |
| 17 / 18 | Rapid start / end, percentage bytes |
| 19 / 20 / 21 | Curve enabled / type / strength; presets use 1 / 3 / 100 |
| 22–31 | Five interleaved x/y pairs, 0–255 |

G7ProCE trigger packets start at 0x354/0x374; T3CE at 0x6a1/0x6c1.
Name, stick settings, button mapping, toggle, and other profile data are
preserved. LeadJoy uses a different protocol and is not changed by this UI.

## Evidence and application

fixtures/gamesir-trigger/website-vectors.json records the reference bundle's
SHA-256, 66 complete preset packet outputs, and 12 complete range-edit outputs.
They were generated from the isolated, inspected pure reference functions
(no website application code, controller access, or network requests executed).
tests/trigger.ts compares all 32 bytes, validates malformed inputs, and checks
full-profile isolation on both supported GameSir geometries.

The site automatically saves profiles; Stick Labs stages changes for its
existing Write to controller action, which acknowledges and reads back the
profile.

## Live proof: Tarantula 8K, firmware 0243

Approved hardware check on 2026-10-17: backed up inactive profile 4 while
profile 1 remained active. Wrote LT input 10%/95%, output 5%/90%, Quick curve
at adjustment +1, rapid mode 129 with start/end 10/90. The entire 1935-byte
readback matched the requested profile. Only the LT 32-byte region changed.
The active profile was read again and remained byte-identical.

Then restored profile 4 and verified the entire original profile byte for
byte. Original/restored SHA-256 and the isolated trigger packet captures are
in fixtures/gamesir-trigger/t3ce-0243-readback.json. Full local backups remain
under .probe-tmp/trigger-live/2026-10-17T17-42-34-808Z/.

This proves storage/readback and restoration on this T3CE firmware. It does
not measure the physical trigger response or establish live proof on G7ProCE;
that model's geometry and packet isolation are covered by the offline tests.
