# HyperStrike sampling reference (read-only research note)

Reverse-engineered from the HyperStrike Hub web app (helium-flash hub,
Vue SPA bundle `assets/index-DetSq_C4.js`, pulled 2026-10-13 via its
Cloudflare Pages origin — the `evua.cc` domain is ISP-blocked and
unarchived). No Stick Labs code touches these registers. GameSir pads do
not implement any of this; do not send these objects to GameSir hardware.

Evidence bundle: `C:\tools\rea-engines\cases\hyperstrike\`.

## Stick Sampling presets → ADC_SAMPLING section (INPUT ch, id 2)

6-byte object: `[version, mode, presetId, divCode, sampleTimeCode, flags]`.
Mode: 1 = preset, 2 = manual. Version: 1 or 2 (tool writes 2).

| UI preset | presetId | Tier | divCode | sampleTimeCode |
|---|---|---|---|---|
| Extreme | 4 | S | 2 (÷6) | 0 (1.5 cycles) |
| Excellent | 3 | A | 3 (÷8) | 0 (1.5 cycles) |
| Good | 2 | B | 2 (÷6) | 1 (7.5 cycles) |
| Robust | 1 | C | 3 (÷8) | 1 (7.5 cycles) |
| Tier D | 5 | D | 3 (÷8) | 2 (13.5 cycles) |
| Tier E | 6 | E | 3 (÷8) | 3 (28.5 cycles) |
| Tier F | 7 | F | 3 (÷8) | 6 (71.5 cycles) |
| Tier G | 8 | G | 3 (÷8) | 7 (239.5 cycles) |
| Custom (manual) | 0 | — | manual | manual |

Faster (÷6, short window) = rawer/slipperier; slower = steadier/duller.
Factory default is Robust. Tiers D–G require newer firmware — the app
silently downgrades on old firmware.

## Advanced Sampling Level → flags byte 5, bits 5–6 (mask 0x60)

| UI | Value | Meaning |
|---|---|---|
| Off | 0 | native sensor rate |
| 14-bit | 1 | light oversampling |
| 15-bit | 2 | balanced oversampling |
| 16-bit | 3 | strong oversampling |

Version-2 configs only. Bit 4 (0x10) of the same byte = overspec-clock
flag: past the 14 MHz ADC spec limit the app warns experimental-only.

## Stick Quantization → XINPUT_STICK_RESOLUTION (INPUT ch, id 1)

4-byte object `[bits, 0, 0, 0]`. Range enforced 8–12; wire `0` = 12
(Unlimited), else literal bits. XInput path only — DS4 mode is
protocol-fixed at 8-bit.

## Section map (channel → id)

- SYSTEM: USB_RATE 1, USB_INPUT_POLICY 2, USB_MODE 3, FIRMWARE_INFO 4,
  RUNTIME_VERSION 5, REPORT_COALESCE 6, PROFILE_ACTIVE 7, PROFILE_NAMES 8,
  LED_MODE_COLORS 9, BOOT_ENTRY 10
- INPUT: XINPUT_STICK_RESOLUTION 1, ADC_SAMPLING 2, STICK_AXIS_INVERT 3,
  STICK_SPEED_RC_LEFT 4, STICK_SPEED_RC_RIGHT 5 (their RC2.0 filter —
  separate from sampling), LIVE_EXTRA_BUTTONS 6, LIVE_STICK_SPEED 7
- CURVE: LEFT 1, RIGHT 2, PRESET 3, ANTICURVE_RIGHT 4, CIRCLE_CLAMP 5
- MAPPING / KEYBOARD / CALIBRATION sections as in bundle (`ne=` table).

## Legitimacy note

Sampling, oversampling and quantization are first-party firmware signal
conditioning (one physical movement → one reported movement, no
automation). Same class as deadzones/curves — not macros/turbo, not
bannable under ALGS-style rules, which police automation and require
peripheral approval, not stock filter settings.

## Hardware identity (live, passive, 2026-10-23)

USB `VID 0x0170 / PID 0xBB80`, USB release 0x0118 (node-hid 280), manufacturer "HyperStrike".
Interfaces: MI_00 XInput ("Controller (HyperStrike XINPUT)", usage 1/5),
MI_01 keyboard + mouse, MI_02 "HyperStrike Driver" (usage page 0xFF60,
usage 0x61) — the config channel. Passive listen: MI_00 sent ~8000 reports/s
(14 bytes each); MI_02 sent nothing unprompted (request/response only).

## Driver HID transport (from the Hub bundle, not yet sent to hardware)

Report ID 0 (node-hid on Windows: prefix a 0x00 byte), 64-byte frames, one
outstanding request at a time; the reply arrives as an input report on MI_02.

Request: `[0]cmd [1]seq(1..255, never 0) [2]channel [3]id [4]0 [5]length
[6]flags [7]0 [8..9]offset LE [10..11]arg LE [12..15]crc32 LE (0 for reads)
[16..63]payload (max 48)`.

Response: `[0]cmd [1]seq [2]channel [3]id [4]status [5]payloadLen [6]flags
(bit0 = more) [7]saveState [8..9]detail LE (total length for BUFFER_GET)
[16..]payload`. Matched on cmd+seq(+channel+id). Status: 0 OK, 1 UNHANDLED,
2 BAD_CHANNEL, 3 BAD_ID, 4 BAD_LENGTH, 5 BAD_OFFSET, 6 BUSY (Hub retries),
7 APPLY_FAILED, 8 READ_ONLY, 9 WRITE_ONLY, 10 LOCKED, 11 CRC_ERROR,
12 ACTION_RUNNING, 13 NOT_READY. Hub timeout 1000 ms (probe 360 ms).

Commands: 1 GET_PROTOCOL, 2 GET_DEVICE_INFO, 3 GET_VALUE, 4 SET_VALUE,
5 SAVE_REQUEST, 6 SAVE_FLUSH, 7 RESET_DEFAULTS, 8 ACTION_START,
9 ACTION_STATUS, 10 BUFFER_GET, 11 BUFFER_SET, 12 BUFFER_COMMIT,
13 BUFFER_RESET. **Read-only: 1, 2, 3, 9, 10.** Never send 4–8 or 11–13
without explicit per-step approval.

Connect handshake: GET_PROTOCOL then GET_DEVICE_INFO (retry delays 0/100/
220/420 ms); payload bytes 14..17 of GET_PROTOCOL must spell `HSR3`.
- GET_PROTOCOL payload: protoMajor, protoMinor, headerLen, reportSize,
  maxPayload, maxBlock u16 @5, topologyVersion @7, nvmSchema, nvmStatus,
  nvmGeneration u32 @10, fingerprint @14..17.
- GET_DEVICE_INFO payload: protoMajor, protoMinor, reportSize, maxPayload,
  currentMode @4, valueCount @5, bcdDevice u16 @6, fwStrLen @8, fw string
  @9.., edition @40.

Reading a value: GET_VALUE with channel/id. If it fails with BAD_LENGTH (too
big for one frame), page it with BUFFER_GET (offset, length 48) until flags
bit0 clears and offset ≥ detail.

Channels: 0 SYSTEM, 2 INPUT, 3 CURVE, 4 MAPPING, 5 KEYBOARD, 6 CALIBRATION.
Objects (channel/id): SYSTEM 1 USB_RATE, 2 USB_INPUT_POLICY, 3 USB_MODE,
4 FIRMWARE_INFO, 5 RUNTIME_VERSION, 6 REPORT_COALESCE, 7 PROFILE_ACTIVE,
8 PROFILE_NAMES, 9 LED_MODE_COLORS, 10 BOOT_ENTRY · INPUT 1 XINPUT_STICK_
RESOLUTION, 2 ADC_SAMPLING, 3 STICK_AXIS_INVERT, 4/5 STICK_SPEED_RC L/R,
6 LIVE_EXTRA_BUTTONS, 7 LIVE_STICK_SPEED · CURVE 1/2 STICK_CURVE L/R,
3 PRESET, 4 ANTICURVE_RIGHT, 5 CIRCLE_CLAMP · MAPPING 1 EXTRA_BUTTON_MAP,
2 NATIVE_BUTTON_REMAP · KEYBOARD 1 EXTRA, 2 NATIVE · CALIBRATION
1 FINE_TUNE_DATA, 2 STICK_CALIBRATION_ACTION (action — do not read blindly).

The bootloader path (sendFeatureReport/receiveFeatureReport) is a separate
firmware-update device; never touch it.

## First live handshake (2026-10-23, read-only: commands 1 and 2 only)

Frame format above confirmed byte for byte; both replied status 0 within the timeout.
- GET_PROTOCOL: proto 4.0, header 16, report 64, maxPayload 48, maxBlock 512,
  topology 1, nvmSchema 2, nvmStatus 3, nvmGeneration 20, fingerprint `HSR3`.
- GET_DEVICE_INFO: currentMode 1, valueCount 27, bcdDevice 0x0266,
  firmware "2.66", edition 0.

## First live settings read (2026-10-23, GET_VALUE only, fw 2.66)

All 15 objects answered with GET_VALUE in one frame (BUFFER_GET not needed).
- USB_INPUT_POLICY `02 06 01 03 00 00`: version 2, rateCode 6, bIntervalHs 1
  (8 kHz), flags 3, smooth off. The Hub always writes rateCode 6 and sets the
  rate via bIntervalHs, so 6 is not "250 Hz" here; 8000 reports/s seen live.
- USB_RATE `06` (legacy mirror of rateCode). USB_MODE `01 01 01 07 07 00 00 00`:
  current XInput, default XInput, supported mask 7.
- REPORT_COALESCE `01 00 64 00`: off, heartbeat 100 ms. PROFILE_ACTIVE 0.
- XINPUT_STICK_RESOLUTION `0c 00 00 00`: 12-bit (maximum).
- ADC_SAMPLING `02 01 04 02 00 ee`: v2 preset, presetId 4 Extreme (÷6, 1.5
  cycles), flags 0xEE → Advanced Sampling 3 (16-bit), overspec bit off.
- STICK_AXIS_INVERT 0. STICK_SPEED_RC L/R (32 B): `01 00 05 00` + five
  `[x u8, value s16]` points at x 0x20/0x50/0x80/0xC0/0xFF, all value 0 (off).
- STICK_CURVE L/R (41 B): byte 0 = 0, then 10 points `[x u16, y u16]` on a
  0–1000 scale: 0, 125, 251, 376, 502, 635, 702, 769, 884, 1000 with y = x
  (linear). STICK_CURVE_PRESET `00 ff e8 03 00`. Anti-curve and circle clamp 0.

## Write path (from the Hub bundle) and first live write (2026-10-23)

Hub writer: SET_VALUE (cmd 4) with the object bytes as payload (≤ 48 B; larger
objects use BUFFER_RESET/SET/COMMIT + CRC32, which Stick Labs does not use).
Curve objects are written with byte 0 = 1 (apply) and read back 0. Saving:
SAVE_FLUSH (6), then poll ACTION_STATUS (9) until savePending (byte 1) = 0,
savePendingMask (35) = 0 and dirtyGeneration u16 @6 = savedGeneration u16 @8;
lastSaveError (33) / lastNvmWriteStatus (34) non-zero = failure. Hub flush
timeout 12 s. USB_INPUT_POLICY and USB_MODE are changed with ACTION_START (8)
and re-enumerate the pad — not implemented. The Hub never writes the curve
preset object and always writes anti-curve 0.

Encoders: resolution `[bits 8..12, 0, 0, 0]`; sampling preset
`[2, 1, preset, div, time, oversample << 5]` (Tier D–G need fw ≥ 2.96);
speed boost `[1, enabled, 5, 0, 5 × (end u8 rising to 255, strength s16 ±500)]`;
coalesce `[1, enabled, heartbeat u16]`; invert mask LX 1/LY 2/RX 4/RY 8;
circle clamp mask L 2/R 4.

Live: Stick Labs wrote resolution 12 → 11 (read back `0b 00 00 00`, saved in
~2.1 s, XInput still 8000 reports/s, all other objects unchanged), then
11 → 12. A full re-read afterwards matched the original 2026-10-23 dump
byte for byte.
- Persistence: 11-bit written, pad unplugged and replugged by the user, read back `0b` (saved to flash); then restored to 12 and the full dump matched the original again.
- Curve: left curve written with outputs 109/223/341/465/600/671/742/869 (x unchanged), raw read-back matched, right curve untouched; restored to linear and the full dump matched the original again.

## Polling rate write (Hub kb(); built, not yet run live)

ACTION_START (cmd 8) on USB_INPUT_POLICY (0/2) with `[2, 6, bIntervalHs 1..6,
current flags, 0, 0]` — 8000/4000/2000/1000/500/250 Hz. Flags bit 0 = the
firmware supports bInterval changes; bit 1 = it re-enumerates. The pad may
drop the reply while re-plugging (the Hub treats that as success). Stick Labs
sends it after any other staged writes are saved, then rediscovers the pad and
checks the reported rate. Stick Labs refuses ACTION_START for every other object.
- Live 2026-10-23: 8K → 1K via Stick Labs (pad re-plugged, re-found and confirmed in ~3.6 s; policy `02 06 04 03 00 00`; measured 3001 reports / 3 s), then 1K → 8K (`02 06 01 03 00 00`; 23998 reports / 3 s). Full dump matched the original afterwards.

## Profiles, USB mode, buttons, keyboard (Hub codecs; live reads 2026-10-23)

- PROFILE_ACTIVE (0/7) `[0..3]`, switched with SET_VALUE, not saved (Hub
  persist:false). If the target slot has another USB mode or polling rate the
  pad re-plugs. PROFILE_NAMES (0/8): 101 written bytes `[4, 4 × (usbMode,
  name 24 B UTF-8)]`; reads add 4 × bIntervalHs (105 B, via BUFFER_GET).
  Live: 配置1 XInput, 配置2–4 **DS4**, all 8 kHz.
- USB_MODE (0/3) changed with ACTION_START `[1, mode, persist 1, 0 ×5]`
  (Hub Pg()); modes DS4 0 / XInput 1 / Switch 2 / PS4 3, supportedMask byte 3
  (live 7 = DS4, XInput, Switch). Identities per mode: 0170:BB80 XInput,
  054C:09CC DS4, 057E:2009 Switch, 1532:0401 PS4, all with the 0xFF60/0x61
  Driver interface.
- Button codes 1..18: cross, circle, square, triangle, ↑, ↓, ←, →, L1, R1,
  L2, R2, L3, R3, create, options, home, touchpad.
- NATIVE_BUTTON_REMAP (4/2) 42 B `[2, 36, 0, 18 × (out1, out2), touchpad
  DS4/XInput/Switch]`; live = identity, touchpad `12 0f 12`.
- EXTRA_BUTTON_MAP (4/1) 35 B `[2, mapLen 0|16, 0, 8 × (out1, out2)]`; live
  empty. LIVE_EXTRA_BUTTONS (2/6) reads `01 08 00 00` (8 extra inputs).
- EXTRA_KEYBOARD_MAP (5/1) 31 B `[1 apply, enabled (shared with native), 8,
  0, 8 × (HID key ≤ 101, modifier, 0)]`; NATIVE_KEYBOARD_MAP (5/2) 60 B
  `[1 apply, 1, 18, 0, 18 × (key, modifier, 0)]` — over 48 B, so it goes
  through BUFFER_RESET / BUFFER_SET (arg = total) / BUFFER_COMMIT (arg,
  CRC-32 IEEE). Apply byte reads back 0.
- Calibration: see the section below (lazy-loaded Hub chunk).


## Calibration (Hub chunk `assets/CalibrationPage-DXT9E5Xf.js`, read 2026-10-23)

The Hub lazy-loads its calibration page, so the 10-13 copy of the main bundle
never contained it. Read through the live site (hs2.evua.cc reachable from the
in-app browser; same main bundle `index-DetSq_C4.js`). Imports from the main
bundle: `tt` read, `mt` write, `Ss` ACTION_START writer, `Cs` probe, `ok`
ACTION_STATUS, `ak` BUFFER_RESET, `ck` RESET_DEFAULTS, `ik` constants.

- Constants `ik`: BEGIN 1, END 2, SAMPLE 3, TARGET_CONTROLLER 1, TYPE_CENTER 1,
  TYPE_RANGE 2.
- Every step is ACTION_START on STICK_CALIBRATION_ACTION (6/2), persist false,
  payload `[cmd, 1, type]`: begin `[1, 1, t]`, sample `[3, 1, 1]`, end
  `[2, 1, t]` (t: 1 center, 2 range). Retries: begin after 0/60/140 ms,
  sample/end after 0/50/120 ms.
- Before begin (and between retries) the Hub waits for an idle action lane:
  ACTION_STATUS not reenumerationArmed (byte 11), not writeActive (byte 3; if
  so it sends BUFFER_RESET and retries), not inFlight (5), not
  responsePending (10), mailboxDepth (4) = 0. Retry delays 0/30/70 ms.
- Center (auto): begin center → 3 × (20 ms, sample) → 20 ms → end center.
  Center (4-way wizard): begin center, then for up/down/left/right "push both
  sticks to that edge, release back to center, pause, Sample", then end.
  Sticks must be still while sampling.
- Range: begin range → user rotates both sticks slowly, three full circles
  along the edge → end range.
- One-key: range (begin → rotate → end) → 100 ms → auto center → "save"
  (a no-op: the pad stores calibration itself on END).
- FINE_TUNE_DATA (6/1): 24 bytes = 12 × u16 LE ("center fine-tune", X/Y per
  stick); read with GET_VALUE, written with SET_VALUE 500 ms after an edit
  ("saved to the device in real time").
- "Clear calibration" in the Hub is RESET_DEFAULTS (full factory reset, also
  wipes mapping/curves/USB policy) — Stick Labs must not offer it.
- Stick Labs implements this (shared/hyperstrike.ts calibrate / calibrateCenterAuto / readFineTune / writeFineTune; Calibrate tab). Not yet run on hardware.
- Baseline FINE_TUNE_DATA read live 2026-10-23 (fw 2.66, read only):
  `26 03 88 02 85 03 eb 02 38 0c 2a 0c 8b 0c 47 0c 73 07 e1 07 d8 07 e4 07`
  = 806, 648, 901, 747, 3128, 3114, 3211, 3143, 1907, 2017, 2008, 2020.
- Live range calibration 2026-10-23 via the Calibrate tab (begin `[1,1,2]`
  → user rotated both sticks → end `[2,1,2]`): FINE_TUNE_DATA became
  792, 633, 920, 760, 3119, 3117, 3219, 3146, 1907, 2017, 2008, 2020 — only
  values 1–8 changed, 9–12 kept. So the 12 values are most likely per-axis
  (LX, LY, RX, RY) minimum, maximum and center on the 12-bit ADC. All other
  objects unchanged.
- Live center calibration 2026-10-23 (begin `[1,1,1]`, 3 × sample `[3,1,1]`,
  end `[2,1,1]`, ~1.3 s): values 9–12 became 1915, 2027, 2006, 2020; values
  1–8 kept — confirms layout min[LX,LY,RX,RY], max[…], center[…]. Resting
  XInput afterwards (2 s, 16k reports): LX 32767, LY 32792 (+0.07%), RX 32769,
  RY 32769 — all within 0.07% of 32768. All other objects unchanged.


## Live write round 2026-10-23 (all through Stick Labs, each restored)

- Button remap A→B: NATIVE_BUTTON_REMAP byte 3 `01`→`02`, saved ~2.9 s.
- A → Space: native A `[0,0]`, NATIVE_KEYBOARD_MAP entry 0 = `2c` written
  through BUFFER_RESET/SET/COMMIT (CRC accepted), EXTRA_KEYBOARD_MAP enabled
  `01`; extra map untouched.
- Profile rename P1 "配置1" → "Stick Labs test" → back (101 B via buffer path).
- Profile switch P1 → P2 (DS4): re-plug to 054C:09CC, re-found in ~4.5 s;
  back to P1 0170:BB80 in ~4.5 s.
- Batch: sampling Robust/off (pad keeps its own flag bits: `8e`), left speed
  boost on, invert LX, clamp left, merging on, left deadzone 5% (curve point
  0 = 50/0) — one write, ~2.2 s, all read back.
- USB mode XInput → DS4 → XInput via ACTION_START on USB_MODE (~3.2 s each).
- Final full compare: every object byte-identical to the morning dump.
