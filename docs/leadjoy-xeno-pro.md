# LeadJoy Xeno Pro and Saber Plus shared support

## Why the existing support works

The connected LeadJoy configuration interface uses the same USB identity as the
Saber Plus: VID 0x4131, PID 0x3519, usage page 0xff80, usage 1 (MI_04).
Discovery continues to match VID + usage page + usage, never product ID.
Its USB product string is simply `Controller`; its board name is `DEFAULT_BOARD`.
Neither is a reliable discriminator between the physical products.

The model registry therefore keeps the existing internal `SaberPlus` family ID
and displays **LeadJoy Saber Plus / Xeno Pro**. Name hints include Xeno/Xeno Pro.
After connection, the read-only version/board handshake identifies the known,
user-confirmed signatures: DEFAULT_BOARD + 57.16.15 displays **LeadJoy Xeno Pro**;
DEFAULT_BOARD + 36.16.12 displays **LeadJoy Saber Plus**. Unknown signatures retain
the shared family label. This is a narrow allowlist of observed combinations,
not a claim that firmware versions universally identify product models. A new
firmware version needs evidence before extending the allowlist. No manual model
selector or saved name override is used, and identification never changes routing.

This avoids duplicate model entries claiming the same generic USB identity or
using a firmware version as an invented model identifier. The shared family
continues to route through the LeadJoy session, never the GameSir handshake.

## Read-only observation (2026-10-18)

The user confirmed the connected controller is the **Xeno Pro**. On firmware
**57.16.15**, it successfully answered the
existing slot reader for Main, Sub1 and Sub2. Each returned all 22 expected
button IDs, both eight-point stick curves and both trigger configurations.
The earlier Saber Plus reference was firmware 36.16.12. The version difference
is evidence to record, not a guaranteed physical-product identification rule.

A sanitized schema/identity summary is in
`fixtures/leadjoy/xeno-family-read-summary.json`; full user settings remain
local under ignored `.probe-tmp/xeno-pro/`. No settings were written.

No wire commands, mappings, write fields or calibration behavior were changed.
Existing button/stick edit paths retain their readback-and-restore checks.
Live write proof remains the Saber Plus captures documented in leadjoy-saber.md;
this observation proves readable compatibility on the connected unit, not a
new model-specific write/restore test. Trigger edits remain disabled, and
LeadJoy calibration remains a read-only center check.
