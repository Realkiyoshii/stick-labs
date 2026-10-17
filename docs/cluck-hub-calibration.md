# Cluck Hub calibration compatibility

Inspected 2026-10-17: https://gs.evua.cc/#/ and public assets
`/assets/CalibrationPage-Btu9bATC.js`, `/assets/index-EzBHbWH-.js`.
The website identifies itself as an unofficial driver.

- Default selected mask: 15. Available masks: 15 (sticks and triggers), 3 (sticks), 12 (triggers), 16 (motion).
- WebHID sends report ID 0x0f with 63-byte payload `[0xfe, operation, parts, ...zeroes]`. Operations: start 0, complete 1, exit 2. Complete and exit send parts 0. No acknowledgement or three-second progress timeout.
- WebHID input report ID 0x12 is separate from event.data. Calibration fields are payload offsets 30/31 for G7ProCE and 24/25 for T3CE. node-hid includes the report ID: use offsets 31/32 and 25/26 respectively.
- Active means mode != 1. Passed flags are bits 1/2/4/8/16. Complete is enabled during a locally started session when active and all selected bits are set. Clear previous live status on start. No local movement thresholds or fine-mode stages.
- Prevent navigation during calibration and block start while profile edits are pending. Stick Labs requires saving or discarding staged profile edits; the website automatically saves them.
- Center controls send `[0xe2, stick, direction, 0, 32]`. Directions 0/1/2/3 are X +32, X -32, Y -32, Y +32. Website expects response payload `[0xe2, 0]`. Stick Labs also retains existing 0xe3 acknowledgement support. Nonzero status is an error.
- Report successful sends as commands sent, not proof of retention after power loss.

The previous implementation applied WebHID offsets directly to node-hid frames. A frame with mode 3 and completion mask 0 therefore incorrectly appeared to have both stick bits set. The regression test covers this case.
