import { useEffect, useRef, useState } from 'react'
import { useT } from './i18n'

/**
 * Deadzone and anti-deadzone cards shared by every controller. Values are in
 * tenths of a percent (0..1000), the 0.1% step every pad stores. Each value can
 * be typed, nudged by 0.1% (Shift: 1%), dragged, or set from a preset; the
 * slider shows where the stick is right now, and "Measure" reads the live
 * stick to set the deadzone just above its resting drift, or full input just
 * inside its reach. The graph shows what the four values do to the output.
 */

export interface Zones { start: number; end: number; floor: number; ceiling: number }
type ZoneKey = keyof Zones
export type ZoneLimits = Record<ZoneKey, [number, number]>

/** Live stick position, 0..255 per axis with 128 at rest. */
export type LiveStick = { x: number; y: number } | null

const PRESETS: Record<ZoneKey, number[]> = {
  start: [0, 20, 40, 60, 80, 100],
  end: [850, 900, 950, 1000],
  floor: [0, 50, 100, 150, 200, 250],
  ceiling: [900, 950, 1000]
}
/** Smallest gap kept between deadzone and full input, and between floor and ceiling. */
const MIN_GAP = 10
const DRIFT_MARGIN = 5
const MEASURE_MS = { start: 2000, end: 3000 }

/** Stick distance from rest in tenths of a percent (0..1000). */
const magnitude = (s: LiveStick): number | null => s ? Math.min(1000, Math.round(Math.hypot(s.x - 128, s.y - 128) / 127 * 1000)) : null
const pct = (v: number): string => (v / 10).toFixed(1)
const clamp = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, Math.round(v)))

/** Output (0..1000) for an input (0..1000) under these zones, before any curve. */
function respond(z: Zones, x: number): number {
  if (x <= z.start) return 0
  if (x >= z.end) return z.ceiling
  return z.floor + (z.ceiling - z.floor) * (x - z.start) / (z.end - z.start)
}

/**
 * Input (0..1000) that produced an output, under these zones: inverts the
 * straight part between deadzone and full input. Pads whose live reading is
 * their own output (HyperStrike, LeadJoy) are measured through this.
 */
function toInput(z: Zones, out: number): number {
  const span = Math.max(1, z.ceiling - z.floor)
  return z.start + Math.min(1, Math.max(0, (out - z.floor) / span)) * (z.end - z.start)
}

/** Keep the four values ordered after one of them changes. */
function settle(z: Zones, key: ZoneKey, v: number, limits: ZoneLimits): Zones {
  const n = { ...z, [key]: clamp(v, limits[key]) }
  if (key === 'start' && n.start > n.end - MIN_GAP) n.start = n.end - MIN_GAP
  if (key === 'end' && n.end < n.start + MIN_GAP) n.end = n.start + MIN_GAP
  if (key === 'floor' && n.floor > n.ceiling - MIN_GAP) n.floor = n.ceiling - MIN_GAP
  if (key === 'ceiling' && n.ceiling < n.floor + MIN_GAP) n.ceiling = n.floor + MIN_GAP
  return n
}

