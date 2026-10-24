/** Input capture translates into existing picker targets; it never writes hardware. */
import { KEY_TARGETS } from './keymap'
import { LJ_HID_KEYS } from './leadjoy'
export type CaptureFamily = 'gamesir' | 'leadjoy' | 'hyperstrike'
const padTargets = {
  gamesir: [9, 10, 11, 12, 5, 6, 19, 20, 14, 15, 7, 8, 1, 2, 3, 4, 13],
  leadjoy: [1, 2, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 18, 19, 20],
  // Standard gamepad order → HyperStrike button codes (A B X Y LB RB LT RT View Menu LS RS ↑ ↓ ← → Guide).
  hyperstrike: [1, 2, 3, 4, 9, 10, 11, 12, 15, 16, 13, 14, 5, 6, 7, 8, 17]
}
export function capturedPadTarget(family: CaptureFamily, index: number): number | null {
  return padTargets[family][index] ?? null
}
const codeLabels: Record<string, string> = {
  Escape: 'Esc', Backquote: '`', Minus: '-', Equal: '=', Backspace: 'Backspace',
  Tab: 'Tab', BracketLeft: '[', BracketRight: ']', Backslash: '\\', CapsLock: 'Caps Lock',
  Semicolon: ';', Quote: "'", Enter: 'Enter', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
  Comma: ',', Period: '.', Slash: '/', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
  MetaLeft: 'Left Win', MetaRight: 'Right Win', AltLeft: 'Left Alt', AltRight: 'Right Alt',
  Space: 'Space', Insert: 'Insert', Home: 'Home', PageUp: 'Page Up', Delete: 'Delete',
  End: 'End', PageDown: 'Page Down', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumLock: 'Num Lock', NumpadDivide: 'Num /', NumpadMultiply: 'Num *', NumpadSubtract: 'Num -',
  NumpadAdd: 'Num +', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
  PrintScreen: 'Print Screen', ScrollLock: 'Scroll Lock', Pause: 'Pause',
  MediaPlayPause: 'Media Play', MediaStop: 'Media Stop', MediaTrackNext: 'Media Next',
  MediaTrackPrevious: 'Media Prev', AudioVolumeUp: 'Volume Up', AudioVolumeDown: 'Volume Down', AudioVolumeMute: 'Volume Mute'
}
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') codeLabels['Key' + letter] = letter
for (let i = 0; i <= 9; i++) { codeLabels['Digit' + i] = String(i); codeLabels['Numpad' + i] = 'Num ' + i }
for (let i = 1; i <= 12; i++) codeLabels['F' + i] = 'F' + i
/** Physical KeyboardEvent.code keeps numpad and left/right modifiers distinct. */
export function capturedKeyTarget(family: CaptureFamily, code: string): number | null {
  let label = codeLabels[code]
  if (!label) return null
  if (family === 'leadjoy' || family === 'hyperstrike') {
    const key = LJ_HID_KEYS.find(k => k.label === label)
    return key ? 1000 + key.code : null
  }
  if (code === 'MetaLeft') label = 'Win'
  if (code.startsWith('Arrow')) label = { ArrowUp: 'Arrow ↑', ArrowDown: 'Arrow ↓', ArrowLeft: 'Arrow ←', ArrowRight: 'Arrow →' }[code]!
  return KEY_TARGETS.find(k => k.group === 'keyboard' && k.label === label)?.value ?? null
}
/** Release barrier and stable single press prevent held inputs/diagonals from winning. */
export class PadCaptureGate {
  private releasedAt: number | null = null
  private ready = false
  private candidate = ''
  private candidateAt = 0
  private done = false
  sample(pads: Array<{ id: string; values: number[] }>, now: number): { state: 'release' | 'press' | 'multiple' | 'unavailable' | 'done'; index?: number } {
    if (this.done) return { state: 'done' }
    if (!pads.length) { this.ready = false; this.releasedAt = null; this.candidate = ''; return { state: 'unavailable' } }
    const pressed = pads.flatMap(p => p.values.flatMap((v, i) => v > 0.5 ? [{ key: p.id + ':' + i, index: i }] : []))
    if (!this.ready) {
      if (pads.every(p => p.values.every(v => v < 0.25))) {
        this.releasedAt ??= now
        if (now - this.releasedAt >= 120) this.ready = true
      } else this.releasedAt = null
      return { state: this.ready ? 'press' : 'release' }
    }
    if (pressed.length > 1) { this.ready = false; this.releasedAt = null; this.candidate = ''; return { state: 'multiple' } }
    if (!pressed.length) { this.candidate = ''; return { state: 'press' } }
    const next = pressed[0]
    if (next.key !== this.candidate) { this.candidate = next.key; this.candidateAt = now }
    if (now - this.candidateAt < 80) return { state: 'press' }
    this.done = true
    return { state: 'done', index: next.index }
  }
}
