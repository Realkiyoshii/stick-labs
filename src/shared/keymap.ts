/**
 * Remap key index table — what a button `map_value` byte means.
 *
 * Provenance: recovered from GameSir Connect's own tables (the older `hg`
 * PROFILE_INDEX_* constants, re-verified against Connect 1.16.7's `ko`
 * literal, which matches values 1–28, 50–155, 200–206, 230, 231 and 255
 * exactly) and confirmed on hardware — profile 1's Camera button holds 82,
 * which is keyboard T.
 *
 * Two deliberate omissions vs the old table: indices 29/30 used to be read
 * as RS diagonals, but Connect 1.16.7 defines them as LEFT_TP/RIGHT_TP with
 * unverified meaning, so they stay unnamed here and display as `#29/#30`
 * rather than a wrong label.
 *
 * Tournament note: Stick Labs writes single targets only. Keyboard targets
 * are offered (every key 50–155); mouse/special entries exist so pads
 * configured in Connect still *display* correctly — this app never offers
 * them as targets. A stricter tournament-only target list can narrow this
 * further without touching the encoding.
 */

export interface KeyTarget {
  value: number
  label: string
  group: KeyGroup
}

export type KeyGroup =
  | 'none'
  | 'controller'
  | 'function'
  | 'sticks'
  | 'dpad'
  | 'keyboard'
  | 'mouse'
  | 'special'

/** Controller buttons (indices 1–16). */
const CONTROLLER: Array<[number, string]> = [
  [1, 'D-pad Up'],
  [2, 'D-pad Down'],
  [3, 'D-pad Left'],
  [4, 'D-pad Right'],
  [5, 'L1'],
  [6, 'R1'],
  [7, 'L3'],
  [8, 'R3'],
  [9, 'A'],
  [10, 'B'],
  [11, 'X'],
  [12, 'Y'],
  [13, 'PS / Home'],
  [14, 'Select / View'],
  [15, 'Start / Menu'],
  [16, 'Camera']
]

/** Function keys and triggers (17–20). */
const FUNCTION: Array<[number, string]> = [
  [17, 'FL1'],
  [18, 'FR1'],
  [19, 'L2'],
  [20, 'R2']
]

/** Stick directions (21–28). */
const STICKS: Array<[number, string]> = [
  [21, 'Left stick ↑'],
  [22, 'Left stick ↓'],
  [23, 'Left stick ←'],
  [24, 'Left stick →'],
  [25, 'Right stick ↑'],
  [26, 'Right stick ↓'],
  [27, 'Right stick ←'],
  [28, 'Right stick →']
]

/** D-pad diagonals (40–43). */
const DPAD: Array<[number, string]> = [
  [40, 'D-pad ↖'],
  [41, 'D-pad ↗'],
  [42, 'D-pad ↙'],
  [43, 'D-pad ↘']
]

/**
 * Indices 29–49 are intentionally unnamed: Connect 1.16.7 defines 29/30 as
 * LEFT_TP/RIGHT_TP (unverified meaning) and nothing at 31–49, while the
 * older table read them as stick diagonals / Ext paddles (and FL2/FR2 as
 * 31/32). Any of those values on a pad displays as `#n` rather than a
 * possibly wrong label.
 */

