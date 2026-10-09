/**
 * Model registry: detection + per-model support levels.
 *
 * Source: GameSir Connect bundle (dist/electron/main.js) mined from the
 * local install — G7ProS reuses the G7ProCE proxy wholesale, T3CE is a
 * separate family, G7SE is firmware-only (Modes:[]).
 */
import { MODELS, identifyModel } from '../src/shared/models.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

check('8K identified (8K name contains base name — order matters)', identifyModel('Gamesir-G7 Pro 8K')?.id === 'G7ProCE')
check('CE identified by PID despite generic Windows product string', identifyModel('Xbox 360 Controller for Windows', 0x10c5)?.id === 'G7ProCE')
check('Tarantula identified by PID 0x103D', identifyModel('Xbox 360 Controller for Windows', 0x103d)?.id === 'T3CE')
check('G7 Pro S identified by PID', identifyModel(undefined, 0x0908)?.id === 'G7ProS')
check('unknown PID returns null (default-deny, never assume CE)', identifyModel('Xbox 360 Controller for Windows', 0x9999) === null)
check('G7 Pro S identified', identifyModel('GameSir-G7 Pro S')?.id === 'G7ProS')
check('G7 SE identified', identifyModel('GameSir-G7 SE')?.id === 'G7SE')
check('Tarantula identified', identifyModel('Tarantula CE')?.id === 'T3CE')
check('unknown product returns null', identifyModel('SomePad X') === null && identifyModel(undefined) === null)

const ce = MODELS.find((m) => m.id === 'G7ProCE')
const s = MODELS.find((m) => m.id === 'G7ProS')
const se = MODELS.find((m) => m.id === 'G7SE')
const t3 = MODELS.find((m) => m.id === 'T3CE')

check('CE full support, 1070-byte profile', !!ce && ce.support === 'full' && ce.profileLength === 1070)
check('G7ProS full support, same profile length', !!s && s.support === 'full' && s.profileLength === 1070)
check(
  'G7ProS gears are 250/500/1000 only',
  !!s && s.reportRates.length === 3 && s.reportRates.map((r) => r.hz).join(',') === '250,500,1000',
  s?.reportRates.map((r) => `${r.hz}(g${r.gear})`).join(' ')
)
check('G7ProS PIDs recorded', !!s && s.pids.includes(0x0908) && s.pids.includes(0x0922))
check('CE variant PIDs cover white/black/nioh (0x913/0x1034/0x10c7)', !!ce && ce.pids.includes(0x0913) && ce.pids.includes(0x1034) && ce.pids.includes(0x10c7))
check('G7SE locked (firmware-only in bundle)', !!se && se.support === 'detect-only' && se.profileLength === 0)
check('Tarantula full support, 1935-byte profile proven on hardware', !!t3 && t3.support === 'full' && t3.profileLength === 1935)
check(
  'Tarantula gears are 250/1000/4000/8000',
  !!t3 && t3.reportRates.map((r) => r.hz).join(',') === '250,1000,4000,8000',
  t3?.reportRates.map((r) => `${r.hz}(g${r.gear})`).join(' ')
)
check('Tarantula PIDs recorded', !!t3 && t3.pids.includes(0x103d) && t3.pids.includes(0x10ff))

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
