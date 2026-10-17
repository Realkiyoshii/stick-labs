# Stick Labs clean profile reference

Generated on 2026-10-17 from isolated, pure GameSir Connect 1.16.7 codecs
`Hm.fromBytes/fromModel` (G7ProCE) and `Jg.fromBytes/fromModel` (T3CE).
No vendor startup, USB code, native DLL, or network code was executed.
The source remains local at C:/tools/rea-engines/cases/gamesir-connect/main.pretty.js.
Research generator and detailed input models are in ignored .probe-tmp/profile-reset/.

These are explicit Stick Labs neutral presets, not claims of factory defaults:
- name Stick Labs Clean; all button remaps/turbo/toggle and macros cleared;
- sticks: Circle, normal left/right output, 0â€“100% input and output, linear,
  identity transform, no inversion, neutral axis/mouse sensitivity, no anti-jitter;
- triggers: 0â€“100% input/output, linear, rapid trigger off, no remaps/turbo;
- gyro activation and bindings off, neutral response;
- shift layer/D-pad lock/ABXY swaps off; 8 kHz gear, 12-bit setting;
- rumble level 3 (75%), audio enabled, volume 100, mixer and mic sensitivity 50.

The builder preserves unnamed/reserved Fun_Data bytes 19â€“31. Calibration and
RGB use separate device commands and are not touched. Only the selected main
profile is replaced; other profile slots (including the separate shift slot)
are not written. A separate shift slot cannot become active through this preset
because the shift activation/bindings in the selected main slot are cleared.

**Live status:**
- T3CE firmware 0243, inactive slot 4: full 1935-byte clean profile verified,
  original restored byte-exact, active slot 1 unchanged (live-readback.json).
- G7ProCE firmware 0229, inactive slot 4: full 1070-byte clean profile verified,
  original restored byte-exact, active slot 1 unchanged (g7-live-readback.json).

Evidence files contain non-personal hashes only. Original profile backups remain
local under ignored .probe-tmp/clean-profile-live/. The tests used only normal
profile read/write/config commands; no calibration command was sent.
Firmware readback proves storage, not measured in-game response.
