import { readFileSync } from 'node:fs'
import { parseVdf, injectStickSettings } from '../src/shared/steamcfg.ts'

const template = readFileSync('C:/Program Files (x86)/Steam/controller_base/templates/gamepad_fps.vdf', 'utf8')
const before = parseVdf(template)

// count groups before
const groupsBefore = before[0].value as Array<{ key: string }>
console.log('top groups:', groupsBefore.filter((p) => p.key === 'group').length)

const patched = injectStickSettings(template, { '2': { begin: 0, end: 100 }, '3': { begin: 5, end: 80 }, '6': { begin: 5, end: 80 } })

// verify each stick group got exactly one deadzone pair, others untouched
const after = parseVdf(patched)
const mappings = (after[0].value as Array<any>).filter((p: any) => p.key === 'group')
let failures = 0
for (const g of mappings) {
  const id = g.value.find((p: any) => p.key === 'id')?.value
  const settings = g.value.find((p: any) => p.key === 'settings')?.value ?? []
  const dz = settings.filter((p: any) => p.key === 'deadzone' || p.key === 'deadzone_outer_radius')
  const want = id === '2' || id === '3' || id === '6' ? 2 : 0
  const ok = dz.length === want
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} group ${id}: ${dz.map((p: any) => `${p.key}=${p.value}`).join(', ') || '(untouched)'}`)
}
// bindings intact?
const binds = (patched.match(/xinput_button/g) ?? []).length
const bindsBefore = (template.match(/xinput_button/g) ?? []).length
console.log(binds === bindsBefore ? `✓ bindings intact (${binds})` : `✗ bindings changed ${bindsBefore} -> ${binds}`)
if (binds !== bindsBefore) failures++
console.log(failures === 0 ? 'TEMPLATE PROOF PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
