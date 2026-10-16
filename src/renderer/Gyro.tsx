import { useState, type ReactNode } from 'react'
import { type Packet, type Profile, motion, fun } from '@shared/profile'
import { bounded, curvePoints, setCustomCurve, setMotionActivation, setPercent, setWindow } from '@shared/gyro'
import { KEY_TARGETS, keyLabel } from '@shared/keymap'
import './gyro.css'

function SectionTitle({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return <div className="gyro-title"><h3>{title}</h3><details><summary aria-label={`Help: ${title}`}>?</summary><div className="gyro-help">{children}</div></details></div>
}
function KeyPicker({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }): JSX.Element {
  return <select className="input" aria-label={label} value={value} onChange={e => onChange(Number(e.target.value))}>
    {!KEY_TARGETS.some(k => k.value === value && k.value !== 231) && <option value={value}>{keyLabel(value)}</option>}
    {KEY_TARGETS.filter(k => k.value !== 231).map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
  </select>
}

type Props = { profile: Profile; edit: (fn: () => void) => void; busy: boolean }
function NumberField({ label, value, max = 100, step = 1, change }: { label: string; value: number; max?: number; step?: number; change: (v: number) => void }): JSX.Element {
  return <label className="stack">{label}<input className="input" type="number" min={0} max={max} step={step} value={value} onChange={(e) => { if (e.target.value !== '') change(Number(e.target.value)) }} /></label>
}
function WindowControls({ p, start, enabled, change }: { p: Packet; start: number; enabled: number; change: (fn: () => void) => void }): JSX.Element {
  const values = Array.from({ length: 4 }, (_, i) => p.u16be(start + i * 2))
  return <><SectionTitle title="Input and output range">Input minimum removes movement near rest. Input maximum sets where full travel is reached. Output minimum adds an initial output; output maximum caps it. Input minimum must stay below input maximum.</SectionTitle><label><input type="checkbox" checked={p.bit(enabled, 0)} onChange={(e) => change(() => p.setBit(enabled, 0, e.target.checked))} /> Enable deadzone and output range</label><div className="control-grid">{['Input minimum %', 'Input maximum %', 'Output minimum %', 'Output maximum %'].map((label, i) => <NumberField key={label} label={label} step={0.1} value={values[i] / 10} change={(v) => change(() => { const next = [...values]; next[i] = Math.round(v * 10); setWindow(p, start, next) })} />)}</div></>
}
function CurveControls({ p, offset, change }: { p: Packet; offset: number; change: (fn: () => void) => void }): JSX.Element {
  const points = curvePoints(p, offset)
  return <><SectionTitle title="Response curve">Maps input movement to output. Custom points use the input range above; endpoints stay at 0 and 100%. Editing a point enables the curve.</SectionTitle><label><input type="checkbox" checked={p.bit(offset - 3, 0)} onChange={(e) => change(() => p.setBit(offset - 3, 0, e.target.checked))} /> Enable curve</label><svg viewBox="0 0 260 110" style={{ width: '100%', height: 160 }} aria-label="Response curve"><path d="M2 2V108H258" fill="none" stroke="#666" /><polyline points={points.map((v) => `${2 + v.x},${108 - v.y * 106 / 255}`).join(' ')} stroke="#fb4058" fill="none" strokeWidth="2" /></svg><div className="control-grid">{points.slice(1, 4).map((point, i) => <div key={i}><NumberField label={`Point ${i + 1} input %`} step={0.1} value={Math.round(point.x / 255 * 1000) / 10} change={(v) => change(() => { const next = points.map((pt) => ({ ...pt })); next[i + 1].x = Math.round(v * 255 / 100); setCustomCurve(p, offset, next) })} /><NumberField label={`Point ${i + 1} output %`} step={0.1} value={Math.round(point.y / 255 * 1000) / 10} change={(v) => change(() => { const next = points.map((pt) => ({ ...pt })); next[i + 1].y = Math.round(v * 255 / 100); setCustomCurve(p, offset, next) })} /></div>)}</div><button className="btn" onClick={() => change(() => { setCustomCurve(p, offset, [0, 64, 128, 191, 255].map((v) => ({ x: v, y: v }))); p.setU8(offset - 2, 0); p.setU8(offset - 1, 50) })}>Linear curve</button></>
}
export function GyroTuning({ profile, edit, busy }: Props): JSX.Element {
  const [side, setSide] = useState(0), [error, setError] = useState('')
  const p = profile.motion[side], activation = p.u8(0), output = p.u8(33)
  function change(fn: () => void): void { try { edit(fn); setError('') } catch (e) { setError((e as Error).message) } }
  const percent = (offset: number, label: string): JSX.Element => <NumberField key={offset} label={label} value={p.u8(offset)} change={(v) => change(() => setPercent(p, offset, v))} />
  return <div className="stack gyro-tuning">
    <div className="card"><SectionTitle title="Gyro tuning">Aim and Tilt are separate firmware configurations. Enabling one disables the other without deleting its settings. Support depends on firmware and connection mode. Changes apply with Write to controller.</SectionTitle>
      <div className="segmented" role="group" aria-label="Motion configuration">{['Tilt', 'Aim'].map((label, i) => <button type="button" disabled={busy} aria-pressed={side === i} key={label} className={side === i ? 'selected' : ''} onClick={() => setSide(i)}>{label}<small>{i ? 'Aim configuration' : 'Tilt configuration'}</small></button>)}</div>
      <p className="hint">Editing {side ? 'Aim' : 'Tilt'} · {['Off', 'Hold combination', 'Toggle combination', 'Always on'][activation] ?? 'Stored activation'} · write to apply</p>
    </div>
    {error && <p className="note bad" role="alert">{error}</p>}
    <fieldset className="control-fieldset" disabled={busy}><div className="settings-grid">
      <section className="card"><SectionTitle title="1. Activation">Off disables this configuration. Hold requires the chosen combination to remain pressed. Toggle switches it on and off with the combination. Always on needs no activation keys.</SectionTitle>
        <label className="stack">When motion is active<select className="input" value={activation} onChange={e => change(() => setMotionActivation(profile.motion, side, Number(e.target.value)))}>
          {![0,1,2,3].includes(activation) && <option value={activation}>Stored activation {activation}</option>}
          {['Off', 'Hold button combination', 'Toggle with button combination', 'Always on'].map((label, i) => <option key={label} value={i}>{label}</option>)}
        </select></label>
        {(activation === 1 || activation === 2) && <div className="control-grid">{motion.triggerKeys(p).map((value, i) => <label className="stack" key={i}>Combination key {i + 1}<KeyPicker label={'Activation key ' + (i + 1)} value={value} onChange={v => change(() => { const keys = motion.triggerKeys(p); keys[i] = v; motion.setTriggerKeys(p, keys) })} /></label>)}</div>}
        <SectionTitle title="Sensor mode · shared">Precision and High speed are the firmware’s sensor presets. This selection applies to both Aim and Tilt; it does not establish a measured sampling rate.</SectionTitle>
        <label className="stack">Sensor preset<select className="input" value={fun.extend.sensorQuickMode(profile.funData)} onChange={e => change(() => fun.extend.setSensorQuickMode(profile.funData, bounded(Number(e.target.value), 1)))}>
          {![0,1].includes(fun.extend.sensorQuickMode(profile.funData)) && <option value={fun.extend.sensorQuickMode(profile.funData)}>Stored mode {fun.extend.sensorQuickMode(profile.funData)}</option>}
          <option value={0}>Precision</option><option value={1}>High speed</option>
        </select></label>
      </section>
      <section className="card"><SectionTitle title="2. Output mapping">Converts motion into the selected destination. Disabling mapping preserves its stored settings. Directional outputs use the key assignments below. Mouse support depends on firmware and connection mode.</SectionTitle>
        <label className="check-row"><input type="checkbox" checked={p.bit(27, 0)} onChange={e => change(() => p.setBit(27, 0, e.target.checked))} /> Enable output mapping</label>
        <fieldset className="control-fieldset" disabled={!p.bit(27, 0)}><label className="stack">Send motion to<select className="input" aria-label="Send motion to" value={output} onChange={e => change(() => p.setU8(33, bounded(Number(e.target.value), 4)))}>{![1,2,3,4].includes(output) && <option value={output}>Stored value {output}</option>}{['Left stick', 'Right stick', 'Directional keys / wheel', 'Mouse'].map((name,i) => <option key={name} value={i+1}>{name}</option>)}</select></label>
        {output === 4 && percent(32, 'Mouse sensitivity · 50 neutral')}{(output === 1 || output === 2) && percent(40, 'Stick sensitivity · 50 neutral')}
        {output === 3 && <div className="control-grid">{['Up', 'Down', 'Left', 'Right', 'Outside deadzone'].map((label, i) => <label className="stack" key={label}>{label}<KeyPicker label={'Motion output: ' + label} value={p.u8(35 + i)} onChange={v => change(() => p.setU8(35 + i, v))} /></label>)}</div>}</fieldset>
      </section>
      <section className="card"><SectionTitle title="3. Axes and direction">Yaw turns the controller left/right; roll tilts its sides. Orientation chooses the horizontal motion source. Inversion reverses an axis. Axis balance adjusts the firmware’s relative axis weighting; 50 is neutral.</SectionTitle>
        <label className="stack">Horizontal motion<select className="input" value={motion.orientation(p)} onChange={e => change(() => motion.setOrientation(p, Number(e.target.value)))}>{['Yaw', 'Roll', 'Yaw + roll'].map((label, i) => <option key={label} value={i}>{label}</option>)}</select></label>
        <div className="stack">{[[28, 'Invert horizontal roll'], [29, 'Invert vertical'], [30, 'Invert horizontal yaw']].map(([offset, label]) => <label className="check-row" key={offset}><input type="checkbox" checked={p.bit(Number(offset), 0)} onChange={e => change(() => p.setBit(Number(offset), 0, e.target.checked))} />{label}</label>)}</div>
        {percent(31, 'Axis balance · 50 equal')}
      </section>
      <section className="card"><SectionTitle title="4. Motion response">Range controls the deadzone and output limits. The curve changes how motion grows between those limits. Reset affects only this configuration’s range and curve, preserving activation and output mapping.</SectionTitle>
        <WindowControls p={p} start={6} enabled={5} change={change} /><CurveControls p={p} offset={17} change={change} />
        <button type="button" className="btn ghost" onClick={() => change(() => { setWindow(p, 6, [0, 1000, 0, 1000]); p.setBit(5, 0, true); setCustomCurve(p, 17, [0, 64, 128, 191, 255].map(v => ({ x: v, y: v }))); p.setU8(15, 0); p.setU8(16, 50) })}>Reset range and curve</button>
      </section>
    </div></fieldset>
  </div>
}