/** Keyboard (50–155), in the order GameSir defines them. */
const KEYBOARD: Array<[number, string]> = [
  [50, 'Esc'],
  [51, 'F1'],
  [52, 'F2'],
  [53, 'F3'],
  [54, 'F4'],
  [55, 'F5'],
  [56, 'F6'],
  [57, 'F7'],
  [58, 'F8'],
  [59, 'F9'],
  [60, 'F10'],
  [61, 'F11'],
  [62, 'F12'],
  [63, '`'],
  [64, '1'],
  [65, '2'],
  [66, '3'],
  [67, '4'],
  [68, '5'],
  [69, '6'],
  [70, '7'],
  [71, '8'],
  [72, '9'],
  [73, '0'],
  [74, '-'],
  [75, '='],
  [76, 'Backspace'],
  [77, 'Tab'],
  [78, 'Q'],
  [79, 'W'],
  [80, 'E'],
  [81, 'R'],
  [82, 'T'],
  [83, 'Y'],
  [84, 'U'],
  [85, 'I'],
  [86, 'O'],
  [87, 'P'],
  [88, '['],
  [89, ']'],
  [90, '\\'],
  [91, 'Caps Lock'],
  [92, 'A'],
  [93, 'S'],
  [94, 'D'],
  [95, 'F'],
  [96, 'G'],
  [97, 'H'],
  [98, 'J'],
  [99, 'K'],
  [100, 'L'],
  [101, ';'],
  [102, "'"],
  [103, 'Enter'],
  [104, 'Left Shift'],
  [105, 'Z'],
  [106, 'X'],
  [107, 'C'],
  [108, 'V'],
  [109, 'B'],
  [110, 'N'],
  [111, 'M'],
  [112, ','],
  [113, '.'],
  [114, '/'],
  [115, 'Right Shift'],
  [116, 'Left Ctrl'],
  [117, 'Win'],
  [118, 'Left Alt'],
  [119, 'Space'],
  [120, 'Right Alt'],
  [121, 'Right Ctrl'],
  [122, 'Insert'],
  [123, 'Home'],
  [124, 'Page Up'],
  [125, 'Delete'],
  [126, 'End'],
  [127, 'Page Down'],
  [128, 'Arrow ↑'],
  [129, 'Arrow ↓'],
  [130, 'Arrow ←'],
  [131, 'Arrow →'],
  [132, 'Num Lock'],
  [133, 'Num /'],
  [134, 'Num *'],
  [135, 'Num -'],
  [136, 'Num +'],
  [137, 'Num .'],
  [138, 'Num Enter'],
  [139, 'Num 0'],
  [140, 'Num 1'],
  [141, 'Num 2'],
  [142, 'Num 3'],
  [143, 'Num 4'],
  [144, 'Num 5'],
  [145, 'Num 6'],
  [146, 'Num 7'],
  [147, 'Num 8'],
  [148, 'Num 9'],
  [149, 'Media Play'],
  [150, 'Media Stop'],
  [151, 'Media Next'],
  [152, 'Media Prev'],
  [153, 'Volume Up'],
  [154, 'Volume Down'],
  [155, 'Volume Mute']
]

/** Mouse (200–206). Note 204 is Button4 and 203 is Button5 — non-sequential. */
const MOUSE: Array<[number, string]> = [
  [200, 'Mouse Left'],
  [201, 'Mouse Middle'],
  [202, 'Mouse Right'],
  [204, 'Mouse Button 4'],
  [203, 'Mouse Button 5'],
  [205, 'Mouse Wheel Up'],
  [206, 'Mouse Wheel Down']
]

/** Special function keys. 37 = Screenshot, observed on T3CE hardware. */
const SPECIAL: Array<[number, string]> = [
  [230, 'Mute'],
  [231, 'Shift'],
  [255, 'No change (NC)'],
  [37, 'Screenshot']
]

function build(
  entries: Array<[number, string]>,
  group: KeyGroup
): KeyTarget[] {
  return entries.map(([value, label]) => ({ value, label, group }))
}

export const KEY_TARGETS: KeyTarget[] = [
  { value: 0, label: 'Unmapped', group: 'none' },
  ...build(CONTROLLER, 'controller'),
  ...build(FUNCTION, 'function'),
  ...build(STICKS, 'sticks'),
  ...build(DPAD, 'dpad'),
  ...build(KEYBOARD, 'keyboard'),
  ...build(MOUSE, 'mouse'),
  ...build(SPECIAL, 'special')
]

/** Remap value for the Shift key; the Shift layer itself is profile 5. */
export const SHIFT_KEY = 231
export const SHIFT_PROFILE = 5

const BY_VALUE = new Map(KEY_TARGETS.map((k) => [k.value, k]))

export function keyLabel(value: number): string {
  if (value === 0) return '—'
  return BY_VALUE.get(value)?.label ?? `#${value}`
}

export function keyGroup(value: number): KeyGroup {
  return BY_VALUE.get(value)?.group ?? 'none'
}

/**
 * Targets this app offers: single controller keys (0–20), every keyboard
 * key (50–155) and Shift (231: hold to use the Shift layer, profile 5).
 * One press in, one press out — no multi-maps, no macros, no turbo.
 * Mouse and the other specials stay out (unneeded attack surface for a
 * tuning app; the bytes would work the same way).
 */
export const REMAP_TARGETS: KeyTarget[] = KEY_TARGETS.filter(
  (k) => k.value <= 20 || (k.value >= 50 && k.value <= 155) || k.value === SHIFT_KEY
)

/** Human-readable mapping, e.g. `A` or `A + B` or `—`. */
export function displayMapping(values: readonly number[]): string {
  const named = values.filter((v) => v !== 0).map((v) => keyLabel(v))
  return named.length > 0 ? named.join(' + ') : '—'
}

export const KEY_GROUPS: Array<{ id: KeyGroup; label: string }> = [
  { id: 'controller', label: 'Controller' },
  { id: 'function', label: 'Function & triggers' },
  { id: 'sticks', label: 'Stick directions' },
  { id: 'dpad', label: 'D-pad diagonals' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'mouse', label: 'Mouse' },
  { id: 'special', label: 'Special' }
]
