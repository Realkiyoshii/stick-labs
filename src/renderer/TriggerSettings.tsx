import { useEffect, useRef, useState } from 'react'
import { trigger, type Profile } from '@shared/profile'
import { TRIGGER_PRESETS, identifyTriggerPreset, setTriggerPoint, setTriggerPreset, setTriggerRange, setTriggerRangeEnabled, setTriggerRapidMode, setTriggerRapidRange, validTriggerCurve, visibleTriggerCurve, type TriggerPoint, type TriggerPreset, type TriggerRangeField } from '@shared/trigger'
import { useT } from './i18n'

function Parameter({ label, value, min = 0, max = 100, step = 0.1, disabled, signed = false, change }: {
  label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; signed?: boolean; change: (value: number) => boolean
}): JSX.Element {
  const format = (n: number): string => step < 1 ? n.toFixed(1) : String(n)
  const [text, setText] = useState(format(value))
  useEffect(() => setText(format(value)), [value, step])
  const commit = (): void => { if (!text.trim() || !change(Number(text))) setText(format(value)) }
  return <label className="trigger-parameter"><span>{label}</span><div className="trigger-number"><input aria-label={label} type="number" min={min} max={max} step={step} value={text} disabled={disabled} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /><span>{signed ? '' : '%'}</span></div><input aria-label={`${label} slider`} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={e => change(Number(e.target.value))} /></label>
}

function TriggerGraph({ points, editable, onPoint }: { points: TriggerPoint[]; editable: boolean; onPoint: (index: number, percent: TriggerPoint) => void }): JSX.Element {
  const t = useT()
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ index: number; pointer: number; x: number; y: number } | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const x = (n: number): number => 32 + n / 255 * 276
  const y = (n: number): number => 308 - n / 255 * 276
  const clamp = (i: number, p: TriggerPoint): TriggerPoint => ({
    x: Math.max(points[i - 1].x + 1, Math.min(points[i + 1].x - 1, Math.round(p.x))) / 255 * 100,
    y: Math.max(points[i - 1].y + 1, Math.min(points[i + 1].y - 1, Math.round(p.y))) / 255 * 100
  })
  const end = (): void => { const p = drag.current?.pointer; drag.current = null; if (p !== undefined && svg.current?.hasPointerCapture(p)) svg.current.releasePointerCapture(p) }
  useEffect(() => { if (!editable) end() }, [editable])
  return <div className="trigger-graph"><svg ref={svg} viewBox="0 0 340 340" role="group" aria-label={t('trgx.response')} onPointerMove={e => {
    const d = drag.current
    if (!editable || !d || d.pointer !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) < 2) return
    const box = e.currentTarget.getBoundingClientRect()
    onPoint(d.index, clamp(d.index, { x: ((e.clientX - box.left) / box.width * 340 - 32) / 276 * 255, y: (308 - (e.clientY - box.top) / box.height * 340) / 276 * 255 }))
  }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
    <rect className="trigger-graph-bg" x="32" y="32" width="276" height="276" />
    {[0, 25, 50, 75, 100].map(n => <g key={n}><path className="trigger-grid" d={`M${32 + n * 2.76} 32V308M32 ${308 - n * 2.76}H308`} /><text x={32 + n * 2.76} y="330" textAnchor="middle">{n}%</text><text x="25" y={312 - n * 2.76} textAnchor="end">{n}</text></g>)}
    <path className="trigger-baseline" d="M32 308 308 32" />
    <polyline className="trigger-response-line" points={points.map(p => `${x(p.x)},${y(p.y)}`).join(' ')} />
    {points.map((p, i) => <g key={i}><circle cx={x(p.x)} cy={y(p.y)} r="12" className="trigger-point-hit" role="button" aria-label={`P${i + 1}`} aria-disabled={!editable || i === 0 || i === 4} tabIndex={editable && i > 0 && i < 4 ? 0 : -1} onFocus={() => setSelected(i)} onPointerDown={e => {
      if (!editable || i === 0 || i === 4 || e.button !== 0) return
      e.preventDefault(); e.currentTarget.focus(); setSelected(i)
      drag.current = { index: i, pointer: e.pointerId, x: e.clientX, y: e.clientY }; svg.current?.setPointerCapture(e.pointerId)
    }} onKeyDown={e => {
      if (e.key === 'Escape') { end(); return }
      if (!editable || i === 0 || i === 4 || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return
      e.preventDefault(); const step = e.shiftKey ? 5 : 1
      onPoint(i, clamp(i, { x: p.x + (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0), y: p.y + (e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0) }))
    }} /><circle className={`trigger-point${i === 0 || i === 4 ? ' locked' : ''}`} cx={x(p.x)} cy={y(p.y)} r="5" /><text x={x(p.x) + (i === 4 ? -23 : 8)} y={y(p.y) - 9}>P{i + 1}</text></g>)}
  </svg><div className="trigger-graph-readout">{selected === null ? `${t('trgx.input')} → ${t('trgx.output')}` : `P${selected + 1} · ${t('trgx.input')} ${(points[selected].x / 255 * 100).toFixed(1)}% / ${t('trgx.output')} ${(points[selected].y / 255 * 100).toFixed(1)}%`}</div></div>
}

