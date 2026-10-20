# Stick X/Y sensitivity scale

GameSir Connect 1.16.7's per-stick "X/Y Sensitivity Scale" lives in the stick
`map_module`: `+24 map_en`, `+25 x_flip`, `+26 y_flip`, `+27 axis_ratio`,
`+28 mouse_dpi`, `+29 map_index`. Connect always writes `map_en = 1` and
defaults `map_index` to 1 (left) / 2 (right) and `axis_ratio` to 50. With
`map_en = 0` the ratio byte is ignored, so Stick Labs shows such sticks as 50.

## Live evidence (2026-10-19)

Tarantula 8K, firmware 0243. Backed up inactive P4 (1,935 bytes, SHA-256
prefix `d40dd672505e81ec`; its right stick was unmapped, ratio byte 0). Wrote
right-stick scale 30: exactly offsets 1821/1824/1826 changed (+24/+27/+29), and
the full-profile readback matched. Activated P4 and captured the right stick
held full right, then full up:

| Slot | Scale | Max right | Max up | Up ÷ right |
| --- | --- | --- | --- | --- |
| P1 | 50 | 127 | 128 | 1.01 |
| P4 | 30 | 127 | 76 | 0.60 |

Horizontal stayed full while vertical was capped at 30 ÷ 50 = 60%, so below 50
the vertical axis is scaled by `ratio ÷ 50` (above 50 the horizontal is
expected to mirror this; not separately measured). Returned to P1, restored P4
and verified it byte for byte (SHA-256 prefix `d40dd672505e81ec` again). P1's
contents were not edited. G7 Pro 8K uses the same stick layout but was not
measured.
