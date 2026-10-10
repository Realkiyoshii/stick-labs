/**
 * Steam export helpers: VDF round-trip + deadzone mapping + group injection.
 *
 *   node scripts/test.mjs tests/steamcfg.ts
 */
import { parseVdf, serializeVdf, deadzoneToSteam, injectStickSettings, fitCurveExponent } from '../src/shared/steamcfg.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SAMPLE = `"controller_mappings"
{
\t"version"\t\t"2"
\t"group"
\t{
\t\t"id"\t\t"2"
\t\t"mode"\t\t"mouse_joystick"
\t\t"settings"
\t\t{
\t\t}
\t}
\t"group"
\t{
\t\t"id"\t\t"3"
\t\t"mode"\t\t"joystick_move"
\t\t"settings"
\t\t{
\t\t\t"adaptive_centering"\t\t"0"
\t\t}
\t}
}
`

const parsed = parseVdf(SAMPLE)
check('parses groups incl repeats', parsed.length === 1 && parsed[0].key === 'controller_mappings')
const reser = serializeVdf(parsed)
check('round-trips structure', parseVdf(reser).length === 1)

const dz = deadzoneToSteam(50, 800)
check('5% → ~1638 inner', dz.inner === 1638, `${dz.inner}`)
check('80% → ~26214 outer', dz.outer === 26214, `${dz.outer}`)
check('clamps 0/100', deadzoneToSteam(0, 1000).inner === 0 && deadzoneToSteam(0, 1000).outer === 32767)

const patched = injectStickSettings(SAMPLE, { '2': { begin: 0, end: 100 }, '3': { begin: 5, end: 80 } }, 200)
check('group 2 gets 0/32767', patched.includes('"deadzone"\t\t"0"') && patched.includes('"deadzone_outer_radius"\t\t"32767"'))
check('group 3 gets 1638/26214', patched.includes('"deadzone"\t\t"1638"') && patched.includes('"deadzone_outer_radius"\t\t"26214"'))
check('group 2 gets sensitivity 200', patched.includes('"sensitivity"\t\t"200"'))
check('anti exports as on/off flag', (() => {
  const on = injectStickSettings(SAMPLE, { '3': { begin: 5, end: 80, anti: 8 } })
  const off = injectStickSettings(SAMPLE, { '3': { begin: 5, end: 80, anti: 0 } })
  return on.includes('"anti_deadzone"\t\t"1"') && off.includes('"anti_deadzone"\t\t"0"')
})())
check('group 3 untouched by sensitivity', (patched.match(/"sensitivity"/g) ?? []).length === 1)
check('adaptive_centering preserved', patched.includes('"adaptive_centering"'))
check('reinject overwrites, not duplicates', (patched.match(/"deadzone"/g) ?? []).length === 2)

let threw = false
try {
  injectStickSettings('"nope"\n{\n}\n', {})
} catch {
  threw = true
}
check('rejects non-config documents', threw)

// Curve-fit convention (standard math: k>1 calms start, k<1 heats it).
// Direction ON STEAM is unconfirmed — UI gates behind explicit opt-in.
check('identity fits k≈1', Math.abs(fitCurveExponent([{ x: 0, y: 0 }, { x: 64, y: 64 }, { x: 128, y: 128 }, { x: 191, y: 191 }, { x: 255, y: 255 }]) - 1) < 0.06)
check('fast start fits k<1', fitCurveExponent([{ x: 0, y: 0 }, { x: 64, y: 100 }, { x: 128, y: 160 }, { x: 191, y: 215 }, { x: 255, y: 255 }]) < 1)
check('slow start fits k>1', fitCurveExponent([{ x: 0, y: 0 }, { x: 64, y: 16 }, { x: 128, y: 70 }, { x: 191, y: 158 }, { x: 255, y: 255 }]) > 1)
check('degenerate fits 1', fitCurveExponent([{ x: 5, y: 5 }]) === 1)

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