function ResponseGraph({ zones, live }: { zones: Zones; live: number | null }): JSX.Element {
  const t = useT()
  const W = 300
  const H = 140
  const P = 8
  const sx = (v: number): number => P + (v / 1000) * (W - 2 * P)
  const sy = (v: number): number => H - P - (v / 1000) * (H - 2 * P)
  const path = [
    `M${sx(0)} ${sy(0)}`, `L${sx(zones.start)} ${sy(0)}`, `L${sx(zones.start)} ${sy(zones.floor)}`,
    `L${sx(zones.end)} ${sy(zones.ceiling)}`, `L${sx(1000)} ${sy(zones.ceiling)}`
  ].join(' ')
  return (
    <figure className="dz-graph">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('dz.graph')}>
        <rect className="dz-graph-dead" x={sx(0)} y={P} width={sx(zones.start) - sx(0)} height={H - 2 * P} />
        <rect className="dz-graph-full" x={sx(zones.end)} y={P} width={sx(1000) - sx(zones.end)} height={H - 2 * P} />
        {[250, 500, 750].map((g) => <line key={g} className="dz-graph-grid" x1={sx(g)} x2={sx(g)} y1={P} y2={H - P} />)}
        {[250, 500, 750].map((g) => <line key={`h${g}`} className="dz-graph-grid" x1={P} x2={W - P} y1={sy(g)} y2={sy(g)} />)}
        <line className="dz-graph-ref" x1={sx(0)} y1={sy(0)} x2={sx(1000)} y2={sy(1000)} />
        <path className="dz-graph-line" d={path} />
        {live !== null && <circle className="dz-graph-dot" cx={sx(live)} cy={sy(respond(zones, live))} r={4.5} />}
      </svg>
      <figcaption className="row spread"><span>{t('dz.in')} →</span><span>{live !== null ? `${t('dz.now')} ${pct(live)}% → ${pct(respond(zones, live))}%` : t('dz.noLive')}</span><span>↑ {t('dz.out')}</span></figcaption>
    </figure>
  )
}

function ZoneRow({ label, help, value, limits, live, presets, onSet, measure }: {
  label: string
  help: string
  value: number
  limits: [number, number]
  live: number | null
  presets: number[]
  onSet: (v: number) => void
  measure?: React.ReactNode
}): JSX.Element {
  const [text, setText] = useState(pct(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => { if (!editing) setText(pct(value)) }, [value, editing])
  const commit = (): void => {
    setEditing(false)
    const v = Number.parseFloat(text.replace(',', '.'))
    if (Number.isFinite(v)) onSet(Math.round(v * 10))
    else setText(pct(value))
  }
  const nudge = (dir: number, big: boolean): void => onSet(value + dir * (big ? 10 : 1))
  const [lo, hi] = limits
  const at = (v: number): string => `${((v - lo) / (hi - lo)) * 100}%`
  const liveShown = live !== null && live >= lo && live <= hi
  return (
    <div className="dz-row">
      <div className="dz-row-head">
        <div>
          <span className="label">{label}</span>
          <p className="dz-help">{help}</p>
        </div>
        <div className="dz-value">
          <button type="button" className="dz-step" aria-label={`${label} −0.1%`} title="−0.1% (Shift: −1%)" onClick={(e) => nudge(-1, e.shiftKey)}>−</button>
          <label className="dz-input">
            <input
              inputMode="decimal"
              value={text}
              aria-label={label}
              onFocus={(e) => { setEditing(true); e.target.select() }}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') { setText(pct(value)); setEditing(false); (e.target as HTMLInputElement).blur() }
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey) }
              }}
            />
            <span>%</span>
          </label>
          <button type="button" className="dz-step" aria-label={`${label} +0.1%`} title="+0.1% (Shift: +1%)" onClick={(e) => nudge(1, e.shiftKey)}>+</button>
        </div>
      </div>
      <div className="dz-track">
        <input type="range" className="input" min={lo} max={hi} step={1} value={value} aria-label={label} onChange={(e) => onSet(Number(e.target.value))} />
        {liveShown && <span className="dz-live" style={{ left: at(live) }} title={`${pct(live)}%`} />}
      </div>
      <div className="dz-presets">
        {presets.filter((p) => p >= lo && p <= hi).map((p) => (
          <button key={p} type="button" className={`dz-chip${p === value ? ' active' : ''}`} onClick={() => onSet(p)}>{pct(p).replace(/\.0$/, '')}%</button>
        ))}
        {measure}
      </div>
    </div>
  )
}