export function TriggerSettings({ profile, edit, disabled = false }: { profile: Profile; edit: (fn: () => void) => void; disabled?: boolean }): JSX.Element {
  const t = useT()
  const [side, setSide] = useState(0)
  const [panel, setPanel] = useState<'basic' | 'rapid'>('basic')
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<{ signature: string; preset: TriggerPreset; adjustment: number } | null>(null)
  const packet = profile.triggers[side]
  if (!packet) return <></>
  const points = visibleTriggerCurve(packet)
  const signature = `${profile.model}:${profile.name}:${side}:${Array.from(packet.bytes.slice(19)).join(',')}`
  const selected = choice?.signature === signature ? choice : identifyTriggerPreset(points)
  const ranges = trigger.deadzonePercent(trigger.deadzone(packet))
  const enabled = !!packet.u8(2)
  const change = (fn: () => void): boolean => { try { edit(fn); setError(null); return true } catch (e) { setError((e as Error).message); return false } }
  const remember = (preset: TriggerPreset, adjustment: number): void => setChoice({ signature: `${profile.model}:${profile.name}:${side}:${Array.from(packet.bytes.slice(19)).join(',')}`, preset, adjustment })
  const preset = (name: TriggerPreset): void => {
    const amount = name === 'default' || name === 'custom' ? 0 : selected.adjustment
    if (change(() => setTriggerPreset(packet, name, amount))) remember(name, amount)
  }
  const updatePoint = (i: number, percent: TriggerPoint): void => { if (change(() => setTriggerPoint(packet, i, percent))) remember('custom', 0) }
  return <section className="card trigger-settings">
    <div className="trigger-settings-top"><h3>{t('trgx.title')}</h3><div className="trigger-tabs" role="group" aria-label={t('trgx.select')}>
      {[0, 1].map(i => <button type="button" key={i} className={`choice-btn${side === i ? ' active' : ''}`} aria-pressed={side === i} onClick={() => { setSide(i); setError(null) }}>{t(i === 0 ? 'trgx.left' : 'trgx.right')}</button>)}
    </div></div>
    <fieldset disabled={disabled} className="trigger-settings-columns"><section className="trigger-settings-parameters">
      <div className="trigger-section-heading"><h4>{t(side === 0 ? 'trgx.left' : 'trgx.right')}</h4><div className="trigger-tabs" role="group" aria-label={t('trgx.groups')}>{(['basic', 'rapid'] as const).map(p => <button type="button" className={`choice-btn${panel === p ? ' active' : ''}`} key={p} aria-pressed={panel === p} onClick={() => setPanel(p)}>{t(`trgx.${p}`)}</button>)}</div></div>
      {panel === 'basic' ? <><label className="trigger-switch"><span>{t('trgx.customDeadzone')}</span><input type="checkbox" checked={enabled} onChange={e => change(() => setTriggerRangeEnabled(packet, e.target.checked))} /></label>
        <div className="trigger-range-grid">{(['begin', 'end', 'beginAnti', 'endAnti'] as TriggerRangeField[]).map(field => <Parameter key={`${side}:${field}`} label={t(`trgx.${field}`)} value={ranges[field]} disabled={!enabled} change={value => change(() => setTriggerRange(packet, field, value))} />)}</div>
      </> : <><div className="trigger-rapid-label">{t('trgx.rapidMode')}</div><div className="trigger-tabs trigger-rapid-options">{[0, 129, 130].map((mode, i) => <button type="button" className={`choice-btn${packet.u8(16) === mode ? ' active' : ''}`} key={mode} aria-pressed={packet.u8(16) === mode} onClick={() => change(() => setTriggerRapidMode(packet, mode))}>{t(`trgx.mode${i}`)}</button>)}</div>
        <div className="trigger-range-grid">{([17, 18] as const).map(offset => <Parameter key={`${side}:${offset}`} label={t(offset === 17 ? 'trgx.rapidStart' : 'trgx.rapidEnd')} value={packet.u8(offset)} min={1} step={1} disabled={!(packet.u8(16) & 128)} change={value => change(() => setTriggerRapidRange(packet, offset, value))} />)}</div>
      </>}
    </section><section className="trigger-settings-response"><h4>{t('trgx.response')}</h4>
      <div className="trigger-curve-options"><label className="trigger-preset-label">{t('trgx.preset')}<select className="input" value={selected.preset} onChange={e => preset(e.target.value as TriggerPreset)}>{TRIGGER_PRESETS.map(name => <option key={name} value={name}>{t(`trgx.preset.${name}`)}</option>)}</select></label>
        <Parameter label={t('trgx.adjustment')} value={selected.adjustment} min={-5} max={5} step={1} signed disabled={selected.preset === 'default' || selected.preset === 'custom'} change={amount => { if (!change(() => setTriggerPreset(packet, selected.preset, amount))) return false; remember(selected.preset, amount); return true }} />
      </div>
      <div className="trigger-curve-editor"><TriggerGraph points={points} editable={!disabled && validTriggerCurve(points)} onPoint={updatePoint} />
        <div className="trigger-coordinates"><div className="trigger-coordinate-head"><span>{t('trgx.point')}</span><span>{t('trgx.input')} %</span><span>{t('trgx.output')} %</span></div>
          {points.map((point, i) => <div className="trigger-coordinate-row" key={`${side}:${i}`}><span>P{i + 1}{(i === 0 || i === 4) && <small>{t('trgx.fixed')}</small>}</span>{(['x', 'y'] as const).map(axis => <input key={axis} className="input" type="number" min={0} max={100} step={0.4} aria-label={`P${i + 1} ${t(axis === 'x' ? 'trgx.input' : 'trgx.output')}`} disabled={i === 0 || i === 4} value={Number((point[axis] / 255 * 100).toFixed(1))} onChange={e => { if (e.currentTarget.value.trim()) updatePoint(i, { x: point.x / 255 * 100, y: point.y / 255 * 100, [axis]: e.currentTarget.valueAsNumber }) }} />)}</div>)}
        </div>
      </div>{!validTriggerCurve(points) && <p className="note warn">{t('trgx.invalidCurve')}</p>}
    </section></fieldset>
    {error && <p className="note bad" role="alert">{error}</p>}
  </section>
}