export function DeadzoneCards({ zones, limits, onChange, live, liveIsOutput = false, fixedCeiling = false, inputClass = 'card', outputClass = 'card stick-output-card', outputExtra }: {
  zones: Zones
  limits: ZoneLimits
  onChange: (next: Zones) => void
  live: LiveStick
  /** The live reading is the pad's output (after these zones), not the raw stick. */
  liveIsOutput?: boolean
  /** The pad keeps output at 100% at the end: no ceiling control. */
  fixedCeiling?: boolean
  inputClass?: string
  outputClass?: string
  outputExtra?: React.ReactNode
}): JSX.Element {
  const t = useT()
  const mag = magnitude(live)
  // Where the stick is in input terms. An output reading of 0 only says "inside the deadzone".
  const pos = mag === null ? null : liveIsOutput ? (mag > 0 ? Math.round(toInput(zones, mag)) : null) : mag
  const set = (key: ZoneKey) => (v: number): void => onChange(settle(zones, key, v, limits))

  // Measuring: collect the stick's reach for a moment, then set the value from it.
  const [measuring, setMeasuring] = useState<ZoneKey | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const peak = useRef(0)
  useEffect(() => { if (measuring && mag !== null) peak.current = Math.max(peak.current, mag) }, [mag, measuring])
  const zonesRef = useRef(zones)
  zonesRef.current = zones
  const measure = (key: 'start' | 'end'): void => {
    peak.current = mag ?? 0
    setResult(null)
    setMeasuring(key)
    window.setTimeout(() => {
      const z = zonesRef.current
      const p = peak.current
      const say = (key2: string, d: number, v: number): void => setResult(t(key2).replace('{d}', pct(d)).replace('{v}', pct(v)))
      if (key === 'start') {
        if (p === 0) {
          say(z.start > 0 ? 'dz.driftCovered' : 'dz.driftNone', 0, z.start)
        } else {
          // Raw: the reading is the drift. Output: drift leaked past the current deadzone.
          const drift = liveIsOutput ? toInput(z, p) : p
          const v = settle(z, 'start', drift + DRIFT_MARGIN, limits)
          onChange(v)
          say('dz.driftResult', drift, v.start)
        }
      } else if (liveIsOutput && p >= 995) {
        say('dz.reachFull', p, z.end)
      } else {
        const reach = liveIsOutput ? toInput(z, p) : p
        const v = settle(z, 'end', reach - DRIFT_MARGIN * 2, limits)
        onChange(v)
        say('dz.reachResult', reach, v.end)
      }
      setMeasuring(null)
    }, MEASURE_MS[key])
  }
  const measureBtn = (key: 'start' | 'end'): JSX.Element => (
    <button type="button" className={`dz-chip dz-measure${measuring === key ? ' busy' : ''}`} disabled={mag === null || measuring !== null} title={mag === null ? t('dz.noLive') : undefined} onClick={() => measure(key)}>
      {measuring === key ? t(key === 'start' ? 'dz.measuringDrift' : 'dz.measuringReach') : t(key === 'start' ? 'dz.measureDrift' : 'dz.measureReach')}
    </button>
  )

  return <>
    <div className={`${inputClass} dz-card`}>
      <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.inputLabel')}</span><h3>{t('sticks.inputTitle')}</h3></div><span className="pill">0.1%</span></div>
      <ResponseGraph zones={zones} live={pos} />
      {result && <p className="dz-result" role="status">{result}</p>}
      <ZoneRow label={t('sticks.innerLabel')} help={t('dz.startHelp')} value={zones.start} limits={limits.start} live={pos} presets={PRESETS.start} onSet={set('start')} measure={measureBtn('start')} />
      <ZoneRow label={t('sticks.outerLabel')} help={t('dz.endHelp')} value={zones.end} limits={limits.end} live={pos} presets={PRESETS.end} onSet={set('end')} measure={measureBtn('end')} />
    </div>
    <div className={`${outputClass} dz-card`}>
      <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.outputLabel')}</span><h3>{t('sticks.outputTitle')}</h3></div></div>
      <ZoneRow label={t('sticks.floorLabel')} help={t('dz.floorHelp')} value={zones.floor} limits={limits.floor} live={null} presets={PRESETS.floor} onSet={set('floor')} />
      {!fixedCeiling && <ZoneRow label={t('sticks.ceilingLabel')} help={t('dz.ceilingHelp')} value={zones.ceiling} limits={limits.ceiling} live={null} presets={PRESETS.ceiling} onSet={set('ceiling')} />}
      {outputExtra}
    </div>
  </>
}
