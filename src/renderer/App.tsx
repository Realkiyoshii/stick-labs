import { buildCleanProfile } from '@shared/clean-profile'
import { capturedKeyTarget, capturedPadTarget, PadCaptureGate, type CaptureFamily } from '@shared/button-capture'
import { useContext, useEffect, useRef, useState } from 'react'
import { TriggerSettings } from './TriggerSettings'
import { api, b64ToBytes, bytesToB64, type Candidate, type DeviceInfo, type DeviceStats, type LiveSample, type PingResult } from './api'
import { parseProfile, serializeProfile, fun, stick, button, trigger, LINEAR_CURVE, looksLikeCEProfile, type Packet, type Profile } from '@shared/profile'
import { PROFILE_LENGTH, REPORT_RATE_OPTIONS, STICK_RESOLUTION_OPTIONS, STANDARD_BUTTONS, CENTER_NUDGE, CalMode, CalPart } from '@shared/protocol'
import { identifyModel, identifyLeadJoyName, MODELS, type ControllerModel } from '@shared/models'
import {
  describeRawResolution,
  bitsToLevels,
  bitsToWireRaw,
  resampleCurve,
  traceSpline,
  addDesignPoint,
  DESIGN_MIN_POINTS,
  DESIGN_MAX_POINTS,
  outerBufferFromBytes,
  isOuterUnlimited,
  linFrontier, linTremor, linResolution, linResample, linMedian,
  linRepresentative, linLinearity, LIN_MIN_PASSES
} from '@shared/sticklab'
import { keyLabel, displayMapping, REMAP_TARGETS } from '@shared/keymap'
import { createPortal } from 'react-dom'
import { LANGS, LangContext, tr, useLangState, useT } from './i18n'
import { THEMES, ThemeContext, useThemeState } from './theme'
import type { DeepPollResult } from '@shared/deeppoll'
import { LJ_HID_KEYS, LJ_MOUSE_BUTTONS, LJ_MAP_GAMEPAD, LJ_MAP_KEYBOARD, LJ_MAP_MOUSE, LJ_SHAPES, LJ_PHYSICAL, ljCurveZones, ljFitZones, ljLinearCurve, ljPercentToWire, ljSampleDesign, ljTargetLabel, type LjButtonTarget, type LjSnapshot, type LjStickZones, type LjTriggerZones } from '@shared/leadjoy'


/**
 * Collapsible help text — every descriptive hint/note in the UI hides behind
 * a small `?` toggle so cards stay clean. Warnings, errors, live readouts
 * and anything interactive are never wrapped in this; only static explainer
 * copy. Expanded content keeps the original `.hint` styling.
 */
function Hint({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="hint-wrap" style={style}>
      <button
        type="button"
        className="hint-toggle"
        title={open ? t('hint.hide') : t('hint.show')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '–' : '?'}
      </button>
      {open && <div className="hint">{children}</div>}
    </div>
  )
}

function CandidateButton({ candidate, onConnect, displayName }: { candidate: Candidate; onConnect: (path: string) => void; displayName?: string }): JSX.Element {
  const known = identifyModel(candidate.product, candidate.productId)
  const genericProduct = !candidate.product || /^(gamepad|xbox 360 controller for windows)$/i.test(candidate.product.trim())
  const fallbackName = genericProduct
    ? `Controller · 0x${candidate.productId.toString(16).padStart(4, '0')}`
    : candidate.product
  return (
    <button className="btn sm" onClick={() => onConnect(candidate.path)}>
      {displayName ?? (known ? known.marketingName : fallbackName)}{candidate.preferred ? ' ★' : ''}
    </button>
  )
}

function Slider(props: {  label: React.ReactNode
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
  format?: (v: number) => string
}): JSX.Element {
  return (
    <label style={{ display: 'block' }}>
      <div className="row spread">
        <span className="label">{props.label}</span>
        <span className="mono">{props.format ? props.format(props.value) : `${props.value}${props.unit ?? ''}`}</span>
      </div>
      <input
        type="range"
        className="input"
        style={{ width: '100%' }}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

type CurvePoint = { x: number; y: number }
type CurveEditorDraft = { points: CurvePoint[]; spline: boolean; output: string }
function sampleDesign(points: CurvePoint[], spline: boolean): CurvePoint[] {
  return resampleCurve(spline ? traceSpline(points, 255) : points)
}
function sampleLjDesign(points: CurvePoint[], spline: boolean): CurvePoint[] {
  if (!spline) return points.map(p => ({ ...p }))
  const zones = ljCurveZones(toPairs(points))
  const width = zones.end - zones.start
  const range = zones.antiEnd - zones.antiStart
  if (width <= 0 || range === 0) return points.map(p => ({ ...p }))
  const normalized = points.map(p => ({ x: (p.x - zones.start) * 255 / width, y: (p.y - zones.antiStart) * 255 / range }))
  return toPts(ljSampleDesign(traceSpline(normalized, 255), zones))
}
function SplineControl({ enabled, onChange, slots }: { enabled: boolean; onChange: (enabled: boolean) => void; slots: number }): JSX.Element {
  const t = useT()
  return <div className="curve-spline-control"><div><strong>{t('sticks.spline')}</strong><p>{t('sticks.splineHelp').replace('{slots}', String(slots))}</p></div><button type="button" role="switch" aria-checked={enabled} aria-label={t('sticks.spline')} className={`curve-spline-switch${enabled ? ' enabled' : ''}`} onClick={() => onChange(!enabled)}><span aria-hidden="true" /><b>{t(enabled ? 'sticks.splineOn' : 'sticks.splineOff')}</b></button></div>
}

function CurvePlot({ points, onChange, onAddPoint, maxPoints = Number.POSITIVE_INFINITY, overlay, max = 255, height = 240, spline = false }: { points: Array<{ x: number; y: number }>; onChange?: (next: Array<{ x: number; y: number }>) => void; onAddPoint?: (point: { x: number; y: number }) => void; maxPoints?: number; overlay?: Array<{ x: number; y: number }>; max?: number; height?: number; spline?: boolean }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const drag = useRef<number | null>(null)

  function toPx(w: number, h: number): { toX: (v: number) => number; toY: (v: number) => number } {
    const pad = 10
    return {
      toX: (v: number): number => pad + (v / max) * (w - pad * 2),
      toY: (v: number): number => h - pad - (v / max) * (h - pad * 2)
    }
  }

  function pointAt(e: React.PointerEvent, w: number, h: number): number | null {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const { toX, toY } = toPx(w, h)
    let best: number | null = null
    let bestD = 14
    points.forEach((p, i) => {
      const d = Math.hypot(toX(p.x) - px, toY(p.y) - py)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  function movePoint(e: React.PointerEvent, i: number): void {
    const canvas = ref.current
    if (!canvas || !onChange) return
    const rect = canvas.getBoundingClientRect()
    const w = canvas.clientWidth
    const h = height
    const pad = 10
    const x = Math.max(0, Math.min(max, Math.round(((e.clientX - rect.left - pad) / (w - pad * 2)) * max)))
    const y = Math.max(0, Math.min(max, Math.round((1 - (e.clientY - rect.top - pad) / (h - pad * 2)) * max)))
    const next = points.map((p) => ({ ...p }))
    // Keep x-ordered: a dragged point may not cross its neighbours, or the
    // drawn polyline zigzags and the table rows leave slot order.
    const lo = i > 0 ? next[i - 1].x : 0
    const hi = i < next.length - 1 ? next[i + 1].x : max
    next[i] = { x: Math.max(lo, Math.min(hi, x)), y }
    onChange(next)
  }
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = height
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const pad = 10
    const toX = (v: number): number => pad + (v / max) * (w - pad * 2)
    const toY = (v: number): number => h - pad - (v / max) * (h - pad * 2)
    ctx.strokeStyle = '#3a2230'
    for (let i = 0; i <= 4; i++) {
      const t = (i / 4) * (w - pad * 2) + pad
      ctx.beginPath()
      ctx.moveTo(t, pad)
      ctx.lineTo(t, h - pad)
      const y = (i / 4) * (h - pad * 2) + pad
      ctx.moveTo(pad, y)
      ctx.lineTo(w - pad, y)
      ctx.stroke()
    }
    ctx.strokeStyle = '#552c38'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(0))
    ctx.lineTo(toX(max), toY(max))
    ctx.stroke()
    ctx.setLineDash([])
    // Max X / Y boundary lines (max edges) with labels.
    ctx.strokeStyle = 'rgba(62,207,142,0.55)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(toX(max), pad)
    ctx.lineTo(toX(max), h - pad)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(pad, toY(max))
    ctx.lineTo(w - pad, toY(max))
    ctx.stroke()
    ctx.fillStyle = '#3ecf8e'
    ctx.font = '10px system-ui'
    ctx.fillText(`X max ${max}`, toX(max) - 52, pad + 11)
    ctx.fillText(`Y max ${max}`, pad + 4, toY(max) + 13)
    // Endpoint projections: actual max X / max Y reached by the design.
    if (points.length > 0) {
      const maxX = Math.max(...points.map((p) => p.x))
      const maxY = Math.max(...points.map((p) => p.y))
      ctx.strokeStyle = 'rgba(245,181,68,0.8)'
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(toX(maxX), toY(0))
      ctx.lineTo(toX(maxX), toY(max))
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(toX(0), toY(maxY))
      ctx.lineTo(toX(max), toY(maxY))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#f5b544'
      ctx.fillText(`max X ${maxX}`, Math.min(toX(maxX) + 5, w - 52), h - pad - 5)
      ctx.fillText(`max Y ${maxY}`, pad + 4, toY(maxY) - 5)
    }
    ctx.strokeStyle = '#f43f52'
    ctx.lineWidth = 2
    ctx.beginPath()
    // Draw the selected interpolation; control handles remain on the original points.
    const line = spline ? traceSpline(points.map(p => ({ x: p.x * 255 / max, y: p.y * 255 / max })), 255).map(p => ({ x: p.x * max / 255, y: p.y * max / 255 })) : points
    line.forEach((p, i) => {
      if (i === 0) ctx.moveTo(toX(p.x), toY(p.y))
      else ctx.lineTo(toX(p.x), toY(p.y))
    })
    ctx.stroke()
    if (overlay) {
      ctx.strokeStyle = 'rgba(245,181,68,0.85)'
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      overlay.forEach((p, i) => {
        if (i === 0) ctx.moveTo(toX(p.x), toY(p.y))
        else ctx.lineTo(toX(p.x), toY(p.y))
      })
      ctx.stroke()
      ctx.setLineDash([])
      overlay.forEach((p) => {
        ctx.strokeStyle = 'rgba(245,181,68,0.9)'
        ctx.lineWidth = 1.5
        ctx.strokeRect(toX(p.x) - 3.5, toY(p.y) - 3.5, 7, 7)
      })
      ctx.lineWidth = 2
    }
    points.forEach((p) => {
      ctx.fillStyle = drag.current !== null ? '#f5b544' : '#ff8fa0'
      ctx.beginPath()
      ctx.arc(toX(p.x), toY(p.y), 5, 0, Math.PI * 2)
      ctx.fill()
    })
  }, [points, overlay, max, height, spline])
  return (
    <canvas
      ref={ref}
      className="plot"
      style={{ height, cursor: onChange ? 'crosshair' : 'default', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (!onChange || !ref.current) return
        const i = pointAt(e, ref.current.clientWidth, height)
        if (i !== null) {
          drag.current = i
          ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
        } else if (onAddPoint && points.length < maxPoints) {
          const rect = ref.current.getBoundingClientRect()
          const pad = 10
          const x = Math.max(0, Math.min(max, Math.round(((e.clientX - rect.left - pad) / (ref.current.clientWidth - pad * 2)) * max)))
          const y = Math.max(0, Math.min(max, Math.round((1 - (e.clientY - rect.top - pad) / (height - pad * 2)) * max)))
          const insertAt = points.findIndex((p) => p.x > x)
          if (insertAt > 0 && insertAt < points.length && x - points[insertAt - 1].x > 2 && points[insertAt].x - x > 2) {
            onAddPoint({ x, y })
          }
        }
      }}
      onPointerMove={(e) => {
        if (drag.current !== null) movePoint(e, drag.current)
      }}
      onPointerUp={() => {
        drag.current = null
      }}
    />
  )
}

function CurveMiniIcon({ points, max = 255 }: { points: Array<{ x: number; y: number }>; max?: number }): JSX.Element {
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${2 + (p.x / max) * 28},${22 - (p.y / max) * 18}`).join(' ')
  return <svg className="curve-mini-icon" viewBox="0 0 32 24" aria-hidden="true" focusable="false"><path d="M2 22H30M2 22V2" className="curve-mini-axes" /><path d={d} className="curve-mini-line" /></svg>
}

function nextCustomPresetName(existing: string[], template: string): string {
  let i = 1
  let name = template.replace('{n}', String(i))
  while (existing.includes(name)) name = template.replace('{n}', String(++i))
  return name
}

function SavedCurvePreset({ preset, max = 255, onApply, onRename, onDelete }: {
  preset: { name: string; pts: Array<{ x: number; y: number }> }
  max?: number
  onApply: () => void
  onRename: (name: string) => boolean
  onDelete: () => void
}): JSX.Element {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(preset.name)
  const [error, setError] = useState(false)
  useEffect(() => setName(preset.name), [preset.name])
  const beginRename = (): void => { setName(preset.name); setError(false); setEditing(true) }
  const commitRename = (): void => {
    const clean = name.trim().slice(0, 24)
    if (!clean) return
    if (clean === preset.name || onRename(clean)) setEditing(false)
    else setError(true)
  }
  return (
    <div className={`saved-curve-card${editing ? ' editing' : ''}`} onContextMenu={(e) => { e.preventDefault(); beginRename() }}>
      {editing ? (
        <>
          <input className="input saved-curve-name-input" autoFocus maxLength={24} value={name} aria-label={t('sticks.renameCurve')} onChange={(e) => { setName(e.target.value); setError(false) }} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditing(false) }} />
          <button className="saved-curve-action saved-curve-confirm" type="button" title={t('common.save')} aria-label={t('common.save')} onClick={commitRename}>✓</button>
          <button className="saved-curve-action saved-curve-cancel" type="button" title={t('common.dismiss')} aria-label={t('common.dismiss')} onClick={() => setEditing(false)}>↩</button>
          {error && <span className="saved-curve-error">{t('sticks.curveNameExists')}</span>}
        </>
      ) : (
        <>
          <button className="saved-curve-apply" type="button" title={preset.name} onClick={onApply} onDoubleClick={beginRename}>
            <CurveMiniIcon points={preset.pts} max={max} /><span>{preset.name}</span>
          </button>
          <button className="saved-curve-action saved-curve-rename" type="button" title={t('sticks.renameCurve')} aria-label={`${t('sticks.renameCurve')}: ${preset.name}`} onClick={beginRename}>✎</button>
          <button className="saved-curve-action saved-curve-delete" type="button" title={t('common.delete')} aria-label={`${t('common.delete')}: ${preset.name}`} onClick={onDelete}>×</button>
        </>
      )}
    </div>
  )
}

/**
 * FPS curve pack — static 5-point dual-zone approximations of a "dynamic"
 * response (fine centre for micro-aim, hot edge for flicks). The pad has no
 * speed-sensing, so true velocity-dynamic curves are impossible; these bend
 * the same LUT a dynamic curve would average out to. All verified byte-safe:
 * curve bytes only, +14..+23. The Dynamic (CoD) entry is digitized from the
 * game's own published curve chart (thumbstick movement → rotation speed):
 * above the diagonal early, crossing at mid, settled below it late.
 */
export const AIM_CURVES: Record<string, { label: string; hint: string; creator?: boolean; pts: Array<{ x: number; y: number }> }> = {
  linear: { label: 'Linear', hint: '1:1 raw', pts: [...LINEAR_CURVE] },
  zamilitox: {
    label: 'Zamilitox',
    creator: true,
    hint: 'shared S-curve: hot start, settled edge',
    pts: [{ x: 0, y: 0 }, { x: 26, y: 48 }, { x: 71, y: 89 }, { x: 128, y: 128 }, { x: 184, y: 166 }, { x: 230, y: 204 }, { x: 255, y: 255 }]
  },
  dynamic: {
    label: 'Dynamic (CoD)',
    hint: 'digitized from CoD chart: hot start, settled mid',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 89 }, { x: 128, y: 128 }, { x: 191, y: 173 }, { x: 255, y: 255 }]
  },
  ryuta: {
    label: '7ryuta',
    creator: true,
    hint: 'lifted start, 1:1 from 160, 9 points',
    pts: [
      { x: 0, y: 0 },
      { x: 32, y: 34 },
      { x: 63, y: 76 },
      { x: 93, y: 116 },
      { x: 129, y: 144 },
      { x: 160, y: 160 },
      { x: 191, y: 191 },
      { x: 223, y: 223 },
      { x: 255, y: 255 }
    ]
  },
  fpsAim: {
    label: 'Kiyoshi Curve',
    creator: true,
    hint: 'calm centre, hot edge',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 38 }, { x: 128, y: 100 }, { x: 191, y: 185 }, { x: 255, y: 255 }]
  },
  micro: {
    label: 'Micro-aim',
    hint: 'extra-fine centre for tracking',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 28 }, { x: 128, y: 80 }, { x: 191, y: 170 }, { x: 255, y: 255 }]
  },
  flick: {
    label: 'Flick/Snap',
    hint: 'fast start for 180s',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 100 }, { x: 128, y: 160 }, { x: 191, y: 215 }, { x: 255, y: 255 }]
  },
  snappy: {
    label: 'Snappy mid',
    hint: 'COD-style boosted mid',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 78 }, { x: 128, y: 140 }, { x: 191, y: 200 }, { x: 255, y: 255 }]
  },
  steady: {
    label: 'Steady track',
    hint: 'Apex-style even pull',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 52 }, { x: 128, y: 112 }, { x: 191, y: 188 }, { x: 255, y: 255 }]
  },  expo: {
    label: 'Expo',
    hint: 'late surge',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 16 }, { x: 128, y: 70 }, { x: 191, y: 158 }, { x: 255, y: 255 }]
  },
  sacreds: {
    label: 'Sacreds',
    creator: true,
    hint: 'Hyperstrike-style smooth fast start, 10 points',
    pts: [
      { x: 0, y: 0 },
      { x: 26, y: 41 },
      { x: 49, y: 72 },
      { x: 76, y: 107 },
      { x: 102, y: 140 },
      { x: 133, y: 157 },
      { x: 153, y: 177 },
      { x: 168, y: 197 },
      { x: 191, y: 223 },
      { x: 229, y: 255 }
    ]
  },
  machixo: {
    label: 'Machixo',
    creator: true,
    hint: 'Slow-start desensitized, tops at 94%',
    pts: [
      { x: 0, y: 0 },
      { x: 20, y: 15 },
      { x: 82, y: 61 },
      { x: 133, y: 99 },
      { x: 184, y: 138 },
      { x: 235, y: 176 },
      { x: 255, y: 240 }
    ]
  },
  nekosu: {
    label: 'Nekosu',
    creator: true,
    hint: 'Snappy fast start, even pull, 10 points',
    pts: [
      { x: 0, y: 0 },
      { x: 12, y: 39 },
      { x: 39, y: 61 },
      { x: 69, y: 82 },
      { x: 98, y: 104 },
      { x: 131, y: 125 },
      { x: 169, y: 154 },
      { x: 207, y: 182 },
      { x: 228, y: 206 },
      { x: 255, y: 255 }
    ]
  }
}

/** Preset picker sections: general-purpose shapes first, then creator curves. */
export const CURVE_GROUPS = [
  { titleKey: 'sticks.curvesStandard', curves: Object.entries(AIM_CURVES).filter(([, c]) => !c.creator) },
  { titleKey: 'sticks.curvesCreator', curves: Object.entries(AIM_CURVES).filter(([, c]) => c.creator) }
] as const


function AnalyticsPanel({ context, setHz, gear }: { context: string; setHz: number; gear: number }): JSX.Element {  const t = useT()
  const [rate, setRate] = useState(0)
  const [frames, setFrames] = useState(0)
  const [history, setHistory] = useState<number[]>([])
  const [paused, setPaused] = useState(false)
  const [ping, setPing] = useState<PingResult | null>(null)
  const [pinging, setPinging] = useState(false)
  const [pingError, setPingError] = useState<string | null>(null)
  const [extents, setExtents] = useState<{ min: number[]; max: number[]; n: number } | null>(null)
  const chartRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (paused) return
    const off = api().on('device:stats', (s) => {
      const stats = s as unknown as DeviceStats
      setRate(stats.rateHz)
      setFrames(stats.inputFrames)
      setHistory((prev) => [...prev.slice(-59), stats.rateHz])
    })
    return off
  }, [paused])

  useEffect(() => {
    const off = api().on('input:sample', (s) => {
      const v = s as unknown as LiveSample
      const axes = [v.lx, v.ly, v.rx, v.ry]
      setExtents((prev) => {
        if (!prev) return { min: [...axes], max: [...axes], n: 1 }
        return {
          min: prev.min.map((m, i) => Math.min(m, axes[i])),
          max: prev.max.map((m, i) => Math.max(m, axes[i])),
          n: prev.n + 1
        }
      })
    })
    return off
  }, [])

  useEffect(() => {
    const c = chartRef.current
    if (!c) return
    let raf = 0
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = c.clientWidth
      const h = 120
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr
        c.height = h * dpr
      }
      const ctx = c.getContext('2d')
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        const max = Math.max(100, ...history) * 1.15
        const bars = Math.max(history.length, 30)
        const bw = w / bars
        ctx.strokeStyle = '#3a2230'
        for (let i = 1; i <= 3; i++) {
          const y = h - (i / 3) * h
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
        }
        history.forEach((v, i) => {
          const bh = (v / max) * h
          ctx.fillStyle = v >= 480 ? '#3ecf8e' : v >= 200 ? '#f43f52' : '#f5b544'
          ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh)
        })
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [history])

  async function runPing(): Promise<void> {
    setPinging(true)
    setPingError(null)
    try {
      setPing(await api().ping(15))
    } catch (e) {
      setPingError((e as Error).message)
    } finally {
      setPinging(false)
    }
  }

  const avg = history.length ? Math.round(history.reduce((a, b) => a + b, 0) / history.length) : 0
  const names = ['LX', 'LY', 'RX', 'RY']

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('lab.title')}</h3>
      <Hint>{context}</Hint>
      <div className="two" style={{ alignItems: 'start', marginTop: 10 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">{t('lab.setPoll')}: {setHz > 0 ? `${setHz.toLocaleString()} Hz (gear ${gear})` : '—'}</span>
            <span className={`pill${rate >= 480 ? ' good' : rate > 0 ? ' warn' : ''}`}>{rate || '—'} {t('lab.hzNow')}</span>
            <span className="pill">{avg || '—'} {t('lab.hzAvg')}</span>
            <span className="pill">{frames.toLocaleString()} {t('lab.frames')}</span>
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => setPaused((p) => !p)}>{paused ? t('lab.resume') : t('lab.pause')}</button>
          </div>
          <canvas ref={chartRef} className="plot" style={{ height: 120 }} />
          <Hint>{t('lab.streamNote')}</Hint>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" disabled={pinging} onClick={() => void runPing()}>{pinging ? t('lab.measuring') : t('lab.runPing')}</button>
            {pingError && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{pingError}</span>}
            {ping && <span className="mono">median {ping.median.toFixed(1)} ms · mean {ping.mean.toFixed(1)} ms · min {ping.min.toFixed(1)} · max {ping.max.toFixed(1)}</span>}
          </div>
          <Hint>{t('lab.pingNote')}</Hint>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row spread">
            <span className="label">{t('lab.range')}</span>
            <button className="btn sm ghost" onClick={() => setExtents(null)}>{t('lab.reset')}</button>
          </div>
          <table className="tbl">
            <thead><tr><th>{t('lab.thAxis')}</th><th>{t('lab.thMin')}</th><th>{t('lab.thMax')}</th><th>{t('lab.thSpan')}</th></tr></thead>
            <tbody>
              {names.map((n, i) => (
                <tr key={n}>
                  <td className="mono">{n}</td>
                  <td className="mono">{extents ? extents.min[i] : '—'}</td>
                  <td className="mono">{extents ? extents.max[i] : '—'}</td>
                  <td className="mono">{extents ? extents.max[i] - extents.min[i] : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Hint>
            {extents ? t('lab.samples').replace('{n}', extents.n.toLocaleString()) : t('lab.samplesEmpty')}
          </Hint>
        </div>
      </div>
    </div>
  )
}

type LinPhase = 'idle' | 'centering' | 'topass' | 'pass' | 'toreturn' | 'done'

interface LinPass {
  pts: number[]
  tms: number[]
  dur: number
}

function LinearityBench({ live, connected }: { live: LiveSample | null; connected: boolean }): JSX.Element {
  const t = useT()
  const [stick, setStick] = useState<0 | 1>(0)
  const [phase, setPhase] = useState<LinPhase>('idle')
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null)
  const [passes, setPasses] = useState<LinPass[]>([])
  const [, setTick] = useState(0)
  const buf = useRef<Array<{ x: number; y: number; t: number }>>([])
  const cur = useRef<{ pts: number[]; tms: number[]; t0: number } | null>(null)
  const phaseRef = useRef<LinPhase>(phase)
  phaseRef.current = phase
  const stickRef = useRef<0 | 1>(stick)
  stickRef.current = stick
  const centerRef = useRef<{ x: number; y: number } | null>(center)
  centerRef.current = center

  useEffect(() => {
    const id = window.setInterval(() => setTick((v) => v + 1), 250)
    return () => window.clearInterval(id)
  }, [])

  const reset = (): void => {
    buf.current = []
    cur.current = null
    setCenter(null)
    setPasses([])
    setPhase('idle')
  }

  const pickStick = (s: 0 | 1): void => {
    setStick(s)
    reset()
  }

  const start = (): void => {
    buf.current = []
    cur.current = null
    setCenter(null)
    setPasses([])
    setPhase('centering')
  }

  useEffect(() => {
    if (!live || !connected) return
    const s = stickRef.current
    const x = s === 0 ? live.lx : live.rx
    const y = s === 0 ? live.ly : live.ry
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const now = Date.now()
    const ph = phaseRef.current
    if (ph === 'centering') {
      buf.current.push({ x, y, t: now })
      const b = buf.current
      if (b.length >= 3 && now - b[0].t >= 1500) {
        let spread = 0
        let sx = 0
        let sy = 0
        for (const p of b) {
          sx += p.x
          sy += p.y
        }
        const mx = sx / b.length
        const my = sy / b.length
        for (const p of b) {
          spread = Math.max(spread, Math.abs(p.x - mx), Math.abs(p.y - my))
        }
        if (spread <= 6) {
          setCenter({ x: mx, y: my })
          buf.current = []
          setPhase('topass')
        } else {
          buf.current = []
        }
      }
    } else if (ph === 'topass') {
      const c = centerRef.current
      if (!c) return
      const r = Math.hypot(x - c.x, y - c.y) / 127
      if (r > 0.2) {
        cur.current = { pts: [r], tms: [0], t0: now }
        setPhase('pass')
      }
    } else if (ph === 'pass') {
      const c = centerRef.current
      const session = cur.current
      if (!c || !session) return
      const r = Math.hypot(x - c.x, y - c.y) / 127
      session.pts.push(r)
      session.tms.push(now - session.t0)
      const dur = now - session.t0
      const recent = session.pts.filter((_, i) => session.tms[i] >= dur - 500)
      const held = r >= 0.85 && recent.length >= 3 && Math.max(...recent) - Math.min(...recent) <= 0.03
      if ((held && dur >= 800) || dur >= 12000) {
        const pts = session.pts
        const tms = session.tms
        cur.current = null
        if (dur >= 500 && pts.length >= 10) {
          const peak = Math.max(...pts)
          if (peak > 0.05) {
            setPasses((prev) => [...prev, { pts: pts.map((v) => v / peak), tms: [...tms], dur: dur / 1000 }])
            setPhase('toreturn')
            return
          }
        }
        setPhase('topass')
      }
    } else if (ph === 'toreturn') {
      const c = centerRef.current
      if (!c) return
      if (Math.hypot(x - c.x, y - c.y) / 127 < 0.25) setPhase('topass')
    }
  }, [live, connected])

  const grids = passes.map((p) => linResample(p.pts, p.tms))
  const median = grids.length > 0 ? linMedian(grids) : []
  const rep = grids.length > 0 && median.length > 0 ? linRepresentative(grids, median) : 0
  const scored = passes.map((p) => {
    const f = linFrontier(p.pts)
    return {
      dur: p.dur,
      tremor: linTremor(p.pts.length, f.kept.length),
      linearity: linLinearity(p.pts, p.tms),
      res: linResolution(f.kept)
    }
  })
  const avg = (vs: number[]): number => (vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0)

  const status =
    phase === 'idle' ? t('lab.linIdle')
    : phase === 'centering' ? t('lab.linCentering')
    : phase === 'done' ? t('lab.linDone').replace('{n}', String(passes.length))
    : phase === 'toreturn' ? t('lab.linReturn')
    : t('lab.linPush')

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('lab.linTitle')}</h3>
      <Hint>{t('lab.linHint')}</Hint>
      <div className="row" style={{ gap: 8, margin: '10px 0' }}>
        {([0, 1] as const).map((s) => (
          <button
            key={s}
            className={`choice-btn${stick === s ? ' active' : ''}`}
            onClick={() => pickStick(s)}
          >
            <span className="choice-label">{s === 0 ? t('cal.left') : t('cal.right')} {t('sticks.stick')}</span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span className="pill">{passes.length}/{LIN_MIN_PASSES}+</span>
      </div>
      <div className="label" style={{ marginBottom: 8 }}>{status}</div>
      <div className="row wrap" style={{ gap: 8 }}>
        {(phase === 'idle' || phase === 'done') && (
          <button className="btn sm primary" disabled={!connected || !live} onClick={start}>
            <span className="choice-label">{t('lab.linStart')}</span>
          </button>
        )}
        {phase !== 'idle' && phase !== 'done' && (
          <button className="btn sm ghost" onClick={reset}>
            <span className="choice-label">{t('common.cancel')}</span>
          </button>
        )}
        {(phase === 'topass' || phase === 'pass' || phase === 'toreturn') && (
          <button className="btn sm primary" disabled={passes.length < LIN_MIN_PASSES} onClick={() => setPhase('done')}>
            <span className="choice-label">{t('lab.linFinish')}</span>
          </button>
        )}
      </div>
      {scored.length > 0 && (
        <div className="stack" style={{ gap: 4, marginTop: 10 }}>
          {scored.map((m, i) => (
            <div key={i} className="mono" style={{ fontSize: 12 }}>
              {t('lab.linPass').replace('{n}', String(i + 1))}{i === rep && phase === 'done' ? ' ★' : ''} · {m.dur.toFixed(1)}s · {t('lab.linTremor')} {m.tremor.toFixed(1)}% · {t('lab.linLinearity')} {m.linearity.toFixed(1)}% · {t('lab.linRes')} {m.res}
            </div>
          ))}
          {phase === 'done' && (
            <div className="mono" style={{ fontSize: 12, color: 'var(--accent-2)' }}>
              {t('lab.linAvg')} · {t('lab.linTremor')} {avg(scored.map((m) => m.tremor)).toFixed(1)}% · {t('lab.linLinearity')} {avg(scored.map((m) => m.linearity)).toFixed(1)}% · {t('lab.linRes')} {Math.round(avg(scored.map((m) => m.res)))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DeepPollCard({ vid, pid, setHz, connected }: { vid: number; pid: number | null; setHz: number; connected: boolean }): JSX.Element {
  const t = useT()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<DeepPollResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const run = (): void => {
    if (pid === null || running) return
    setRunning(true)
    setResult(null)
    setFailed(null)
    void api().deeppoll(vid, pid, 8).then(
      (r) => {
        setResult(r)
        setRunning(false)
      },
      (e) => {
        setFailed((e as Error).message)
        setRunning(false)
      }
    )
  }
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('lab.dpTitle')}</h3>
      <Hint>{t('lab.dpHint')}</Hint>
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn sm primary" disabled={!connected || pid === null || running} onClick={run}>
          {running ? t('lab.dpRunning') : t('lab.dpRun')}
        </button>
        <span className="label">{t('lab.dpAdmin')}</span>
      </div>
      {failed && (
        <div className="note bad" style={{ marginTop: 8 }}>
          {t('lab.dpFailed')} <span className="mono">{failed}</span>
        </div>
      )}
      {result && !result.ok && (
        <div className="note warn" style={{ marginTop: 8 }}>
          {/declined|admin/i.test(result.error ?? '') ? t('lab.dpDenied') : t('lab.dpFailed')}{' '}
          {result.error && <span className="mono">{result.error}</span>}
        </div>
      )}
      {result && result.ok && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <span className="pill accent">{Math.round(result.rateHz).toLocaleString()} Hz</span>
            <span className="pill">{result.samples.toLocaleString()} {t('lab.dpSamples')}</span>
            {result.vidPid && <span className="mono">{result.vidPid}</span>}
            {result.stalls > 0 && (
              <span className="pill warn">{t('lab.dpStalls').replace('{n}', String(result.stalls))} · {result.stallMs.toFixed(0)} ms</span>
            )}
          </div>
          {setHz > 0 && (
            <div className="label">
              {t('lab.dpGear').replace('{hz}', setHz.toLocaleString())} → {t('lab.dpTitle')}: {Math.round(result.rateHz).toLocaleString()} Hz
            </div>
          )}
          <div className="stack" style={{ gap: 4 }}>
            {result.bins.map((b) => (
              <div key={b.label} className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="mono" style={{ width: 110, fontSize: 11.5 }}>{b.label}</span>
                <div style={{ flex: 1, height: 8, background: 'var(--bg-2)', borderRadius: 'var(--radius-sm)' }}>
                  <div style={{ width: `${Math.max(0, Math.min(100, b.pct))}%`, height: '100%', background: 'var(--accent)', borderRadius: 'var(--radius-sm)' }} />
                </div>
                <span className="mono" style={{ width: 52, textAlign: 'right', fontSize: 11.5 }}>{b.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
          {result.devices.length > 1 && (
            <div className="stack" style={{ gap: 2, marginTop: 4 }}>
              <div className="label">{t('lab.dpOthers')}</div>
              {result.devices.filter((d) => d.vidPid !== result.vidPid).slice(0, 6).map((d) => (
                <div key={d.vidPid} className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  {d.vidPid} · {Math.round(d.rateHz).toLocaleString()} Hz · {d.samples.toLocaleString()} {t('lab.dpSamples')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface SlotEntry {
  index: number
  name: string | null
  bytes: Uint8Array | null
  loading: boolean
  error: string | null
}

function download(filename: string, data: Uint8Array | string): void {
  const blob =
    typeof data === 'string'
      ? new Blob([data], { type: 'application/json' })
      : new Blob([data.buffer as ArrayBuffer], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function LockedDump({ modelId, modelName, defaultLength }: { modelId: string; modelName: string | null; defaultLength: number }): JSX.Element {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [length, setLength] = useState(defaultLength)

  async function run(): Promise<void> {
    const len = Math.max(100, Math.min(4096, Math.round(Number(length) || 0)))
    if (!len) {
      setMessage('Enter a byte length first (try 680, 1070 or 1935).')
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const dump: Record<string, { name: string; bytes: string }> = {}
      let allZero = true
      for (const s of [1, 2, 3, 4]) {
        const res = await api().readProfile(s, len)
        const bytes = b64ToBytes(res.bytes)
        if (bytes.some((b) => b !== 0)) allZero = false
        let name = ''
        try {
          name = parseProfile(bytes, modelId).name
        } catch {
          name = ''
        }
        dump[String(s)] = { name, bytes: bytesToB64(bytes) }
      }
      if (allZero) {
        setMessage('All slots read back empty — wrong length, or the pad is not answering. Try 680 / 1070 / 1935.')
        return
      }
      download(
        `sticklabs-dump-${modelId}-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify({ version: 1, app: 'stick-labs-dump', model: modelId, length: len, profiles: dump }, null, 2)
      )
      setMessage('Dump downloaded — send it to RealKiyoshi to unlock this model.')
    } catch (e) {
      setMessage(`Dump failed: ${(e as Error).message} — try another length (680 / 1070 / 1935).`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Locked — {modelName ?? t('msg.unknownModel')}</h3>
      <Hint>Profile backup is disabled for this model — its profile layout is unverified, so reads and writes stay off. A read-only dump helps unlock it.</Hint>
      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <input
          className="input"
          style={{ width: 110 }}
          type="number"
          min={100}
          max={4096}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
        />
        <button
          className="btn sm"
          disabled={busy}
          title="Read-only: dumps all 4 slots for support analysis. Writes nothing."
          onClick={() => void run()}
        >
          {busy ? 'Reading…' : 'Export raw dump for support'}
        </button>
        {message && <span className="pill">{message}</span>}
      </div>
    </div>
  )
}

const CAL_STEPS = ['cal.stepReady', 'cal.stepOpen', 'cal.stepS1', 'cal.stepS2', 'cal.done']

function StickDial({ x, y, label }: { x: number; y: number; label: string }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const trail = useRef<Array<{ x: number; y: number }>>([])
  const nx = (x - 128) / 128
  const ny = (y - 128) / 128
  trail.current.push({ x: nx, y: ny })
  if (trail.current.length > 90) trail.current.splice(0, trail.current.length - 90)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const S = 120
    c.width = S * dpr
    c.height = S * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, S, S)
    const cx = S / 2
    const cy = S / 2
    const R = S / 2 - 8
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#3a2230'
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = '#552c38'
    ctx.beginPath()
    ctx.moveTo(cx - R, cy)
    ctx.lineTo(cx + R, cy)
    ctx.moveTo(cx, cy - R)
    ctx.lineTo(cx, cy + R)
    ctx.stroke()
    // ±2-step rest zone
    ctx.strokeStyle = '#3fa46a'
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(2, (2 / 128) * R), 0, Math.PI * 2)
    ctx.stroke()
    const pts = trail.current
    if (pts.length > 1) {
      ctx.strokeStyle = '#f0a030'
      ctx.beginPath()
      pts.forEach((p, i) => {
        const px = cx + Math.max(-1, Math.min(1, p.x)) * R
        const py = cy + Math.max(-1, Math.min(1, p.y)) * R
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      })
      ctx.stroke()
    }
    ctx.fillStyle = '#ff8fa0'
    ctx.beginPath()
    ctx.arc(cx + Math.max(-1, Math.min(1, nx)) * R, cy + Math.max(-1, Math.min(1, ny)) * R, 4, 0, Math.PI * 2)
    ctx.fill()
  })
  const fmt = (v: number): string => `${v > 0 ? `+${v}` : `${v}`}`
  return (
    <div style={{ textAlign: 'center' }}>
      <div className="label">{label}</div>
      <canvas ref={ref} style={{ width: 120, height: 120 }} />
      <div className="mono" style={{ fontSize: 11 }}>x {fmt(x - 128)} · y {fmt(y - 128)}</div>
    </div>
  )
}

function LeadJoyCalibrationPanel({ live, onOpenSticks }: {
  live: { lx: number; ly: number; rx: number; ry: number } | null
  onOpenSticks: () => void
}): JSX.Element {
  const t = useT()
  const [measuring, setMeasuring] = useState(false)
  const [result, setResult] = useState<{ offsets: number[]; jitter: number; count: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const samples = useRef<number[][]>([])
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (!measuring || !live) return
    samples.current.push([live.lx, live.ly, live.rx, live.ry])
  }, [live, measuring])

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current)
  }, [])

  const measure = (): void => {
    if (!live || measuring) return
    samples.current = []
    setResult(null)
    setError(null)
    setMeasuring(true)
    timer.current = window.setTimeout(() => {
      const rows = samples.current
      setMeasuring(false)
      if (rows.length < 30) {
        setError(t('cal.measureLowSample'))
        return
      }
      const means = [0, 1, 2, 3].map((axis) => rows.reduce((sum, row) => sum + row[axis], 0) / rows.length)
      let jitter = 0
      for (const row of rows) {
        for (let axis = 0; axis < 4; axis++) jitter = Math.max(jitter, Math.abs(row[axis] - means[axis]))
      }
      setResult({ offsets: means.map((value) => Math.round(value - 128)), jitter: Math.round(jitter), count: rows.length })
    }, 2500)
  }

  const signed = (value: number): string => value > 0 ? `+${value}` : String(value)
  let resultText = ''
  if (result) {
    resultText = t('cal.measureResult')
      .replace('{lx}', signed(result.offsets[0]))
      .replace('{ly}', signed(result.offsets[1]))
      .replace('{rx}', signed(result.offsets[2]))
      .replace('{ry}', signed(result.offsets[3]))
      .replace('{jitter}', String(result.jitter))
  }

  return (
    <div className="card calibration-workspace" style={{ display: 'grid', gap: 14 }}>
      <div className="stick-panel-heading">
        <div><span className="stick-eyebrow">{t('nav.calibrate')}</span><h3>{t('cal.ljTitle')}</h3></div>
        <span className="pill">{t('cal.idle')}</span>
      </div>
      <p className="stick-intro">{t('cal.ljHint')}</p>
      <div className="calibration-dials" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 36, minHeight: 150, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--bg-1)' }}>
        {live ? <>
          <StickDial x={live.lx} y={live.ly} label={t('cal.left')} />
          <StickDial x={live.rx} y={live.ry} label={t('cal.right')} />
        </> : <Hint>{t('cal.waiting')}</Hint>}
      </div>
      <div className="calibration-actions row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <button className="btn primary" disabled={!live || measuring} onClick={measure}>
          {measuring ? t('cal.measuringCenter') : t('cal.measureCenter')}
        </button>
        <button className="btn ghost" onClick={onOpenSticks}>{t('cal.openSticks')}</button>
      </div>
      {measuring && <div className="note">{t('cal.measuringCenter')}</div>}
      {result && <div className="note" role="status">{resultText} · {result.count} {t('lab.dpSamples')}</div>}
      {error && <div className="note bad" role="alert">{error}</div>}
      <div className="note warn">{t('cal.ljReadOnly')}</div>
    </div>
  )
}

function CalibrationPanel({ modelName }: { modelName: string }): JSX.Element {
  const t = useT()
  const [live, setLive] = useState<LiveSample | null>(null)
  const liveRef = useRef<LiveSample | null>(null)
  const [before, setBefore] = useState<number[] | null>(null)
  const [after, setAfter] = useState<number[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [flow, setFlow] = useState<null | { kind: 'quick' | 'step'; step: number; label: string; progress: number }>(null)
  const flowId = useRef(0)
  const stillRef = useRef<Array<{ t: number; dev: number }>>([])

  useEffect(() => () => { flowId.current++ }, [])

  useEffect(() => {
    const off = api().on('input:sample', (s) => {
      const v = s as unknown as LiveSample
      liveRef.current = v
      setLive(v)
      const dev = Math.max(Math.abs(v.lx - 128), Math.abs(v.ly - 128), Math.abs(v.rx - 128), Math.abs(v.ry - 128))
      const now = Date.now()
      stillRef.current.push({ t: now, dev })
      while (stillRef.current.length > 0 && now - stillRef.current[0].t > 4000) stillRef.current.shift()
    })
    return off
  }, [])

  const rest = live ? [live.lx - 128, live.ly - 128, live.rx - 128, live.ry - 128] : null
  const maxDev = rest ? Math.max(...rest.map((v) => Math.abs(v))) : 0
  const centered = maxDev <= 4
  const inCal = (live?.calTarget ?? 0) !== 0
  const [trim, setTrim] = useState<[number, number, number, number]>([0, 0, 0, 0])
  const [trimBusy, setTrimBusy] = useState(false)
  const [trimErr, setTrimErr] = useState<string | null>(null)
  const fmtT = (v: number): string => (v > 0 ? `+${v}` : `${v}`)

  async function nudgeTrim(stick: 0 | 1, direction: 0 | 1 | 2 | 3, axis: 0 | 1, delta: number): Promise<void> {
    if (busy || trimBusy || flow || inCal) return
    setTrimErr(null)
    setTrimBusy(true)
    const i = stick * 2 + axis
    setTrim((prev) => {
      const next: [number, number, number, number] = [...prev] as [number, number, number, number]
      next[i] += delta
      return next
    })
    try {
      await api().setStickCenter(stick, direction)
    } catch (e) {
      setTrim((prev) => {
        const next: [number, number, number, number] = [...prev] as [number, number, number, number]
        next[i] -= delta
        return next
      })
      setTrimErr((e as Error).message)
    } finally {
      setTrimBusy(false)
    }
  }

  async function enter(): Promise<void> {
    setErr(null)
    setAfter(null)
    if (live) setBefore([live.lx, live.ly, live.rx, live.ry].map((v) => v - 128))
    setBusy(true)
    try {
      await api().calibration(0)
      setNote('Calibration open — hands off, sticks centered. Commit writes this rest position as the new centre.')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function commit(): Promise<void> {
    setErr(null)
    if (!centered) {
      setErr(`Sticks are ${maxDev} steps off centre — re-centre them first. Commit is blocked to protect your calibration.`)
      return
    }
    if (!window.confirm('Commit calibration? The current rest position becomes the new centre. This cannot be undone from a file.')) return
    setBusy(true)
    try {
      await api().calibration(1)
      setNote('Committed — sampling the new rest position…')
      window.setTimeout(() => {
        const v = liveRef.current
        if (v) setAfter([v.lx, v.ly, v.rx, v.ry].map((x) => x - 128))
        setNote('Committed. Compare before/after below — both should sit near 0.')
      }, 1500)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function cancel(): Promise<void> {
    setErr(null)
    try {
      await api().calibration(2)
      setNote('Calibration cancelled — nothing was written.')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  /** Uninterrupted stillness span (ms) at the trailing edge, threshold in steps. */
  function stillSpan(threshold: number): number {
    const samples = stillRef.current
    if (samples.length === 0) return 0
    const newest = samples[samples.length - 1]
    if (newest.dev > threshold) return 0
    let first = newest.t
    for (let i = samples.length - 2; i >= 0; i--) {
      if (samples[i].dev > threshold) break
      first = samples[i].t
    }
    return newest.t - first
  }

  /** DualShock-style stability gate: resolve once still enough, timeout at 20 s. */
  function gateStill(threshold: number, needMs: number, myId: number, onProgress: (p: number) => void): Promise<'ok' | 'timeout' | 'cancelled'> {
    return new Promise((resolve) => {
      const deadline = Date.now() + 20000
      const tick = (): void => {
        if (flowId.current !== myId) { resolve('cancelled'); return }
        if (Date.now() > deadline) { resolve('timeout'); return }
        const span = stillSpan(threshold)
        onProgress(Math.min(1, span / needMs))
        if (span >= needMs) { resolve('ok'); return }
        window.setTimeout(tick, 100)
      }
      tick()
    })
  }

  function sampleAfter(): void {
    window.setTimeout(() => {
      const v = liveRef.current
      if (v) setAfter([v.lx, v.ly, v.rx, v.ry].map((x) => x - 128))
      setNote('Committed. Compare before/after below — both should sit near 0.')
    }, 1500)
  }

  /** Fully automatic center calibration: open, stillness-gated, commit. */
  async function quickCalibrate(): Promise<void> {
    if (busy || flow) return
    setErr(null)
    const v0 = liveRef.current
    if (!v0) { setErr('No live input — connect the pad first.'); return }
    flowId.current++
    const myId = flowId.current
    setAfter(null)
    setBefore([v0.lx, v0.ly, v0.rx, v0.ry].map((v) => v - 128))
    setBusy(true)
    setFlow({ kind: 'quick', step: 0, label: 'Opening session…', progress: 0 })
    try {
      await api().calibration(0)
      if (flowId.current !== myId) return
      setNote('Session open — hands off. Sampling stillness…')
      const r = await gateStill(2, 2500, myId, (p) => {
        if (flowId.current === myId) setFlow({ kind: 'quick', step: 0, label: 'Hold still — sampling centre…', progress: p })
      })
      if (flowId.current !== myId) return
      if (r !== 'ok') {
        if (r === 'timeout') {
          try { await api().calibration(2) } catch { /* already closed */ }
          if (flowId.current === myId) {
            setErr('Could not hold still for 2.5 s — session cancelled, nothing written.')
            setFlow(null)
          }
        }
        return
      }
      setFlow({ kind: 'quick', step: 0, label: 'Committing…', progress: 1 })
      await api().calibration(1)
      if (flowId.current !== myId) return
      setNote('Committed — sampling the new rest position…')
      sampleAfter()
      setFlow(null)
    } catch (e) {
      if (flowId.current === myId) {
        setErr((e as Error).message)
        setFlow(null)
      }
      try { await api().calibration(2) } catch { /* ignore */ }
    } finally {
      setBusy(false)
    }
  }

  function startSteps(): void {
    if (busy || flow) return
    setErr(null)
    if (!liveRef.current) { setErr('No live input — connect the pad first.'); return }
    flowId.current++
    setFlow({ kind: 'step', step: 0, label: 'Ready — set the pad down, hands off', progress: 0 })
  }

  async function exitFlow(): Promise<void> {
    flowId.current++
    setFlow(null)
    if (inCal) await cancel()
  }

  async function stepNext(): Promise<void> {
    if (busy || !flow || flow.kind !== 'step') return
    const myId = flowId.current
    const s = flow.step
    const setStep = (step: number, label: string, progress?: number): void => {
      if (flowId.current === myId) setFlow({ kind: 'step', step, label, progress: progress ?? step / 4 })
    }
    setErr(null)
    if (s === 0) {
      setAfter(null)
      const v = liveRef.current
      if (!v) { setErr('No live input — connect the pad first.'); return }
      setBefore([v.lx, v.ly, v.rx, v.ry].map((x) => x - 128))
      setBusy(true)
      try {
        await api().calibration(0)
        if (flowId.current !== myId) return
        setNote('Session open — hands off, sticks centered.')
        setStep(1, 'Session open — hands off')
      } catch (e) {
        if (flowId.current === myId) setErr((e as Error).message)
      } finally {
        setBusy(false)
      }
      return
    }
    if (s === 1 || s === 2) {
      setBusy(true)
      try {
        const r = await gateStill(2, 2000, myId, (p) => {
          if (flowId.current === myId) setFlow({ kind: 'step', step: s, label: 'Hold still — sampling…', progress: s / 4 + p / 4 })
        })
        if (flowId.current !== myId) return
        if (r !== 'ok') {
          if (r === 'timeout') setErr('Sticks moved during sampling — nothing written. Wait for stillness and press Next to retry.')
          return
        }
        setStep(s + 1, s + 1 === 3 ? 'Samples good — ready to commit' : 'Sample 1 of 2 good')
      } finally {
        setBusy(false)
      }
      return
    }
    if (s === 3) {
      if (!window.confirm('Commit calibration? The current rest position becomes the new centre. This cannot be undone from a file.')) return
      setBusy(true)
      try {
        await api().calibration(1)
        if (flowId.current !== myId) return
        setNote('Committed — sampling the new rest position…')
        sampleAfter()
        setStep(4, 'Done')
      } catch (e) {
        if (flowId.current === myId) setErr((e as Error).message)
      } finally {
        setBusy(false)
      }
    }
  }

  const names = ['LX', 'LY', 'RX', 'RY']
  const verdict = !rest ? null : maxDev <= 2 ? t('cal.centered') : maxDev <= 6 ? t('cal.mild') : t('cal.drifting')

  return (
    <div className="card calibration-workspace" style={{ display: 'grid', gap: 14 }}>
      <div className="stick-panel-heading">
        <div><span className="stick-eyebrow">{modelName}</span><h3>{t('cal.bench')}</h3></div>
        <span className={`pill${inCal ? ' warn' : live ? ' good' : ''}`}>{inCal ? t('cal.inCal') : live ? t('cal.idle') : t('cal.waiting')}</span>
      </div>
      <Hint>{t('cal.intro')}</Hint>
      <div className="calibration-dials row" style={{ justifyContent: 'center', alignItems: 'center', gap: 36, minHeight: 150, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--bg-1)' }}>
        {live ? (
          <>
            <StickDial x={live.lx} y={live.ly} label={t('cal.left')} />
            <StickDial x={live.rx} y={live.ry} label={t('cal.right')} />
          </>
        ) : (
          <Hint>{t('cal.waiting')}</Hint>
        )}
      </div>
      <div className="note calibration-scope">{t('cal.stickOnly')}</div>
      <details className="stick-extra calibration-advanced">
        <summary>{t('cal.centerTrim')}</summary>
        <div className="stick-extra-body">
      <Hint style={{ textAlign: 'center' }}>{t('cal.centerHint')}</Hint>
      <div className="row" style={{ gap: 28, justifyContent: 'center', margin: '4px 0 12px' }}>
        {([0, 1] as const).map((s) => (
          <div key={s} style={{ textAlign: 'center' }}>
            <div className="label">{t('cal.centerTrim')} — {s === 0 ? t('cal.left') : t('cal.right')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 36px)', gap: 4, justifyContent: 'center', margin: '8px 0' }}>
              <span />
              <button className="btn sm ghost" disabled={busy || trimBusy || !!flow || inCal} onClick={() => void nudgeTrim(s, 2, 1, -CENTER_NUDGE)}>▲</button>
              <span />
              <button className="btn sm ghost" disabled={busy || trimBusy || !!flow || inCal} onClick={() => void nudgeTrim(s, 0, 0, -CENTER_NUDGE)}>◀</button>
              <span />
              <button className="btn sm ghost" disabled={busy || trimBusy || !!flow || inCal} onClick={() => void nudgeTrim(s, 1, 0, CENTER_NUDGE)}>▶</button>
              <span />
              <button className="btn sm ghost" disabled={busy || trimBusy || !!flow || inCal} onClick={() => void nudgeTrim(s, 3, 1, CENTER_NUDGE)}>▼</button>
              <span />
            </div>
            <div className="mono" style={{ fontSize: 11 }}>X {fmtT(trim[s * 2])} · Y {fmtT(trim[s * 2 + 1])}</div>
          </div>
        ))}
      </div>
      {trimErr && <div className="note bad" style={{ marginBottom: 8 }}>{trimErr}</div>}
        </div>
      </details>
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <span className={`pill${inCal ? ' warn' : ''}`}>{inCal ? `${t('cal.inCal')} (target ${live?.calTarget})` : t('cal.idle')}</span>
        {rest && <span className={`pill${maxDev <= 2 ? ' good' : maxDev <= 6 ? ' warn' : ' bad'}`}>{verdict} · ±{maxDev}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn sm primary" disabled={busy || !!flow || !live} onClick={() => void quickCalibrate()}>{t('cal.quick')}</button>
        <button className="btn sm" disabled={busy || !!flow || !live} onClick={() => startSteps()}>{t('cal.step')}</button>
      </div>
      {flow && flow.kind === 'step' && (
        <div className="row wrap" style={{ gap: 6, margin: '10px 0', alignItems: 'center' }}>
          {CAL_STEPS.map((key, i) => (
            <span key={key} className={`pill${flow.step === i ? ' warn' : flow.step > i ? ' good' : ''}`}>{i + 1} · {t(key)}</span>
          ))}
          <div style={{ flex: 1 }} />
          <button className="btn sm primary" disabled={busy} onClick={() => void stepNext()}>{flow.step === 0 ? t('cal.open') : flow.step < 3 ? t('cal.sample') : flow.step === 3 ? t('cal.commit') : t('cal.done')}</button>
          <button className="btn sm ghost" disabled={busy && !inCal} onClick={() => void exitFlow()}>{t('cal.exit')}</button>
        </div>
      )}
      {flow && (
        <div style={{ margin: '10px 0' }}>
          <div className="row spread">
            <span className="label">{flow.label}</span>
            <span className="mono">{Math.round(flow.progress * 100)}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 4, background: '#3a2230', overflow: 'hidden', marginTop: 4 }}>
            <div style={{ height: '100%', width: `${Math.round(flow.progress * 100)}%`, background: '#f0a030', transition: 'width 120ms linear' }} />
          </div>
        </div>
      )}
      {flow && flow.kind === 'quick' && (
        <div className="row wrap" style={{ gap: 8, margin: '0 0 10px' }}>
          <button className="btn sm ghost" onClick={() => void exitFlow()}>{t('cal.abort')}</button>
        </div>
      )}
      <details className="stick-extra calibration-advanced">
        <summary>{t('cal.manual')}</summary>
        <div className="stick-extra-body">
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn sm" disabled={busy || !!flow || inCal} onClick={() => void enter()}>1 · {t('cal.open')}</button>
        <button className="btn sm primary" disabled={busy || !!flow || !inCal} onClick={() => void commit()}>2 · {t('cal.commit')}</button>
        <button className="btn sm ghost" disabled={busy || !!flow || !inCal} onClick={() => void cancel()}>{t('cal.cancel')}</button>
      </div>
        </div>
      </details>
      {note && <div className="note" style={{ marginBottom: 8 }}>{note}</div>}
      {err && <div className="note bad" style={{ marginBottom: 8 }}>{err}</div>}
      <details className="stick-extra calibration-advanced">
        <summary>{t('cal.tableBefore')} / {t('cal.tableAfter')}</summary>
        <div className="stick-extra-body">
      <table className="tbl">
        <thead><tr><th>{t('cal.tableAxis')}</th><th>{t('cal.tableLive')}</th><th>{t('cal.tableBefore')}</th><th>{t('cal.tableAfter')}</th></tr></thead>
        <tbody>
          {names.map((n, i) => (
            <tr key={n}>
              <td className="mono">{n}</td>
              <td className="mono">{rest ? (rest[i] > 0 ? `+${rest[i]}` : `${rest[i]}`) : '—'}</td>
              <td className="mono">{before ? (before[i] > 0 ? `+${before[i]}` : `${before[i]}`) : '—'}</td>
              <td className="mono">{after ? (after[i] > 0 ? `+${after[i]}` : `${after[i]}`) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
        </div>
      </details>
      <Hint style={{ marginTop: 8 }}>{t('cal.tipRest')}</Hint>
      <div className="note warn" style={{ marginTop: 8 }}>{t('cal.driftWarn')} {t('cal.driftWarn2')}</div>
    </div>
  )
}

function HardwareCalibrationPanel({ dirty, blocked, onActiveChange }: { dirty: boolean; blocked: boolean; onActiveChange: (active: boolean) => void }): JSX.Element {
  const t = useT()
  const [live, setLive] = useState<LiveSample | null>(null)
  const [parts, setParts] = useState(15)
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const pending = useRef(false)
  const passed = active && live?.calibrationActive === true && (live.calibrationPartMask & parts) === parts
  const status = !active ? 'notStarted' : live?.calibrationActive ? 'running' : 'waiting'
  useEffect(() => api().on('input:sample', sample => setLive(sample as LiveSample)), [])
  useEffect(() => { onActiveChange(active); return () => onActiveChange(false) }, [active, onActiveChange])
  async function calibrate(state: number): Promise<void> {
    if (pending.current || blocked || dirty || (state === 1 && !passed)) return
    pending.current = true
    setBusy(true); setError(null); setMessage(null)
    try {
      await api().calibration(state, state === 0 ? parts : 0, CalMode.Standard)
      if (state === 0) setLive(null) // Match the website: discard pre-start status.
      setActive(state === 0)
      setMessage(t(`cal.web.${state === 0 ? 'startSent' : state === 1 ? 'saveSent' : 'exitSent'}`))
    } catch (e) { setError((e as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  async function adjust(stick: number, direction: number): Promise<void> {
    if (pending.current || blocked || dirty || !active || !(parts & 3)) return
    pending.current = true; setBusy(true); setError(null)
    try { await api().setStickCenter(stick, direction); setMessage(t('cal.web.centerConfirmed')) }
    catch (e) { setError((e as Error).message) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className={`lab-calibration${active ? ' is-active' : ''}${passed ? ' is-complete' : ''}`}>
    <div className="lab-cal-toolbar">
      <div className="lab-cal-title"><span className="stick-eyebrow">STICK LABS</span><h2>{t('cal.bench')}</h2></div>
      <span className={`lab-cal-session ${status}`} role="status"><i />{t(`cal.web.${status}`)}</span>
    </div>
    <div className="lab-cal-modes" role="group" aria-label={t('cal.web.parts')}>
      {[['both', 15], ['sticks', 3], ['triggers', 12], ['motion', 16]].map(([key, value]) => <button key={key} className={`choice-btn lab-cal-mode${parts === value ? ' active' : ''}`} aria-pressed={parts === value} disabled={active || busy || blocked} onClick={() => setParts(Number(value))}>
        <span className="lab-cal-mode-icon" aria-hidden="true">{key === 'both' ? <><StickSideIcon side="left" size={20} /><KeyIcon value={19} size={20} /></> : key === 'sticks' ? <StickSideIcon side="left" size={25} /> : key === 'triggers' ? <KeyIcon value={19} size={25} /> : <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/><circle cx="12" cy="12" r="7"/><path d="m8 14 4-6 4 6"/></svg>}</span>
        <span className="choice-label">{t(`cal.web.${key}`)}</span>
      </button>)}
    </div>
    <div className="lab-cal-workspace">
      <section className="card lab-cal-instruments">
        <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('cal.fineLive')}</span><h3>{t('cal.fineLiveTitle')}</h3></div><span className={`lab-cal-input-light${live?.live ? ' on' : ''}`} aria-label={live?.live ? t('cal.connected') : t('cal.waiting')} /></div>
        <div className="lab-cal-dials">
          <StickDial x={live?.lx ?? 128} y={live?.ly ?? 128} label={t('cal.web.left')} />
          <StickDial x={live?.rx ?? 128} y={live?.ry ?? 128} label={t('cal.web.right')} />
        </div>
        <div className="lab-cal-trigger-readouts">
          {[['LT', live?.lt ?? 0], ['RT', live?.rt ?? 0]].map(([label, value]) => <div key={label} className="lab-cal-trigger"><div><span>{label}</span><strong>{Math.round(Number(value) / 255 * 100)}<small>%</small></strong></div><div className="lab-cal-meter"><i style={{ width: `${Math.min(100, Math.max(0, Number(value) / 255 * 100))}%` }} /></div></div>)}
        </div>
      </section>
      <section className="card lab-cal-guide">
        <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('cal.web.parts')}</span><h3>{t(`cal.web.${parts === 15 ? 'both' : parts === 3 ? 'sticks' : parts === 12 ? 'triggers' : 'motion'}`)}</h3></div></div>
        <ol>
          <li><span className="lab-cal-step-mark" aria-hidden="true">01</span><p>{t(parts === 16 ? 'cal.web.still' : 'cal.web.neutral')}</p></li>
          <li><span className="lab-cal-step-mark" aria-hidden="true">02</span><p>{t(parts === 16 ? 'cal.web.startStill' : 'cal.web.move')}</p></li>
          <li><span className="lab-cal-step-mark" aria-hidden="true">03</span><p>{t('cal.web.observe')}</p></li>
        </ol>
      </section>
    </div>
    <section className="lab-cal-feedback" aria-label={t('cal.web.status')}>
      {[['left', 1], ['right', 2], ['leftTrigger', 4], ['rightTrigger', 8], ['motion', 16]].map(([key, bit]) => {
        const flag = Number(bit)
        const state = !active ? 'notStarted' : !(parts & flag) ? 'notSelected' : !live?.calibrationActive ? 'waiting' : live.calibrationPartMask & flag ? 'passed' : 'notPassed'
        return <div key={key} className={`lab-cal-part ${state}`}><span className="lab-cal-part-indicator" aria-hidden="true">{state === 'passed' ? '✓' : '·'}</span><span><strong>{t(`cal.web.${key}`)}</strong><small>{t(`cal.web.${state}`)}</small></span></div>
      })}
    </section>
    <details className="stick-extra lab-cal-center">
      <summary>{t('cal.web.center')}</summary>
      <div className="stick-extra-body"><p className="hint">{t('cal.web.centerHint')}</p><div className="lab-cal-center-grid">
        {['left', 'right'].map((key, stick) => <section key={key}><span className="lab-cal-center-label"><StickSideIcon side={key as 'left' | 'right'} size={18} />{t(`cal.web.${key}`)}</span>
          <div className="lab-cal-center-buttons">{['X +32', 'X −32', 'Y −32', 'Y +32'].map((label, direction) => <button key={label} className="btn sm ghost" disabled={blocked || busy || dirty || !active || !(parts & 3)} onClick={() => void adjust(stick, direction)} aria-label={`${t(`cal.web.${key}`)} · ${t('cal.web.centerAxis')} ${label}`}><span>{label[0]}</span><strong>{label.slice(2)}</strong></button>)}</div>
        </section>)}
      </div></div>
    </details>
    <footer className="lab-cal-dock">
      <div className="lab-cal-dock-copy">{error ? <span className="lab-cal-error" role="alert">{error}</span> : dirty ? <span className="lab-cal-warning">{t('cal.web.dirty')}</span> : message ? <span role="status">{message}</span> : <span>{t(`cal.web.${status}`)}</span>}</div>
      <div className="lab-cal-dock-actions">
        <button className="btn ghost" disabled={blocked || busy || !active} onClick={() => void calibrate(2)}>{t('cal.web.exit')}</button>
        <button className="btn primary" disabled={blocked || dirty || busy || active} onClick={() => void calibrate(0)}><span aria-hidden="true">▶</span>{t('cal.web.start')}</button>
        <button className="btn primary" disabled={blocked || busy || !passed} onClick={() => void calibrate(1)}><span aria-hidden="true">✓</span>{t('cal.web.finish')}</button>
      </div>
    </footer>
  </div>
}

function ProfilesPanel({ connected, activeSlot, locked, modelId, modelLen, dumpLength, modelName }: { connected: boolean; activeSlot: number | null; locked: boolean; modelId: string; modelLen: number; dumpLength: number; modelName: string | null }): JSX.Element {
  const t = useT()
  const [entries, setEntries] = useState<SlotEntry[]>([1, 2, 3, 4].map((index) => ({ index, name: null, bytes: null, loading: false, error: null })))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const update = (index: number, patch: Partial<SlotEntry>): void => {
    setEntries((prev) => prev.map((e) => (e.index === index ? { ...e, ...patch } : e)))
  }

  async function readSlot(index: number): Promise<Uint8Array> {
    update(index, { loading: true, error: null })
    try {
      const res = await api().readProfile(index, modelLen)
      const bytes = b64ToBytes(res.bytes)
      let name = ''
      try {
        name = parseProfile(bytes, modelId).name
      } catch {
        name = ''
      }
      update(index, { bytes, name, loading: false })
      return bytes
    } catch (e) {
      update(index, { loading: false, error: (e as Error).message })
      throw e
    }
  }

  async function refreshAll(): Promise<void> {
    setBusy(true)
    setMessage(null)
    // Sequential, not parallel: five concurrent 19-chunk reads on one handle
    // bury each other and surface as `timed out waiting for cmd 0x4`.
    let failed = 0
    for (const i of [1, 2, 3, 4]) {
      try {
        await readSlot(i)
      } catch {
        failed++
      }
    }
    setMessage(failed ? `${failed} slot(s) failed to read — Retry them individually` : 'Read all 4 stick profiles')
    setBusy(false)
  }

  useEffect(() => {
    if (!connected) return
    // Let the main editor's slot read finish first before starting ours.
    const t = window.setTimeout(() => void refreshAll(), 2000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  async function exportSlot(entry: SlotEntry, format: 'bin' | 'json'): Promise<void> {
    const bytes = entry.bytes ?? (await readSlot(entry.index))
    const base = (entry.name || `profile-${entry.index}`).replace(/[^\w-]+/g, '_') || `profile-${entry.index}`
    if (format === 'bin') {
      download(`${base}.sticklab.bin`, bytes)
    } else {
      download(`${base}.sticklab.json`, JSON.stringify({ version: 1, app: 'g7-stick-lab', model: modelId, index: entry.index, name: parseProfile(bytes, modelId).name, bytes: bytesToB64(bytes) }, null, 2))
    }
  }

  function handleImport(entry: SlotEntry): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.bin,.json,.g7p'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        let bytes: Uint8Array
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(await file.text()) as { bytes?: string }
          if (!parsed.bytes) throw new Error('JSON file has no bytes field')
          bytes = b64ToBytes(parsed.bytes)
        } else {
          bytes = new Uint8Array(await file.arrayBuffer())
        }
        if (bytes.length !== modelLen) throw new Error(`expected ${modelLen} bytes, got ${bytes.length}`)
        setBusy(true)
        const result = await api().writeProfile(entry.index, bytesToB64(bytes), modelLen)
        if (!result.verified) throw new Error(result.rolledBack ? 'rejected — previous contents restored' : 'did not verify')
        setMessage(`Imported ${file.name} → P${entry.index} · verified`)
        await readSlot(entry.index)
      } catch (e) {
        setMessage(`Import failed: ${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  async function copyTo(from: SlotEntry, toIndex: number): Promise<void> {
    if (!window.confirm(`Overwrite P${toIndex} with P${from.index}?`)) return
    try {
      const bytes = from.bytes ?? (await readSlot(from.index))
      setBusy(true)
      const result = await api().writeProfile(toIndex, bytesToB64(bytes))
      if (!result.verified) throw new Error(result.rolledBack ? 'rejected — previous contents restored' : 'did not verify')
      setMessage(`Copied P${from.index} → P${toIndex} · verified`)
      await readSlot(toIndex)
    } catch (e) {
      setMessage(`Copy failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function backupAll(): Promise<void> {
    setBusy(true)
    try {
      const dump: Record<string, { name: string; bytes: string }> = {}
      for (const slot of [1, 2, 3, 4]) {
        const bytes = await readSlot(slot)
        dump[String(slot)] = { name: parseProfile(bytes, modelId).name, bytes: bytesToB64(bytes) }
      }
      download(`sticklab-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ version: 1, app: 'g7-stick-lab', device: 'G7ProCE', profiles: dump }, null, 2))
      setMessage('Backup downloaded')
    } catch (e) {
      setMessage(`Backup failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  function restoreAll(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const written: string[] = []
      try {
        const parsed = JSON.parse(await file.text()) as { profiles?: Record<string, { name?: string; bytes?: string }> }
        const slots = Object.entries(parsed.profiles ?? {})
          .map(([slot, entry]) => ({ slot: Number(slot), entry }))
          .filter((x) => Number.isInteger(x.slot) && x.slot >= 1 && x.slot <= 4 && !!x.entry?.bytes)
        if (slots.length === 0) throw new Error('that file holds no profiles')
        if (!window.confirm(`Write ${slots.length} profile(s)? ${slots.map((x) => `P${x.slot} ${x.entry.name || ''}`).join(', ')}`)) return
        setBusy(true)
        for (const { slot, entry } of slots) {
          const bytes = b64ToBytes(entry.bytes as string)
          if (bytes.length !== modelLen) throw new Error(`P${slot}: expected ${modelLen} bytes, got ${bytes.length}`)
          const result = await api().writeProfile(slot, bytesToB64(bytes), modelLen)
          if (!result.verified) throw new Error(result.rolledBack ? `P${slot} rejected — restored` : `P${slot} did not verify`)
          written.push(`P${slot}`)
          await readSlot(slot)
        }
        setMessage(`Restored ${written.join(', ')} · all verified`)
      } catch (e) {
        setMessage(`Restore failed: ${written.length ? `restored ${written.join(', ')} before failing — ` : ''}${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  if (!connected) return <div className="note">{t('profiles.needConn')}</div>
  if (locked) {
    return (
      <LockedDump
        modelId={modelId}
        modelName={modelName}
        defaultLength={dumpLength > 0 ? dumpLength : 680}
      />
    )
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('profiles.title')} — {t('profiles.subtitle')}</h3>
      <Hint>{t('profiles.hint')}</Hint>
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn sm" disabled={busy} onClick={() => void refreshAll()}>{busy ? t('common.working') : t('profiles.readAll')}</button>
        <button className="btn sm" disabled={busy} onClick={() => void backupAll()}>{t('profiles.backup')}</button>
        <button className="btn sm" disabled={busy} onClick={restoreAll}>{t('profiles.restore')}</button>
        {message && <span className="pill">{message}</span>}
      </div>
      <table className="tbl">
        <thead><tr><th>{t('profiles.slot')}</th><th>{t('profiles.name')}</th><th>{t('profiles.active')}</th><th>{t('profiles.actions')}</th></tr></thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.index}>
              <td className="mono">P{entry.index}</td>
              <td>{entry.loading ? t('profiles.reading') : entry.error ? <span style={{ color: 'var(--bad)' }}>{entry.error} <button className="btn sm ghost" disabled={busy} onClick={() => void readSlot(entry.index)}>{t('profiles.retry')}</button></span> : (entry.name || <span style={{ color: 'var(--text-3)' }}>{t('profiles.unnamed')}</span>)}</td>
              <td>{entry.index === activeSlot ? <span className="pill good">{t('profiles.current')}</span> : <span className="tag">—</span>}</td>
              <td>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm ghost" disabled={busy} onClick={() => void exportSlot(entry, 'bin')}>{t('profiles.export')}</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => void exportSlot(entry, 'json')}>JSON</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => handleImport(entry)}>{t('profiles.import')}</button>
                  <select className="input" style={{ width: 110 }} disabled={busy} value="" onChange={(e) => { if (e.target.value) void copyTo(entry, Number(e.target.value)) }}>
                    <option value="">{t('profiles.copyTo')}</option>
                    {[1, 2, 3, 4].filter((s) => s !== entry.index).map((s) => <option key={s} value={s}>P{s}</option>)}
                  </select>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Button glyphs for the remap UI — original Xbox-style icons (colored
 * ABXY, bumpers, triggers, d-pad arrows, system keys, back paddles).
 * Anything without a drawn glyph (keyboard/mouse/special/unknown)
 * returns null and the text label carries it.
 */
function glyphWrap(s: number, inner: JSX.Element): JSX.Element {
  return (
    <svg width={s} height={s} viewBox="0 0 20 20" style={{ verticalAlign: 'middle', flexShrink: 0 }}>{inner}</svg>
  )
}
function glyphLabel(s: number, bg: string, ch: string, fg = '#fff', fs = 10): JSX.Element {
  return glyphWrap(s, <><circle cx={10} cy={10} r={8.5} fill={bg} /><text x={10} y={10.5} fontSize={fs} fill={fg} fontWeight={800} textAnchor="middle" dominantBaseline="central">{ch}</text></>)
}
function glyphArrow(s: number, pts: string): JSX.Element {
  return glyphWrap(s, <><rect x={2.5} y={2.5} width={15} height={15} rx={4.5} fill="#33333d" /><polygon points={pts} fill="#fff" /></>)
}
function glyphPill(s: number, ch: string, tall: boolean): JSX.Element {
  return glyphWrap(s, <><rect x={2} y={tall ? 3 : 6.5} width={16} height={tall ? 14 : 7} rx={3.5} fill={tall ? '#3a3a46' : '#4a4a55'} /><text x={10} y={10.5} fontSize={6} fill="#fff" fontWeight={800} textAnchor="middle" dominantBaseline="central">{ch}</text></>)
}
function glyphPaddle(s: number, ch: string): JSX.Element {
  return glyphWrap(s, <><rect x={3.5} y={3.5} width={13} height={13} rx={5.5} fill="#4a4a55" stroke="#7a7a88" strokeWidth={1} /><text x={10} y={10.5} fontSize={6} fill="#fff" fontWeight={800} textAnchor="middle" dominantBaseline="central">{ch}</text></>)
}
const ARROW_UP = '10,5.5 14.5,12 5.5,12'
const ARROW_DOWN = '10,14.5 14.5,8 5.5,8'
const ARROW_LEFT = '5.5,10 12,5.5 12,14.5'
const ARROW_RIGHT = '14.5,10 8,5.5 8,14.5'

function StickSideIcon({ side, size = 18 }: { side: 'left' | 'right'; size?: number }): JSX.Element {
  return (
    <svg className="stick-side-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 5.5c-2.4 0-4 2.1-4 4.6v5.2c0 1.5 1 2.7 2.3 2.7 1 0 1.6-.7 2.2-1.5.5-.7 1-1.2 1.9-1.2h5.2c.9 0 1.4.5 1.9 1.2.6.8 1.2 1.5 2.2 1.5 1.3 0 2.3-1.2 2.3-2.7v-5.2c0-2.5-1.6-4.6-4-4.6H7Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7 9v5M4.5 11.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx={15.8} cy={10.6} r="1.35" fill="currentColor" />
      <circle cx={18.2} cy={13.2} r="1.05" fill="currentColor" opacity=".72" />
      <circle cx="10" cy="15.2" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity={side === 'left' ? '.45' : '.25'} />
      <circle cx="14" cy="15.2" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity={side === 'right' ? '.45' : '.25'} />
      <circle cx={side === 'left' ? 10 : 14} cy="15.2" r="1.1" fill="currentColor" />
    </svg>
  )
}

function MappingTypeIcon({ type, size = 18 }: { type: 'keyboard' | 'mouse'; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" className="mapping-type-icon">
      {type === 'keyboard' ? (
        <><rect x="2" y="4.5" width="16" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M5 8h1m2 0h1m2 0h1m2 0h1M5 10.5h1m2 0h1m2 0h1m2 0h1M7 13h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>
      ) : (
        <><path d="M10 2.5c-3 0-5 2.1-5 5.2v4.6c0 3.1 2 5.2 5 5.2s5-2.1 5-5.2V7.7c0-3.1-2-5.2-5-5.2Z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10 3v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /><path d="M7.3 11h1m3.4 0h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></>
      )}
    </svg>
  )
}

function DeviceIcon({ kind, size = 20 }: { kind: 'polling' | 'resolution' | 'rate'; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="device-icon">
      {kind === 'polling' ? (
        <><path d="M19.2 8A8 8 0 0 0 5.5 5.7L4 7.2M4 7.2V3.8M4 7.2h3.4M4.8 16A8 8 0 0 0 18.5 18.3l1.5-1.5m0 0v3.4m0-3.4h-3.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /><path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>
      ) : kind === 'resolution' ? (
        <><rect x="3.5" y="4" width="17" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M9 4v16m6-16v16M3.5 9.3h17m-17 5.4h17" stroke="currentColor" strokeWidth="1.2" opacity=".75" /></>
      ) : (
        <><path d="M12 3c-3.8 0-6.2 2.7-6.2 6.4v5.2c0 3.7 2.4 6.4 6.2 6.4s6.2-2.7 6.2-6.4V9.4C18.2 5.7 15.8 3 12 3Z" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M12 3v6m-3.2 5.7h.1m6.2 0h.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>
      )}
    </svg>
  )
}

function KeyIcon({ value, tag, size = 18 }: { value: number; tag?: string; size?: number }): JSX.Element | null {
  const s = size
  switch (value) {
    case 9: return glyphLabel(s, '#2ca243', 'A')
    case 10: return glyphLabel(s, '#e74856', 'B')
    case 11: return glyphLabel(s, '#2f7de1', 'X')
    case 12: return glyphLabel(s, '#f2b90d', 'Y')
    case 1: return glyphArrow(s, ARROW_UP)
    case 2: return glyphArrow(s, ARROW_DOWN)
    case 3: return glyphArrow(s, ARROW_LEFT)
    case 4: return glyphArrow(s, ARROW_RIGHT)
    case 5: return glyphPill(s, 'LB', false)
    case 6: return glyphPill(s, 'RB', false)
    case 19: return glyphPill(s, 'LT', true)
    case 20: return glyphPill(s, 'RT', true)
    case 7:
    case 8:
      return glyphWrap(s, <><circle cx={10} cy={10} r={8} fill="#33333d" /><circle cx={value === 7 ? 7.5 : 12.5} cy={10} r={3} fill="#8a8a96" /></>)
    case 13:
      return glyphWrap(s, <><circle cx={10} cy={10} r={8} fill="none" stroke="#8a8a96" strokeWidth={2} /><circle cx={10} cy={10} r={2.5} fill="#8a8a96" /></>)
    case 14:
      return glyphWrap(s, <><rect x={3} y={6} width={9} height={8} rx={1.5} fill="none" stroke="#8a8a96" strokeWidth={1.5} /><rect x={8} y={8.5} width={9} height={8} rx={1.5} fill="#33333d" stroke="#8a8a96" strokeWidth={1.5} /></>)
    case 15:
      return glyphWrap(s, <><rect x={2.5} y={2.5} width={15} height={15} rx={4.5} fill="#33333d" /><path d="M6 7.5h8M6 10h8M6 12.5h8" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" /></>)
    case 16:
      return glyphWrap(s, <><rect x={2.5} y={6} width={15} height={9} rx={2} fill="#33333d" /><circle cx={10} cy={10.5} r={2.8} fill="none" stroke="#8a8a96" strokeWidth={1.5} /><rect x={8} y={4} width={4} height={2.5} rx={1} fill="#33333d" /></>)
    case 17: return glyphPaddle(s, tag ?? 'FL1')
    case 18: return glyphPaddle(s, tag ?? 'FR1')
    default: {
      const target = REMAP_TARGETS.find((item) => item.value === value)
      if (target?.group === 'keyboard') {
        const label = target.label.length <= 2 ? target.label : ''
        return label ? glyphLabel(s, '#4a4c56', label) : <MappingTypeIcon type="keyboard" size={s} />
      }
      if (target?.group === 'mouse') return <MappingTypeIcon type="mouse" size={s} />
      if (target?.group === 'sticks') {
        const direction = value % 4
        const arrow = direction === 1 ? ARROW_UP : direction === 2 ? ARROW_DOWN : direction === 3 ? ARROW_LEFT : ARROW_RIGHT
        const sideX = value < 25 ? 7 : 13
        return glyphWrap(s, <><circle cx={10} cy={10} r={8} fill="#33333d" /><circle cx={sideX} cy="10" r="2.5" fill="#ff8fa0" /><path d={arrow} fill="#fff" transform="translate(3 3) scale(.7)" /></>)
      }
      if (target) return glyphPill(s, target.label.slice(0, 4), false)
      return value === 0 ? glyphPill(s, '—', false) : glyphPill(s, `#${value}`, false)
    }
  }
}

/**
 * Same glyphs for LeadJoy ids (A=1 B=2 X=4 Y=5 … M1=24 M2=25 M3=26 M4=27):
 * identical look to KeyIcon, correct mapping for the LeadJoy table.
 */
function LjKeyIcon({ id, size = 18 }: { id: number; size?: number }): JSX.Element | null {
  const s = size
  switch (id) {
    case 1: return glyphLabel(s, '#2ca243', 'A')
    case 2: return glyphLabel(s, '#e74856', 'B')
    case 4: return glyphLabel(s, '#2f7de1', 'X')
    case 5: return glyphLabel(s, '#f2b90d', 'Y')
    case 17: return glyphArrow(s, ARROW_UP)
    case 18: return glyphArrow(s, ARROW_DOWN)
    case 19: return glyphArrow(s, ARROW_LEFT)
    case 20: return glyphArrow(s, ARROW_RIGHT)
    case 7: return glyphPill(s, 'LB', false)
    case 8: return glyphPill(s, 'RB', false)
    case 9: return glyphPill(s, 'LT', true)
    case 10: return glyphPill(s, 'RT', true)
    case 14:
    case 15:
      return glyphWrap(s, <><circle cx={10} cy={10} r={8} fill="#33333d" /><circle cx={10} cy={10} r={3} fill="#8a8a96" /></>)
    case 11:
      return glyphWrap(s, <><rect x={3} y={6} width={9} height={8} rx={1.5} fill="none" stroke="#8a8a96" strokeWidth={1.5} /><rect x={8} y={8.5} width={9} height={8} rx={1.5} fill="#33333d" stroke="#8a8a96" strokeWidth={1.5} /></>)
    case 12:
      return glyphWrap(s, <><rect x={2.5} y={2.5} width={15} height={15} rx={4.5} fill="#33333d" /><path d="M6 7.5h8M6 10h8M6 12.5h8" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" /></>)
    case 16:
      return glyphWrap(s, <><rect x={2.5} y={6} width={15} height={9} rx={2} fill="#33333d" /><circle cx={10} cy={10.5} r={2.8} fill="none" stroke="#8a8a96" strokeWidth={1.5} /><rect x={8} y={4} width={4} height={2.5} rx={1} fill="#33333d" /></>)
    case 24: return glyphPaddle(s, 'R5')
    case 25: return glyphPaddle(s, 'L5')
    case 26: return glyphPaddle(s, 'R4')
    case 27: return glyphPaddle(s, 'L4')
    default: return glyphPill(s, `#${id}`, false)
  }
}

/**
 * Icon dropdown for remap targets — native <select> cannot render icons,
 * so this renders a button + a portal popup (position:fixed, so card and
 * table scrolling cannot clip it). Closes on pick, Escape, outside click,
 * scroll or resize. Only one row's popup is open at a time (lifted state).
 */
function KeySelect({ value, disabled, open, onToggle, onClose, onPick, options, getLabel, renderIcon, searchable = false }: {
  value: number
  disabled?: boolean
  open: boolean
  onToggle: () => void
  onClose: () => void
  onPick: (v: number) => void
  /** Custom option list — defaults to the GameSir remap targets. */
  options?: Array<{ value: number; label: string }>
  /** Label for the current value — defaults to the GameSir key table. */
  getLabel?: (v: number) => string
  /** Icon for a value — defaults to the GameSir glyphs. */
  renderIcon?: (v: number) => JSX.Element | null
  searchable?: boolean
}): JSX.Element {
  const t = useT()
  const [search, setSearch] = useState('')
  useEffect(() => { if (open) setSearch('') }, [open])
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; bottom: number; width: number } | null>(null)
  const [flip, setFlip] = useState(false)
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      setPos({ left: r.left, top: r.top, bottom: r.bottom, width: Math.max(r.width, 210) })
      setFlip(r.bottom + 320 > window.innerHeight)
    }
    place()
    const close = (e: Event): void => {
      // Scrolling the option list itself must not close the menu —
      // only page-level scrolls do.
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open, onClose])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onDown = (e: PointerEvent): void => {
      if (!(e.target as HTMLElement).closest?.('[data-keyselect]')) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open, onClose])
  const opts = options ?? [{ value: 0, label: t('buttons.unmapped') }, ...REMAP_TARGETS.filter((k) => k.value !== 0)]
  const labelFor = getLabel ?? ((v: number) => (v === 0 ? t('buttons.unmapped') : keyLabel(v)))
  const iconFor = renderIcon ?? ((v: number) => <KeyIcon value={v} />)
  return (
    <span data-keyselect style={{ display: 'inline-block' }}>
      <button
        ref={btnRef}
        type="button"
        className="input"
        disabled={disabled}
        onClick={onToggle}
        style={{ width: 210, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: disabled ? 'default' : 'pointer', textAlign: 'left', color: 'var(--text)' }}
      >
        <span className="row" style={{ gap: 7, alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap' }}>
          {value !== 0 && iconFor(value)}
          <span>{labelFor(value)}</span>
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 11 }}>▾</span>
      </button>
      {open && pos && createPortal(
        <div
          data-keyselect
          ref={menuRef}
          style={{
            position: 'fixed',
            left: Math.max(8, Math.min(pos.left, window.innerWidth - pos.width - 8)),
            ...(flip ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.bottom + 4 }),
            width: pos.width,
            maxHeight: 300,
            overflowY: 'auto',
            background: 'var(--bg-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--radius-sm)',
            padding: 4,
            zIndex: 5000,
            boxShadow: '0 12px 32px rgba(0,0,0,0.55)'
          }}
        >
          {searchable && <div className="remap-picker-search"><input autoFocus className="input" type="search" aria-label={t('remap.searchOutputs')} placeholder={t('remap.searchOutputs')} value={search} onChange={e => setSearch(e.target.value)} /></div>}
          {opts.filter(o => !searchable || o.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onPick(o.value); onClose() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '7px 9px', borderRadius: 5, border: 'none', cursor: 'pointer',
                background: o.value === value ? 'var(--bg-3)' : 'transparent',
                color: 'var(--text)', fontSize: 13, textAlign: 'left'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-3)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = o.value === value ? 'var(--bg-3)' : 'transparent' }}
            >
              {iconFor(o.value)}
              <span>{o.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </span>
  )
}


type RemapSource = {
  id: string
  name: string
  icon: React.ReactNode
  current: number
  effective: string
  outputIcon: React.ReactNode
  extra: boolean
  known: boolean
  onPick: (value: number) => void
}

function RemapWorkspace({ rows, disabled, help, options, getLabel, renderIcon, captureFamily }: {
  captureFamily: CaptureFamily
  rows: RemapSource[]
  disabled: boolean
  help: React.ReactNode
  options?: Array<{ value: number; label: string }>
  getLabel?: (value: number) => string
  renderIcon?: (value: number) => JSX.Element | null
}): JSX.Element {
  const t = useT()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const selected = rows.find(row => row.id === selectedId) ?? rows[0]
  const visible = rows.filter(row => `${row.name} ${row.effective}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  const [capture, setCapture] = useState<'keyboard' | 'controller' | null>(null)
  const [captureMessage, setCaptureMessage] = useState('')
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  useEffect(() => { setOpen(false); setCapture(null); setCaptureMessage('') }, [selected?.id])
  useEffect(() => {
    if (!capture || disabled || !selected?.known) { setCapture(null); return }
    let finished = false
    let frame = 0
    const started = performance.now()
    const gate = new PadCaptureGate()
    const held = new Set<string>()
    let chord = false
    const stop = () => { finished = true; setCapture(null) }
    const finish = (target: number | null) => {
      if (finished) return
      if (target === null) { setCaptureMessage(t('remap.captureUnsupported')); return }
      stop()
      selectedRef.current?.onPick(target)
      setCaptureMessage(t('remap.captured').replace('{button}', getLabel?.(target) ?? keyLabel(target)))
    }
    const cancel = () => { stop(); setCaptureMessage(t('remap.captureCancelled')) }
    const hidden = () => { if (document.hidden) cancel() }
    const down = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation()
      if (e.code === 'Escape') { cancel(); return }
      if (capture !== 'keyboard' || e.repeat || performance.now() - started < 150) return
      held.add(e.code)
      if (held.size > 1 || (e.ctrlKey && !e.code.startsWith('Control')) || (e.shiftKey && !e.code.startsWith('Shift')) || (e.altKey && !e.code.startsWith('Alt')) || (e.metaKey && !e.code.startsWith('Meta'))) {
        chord = true; setCaptureMessage(t('remap.captureSingle'))
      }
    }
    const up = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopImmediatePropagation()
      if (capture !== 'keyboard' || !held.has(e.code)) return
      held.delete(e.code)
      if (!chord) finish(capturedKeyTarget(captureFamily, e.code))
      if (!held.size) chord = false
    }
    const poll = () => {
      if (finished) return
      if (performance.now() - started > 15000) { stop(); setCaptureMessage(t('remap.captureTimeout')); return }
      if (capture === 'controller') {
        const pads = Array.from(navigator.getGamepads?.() ?? []).filter((p): p is Gamepad => !!p && p.connected && p.mapping === 'standard')
        const result = gate.sample(pads.map(p => ({ id: String(p.index) + p.id, values: p.buttons.map(b => b.pressed ? Math.max(1, b.value) : b.value) })), performance.now())
        if (result.state === 'done' && result.index !== undefined) {
          const target = capturedPadTarget(captureFamily, result.index)
          if (target === null) { stop(); setCaptureMessage(t('remap.captureUnsupported')) } else finish(target)
          return
        }
        setCaptureMessage(t('remap.capture' + result.state[0].toUpperCase() + result.state.slice(1)))
      }
      frame = requestAnimationFrame(poll)
    }
    setCaptureMessage(t(capture === 'keyboard' ? 'remap.captureKeyboardHint' : 'remap.captureRelease'))
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hidden)
    frame = requestAnimationFrame(poll)
    return () => { finished = true; cancelAnimationFrame(frame); window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hidden) }
  }, [capture, selected?.id, disabled, captureFamily])

  return <section className="card remap-workspace">
    <header className="remap-header"><div><span className="stick-eyebrow">{t('nav.buttons')}</span><h3>{t('buttons.title')}</h3><p>{t('remap.intro')}</p></div><details className="remap-help"><summary aria-label={t('buttons.help')}>?</summary><div>{help}</div></details></header>
    <div className="remap-layout">
      <section className="remap-sources"><label className="remap-search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg><input type="search" placeholder={t('remap.searchButtons')} aria-label={t('remap.searchButtons')} value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="remap-source-scroll">{[false, true].map(extra => {
          const group = visible.filter(row => row.extra === extra)
          if (!group.length) return null
          return <div className="remap-source-group" key={String(extra)}><div className="remap-group-label"><span>{t(extra ? 'remap.extra' : 'remap.standard')}</span><span>{group.length}</span></div><div className="remap-source-grid">{group.map(row => <button type="button" className={`remap-source${selected?.id === row.id ? ' selected' : ''}${row.current ? ' mapped' : ''}`} key={row.id} aria-pressed={selected?.id === row.id} onClick={() => { setCapture(null); setSelectedId(row.id); setOpen(false) }}><span className="remap-source-icon">{row.icon}</span><strong>{row.name}</strong><small>{row.current ? row.effective : t('remap.original')}</small>{row.current !== 0 && <i aria-hidden="true" />}</button>)}</div></div>
        })}{!visible.length && <p className="remap-empty">{t('remap.noResults')}</p>}</div>
      </section>
      {selected && <section className="remap-binding">
        <span className="stick-eyebrow">{t('remap.selected')}</span>
        <div className="remap-preview"><div><span className="remap-preview-icon">{selected.icon}</span><strong>{selected.name}</strong></div><span className="remap-preview-arrow" aria-hidden="true">→</span><div><span className="remap-preview-icon output">{selected.current ? selected.outputIcon : selected.icon}</span><strong>{selected.current ? selected.effective : selected.name}</strong></div></div>
        <div className="remap-binding-label">{t('buttons.target')}</div>
        {selected.known ? <KeySelect key={selected.id} value={selected.current} disabled={disabled} open={open} onToggle={() => { setCapture(null); setOpen(!open) }} onClose={() => setOpen(false)} onPick={selected.onPick} options={options} getLabel={getLabel} renderIcon={renderIcon} searchable /> : <div className="remap-readonly">{selected.effective}<small>{t('remap.readonly')}</small></div>}
        <div className={`remap-capture-panel${capture ? ' active' : ''}`}>
          <div className="remap-capture-heading"><span>{t('remap.quickBind')}</span>{capture && <span className="remap-listening-dot" aria-hidden="true" />}</div>
          <div className="remap-capture-actions">{capture ? <button type="button" className="remap-capture-cancel" onClick={() => { setCapture(null); setCaptureMessage(t('remap.captureCancelled')) }}><svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>{t('remap.captureCancel')}<kbd>Esc</kbd></button> : <>{(['controller', 'keyboard'] as const).map(mode => <button type="button" className="remap-capture-choice" key={mode} aria-label={t(mode === 'keyboard' ? 'remap.captureKeyboard' : 'remap.captureController')} disabled={disabled || !selected.known} onClick={() => { setOpen(false); setCapture(mode) }}><span className="remap-capture-icon">{mode === 'keyboard' ? <MappingTypeIcon type="keyboard" size={24} /> : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 6h8c2.1 0 3.4 1.6 3.9 3.7l1.1 5.2c.6 2.7-1.5 4-3.4 2.1L15 14H9l-2.6 3C4.5 19 2.4 17.6 3 14.9l1.1-5.2C4.6 7.6 5.9 6 8 6Z"/><path d="M8 8.8v4M6 10.8h4"/><circle cx="15.7" cy="9.5" r=".8" fill="currentColor" stroke="none"/><circle cx="18" cy="11.8" r=".8" fill="currentColor" stroke="none"/></svg>}</span><span>{t(mode === 'keyboard' ? 'remap.keyboardLabel' : 'remap.controllerLabel')}</span></button>)}</>}</div>
          <p className={`remap-capture-message${capture ? ' listening' : ''}`} role="status" aria-live="polite" title={t('remap.captureHint')}>{captureMessage || t('remap.captureShortHint')}</p>
        </div>
        <div className={`remap-binding-state${selected.current ? ' changed' : ''}`}><i />{t(selected.current ? 'remap.custom' : 'remap.original')}</div>
        <button type="button" className="btn sm ghost remap-reset" disabled={disabled || !selected.known || !selected.current} onClick={() => { setCapture(null); selected.onPick(0); setOpen(false) }}>{t('remap.reset')}</button>
        <p className="remap-apply-note">{t('remap.apply')}</p>
      </section>}
    </div>
  </section>
}

function ResetEverythingCard({ profile, fd, edit, onReload, notify }: {
  profile: Profile | null
  fd: Packet | null
  edit: (fn: () => void) => void
  onReload: () => void
  notify: (m: string) => void
}): JSX.Element | null {
  const t = useT()
  if (!profile || !fd) return null
  return (
    <div className="card" style={{ marginTop: 16, borderColor: 'var(--bad)' }}>
      <h3>{t('sticks.reset')}</h3>
      <Hint>{t('sticks.resetHint')}</Hint>
      <button
        className="btn danger"
        style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 700, letterSpacing: '0.08em', marginTop: 10 }}
        onClick={() => {
          if (!window.confirm('Reset EVERYTHING this app controls to stock neutral?\n\nBoth sticks, outer, detail, polling. Names, triggers, buttons and macros are kept.')) return
          edit(() => {
            profile.sticks.forEach((s, i) => {
              stick.setDeadzone(s, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 })
              stick.setCurve(s, LINEAR_CURVE.map((p) => ({ ...p })))
              stick.markCurveIdentity(s)
              stick.setFlipX(s, false)
              stick.setFlipY(s, false)
              stick.setSquareGate(s, false)
              stick.setAxisRatio(s, 50)
              stick.setMouseDpi(s, 50)
              stick.setMapIndex(s, i === 0 ? 1 : 2)
              stick.setMapped(s, true)
            })
            fun.extend.setStickResolutionBits(fd, 12)
            fun.extend.setReportRateGear(fd, 5)
          })
          onReload()
          notify('Everything reset to stock neutral — Write to apply it to the pad.')
        }}
      >
        {t('sticks.resetAll')}
      </button>
    </div>
  )
}

/**
 * Self-update row in the sidebar. Nothing pops up anywhere: the state comes from
 * the main process, the button carries a badge while an update is downloading or
 * waiting, and clicking installs (or re-checks). Packaged builds only — in dev
 * the check just reports that there is nothing to check.
 */
function UpdateRow(): JSX.Element | null {
  const [st, setSt] = useState<{ state: string; version?: string; percent?: number; message?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void api()
      .updateStatus()
      .then((s) => {
        if (alive) setSt(s)
      })
      .catch(() => undefined)
    const off = api().on('update:status', (s) => setSt(s as never))
    return () => {
      alive = false
      off()
    }
  }, [])
  if (!st) return null

  const label =
    st.state === 'ready'
      ? `Restart to install${st.version ? ` ${st.version}` : ''}`
      : st.state === 'downloading'
        ? `Update ${st.version ?? ''} — ${st.percent ?? 0}%`
        : st.state === 'checking'
          ? 'Checking for updates…'
          : st.state === 'current'
            ? 'Up to date — check again'
            : st.state === 'error'
              ? 'Update check failed'
              : 'Check for updates'
  const hot = st.state === 'ready' || st.state === 'downloading'

  return (
    <button
      type="button"
      className={`btn sm${hot ? ' primary' : ' ghost'}`}
      style={{ width: '100%', marginTop: 8 }}
      disabled={busy || st.state === 'checking'}
      title={st.message ?? label}
      onClick={() => {
        void (async () => {
          setBusy(true)
          try {
            if (st.state === 'ready') await api().updateInstall()
            else await api().updateCheck()
          } catch {
            /* state is reported back through update:status */
          } finally {
            setBusy(false)
          }
        })()
      }}
    >
      {hot && (
        <span
          style={{
            display: 'inline-block',
            width: 7,
            height: 7,
            borderRadius: 4,
            background: 'var(--bad, #f43f52)',
            marginRight: 6,
            verticalAlign: 'middle'
          }}
        />
      )}
      {label}
    </button>
  )
}

function StickCross({ lx, ly, rx, ry, windows }: { lx: number; ly: number; rx: number; ry: number; windows?: Array<{ begin: number; end: number; beginAnti: number } | null> }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = 190
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const draw = (x: number, y: number, cx: number, label: string, win?: { begin: number; end: number; beginAnti: number } | null): void => {
      const r = 62
      ctx.setLineDash([])
      ctx.strokeStyle = '#3a2230'
      ctx.beginPath()
      ctx.arc(cx, h / 2, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx - r, h / 2)
      ctx.lineTo(cx + r, h / 2)
      ctx.moveTo(cx, h / 2 - r)
      ctx.lineTo(cx, h / 2 + r)
      ctx.stroke()

      // The stick's own windows, so tuning is visible while it moves:
      // dead zone disc (input below this reads 0), saturation ring (output is
      // pinned past this), and the anti-dead-zone floor — the output jump that
      // happens the moment you leave the dead zone.
      if (win) {
        const inner = Math.max(0, Math.min(0.95, win.begin / 1000)) * r
        if (inner > 0.5) {
          ctx.fillStyle = 'rgba(244,63,82,0.13)'
          ctx.beginPath()
          ctx.arc(cx, h / 2, inner, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = 'rgba(244,63,82,0.6)'
          ctx.setLineDash([3, 3])
          ctx.beginPath()
          ctx.arc(cx, h / 2, inner, 0, Math.PI * 2)
          ctx.stroke()
        }
        const outer = Math.max(0.05, Math.min(1, win.end / 1000)) * r
        ctx.strokeStyle = 'rgba(120,200,255,0.55)'
        ctx.setLineDash([5, 4])
        ctx.beginPath()
        ctx.arc(cx, h / 2, outer, 0, Math.PI * 2)
        ctx.stroke()
        const anti = Math.max(0, Math.min(0.95, win.beginAnti / 1000)) * r
        if (anti > 0.5) {
          ctx.strokeStyle = 'rgba(245,181,68,0.55)'
          ctx.setLineDash([2, 3])
          ctx.beginPath()
          ctx.arc(cx, h / 2, anti, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.setLineDash([])
      }

      const nx = (x - 128) / 128
      const ny = (y - 128) / 128
      const px = cx + nx * r
      const py = h / 2 + ny * r
      ctx.fillStyle = '#f43f52'
      ctx.beginPath()
      ctx.arc(px, py, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#c9a3ad'
      ctx.font = '11px system-ui'
      ctx.fillText(label, cx - 12, h - 8)
      if (win) {
        ctx.fillStyle = '#8d7f86'
        ctx.font = '10px system-ui'
        ctx.fillText(`dz ${(win.begin / 10).toFixed(1)}% · sat ${(win.end / 10).toFixed(0)}% · anti ${(win.beginAnti / 10).toFixed(1)}%`, cx - 44, h - 20)
      }
    }
    draw(lx, ly, w * 0.27, `L ${lx},${ly}`, windows?.[0] ?? null)
    draw(rx, ry, w * 0.73, `R ${rx},${ry}`, windows?.[1] ?? null)
  }, [lx, ly, rx, ry, windows])
  return <canvas ref={ref} className="plot" style={{ height: 190 }} />
}

/**
 * LeadJoy stick editor: draggable 8-point curve (0.1% grid) + precise
 * deadzone slider + explicit Write. Draft lives in decide-percent; Write
 * converts to wire and the pad proves it with readback. Point 1 output is
 * locked at 0 (the vendor deadzone-floor invariant).
 */
/** Staged LeadJoy edits — the topbar Write commits these, one record at a time. */
interface LjDraft {
  buttons: Record<number, LjButtonTarget | null>
  sticks: Partial<Record<0 | 1, Array<{ x: number; y: number }>>>
  shapes: Partial<Record<0 | 1, number>>
  mouse: Partial<Record<0 | 1, { enabled: number; rate: number }>>
}

/** Convert the renderer's 0.1% point grid to/from the shared pair form. */
const toPairs = (pts: ReadonlyArray<{ x: number; y: number }>): Array<[number, number]> => pts.map((p) => [p.x, p.y])
const toPts = (pairs: ReadonlyArray<readonly [number, number]>): Array<{ x: number; y: number }> =>
  pairs.map(([x, y]) => ({ x, y }))

/**
 * KeySelect speaks plain numbers, so LeadJoy remap targets (stock / gamepad /
 * keyboard / mouse) get a UI-only encoding here. Never hits the wire: the
 * shared builder turns the decoded target into the pad's real action shape.
 */
const LJ_TARGET_KEY_BASE = 1000
const LJ_TARGET_MOUSE_BASE = 2000
const ljEncodeTarget = (target: LjButtonTarget): number =>
  target.t === LJ_MAP_GAMEPAD
    ? target.code
    : target.t === LJ_MAP_KEYBOARD
      ? LJ_TARGET_KEY_BASE + target.code
      : LJ_TARGET_MOUSE_BASE + target.code
const ljDecodeTarget = (v: number): LjButtonTarget =>
  v >= LJ_TARGET_MOUSE_BASE
    ? { t: LJ_MAP_MOUSE, code: v - LJ_TARGET_MOUSE_BASE }
    : v >= LJ_TARGET_KEY_BASE
      ? { t: LJ_MAP_KEYBOARD, code: v - LJ_TARGET_KEY_BASE }
      : { t: LJ_MAP_GAMEPAD, code: v }
const ljSameTarget = (a: LjButtonTarget | null, b: LjButtonTarget | null): boolean =>
  a === null || b === null ? a === b : a.t === b.t && a.code === b.code

/**
 * LeadJoy sticks — the GameSir Sticks tab wired to the record-71 curve image.
 * This pad has no separate deadzone/anti bytes, so the four zone numbers live
 * on the curve endpoints (point 1 = start/anti-start, point 8 = end/anti-end)
 * and the deadzone card and the designer edit one image. Edits stage upward;
 * the topbar Write commits the side and reads it back.
 */
function LjLiveCard({ live, windows }: { live: { lx: number; ly: number; rx: number; ry: number } | null; windows?: Array<{ begin: number; end: number; beginAnti: number } | null> }): JSX.Element {
  const t = useT()
  return (
    <div className="card lj-live-card">
      <h3>{t('sticks.live')}</h3>
      <Hint>{t('lj.liveHint')}</Hint>
      <StickCross
        lx={live?.lx ?? 128}
        ly={live?.ly ?? 128}
        rx={live?.rx ?? 128}
        ry={live?.ry ?? 128}
        windows={windows}
      />
      <div className="row spread">
        <span className="mono">L {live?.lx ?? '—'},{live?.ly ?? '—'}</span>
        <span className="mono">R {live?.rx ?? '—'},{live?.ry ?? '—'}</span>
      </div>
    </div>
  )
}

function LjZonesCard({ points, onChange }: {
  points: Array<{ x: number; y: number }>
  onChange: (next: Array<{ x: number; y: number }>) => void
}): JSX.Element | null {
  const t = useT()
  if (points.length !== 8) return null
  const z = ljCurveZones(toPairs(points))
  const apply = (patch: Partial<LjStickZones>): void => onChange(toPts(ljFitZones(toPairs(points), { ...z, ...patch })))
  const slider = (key: keyof LjStickZones, label: string): JSX.Element => (
    <Slider label={label} value={z[key]} min={0} max={1000} step={1} format={(v) => `${(v / 10).toFixed(1)}%`} onChange={(v) => apply({ [key]: v })} />
  )
  return (
    <div className="lj-zone-sections"><div className="card lj-zones-card">
      <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.inputLabel')}</span><h3>{t('sticks.inputTitle')}</h3></div><span className="pill">0.1%</span></div>
      <p className="stick-intro">{t('sticks.inputHelp')}</p>
      <div className="stack lj-zone-primary" style={{ gap: 12, marginTop: 8 }}>
        {slider('start', t('sticks.innerLabel'))}
        {slider('end', t('sticks.outerLabel'))}
      </div>
      </div><div className="card stick-output-card"><div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.outputLabel')}</span><h3>{t('sticks.outputTitle')}</h3></div></div><p className="stick-intro">{t('sticks.outputHelp')}</p>
      <div className="stack" style={{ gap: 18 }}>{slider('antiStart', t('sticks.floorLabel'))}{slider('antiEnd', t('sticks.ceilingLabel'))}</div>
      </div>
    </div>
  )
}

function LjOuterCard({ points, onChange }: {
  points: Array<{ x: number; y: number }>
  onChange: (next: Array<{ x: number; y: number }>) => void
}): JSX.Element | null {
  const t = useT()
  if (points.length !== 8) return null
  const z = ljCurveZones(toPairs(points))
  const unlimited = z.end === 1000 && z.antiEnd === 1000
  const apply = (patch: Partial<LjStickZones>): void => onChange(toPts(ljFitZones(toPairs(points), { ...z, ...patch })))
  return (
    <div className="card lj-outer-card">
      <h3>{t('sticks.outer')} — {unlimited ? t('sticks.noLimitTitle') : t('sticks.custom')}</h3>
      <Hint>{t('lj.outerHint')}</Hint>
      <div className="row spread" style={{ margin: '10px 0' }}>
        <div>
          <div style={{ fontSize: 13.5 }}>{t('sticks.noLimitTitle')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{unlimited ? t('sticks.outerActive') : t('sticks.outerOff')}</div>
        </div>
        <button
          className={`choice-btn${unlimited ? ' active' : ''}`}
          onClick={() => (unlimited ? apply({ end: 900, antiEnd: 1000 }) : apply({ end: 1000, antiEnd: 1000 }))}
        >
          <span className="choice-label">{unlimited ? t('sticks.infiniteOn') : t('sticks.setInfinite')}</span>
        </button>
      </div>
    </div>
  )
}

function LjShapeCard({ shape, busy, onChange }: {
  shape: number
  busy: boolean
  onChange: (code: number) => void
}): JSX.Element {
  const t = useT()
  const opts = [
    { code: LJ_SHAPES.Circle, label: t('sticks.shapeRound') },
    { code: LJ_SHAPES.RoundedRectangle, label: t('lj.shapeRect') }
  ]
  return (
    <div className="card lj-shape-card">
      <h3>{t('sticks.shape')}</h3>
      <Hint>{t('lj.shapeHint')}</Hint>
      <div className="stack" style={{ gap: 8 }}>
        {opts.map((o) => (
          <button
            key={o.code}
            className={`choice-btn${shape === o.code ? ' active' : ''}`}
            disabled={busy}
            onClick={() => onChange(o.code)}
          >
            <span className="choice-label">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function LjCurveCard({ snap, side, points, onChange, onReset, onCopyToOther, editor, onEditorChange }: {
  editor?: CurveEditorDraft
  onEditorChange: (draft: CurveEditorDraft) => void
  snap: LjSnapshot
  side: 0 | 1
  points: Array<{ x: number; y: number }>
  onChange: (next: Array<{ x: number; y: number }>) => void
  onReset: () => void
  onCopyToOther: () => void
}): JSX.Element | null {
  const t = useT()
  const stick = snap.sticks.find((s) => s.side === side)
  const [presets, setPresets] = useState<Array<{ name: string; pts: Array<{ x: number; y: number }> }>>(() => {
    try {
      const raw = window.localStorage.getItem('sticklabs.ljcurves.v1')
      const parsed = raw ? (JSON.parse(raw) as Array<{ name: string; pts: Array<{ x: number; y: number }> }>) : []
      return Array.isArray(parsed)
        ? parsed.filter((p) => typeof p?.name === 'string' && Array.isArray(p?.pts)).slice(0, 20)
        : []
    } catch {
      return []
    }
  })
  const [presetNotice, setPresetNotice] = useState('')
  useEffect(() => {
    try {
      window.localStorage.setItem('sticklabs.ljcurves.v1', JSON.stringify(presets))
    } catch {
      /* storage full/blocked — presets stay session-only */
    }
  }, [presets])
  if (!stick || points.length !== 8) return null
  const padPts = stick.curvePct.map(([x, y]) => ({ x: Math.round(x * 10), y: Math.round(y * 10) }))
  const dirty = JSON.stringify(points) !== JSON.stringify(padPts)
  const validEditor = editor?.output === JSON.stringify(points) ? editor : undefined
  const designPoints = validEditor?.points ?? points
  const spline = validEditor?.spline ?? false
  const stageCurve = (next: CurvePoint[], smooth = spline): void => {
    const output = sampleLjDesign(next, smooth)
    onEditorChange({ points: next.map(p => ({ ...p })), spline: smooth, output: JSON.stringify(output) })
    onChange(output)
  }
  const zones = ljCurveZones(toPairs(designPoints))
  const setPoint = (i: number, axis: 'x' | 'y', v: number): void => {
    if (!Number.isFinite(v)) return
    const next = designPoints.map((p) => ({ ...p }))
    if (axis === 'x') {
      const lo = i > 0 ? next[i - 1].x : 0
      const hi = i < next.length - 1 ? next[i + 1].x : 1000
      next[i].x = Math.max(lo, Math.min(hi, Math.round(v * 10)))
    } else {
      next[i].y = Math.max(0, Math.min(1000, Math.round(v * 10)))
    }
    stageCurve(next)
  }
  const savePreset = (): void => {
    const name = nextCustomPresetName(presets.map((p) => p.name), t('sticks.customCurveName'))
    setPresets((prev) => [{ name, pts: designPoints.map((p) => ({ ...p })) }, ...prev].slice(0, 20))
    setPresetNotice(t('sticks.curveSavedNotice').replace('{name}', name))
  }
  const renamePreset = (oldName: string, name: string): boolean => {
    if (presets.some((p) => p.name === name && p.name !== oldName)) return false
    setPresets((prev) => prev.map((p) => p.name === oldName ? { ...p, name } : p))
    return true
  }
  return (
    <div className="card lj-curve-card">
      <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.curve')}</span><h3>8 {t('sticks.points')}</h3></div><span className={`pill ${dirty ? 'warn' : 'good'}`}>{dirty ? t('sticks.differs') : t('sticks.matches')}</span></div>
      <Hint>{t('lj.stickHint')}</Hint>
      <SplineControl enabled={spline} slots={8} onChange={enabled => stageCurve(designPoints, enabled)} /><div className="curve-edit-layout"><div className="curve-graph-panel"><CurvePlot spline={spline} height={320} points={designPoints} max={1000} overlay={points} onChange={next => stageCurve(next)} />
      <div className="row wrap" style={{ gap: 8, margin: '12px 0' }}>
        <button className="btn sm ghost" title={t('lj.copyOther')} onClick={onCopyToOther}>{t('sticks.copyCurve')}</button>
        <button className="btn sm ghost" onClick={() => stageCurve(toPts(ljLinearCurve(zones)))}>{t('sticks.resetCurve')}</button>
        <button className="btn sm ghost" disabled={!dirty} onClick={() => { onEditorChange({ points: padPts, spline: false, output: JSON.stringify(padPts) }); onReset() }}>{t('sticks.reload')}</button>
      </div>
      </div><section className="curve-point-editor">
        <h4>{t('sticks.pointEditor')}</h4>
        <div className="stick-extra-body">
      <table className="tbl" style={{ marginTop: 8 }}>
        <thead><tr><th>#</th><th>X</th><th>Y</th></tr></thead>
        <tbody>
          {designPoints.map((p, i) => (
            <tr key={i}>
              <td className="mono">{i + 1}</td>
              <td><input className="input" type="number" min={0} max={100} step={0.1} value={Number((p.x / 10).toFixed(1))} onChange={(e) => setPoint(i, 'x', Number(e.target.value))} /></td>
              <td><input className="input" type="number" min={0} max={100} step={0.1} value={Number((p.y / 10).toFixed(1))} onChange={(e) => setPoint(i, 'y', Number(e.target.value))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="note" style={{ marginTop: 8 }}>
        {t('sticks.hwPreview')} <span className="mono">{points.map((p) => `${ljPercentToWire(p.x / 10)}/${ljPercentToWire(p.y / 10)}`).join(' · ')}</span>
      </div>
        </div>
      </section></div><div className="curve-preset-area"><section className="curve-presets-visible">
        <h4>{t('sticks.presetsAndSaved')}</h4>
        <div className="stick-extra-body">
      {CURVE_GROUPS.map((g) => (
        <div key={g.titleKey} className="curve-preset-group">
          <h5>{t(g.titleKey)}</h5>
          <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
            {g.curves.map(([key, c]) => (
              <button key={key} className="choice-btn" title={c.hint} onClick={() => stageCurve(toPts(ljSampleDesign(c.pts, zones)))}>
                <CurveMiniIcon points={c.pts} />
                <span className="choice-label">{c.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="row wrap" style={{ gap: 8, margin: '8px 0', alignItems: 'center' }}>
        <button
          className="btn sm"
          title={t('sticks.saveTitle')}
          onClick={savePreset}
        >
          {t('sticks.saveCurrent')}
        </button>
        {presetNotice && <span className="saved-curve-notice" role="status">{presetNotice}</span>}
        {presets.length === 0 && <span className="saved-curve-empty">{t('sticks.noSavedCurves')}</span>}
        {presets.map((p) => (
          <SavedCurvePreset key={p.name} preset={p} max={1000} onApply={() => stageCurve(p.pts.map((q) => ({ ...q })))} onRename={(name) => renamePreset(p.name, name)} onDelete={() => setPresets((prev) => prev.filter((q) => q.name !== p.name))} />
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm" disabled title={t('lj.fixedPoints')}>{t('sticks.addPoint')} (8/8)</button>
      </div>
        </div>
      </section>
      </div>
    </div>
  )
}

/**
 * LeadJoy trigger editor: LT/RT inner/outer deadzones. Modes and vibration
 * thresholds pass through from the pad read untouched; edits stage upward and
 * the topbar Write sends the whole trigger image with readback.
 */
function LjTriggerCard({ value }: {
  value: LjTriggerZones
}): JSX.Element {
  const t = useT()
  return (
    <div className="card">
      <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('buttons.title')}</span><h3>{t('lj.trigTitle')}</h3></div><LjKeyIcon id={9} size={24} /></div>
      <Hint>{t('lj.trigHint')}</Hint>
      <div className="device-summary-pills">
        <span className="pill"><LjKeyIcon id={9} size={14} /> LT · {value.leftInner}% / {value.leftOuter}%</span>
        <span className="pill"><LjKeyIcon id={10} size={14} /> RT · {value.rightInner}% / {value.rightOuter}%</span>
      </div>
      <div className="note warn">{t('lj.triggerWriteLocked')}</div>
    </div>
  )
}

/**
 * LeadJoy "controller rate" — the pad's mouse mapping (enable + sensitivity),
 * mirroring the GameSir Controller Rate card. It only matters while a stick
 * answers as a mouse, so the enable toggle ships with it. 50 = stock neutral;
 * the pad clamps/rejects anything out of range and Write reads back to prove it.
 */
function LjControllerRateCard({ value, busy, onChange }: {
  value: { enabled: number; rate: number }
  busy: boolean
  onChange: (next: { enabled: number; rate: number }) => void
}): JSX.Element {
  const t = useT()
  const presets = [50, 60, 70, 80, 90, 100]
  return (
    <div className="card device-rate-card">
      <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('nav.device')}</span><h3>{t('device.rate')}</h3></div><DeviceIcon kind="rate" size={24} /></div>
      <Hint>{t('lj.rateHint')}</Hint>
      <div className="row spread" style={{ margin: '10px 0' }}>
        <div>
          <div style={{ fontSize: 13.5 }}>{t('lj.mouseMapping')}</div>
          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{value.enabled ? t('lj.mouseOn') : t('lj.mouseOff')}</div>
        </div>
        <button
          className={`choice-btn${value.enabled ? ' active' : ''}`}
          disabled={busy}
          onClick={() => onChange({ ...value, enabled: value.enabled ? 0 : 1 })}
        >
          <span className="choice-label">{value.enabled ? t('lj.mouseOn') : t('lj.mouseOff')}</span>
        </button>
      </div>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row spread">
          <span className="label">{t('device.rateConst')}</span>
          <span className="mono">{t('device.stored')}: {value.rate}</span>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {presets.map((r) => (
            <button
              key={r}
              className={`choice-btn${value.rate === r ? ' active' : ''}`}
              disabled={busy}
              onClick={() => onChange({ ...value, rate: r })}
            >
              <span className="choice-label">{r === 50 ? t('device.none') : String(r)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function App(): JSX.Element {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [connPath, setConnPath] = useState<string | null>(null)
  const [leadjoyDetectedNames, setLeadjoyDetectedNames] = useState<Record<string, string>>({})
  // Idle receivers (all-zero frames) are hidden; the open handle and
  // unopenable handles always stay visible. If nothing proves live, show
  // everything rather than an empty list. Receiver interfaces (0x0575) are
  // hidden whenever a direct pad interface is present — they only stay when
  // wireless-through-receiver is the sole path.
  const knownPadPids = MODELS.flatMap((m) => m.pids)
  const hasDirectPad = candidates.some((c) => knownPadPids.includes(c.productId) && c.live === true)
  const visibleCandidates = (
    candidates.some((c) => c.live === true) ? candidates.filter((c) => c.live === true || c.live === null || c.path === connPath) : candidates
  ).filter((c) => !(c.productId === 0x0575 && hasDirectPad))
  const preferredCandidates = visibleCandidates.filter((c) => c.preferred)
  const primaryCandidates = preferredCandidates.length > 0 ? preferredCandidates : visibleCandidates
  const otherCandidates = preferredCandidates.length > 0 ? visibleCandidates.filter((c) => !c.preferred) : []
  const [connected, setConnected] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  // LeadJoy Saber Plus / Xeno Pro — shared protocol, same UI as GameSir.
  // Edits stage into `ljDraft`; the topbar Write commits them record by
  // record (each verified with readback); slots switch from the topbar.
  const [ljPath, setLjPath] = useState<string | null>(null)
  const [ljSnap, setLjSnap] = useState<LjSnapshot | null>(null)
  const [ljBusy, setLjBusy] = useState(false)
  const [ljSlot, setLjSlot] = useState<0 | 1 | 2>(0)
  const [ljDraft, setLjDraft] = useState<LjDraft>({ buttons: {}, sticks: {}, shapes: {}, mouse: {} })
  const [ljLive, setLjLive] = useState<{ lx: number; ly: number; rx: number; ry: number } | null>(null)
  const [pid, setPid] = useState<number | null>(null)
  const [model, setModel] = useState<ControllerModel | null>(null)
  const [slot, setSlot] = useState<number>(() => {
    try {
      const saved = Number(window.localStorage.getItem('sticklabs.slot'))
      if (Number.isInteger(saved) && saved >= 1 && saved <= 4) return saved
    } catch {
      /* fresh — default slot */
    }
    return 3
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('sticklabs.slot', String(slot))
    } catch {
      /* storage full/blocked — slot still works for the session */
    }
  }, [slot])
  const [blob, setBlob] = useState<Uint8Array | null>(null)
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [which, setWhich] = useState(0)
  const [live, setLive] = useState<LiveSample | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadId, setLoadId] = useState(0)
  const [savedAt, setSavedAt] = useState<{ slot: number; at: number } | null>(null)
  const [freshUndo, setFreshUndo] = useState<{ path: string | null; slot: number; model: string; bytes: Uint8Array; dirty: boolean; designs: Array<string | null>; modes: Record<string, boolean> } | null>(null)
  const [calibrationRunning, setCalibrationRunning] = useState(false)
  const [tab, changeTab] = useState<'sticks' | 'curves' | 'device' | 'buttons' | 'profiles' | 'lab' | 'calibrate' | 'language' | 'theme'>('sticks')
  const setTab = (next: typeof tab): void => {
    if (calibrationRunning && next !== 'calibrate') { setErr(t('cal.web.leave')); return }
    changeTab(next)
  }
  const [measuring, setMeasuring] = useState<{ left: number; suggestion: { dev: number; pct10: number } | null } | null>(null)
  const wanderRef = useRef(0)
  const modelLenRef = useRef(PROFILE_LENGTH)
  // The device-event effect below runs once, so its closures go stale — these
  // refs keep the reconnect handler pointed at the live slot + dirty flag.
  const slotRef = useRef(slot)
  slotRef.current = slot
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [showSafety, setShowSafety] = useState(() => {
    try {
      return window.localStorage.getItem('sticklabs.seenSafety') !== '1'
    } catch {
      return true
    }
  })
  // Free-point curve design (2–10 pts). The pad only stores 5, so this is a
  // design canvas — `quantized` is what actually gets written. Persisted per
  // slot+stick so a half-finished shape survives a reload. Spline mode samples
  // a bounded smooth design into the same five firmware slots.
  const [design, setDesign] = useState<Array<{ x: number; y: number }>>([])
  const [splineModes, setSplineModes] = useState<Record<string, boolean>>({})
  const [ljCurveEditors, setLjCurveEditors] = useState<Record<string, CurveEditorDraft>>({})
  const splineKey = `${connPath}.${slot}.${which}`
  const spline = splineModes[splineKey] ?? false
  // Which remap row's icon dropdown is open (row key, or null).
  // Per-stick output lock: locked sticks are forced back to normal stick
  // output on every Write, so Mouse output can never reach the pad again.
  const [outLock, setOutLock] = useState<[boolean, boolean]>(() => {
    try {
      const saved = window.localStorage.getItem('sticklabs.outLock.v1')
      const parsed = JSON.parse(saved ?? 'null')
      if (Array.isArray(parsed)) return [parsed[0] === true, parsed[1] === true]
    } catch {
      /* fresh — unlocked */
    }
    return [false, false]
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('sticklabs.outLock.v1', JSON.stringify(outLock))
    } catch {
      /* storage full/blocked — lock still works for the session */
    }
  }, [outLock])
  // User curve presets for 8K profiles — named designs kept in this browser.
  const [presets, setPresets] = useState<Array<{ name: string; pts: Array<{ x: number; y: number }> }>>(() => {
    try {
      const raw = window.localStorage.getItem('sticklabs.curves.v1')
      if (!raw) return []
      const parsed = JSON.parse(raw) as Array<{ name: string; pts: Array<{ x: number; y: number }> }>
      return Array.isArray(parsed)
        ? parsed
            .filter((p) => typeof p?.name === 'string' && Array.isArray(p?.pts))
            .slice(0, 20)
            .map((p) => ({
              name: p.name.slice(0, 24),
              pts: p.pts
                .filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y))
                .slice(0, 10)
                .map((q) => ({ x: Math.max(0, Math.min(255, Math.round(q.x))), y: Math.max(0, Math.min(255, Math.round(q.y))) })),
            }))
        : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('sticklabs.curves.v1', JSON.stringify(presets))
    } catch {
      /* storage full/blocked — presets stay session-only */
    }
  }, [presets])
  const [lang, setLang] = useLangState()
  const [theme, setTheme] = useThemeState()
  const t = (key: string): string => tr(lang, key)
  const [, force] = useState(0)
  const bump = (): void => {
    setDirty(true)
    force((n) => n + 1)
  }

  useEffect(() => {
    const offSample = api().on('input:sample', (s) => setLive(s as unknown as LiveSample))
    const offStale = api().on('device:stale', () => {
      setMsg('Pad restarted to apply the write — if the sidebar shows disconnected, hit Rescan USB + Connect again.')
    })
    const offReconnecting = api().on('device:reconnecting', () => {
      setMsg('Pad rebooted to apply the change — reconnecting automatically…')
    })
    const offReconnected = api().on('device:reconnected', (incoming) => {
      const info = incoming as unknown as DeviceInfo
      setConnected(true)
      setInfo(info)
      if (dirtyRef.current) {
        // A reboot mid-edit must not silently throw away the working copy:
        // keep it and let the user choose when to re-read the pad.
        setMsg('Reconnected — your unsaved edits were kept. Re-select the slot to reload the pad bytes.')
      } else {
        setMsg('Reconnected — profile reloaded.')
        void loadSlot(slotRef.current)
      }
    })
    return () => {
      offSample()
      offStale()
      offReconnecting()
      offReconnected()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh(): Promise<void> {
    try {
      setCandidates(await api().discover())
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  useEffect(() => {
    void refresh()
    void api().version().then(setAppVersion).catch(() => undefined)
  }, [])

  /** Read one LeadJoy slot (Main/Sub1/Sub2) into the snapshot. */
  async function loadLeadJoySlot(slot: 0 | 1 | 2, force = false): Promise<void> {
    if (!ljPath || ljBusy) return
    if (!force && ljDirty && !window.confirm(t('lj.discard'))) return
    setLjDraft({ buttons: {}, sticks: {}, shapes: {}, mouse: {} })
    setSavedAt(null)
    setLjBusy(true)
    setErr(null)
    try {
      setLjSlot(slot)
      setLjSnap(await api().leadjoyReadSlot({ path: ljPath, slot }))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLjBusy(false)
    }
  }

  /** Stage a remap (gamepad / keyboard / mouse) or stock — committed by Write. */
  function stageLjButton(id: number, target: LjButtonTarget | null): void {
    setLjDraft((prev) => ({ ...prev, buttons: { ...prev.buttons, [id]: target } }))
  }

  /** Stage a stick curve (8 points, 0.1% grid); `null` reverts to the pad. */
  function stageLjStick(side: 0 | 1, points: Array<{ x: number; y: number }> | null): void {
    setLjDraft((prev) => {
      const sticks = { ...prev.sticks }
      if (points) sticks[side] = points
      else delete sticks[side]
      return { ...prev, sticks }
    })
  }

  /** Stage a pad-proven stick gate code (0 rounded-rect, 1 circle). */
  function stageLjShape(side: 0 | 1, code: number): void {
    setLjDraft((prev) => ({ ...prev, shapes: { ...prev.shapes, [side]: code } }))
  }

  /** Stage the pad's mouse mapping — its "controller rate" (enable + rate). */
  function stageLjMouse(side: 0 | 1, next: { enabled: number; rate: number }): void {
    setLjDraft((prev) => ({ ...prev, mouse: { ...prev.mouse, [side]: next } }))
  }

  /**
   * Commit every staged LeadJoy edit: each record is written live and proven
   * with a readback (a mismatch restores the old value and reports). Entries
   * that already match the pad are skipped, so a retry after a partial commit
   * only resends what is missing.
   */
  async function writeLeadJoyDraft(): Promise<void> {
    if (!ljPath || ljBusy || !ljDirty) return
    setLjBusy(true)
    setErr(null)
    setMsg(t('lj.writing'))
    try {
      for (const [key, target] of Object.entries(ljDraft.buttons)) {
        const id = Number(key)
        if (ljSameTarget(target, ljPadTarget(id))) continue
        await api().leadjoyWriteButton({ path: ljPath, slot: ljSlot, id, target })
      }
      // Curve, gate and mouse mapping all live on one stick image, so send a
      // single read-modify-write patch per side.
      const sides = new Set<number>()
      for (const k of Object.keys(ljDraft.sticks)) sides.add(Number(k))
      for (const k of Object.keys(ljDraft.shapes)) sides.add(Number(k))
      for (const k of Object.keys(ljDraft.mouse)) sides.add(Number(k))
      for (const n of sides) {
        const side = n as 0 | 1
        const patch: { cv?: number[]; ci?: number; mm?: number; mse?: number } = {}
        const grid = ljDraft.sticks[side]
        if (grid && JSON.stringify(grid) !== JSON.stringify(ljPadGrid(side))) {
          patch.cv = grid.flatMap((p) => [ljPercentToWire(p.x / 10), ljPercentToWire(p.y / 10)])
        }
        const code = ljDraft.shapes[side]
        if (code !== undefined && code !== ljPadShape(side)) patch.ci = code
        const mouse = ljDraft.mouse[side]
        if (mouse) {
          const pad = ljPadMouse(side)
          if (mouse.enabled !== pad.enabled) patch.mm = mouse.enabled
          if (mouse.rate !== pad.rate) patch.mse = mouse.rate
        }
        if (patch.cv === undefined && patch.ci === undefined && patch.mm === undefined && patch.mse === undefined) continue
        await api().leadjoyWriteStick({ path: ljPath, slot: ljSlot, side, patch })
      }
      setLjSnap(await api().leadjoyReadSlot({ path: ljPath, slot: ljSlot }))
      setSavedAt({ slot: ljSlot + 1, at: Date.now() })
      setMsg(t('msg.saved'))
    } catch (e) {
      setErr((e as Error).message)
      // Some records may have landed before the failure — re-read so the UI
      // shows the pad's real state (staged entries that match drop out of dirty).
      try {
        setLjSnap(await api().leadjoyReadSlot({ path: ljPath, slot: ljSlot }))
      } catch {
        /* handle down — keep the last good snapshot */
      }
    } finally {
      setLjBusy(false)
    }
  }

  async function connect(path: string): Promise<void> {
    setErr(null)
    try {
      const cand = candidates.find((c) => c.path === path)
      const pre = identifyModel(cand?.product, cand?.productId) ?? null
      if (pre && pre.support === 'unsupported') {
        // Known-unsupportable (e.g. DLL-driven pads with no HID listener):
        // don't waste 10 s timing out a handshake that cannot answer.
        setModel(pre)
        setPid(cand?.productId ?? null)
        setMsg(`${pre.marketingName} detected — ${pre.supportNote}`)
        return
      }
      if (pre && (pre.support === 'detect-only' || pre.id === 'SaberPlus')) {
        // No GameSir handshake for detect-only pads: foreign bytes on another
        // vendor's device buy nothing and the timeout only confuses. The LeadJoy
        // Saber Plus / Xeno Pro family uses its own slot reader.
        setModel(pre)
        setPid(cand?.productId ?? null)
        setBlob(null)
        setLjSnap(null)
        setLjDraft({ buttons: {}, sticks: {}, shapes: {}, mouse: {} })
        setLjSlot(0)
        setSavedAt(null)
        const saber = pre.id === 'SaberPlus'
        setLjPath(saber ? path : null)
        setConnected(saber)
        setConnPath(saber ? path : null)
        setMsg(`${pre.marketingName} detected — ${pre.supportNote}`)
        if (saber) {
          setLjBusy(true)
          try {
            setLjSnap(await api().leadjoyReadSlot({ path, slot: 0 }))
            setMsg(null)
          } catch (e) {
            setErr((e as Error).message)
          } finally {
            setLjBusy(false)
          }
        }
        return
      }
      const res = await api().connect(path)
      setConnPath(path)
      setConnected(true)
      setLjPath(null)
      setLjSnap(null)
      setLjSlot(0)
      setInfo(res)
      setPid(cand?.productId ?? null)
      const m = identifyModel(cand?.product, cand?.productId) ?? null
      setModel(m)
      if (m && m.support === 'full') {
        await loadSlot(slot, m.profileLength)
      } else if (m) {
        setBlob(null)
        setMsg(`${m.marketingName} detected — ${m.supportNote}`)
      } else {
        // Unknown PID (new editions like Royal2): prove the family live.
        // Handshake already answered; a 1070-byte read that parses as a
        // CE-family profile unlocks it as an unverified variant. Anything
        // else stays locked — this is what keeps a foreign layout safe.
        setMsg('Unknown edition — proving compatibility (read-only check)…')
        try {
          // Try the running slot first, then every user slot: a single
          // family-shaped read anywhere unlocks the pad.
          const tried = [res.currentProfile, 1, 2, 3, 4].filter((s, i, a) => s >= 1 && s <= 5 && a.indexOf(s) === i)
          let proven: Uint8Array | null = null
          for (const s of tried) {
            try {
              const probe = await api().readProfile(s, PROFILE_LENGTH)
              const bytes = b64ToBytes(probe.bytes)
              if (looksLikeCEProfile(bytes)) {
                proven = bytes
                break
              }
            } catch {
              /* next slot */
            }
          }
          if (proven) {
            const ce = MODELS.find((x) => x.id === 'G7ProCE')
            const variant: ControllerModel = {
              ...(ce ?? {
                id: 'G7ProCE',
                marketingName: 'GameSir G7 Pro 8K',
                vendorId: 0x3537,
                usagePage: 0xfff0,
                usage: 0x40,
                pids: [],
                productHints: [],
                reportRates: REPORT_RATE_OPTIONS.map((o) => ({ gear: o.gear, hz: o.hz, confirmed: o.confirmed })),
                profileLength: 1070,
                dumpLength: 1070,
                support: 'full',
                supportNote: ''
              }),
              supportNote: `Unlisted edition (PID 0x${(cand?.productId ?? 0).toString(16)}) — family proven live by structural check. Report this PID to add it permanently.`
            }
            setModel(variant)
            await loadSlot(slot, variant.profileLength)
          } else {
            setBlob(null)
            setMsg(
              `Unknown model (PID 0x${cand ? cand.productId.toString(16) : '?'}) — its profile does not read as G7-family, so it stays locked. Report the PID and model name to add it.`
            )
          }
        } catch (e) {
          setBlob(null)
          setMsg(
            `Unknown model — compatibility check failed (${(e as Error).message}). Locked as a safety default; report the PID to add it.`
          )
        }
      }
    } catch (e) {
      const raw = (e as Error).message
      setErr(
        raw.includes('timed out waiting for response')
          ? `${raw} — the pad opened but never answered. Use wired USB or the 2.4 GHz dongle (Bluetooth exposes no config channel to any app), update firmware in GameSir Connect first if this is a first connect, then close GameSir Connect (it holds the handle) and retry. If it persists, try another listed interface.`
          : raw
      )
    }
  }

  async function loadSlot(s: number, len = modelLenRef.current): Promise<void> {
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await api().readProfile(s, len)
      setBlob(b64ToBytes(res.bytes))
      setSlot(s)
      setDirty(false)
      setLoadId((n) => n + 1)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function write(): Promise<boolean> {
    if (!blob) return false
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      if (profile && (outLock[0] || outLock[1])) {
        // Output lock: Mouse output can never reach the pad on locked sticks.
        if (stick.lockStickOutput(profile.sticks, outLock)) syncBlob()
      }
      const res = await api().writeProfile(slot, bytesToB64(blob), modelLen)
      if (res.verified) {
        setFreshUndo(null)
        const liveNow = info?.currentProfile
        setSavedAt({ slot, at: Date.now() })
        setDirty(false)
        if (liveNow !== undefined && liveNow !== slot) {
          // One step: apply by switching onto the written slot, then prove
          // it — the pad may reboot instead of acking, so the live slot is
          // read back (across the reboot window) rather than trusting reply.
          let switched = false
          try {
            await api().switchProfile(slot)
            switched = true
          } catch {
            /* reboot likely ate the ack — confirm below instead of failing */
          }
          let applied = switched
          if (!applied) {
            setMsg(`Slot ${slot} written + verified — confirming it took (pad may be rebooting)…`)
          }
          for (let i = 0; i < 8 && !applied; i++) {
            await new Promise((r) => setTimeout(r, 1000))
            try {
              if ((await api().currentProfile()) === slot) applied = true
            } catch {
              /* handle down mid-reboot — retry */
            }
          }
          if (applied) {
            setInfo((prev) => (prev ? { ...prev, currentProfile: slot } : prev))
            setMsg(`Slot ${slot} written, verified and confirmed live on the pad.`)
          } else {
            setMsg(`Slot ${slot} written + verified, but could not confirm it went live — use Activate in Stick profiles below.`)
          }
        } else {
          // Bytes are verified in the slot, but this was the LIVE slot, so
          // the pad reboots to apply — confirm it comes back on this slot
          // rather than assuming the reboot went fine.
          let back = false
          for (let i = 0; i < 8 && !back; i++) {
            await new Promise((r) => setTimeout(r, 1000))
            try {
              if ((await api().currentProfile()) === slot) back = true
            } catch {
              /* handle down mid-reboot — retry */
            }
          }
          if (back) {
            setInfo((prev) => (prev ? { ...prev, currentProfile: slot } : prev))
            setMsg(`Slot ${slot} written, verified and live after reboot.`)
          } else {
            setMsg(`Slot ${slot} written + verified, but the pad has not reconnected yet — confirm the live slot above before continuing.`)
          }
        }
        return true
      } else if (res.rolledBack) {
        setErr('Write did not verify — previous bytes restored.')
        await loadSlot(slot)
      }
      return false
    } catch (e) {
      setErr((e as Error).message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const profile = blob ? parseProfile(blob, model?.id ?? 'G7ProCE') : null
  // Mutations go straight into `blob` via Packet views; re-serialize keeps
  // the working copy canonical so write() sends exactly what the UI shows.
  const syncBlob = (): void => {
    if (profile && blob) {
      const out = serializeProfile(profile)
      blob.set(out)
    }
  }
  const edit = (fn: () => void): void => {
    fn()
    syncBlob()
    bump()
  }

  const pkt = profile?.sticks[which] ?? null
  const fd = profile?.funData ?? null
  const dz = pkt ? stick.deadzone(pkt) : null
  const outerBuffer = dz ? outerBufferFromBytes(dz.end, dz.endAnti) : 0
  const outerUnlimited = dz ? isOuterUnlimited(dz.end, dz.endAnti) : true
  const pts = pkt ? stick.curve(pkt) : []
  const resBits = fd ? fun.extend.stickResolutionBits(fd) : 12
  const gear = fd ? fun.extend.reportRateGear(fd) : 5
  const rates = model && model.reportRates.length > 0 ? model.reportRates : REPORT_RATE_OPTIONS
  // One row for every gear: model gears first (their proof state wins),
  // then any missing standard gears, always flagged unconfirmed here.
  const allRates = [...rates, ...REPORT_RATE_OPTIONS.filter((o) => !rates.some((r) => r.gear === o.gear)).map((o) => ({ ...o, confirmed: false }))].sort((a, b) => a.hz - b.hz)
  const gearHz = rates.find((o) => o.gear === gear)?.hz ?? 0
  const resWire = fd ? fun.extend.stickResolution(fd) : 0
  const resInfo = describeRawResolution(fd ? fun.extend.stickResolution(fd) : 0)

  // --- LeadJoy derived state: same UI, different wire ----------------------
  const isLj = !!ljPath && model?.id === 'SaberPlus'
  const detectedLeadjoyName = isLj ? identifyLeadJoyName(ljSnap?.version, ljSnap?.board) : null
  const modelName = detectedLeadjoyName ?? model?.marketingName
  useEffect(() => {
    if (!ljPath || !ljSnap) return
    const name = identifyLeadJoyName(ljSnap.version, ljSnap.board)
    setLeadjoyDetectedNames(previous => {
      if (previous[ljPath] === (name ?? undefined)) return previous
      const next = { ...previous }
      if (name) next[ljPath] = name
      else delete next[ljPath]
      return next
    })
  }, [ljPath, ljSnap?.version, ljSnap?.board])
  const ljPadGrid = (side: 0 | 1): Array<{ x: number; y: number }> =>
    (ljSnap?.sticks.find((s) => s.side === side)?.curvePct ?? []).map(([x, y]) => ({ x: Math.round(x * 10), y: Math.round(y * 10) }))
  const ljPadZones: LjTriggerZones | null = ljSnap
    ? {
        leftInner: ljSnap.trigger.left.inner,
        leftOuter: ljSnap.trigger.left.outer,
        rightInner: ljSnap.trigger.right.inner,
        rightOuter: ljSnap.trigger.right.outer
      }
    : null
  const ljPadTarget = (id: number): LjButtonTarget | null => {
    const m = ljSnap?.buttons.find((x) => x.id === id)?.map
    return m && m.t !== 0 ? m : null
  }
  const ljStickPoints = (side: 0 | 1): Array<{ x: number; y: number }> => ljDraft.sticks[side] ?? ljPadGrid(side)
  const ljPadShape = (side: 0 | 1): number => ljSnap?.sticks.find((s) => s.side === side)?.shape ?? LJ_SHAPES.Circle
  const ljPadMouse = (side: 0 | 1): { enabled: number; rate: number } => {
    const s = ljSnap?.sticks.find((x) => x.side === side)
    return { enabled: s?.mouse.enabled ? 1 : 0, rate: s?.mouse.rate ?? 50 }
  }
  const ljMouse = (side: 0 | 1): { enabled: number; rate: number } => ljDraft.mouse[side] ?? ljPadMouse(side)
  const ljZones = ljPadZones
  const ljDirty =
    isLj &&
    (Object.entries(ljDraft.buttons).some(([id, v]) => !ljSameTarget(v, ljPadTarget(Number(id)))) ||
      ([0, 1] as const).some((s) => ljDraft.sticks[s] !== undefined && JSON.stringify(ljDraft.sticks[s]) !== JSON.stringify(ljPadGrid(s))) ||
      Object.entries(ljDraft.shapes).some(([side, code]) => code !== ljPadShape(Number(side) as 0 | 1)) ||
      Object.entries(ljDraft.mouse).some(([side, m]) => {
        const pad = ljPadMouse(Number(side) as 0 | 1)
        return m.enabled !== pad.enabled || m.rate !== pad.rate
      }))

  // Live sticks for the Saber Plus come from the system Gamepad API: its own
  // HID node hands raw readers nothing (stub/needs a vendor command), but
  // Windows exposes it as a standard gamepad, so the cross moves with no
  // capture, no admin and no extra driver. Axis order is the standard
  // left-X/Y, right-X/Y, and 0..255 matches the GameSir cross convention
  // (up = smaller Y).
  useEffect(() => {
    if (!isLj) {
      setLjLive(null)
      return
    }
    const to255 = (v: number): number => Math.max(0, Math.min(255, Math.round((v + 1) * 127.5)))
    let raf = 0
    const poll = (): void => {
      const pads = Array.from(navigator.getGamepads()).filter((p): p is Gamepad => !!p && p.connected)
      const pad = pads.find((p) => /controller|gamepad|360|xbox|saber|leadjoy/i.test(p.id)) ?? pads[0] ?? null
      if (pad) {
        const a = pad.axes
        setLjLive({ lx: to255(a[0] ?? 0), ly: to255(a[1] ?? 0), rx: to255(a[2] ?? 0), ry: to255(a[3] ?? 0) })
      } else {
        setLjLive(null)
      }
      raf = requestAnimationFrame(poll)
    }
    raf = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf)
  }, [isLj])

  // Center guard: while measuring, track the worst rest deviation of the
  // current stick; the countdown then proposes a Start % that covers it.
  useEffect(() => {
    if (!measuring || measuring.suggestion || !live) return
    const axes = which === 0 ? [live.lx, live.ly] : [live.rx, live.ry]
    const dev = Math.max(...axes.map((v) => Math.abs(v - 128)))
    if (dev > wanderRef.current) wanderRef.current = dev
  }, [live, measuring, which])

  useEffect(() => {
    if (!measuring || measuring.suggestion) return
    if (measuring.left <= 0) {
      const dev = Math.round(wanderRef.current)
      const pct10 = Math.min(200, Math.ceil((dev / 128) * 1000) + 5)
      setMeasuring({ left: 0, suggestion: { dev, pct10 } })
      return
    }
    const t = window.setTimeout(() => {
      setMeasuring((m) => (m && !m.suggestion ? { ...m, left: m.left - 1 } : m))
    }, 1000)
    return () => window.clearTimeout(t)
  }, [measuring])

  const designKey = `sticklab.design.${slot}.${which}`  // (Re)load the design canvas whenever the slot, stick, or profile bytes
  // change: prefer a saved design, else start from the pad's 5 points.
  useEffect(() => {
    if (!pkt) return
    setMeasuring(null)
    try {
      const saved = window.localStorage.getItem(designKey)
      if (saved) {
        const parsed = JSON.parse(saved) as Array<{ x: number; y: number }>
        if (Array.isArray(parsed) && parsed.length >= DESIGN_MIN_POINTS && parsed.length <= DESIGN_MAX_POINTS) {
          setDesign(parsed.map((p) => ({ x: Math.max(0, Math.min(255, Math.round(p.x))), y: Math.max(0, Math.min(255, Math.round(p.y))) })))
          return
        }
      }
    } catch {
      /* fall through to pad curve */
    }
    setDesign(stick.curve(pkt).map((p) => ({ ...p })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadId, slot, which, designKey])

  useEffect(() => {
    if (design.length === 0) return
    try {
      window.localStorage.setItem(designKey, JSON.stringify(design))
    } catch {
      /* storage full/blocked — design still works for the session */
    }
  }, [design, designKey])

  const quantized = design.length >= 2 ? sampleDesign(design, spline) : pts
  const locked = connected && (!model || model.support !== 'full')
  const modelId = model?.id ?? 'G7ProCE'
  const modelLen = model && model.profileLength > 0 ? model.profileLength : PROFILE_LENGTH
  modelLenRef.current = modelLen
  const padCurve = pts

  /** Canvas only: rebuild the design points from the working copy (no pad traffic). */
  function syncDesignFromCopy(): void {
    if (pkt) setDesign(stick.curve(pkt).map((p) => ({ ...p })))
  }

  /**
   * Curve card's "Reload from pad": actually reads the pad. Restores THIS
   * stick's curve + transform bytes (11–23) in the working copy, so any other
   * staged edits survive; `dirty` is then recomputed from a real byte compare
   * against the bytes just read rather than assumed.
   */
  async function reloadCurveFromPad(): Promise<void> {
    if (!blob || !pkt) return
    setBusy(true)
    setErr(null)
    try {
      const res = await api().readProfile(slot, modelLen)
      const padBytes = b64ToBytes(res.bytes)
      const padStick = parseProfile(padBytes, modelId).sticks[which]
      if (!padStick) return
      edit(() => {
        for (let i = 11; i <= 23; i++) pkt.bytes[i] = padStick.bytes[i]
      })
      syncDesignFromCopy()
      let same = blob.length === padBytes.length
      if (same) {
        for (let i = 0; i < blob.length; i++) {
          if (blob[i] !== padBytes[i]) {
            same = false
            break
          }
        }
      }
      setDirty(!same)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Curve edits apply immediately, like every other control: the design
   * canvas updates AND the sampled slots are written into the working copy
   * (marked dirty — the top Write button commits to the pad). No-op when
   * the sampled design already equals the working copy, so loading and
   * no-change touches never dirty the profile.
   */
  function stageDesign(next: Array<{ x: number; y: number }>, smooth = spline): void {
    setDesign(next)
    if (!pkt || next.length < 2) return
    const q = sampleDesign(next, smooth)
    if (stick.matchesCurveIdentity(pkt, q)) return
    edit(() => {
      stick.setCurve(pkt, q.map((p) => ({ ...p })))
      stick.markCurveIdentity(pkt)
    })
  }

  function stageCleanProfile(): void {
    if (!blob || !connected || busy || locked || calibrationRunning || !['G7ProCE', 'T3CE'].includes(modelId)) return
    try {
      const backup = blob.slice()
      const clean = buildCleanProfile(backup, modelId)
      const designs = [0, 1].map(side => { try { return localStorage.getItem(`sticklab.design.${slot}.${side}`) } catch { return null } })
      setFreshUndo({ path: connPath, slot, model: modelId, bytes: backup, dirty, designs, modes: { ...splineModes } })
      for (const side of [0, 1]) { try { localStorage.removeItem(`sticklab.design.${slot}.${side}`) } catch { /* session still resets */ } }
      setSplineModes(prev => ({ ...prev, [`${connPath}.${slot}.0`]: false, [`${connPath}.${slot}.1`]: false }))
      setBlob(clean)
      setDirty(true)
      setLoadId(n => n + 1)
      setMsg(t('clean.staged'))
      setErr(null)
    } catch (e) { setErr((e as Error).message) }
  }
  function undoCleanProfile(): void {
    if (!freshUndo || freshUndo.path !== connPath || freshUndo.slot !== slot || freshUndo.model !== modelId || busy || calibrationRunning) return
    freshUndo.designs.forEach((value, side) => { try { const key = `sticklab.design.${slot}.${side}`; if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value) } catch { /* restore bytes even without storage */ } })
    setSplineModes(freshUndo.modes)
    setBlob(freshUndo.bytes.slice())
    setDirty(freshUndo.dirty)
    setLoadId(n => n + 1)
    setFreshUndo(null)
    setMsg(t('clean.undone'))
  }

  function saveCurrentCurvePreset(): void {
    const name = nextCustomPresetName(presets.map((p) => p.name), t('sticks.customCurveName'))
    setPresets((prev) => [{ name, pts: design.map((p) => ({ ...p })) }, ...prev].slice(0, 20))
    setMsg(t('sticks.curveSavedNotice').replace('{name}', name))
  }

  function renameCurvePreset(oldName: string, name: string): boolean {
    if (presets.some((p) => p.name === name && p.name !== oldName)) return false
    setPresets((prev) => prev.map((p) => p.name === oldName ? { ...p, name } : p))
    return true
  }

  return (
    <LangContext.Provider value={{ lang, setLang }}>
    <ThemeContext.Provider value={{ theme, setTheme }}>
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-copy">
            <h1>Stick <span>Labs</span></h1>
          </div>
        </div>
        <nav className="nav">
          <div className="nav-group">
            <h4>{t('nav.tuning')}</h4>
            <button type="button" className={`nav-item${tab === 'sticks' ? ' active' : ''}`} onClick={() => setTab('sticks')}>
              <StickSideIcon side="left" size={17} />
              {t('nav.sticks')}
            </button>
            <button type="button" className={`nav-item${tab === 'curves' ? ' active' : ''}`} onClick={() => setTab('curves')}>
              <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3v14h14"/><path d="M5 14c7 0 3-9 10-9"/></svg>
              {t('nav.curves')}
            </button>
            <button type="button" className={`nav-item${tab === 'device' ? ' active' : ''}`} onClick={() => setTab('device')}>
              <DeviceIcon kind="rate" size={17} />
              {t('nav.device')}
            </button>
            <button type="button" className={`nav-item${tab === 'buttons' ? ' active' : ''}`} onClick={() => setTab('buttons')}>
              <KeyIcon value={9} size={17} />
              {t('nav.buttons')}
            </button>
          </div>
          <details className="nav-more" open={['calibrate', 'profiles', 'lab', 'language', 'theme'].includes(tab)}>
            <summary>{t('nav.moreTools')}</summary>
            <div className="nav-group">
              <h4>{t('nav.tuning')}</h4>
              <button type="button" className={`nav-item${tab === 'calibrate' ? ' active' : ''}`} onClick={() => setTab('calibrate')}>
                {t('nav.calibrate')}
              </button>
            </div>
            <div className="nav-group">
              <h4>{t('nav.data')}</h4>
            <button type="button" className={`nav-item${tab === 'profiles' ? ' active' : ''}`} onClick={() => setTab('profiles')}>
              {t('nav.profiles')}
            </button>
            <button type="button" className={`nav-item${tab === 'lab' ? ' active' : ''}`} onClick={() => setTab('lab')}>
              {t('nav.lab')}
            </button>
            </div>
            <div className="nav-group">
              <h4>{t('nav.app')}</h4>
            <button type="button" className={`nav-item${tab === 'language' ? ' active' : ''}`} onClick={() => setTab('language')}>
              {t('nav.language')}
            </button>
            <button type="button" className={`nav-item${tab === 'theme' ? ' active' : ''}`} onClick={() => setTab('theme')}>
              {t('nav.theme')}
            </button>
            </div>
          </details>
        </nav>
        <div className="stack" style={{ gap: 10 }}>
          <button className="btn ghost sm" onClick={() => void refresh()}>{t('side.rescan')}</button>
          <button
            className="btn ghost sm"
            title={t('side.copyTitle')}
            onClick={() => {
              const lines = [
                `Stick Labs v${appVersion ?? '?'} ${new Date().toISOString()}`,
                `connected=${connected} model=${model?.id ?? 'none'} pid=${pid !== null ? '0x' + pid.toString(16) : 'none'} fw=${info?.firmware ?? 'none'}`,
                ...candidates.map(
                  (c) => `cand pid=0x${c.productId.toString(16)} live=${c.live} preferred=${c.preferred} product=${c.product ?? '?'}`
                )
              ]
              const text = lines.join('\n')
              try {
                void navigator.clipboard.writeText(text).then(
                  () => setMsg('Diagnostics copied — paste it to RealKiyoshi.'),
                  () => setMsg(text)
                )
              } catch {
                setMsg(text)
              }
            }}
          >
            {t('side.copy')}
          </button>
          {primaryCandidates.map((c) => <CandidateButton key={c.path} candidate={c} displayName={leadjoyDetectedNames[c.path]} onConnect={(path) => void connect(path)} />)}
          {otherCandidates.length > 0 && (
            <details className="candidate-more">
              <summary>{t('side.otherControllers')} <span className="pill">{otherCandidates.length}</span></summary>
              <div className="stack">
                {otherCandidates.map((c) => <CandidateButton key={c.path} candidate={c} displayName={leadjoyDetectedNames[c.path]} onConnect={(path) => void connect(path)} />)}
              </div>
            </details>
          )}
          {connected && (
            <button
              className="btn ghost sm"
              onClick={() => {
                void api().disconnect()
                setConnPath(null)
                setConnected(false)
                setInfo(null)
                setPid(null)
                setModel(null)
                setBlob(null)
                setLjPath(null)
                setLjSnap(null)
                setLjSlot(0)
                setDirty(false)
              }}
            >
              {t('side.disconnect')}
            </button>
          )}
          {info && (
            <div className="note">
              <>{t('msg.fw')} {info.firmware} · {t('msg.liveSlot')} P{info.currentProfile}<br />{model ? model.marketingName : t('msg.unknownModel')}</>
            </div>
          )}
          {isLj && ljSnap && (
            <div className="note">
              <>{modelName}<br />{t('lj.version')} {ljSnap.version} · {t('lj.board')} {ljSnap.board}</>
            </div>
          )}
          {pid === 0x0575 && (
            <div className="note bad">
              {t('msg.receiver')}
            </div>
          )}
        </div>
        <div className="status-bar">
          <div className="status-row">
            <span className={`dot ${connected ? 'good' : 'bad'}`} />
            {connected ? t('side.connected') : t('side.disconnected')}
            {appVersion && <span style={{ color: 'var(--text-3)' }}>v{appVersion}</span>}
          </div>
          <div className="status-row" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t('side.by')}</span>
          </div>
          <UpdateRow />
          <div className="creator-links">
            <button
              type="button"
              className="creator-link creator-youtube"
              title="YouTube @realkiyoshi"
              aria-label="YouTube @realkiyoshi"
              onClick={() => void api().openExternal('https://www.youtube.com/@realkiyoshi').catch(() => undefined)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23 7.1a3 3 0 0 0-2.1-2.2C19 4.4 12 4.4 12 4.4s-7 0-8.9.5A3 3 0 0 0 1 7.1a31 31 0 0 0-.5 4.9 31 31 0 0 0 .5 4.9 3 3 0 0 0 2.1 2.2c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.2 31 31 0 0 0 .5-4.9 31 31 0 0 0-.5-4.9Z"/><path fill="var(--bg-1)" d="m9.7 15.5 6-3.5-6-3.5Z"/></svg>
              <span>YouTube</span>
            </button>
            <button
              type="button"
              className="creator-link creator-x"
              title="X @realkiyoshii"
              aria-label="X @realkiyoshii"
              onClick={() => void api().openExternal('https://x.com/realkiyoshii').catch(() => undefined)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.3l7.9-9L.8 2h6.5l4.5 6.7L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg>
            </button>
            <button
              type="button"
              className="creator-link creator-coffee"
              title="Support me on Buy Me a Coffee"
              aria-label="Support RealKiyoshi on Buy Me a Coffee"
              onClick={() => void api().openExternal('https://buymeacoffee.com/RealKiyoshi').catch(() => undefined)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 8h12v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8Zm12 1h1a3 3 0 1 1 0 6h-1M8 3v2m4-2v2m4-2v2M3 22h17"/></svg>
              <span>{t('side.support')}</span>
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="row" style={{ gap: 12 }}>
            <h2>Stick Labs</h2>
            <span className="sub">{t('topbar.sub')}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {connected && (isLj
              ? (['Main', 'Sub1', 'Sub2'] as const).map((name, i) => (
                  <button
                    key={name}
                    className={`choice-btn${i === ljSlot ? ' active' : ''}`}
                    disabled={ljBusy}
                    onClick={() => void loadLeadJoySlot(i as 0 | 1 | 2)}
                  >
                    <span className="choice-label">{name}</span>
                  </button>
                ))
              : [1, 2, 3, 4].map((s) => (
                  <button
                    key={s}
                    className={`choice-btn${s === slot ? ' active' : ''}`}
                    disabled={!connected || busy || locked || calibrationRunning}
                    onClick={() => void loadSlot(s)}
                  >
                    <span className="choice-label">P{s}</span>
                  </button>
                )))}
            {connected && <button
              className="btn sm primary"
              disabled={isLj ? ljBusy || !ljDirty : !connected || !dirty || busy || locked || calibrationRunning}
              onClick={() => void (isLj ? writeLeadJoyDraft() : write())}
            >
              {(isLj ? ljBusy : busy) ? t('common.working') : t('top.write')}
            </button>}
            {(isLj ? ljDirty : dirty) && <span className="pill warn">{t('msg.unsaved')}</span>}
            {!(isLj ? ljDirty : dirty) && savedAt && savedAt.slot === (isLj ? ljSlot + 1 : slot) && (
              <span className="pill good" title={t('msg.verifiedTitle')}>
                {t('msg.saved')} {new Date(savedAt.at).toLocaleTimeString()}
              </span>
            )}
          </div>
        </header>
        <div className="content">
          <div className="content-frame">
          {showSafety && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
              <h3>{t('safety.title')}</h3>
              <div className="stack" style={{ gap: 6, fontSize: 13 }}>
                <span>1. <strong>{t('safety.backup')}</strong> — Stick profiles card → Backup all → JSON. You can always restore.</span>
                <span>2. <strong>{t('safety.closeApp')}</strong> — it holds the controller and blocks this app.</span>
                <span>3. <strong>{t('safety.wired')}</strong> — Bluetooth pads don't appear here, ever.</span>
                <span>4. <strong>{t('safety.reboot')}</strong> for ~2 seconds. Normal — it reconnects by itself.</span>
                <span>5. <strong>{t('safety.tournaments')}</strong> — check your event's rules before competing on a tuned profile.</span>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="btn sm primary"
                  onClick={() => {
                    try {
                      window.localStorage.setItem('sticklabs.seenSafety', '1')
                    } catch {
                      /* ignore */
                    }
                    setShowSafety(false)
                  }}
                >
                  {t('common.gotIt')}
                </button>
              </div>
            </div>
          )}
          {err && <div className="note bad">{err}</div>}
          {msg && <div className="note">{msg}</div>}
          {(isLj ? ljDirty : dirty) && <div className="note warn">{t('msg.dirty')}</div>}
          {!connected && (
            <div className="msg"><h3>{t('msg.connect')}</h3><p>{t('msg.models')} {t('msg.connectBody')}</p></div>
          )}
          {isLj && (
            <>
              <div className="row stick-selector" style={{ gap: 8, marginBottom: 12 }}>
                {(['Left', 'Right'] as const).map((n, i) => (
                  <button key={n} className={`choice-btn${i === which ? ' active' : ''}`} onClick={() => setWhich(i)}>
                    <span className="row stick-choice-label"><StickSideIcon side={n.toLowerCase() as 'left' | 'right'} /><KeyIcon value={i === 0 ? 7 : 8} size={16} /><span className="stick-click-badge">{i === 0 ? 'L3' : 'R3'}</span><span>{(n === 'Left' ? t('cal.left') : t('cal.right'))} {t('sticks.stick')}</span></span>
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="pill">{modelName} · {(['Main', 'Sub1', 'Sub2'] as const)[ljSlot]}</span>
              </div>
              {!ljSnap && <div className="msg"><h3>{ljBusy ? t('lj.reading') : t('msg.loading')}</h3></div>}
              {ljSnap && (tab === 'sticks' || tab === 'curves') && (() => {
                const side = (which === 0 ? 0 : 1) as 0 | 1
                const other = (side === 0 ? 1 : 0) as 0 | 1
                const pts = ljStickPoints(side)
                return tab === 'curves' ? <div className="curves-workspace"><div className="tuning-page-heading"><h2>{t('nav.curves')}</h2><p>{t('sticks.curvesHelp')}</p></div><LjCurveCard
                        editor={ljCurveEditors[`${connPath}.${ljSlot}.${side}`]}
                        onEditorChange={draft => setLjCurveEditors(prev => ({ ...prev, [`${connPath}.${ljSlot}.${side}`]: draft }))}
                        snap={ljSnap}
                        side={side}
                        points={pts}
                        onChange={(next) => stageLjStick(side, next)}
                        onReset={() => stageLjStick(side, null)}
                        onCopyToOther={() => stageLjStick(other, pts.map((p) => ({ ...p })))}
                      /></div> : <>
                  <div className="tuning-page-heading"><h2>{t('sticks.cleanTitle')}</h2><p>{t('sticks.cleanHelp')}</p></div>
                  <div className="stick-clean-workspace"><div className="stack stick-clean-monitor"><LjLiveCard
                  live={ljLive}
                  windows={([0, 1] as const).map((s) => {
                    const z = ljCurveZones(toPairs(ljDraft.sticks[s] ?? ljPadGrid(s)))
                    return { begin: z.start, end: z.end, beginAnti: z.antiStart }
                  })}
                /><LjOuterCard points={pts} onChange={(next) => stageLjStick(side, next)} /><LjShapeCard shape={ljDraft.shapes[side] ?? ljPadShape(side)} busy={ljBusy} onChange={(code) => stageLjShape(side, code)} /></div><div className="stack stick-clean-controls"><LjZonesCard points={pts} onChange={(next) => stageLjStick(side, next)} /></div></div>
                </>
              })()}
              {ljSnap && tab === 'device' && (
                <div className="stack" style={{ gap: 16 }}>
                  <LjControllerRateCard
                    value={ljMouse(which === 0 ? 0 : 1)}
                    busy={ljBusy}
                    onChange={(next) => stageLjMouse(which === 0 ? 0 : 1, next)}
                  />
                </div>
              )}
              {ljSnap && tab === 'buttons' && (
                <div className="buttons-workspace lj-buttons-workspace">
                  {ljZones && <LjTriggerCard value={ljZones} />}
                  {(() => {
                          const ljOptions = [
                            { value: 0, label: t('buttons.unmapped') },
                            ...ljSnap.buttons.map((b) => ({ value: b.id, label: b.label })),
                            ...LJ_HID_KEYS.map((k) => ({ value: LJ_TARGET_KEY_BASE + k.code, label: k.label })),
                            ...LJ_MOUSE_BUTTONS.map((k) => ({ value: LJ_TARGET_MOUSE_BASE + k.code, label: k.label }))
                          ]
                          const ljLabel = (v: number): string => ljTargetLabel(ljDecodeTarget(v)) ?? t('buttons.unmapped')
                          // Give every target kind a visible icon in the picker.
                          const ljIcon = (v: number): JSX.Element | null => {
                            const target = ljDecodeTarget(v)
                            if (target.t === LJ_MAP_KEYBOARD) return <MappingTypeIcon type="keyboard" />
                            if (target.t === LJ_MAP_MOUSE) return <MappingTypeIcon type="mouse" />
                            return v > 0 ? <LjKeyIcon id={v} /> : <LjKeyIcon id={0} />
                          }
                          const rows = [
                            ...[24, 25, 26, 27].map((id) => ({ id, phys: LJ_PHYSICAL[id] ?? '' })),
                            ...ljSnap.buttons.filter((b) => b.id !== 24 && b.id !== 25 && b.id !== 26 && b.id !== 27).map((b) => ({ id: b.id, phys: '' }))
                          ]

                    return <RemapWorkspace captureFamily="leadjoy" disabled={ljBusy} help={t('lj.bindHint')} options={ljOptions} getLabel={ljLabel} renderIcon={ljIcon} rows={rows.map(row => {
                            const snap = ljSnap.buttons.find((b) => b.id === row.id)
                            const staged = ljDraft.buttons[row.id]
                            const padMap = snap?.map && snap.map.t !== 0 ? snap.map : null
                            const current = staged !== undefined ? staged : padMap
                            // An uncaptured kind (e.g. Macro) stays read-only text.
                            const known = current === null || [LJ_MAP_GAMEPAD, LJ_MAP_KEYBOARD, LJ_MAP_MOUSE].includes(current.t)
                            const label = current ? (ljTargetLabel(current) ?? t('buttons.unmapped')) : t('buttons.unmapped')
                            const sourceName = row.phys ? `${row.phys} · ${snap?.label ?? ''}` : (snap?.label ?? `ID ${row.id}`)

                      return { id: String(row.id), name: sourceName, icon: <LjKeyIcon id={row.id} size={27} />, current: current ? ljEncodeTarget(current) : 0, effective: label, outputIcon: current ? ljIcon(ljEncodeTarget(current)) : null, extra: [24, 25, 26, 27].includes(row.id), known, onPick: (v: number) => stageLjButton(row.id, v === 0 ? null : ljDecodeTarget(v)) }
                    })} />
                  })()}
                </div>
              )}
            </>
          )}
          {connected && !profile && !isLj && (
            !model || model.support !== 'full' ? (
              <div className="msg">
                <h3>{model ? `${model.marketingName} — ${t('msg.locked')}` : `${t('msg.unknownModel')} — ${t('msg.locked')}`}</h3>
                <p>{model ? model.supportNote : 'This USB ID is not in the verified model table, so profile access stays off as a safety default.'}</p>
                <p>Live input below still works. Profile reads/writes stay disabled until the layout is verified on hardware.</p>
              </div>
            ) : (
              <div className="msg"><h3>{t('msg.loading')}</h3></div>
            )
          )}
          {connected && profile && pkt && dz && fd && (
            <>
              <div className="row stick-selector" style={{ gap: 8, marginBottom: 12 }}>
                {(['Left', 'Right'] as const).map((n, i) => (
                  <button key={n} className={`choice-btn${i === which ? ' active' : ''}`} onClick={() => setWhich(i)}>
                    <span className="row stick-choice-label"><StickSideIcon side={n.toLowerCase() as 'left' | 'right'} /><KeyIcon value={i === 0 ? 7 : 8} size={16} /><span className="stick-click-badge">{i === 0 ? 'L3' : 'R3'}</span><span>{(n === 'Left' ? t('cal.left') : t('cal.right'))} {t('sticks.stick')}</span></span>
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="pill">{resBits}-bit · {bitsToLevels(resBits).toLocaleString()} {t('device.levels')}</span>
              </div>
              {tab === 'sticks' && <>
                <div className="tuning-page-heading"><h2>{t('sticks.cleanTitle')}</h2><p>{t('sticks.cleanHelp')}</p></div>
                <div className="stick-clean-workspace">
                  <div className="stack stick-clean-monitor"><div className="card stick-live-card">
                    <h3>{t('sticks.live')}</h3>
                    <Hint>{t('sticks.liveNote')} {t('sticks.liveHint')}</Hint>
                    <div className="stick-live-visual"><StickCross
                      lx={live?.lx ?? 128}
                      ly={live?.ly ?? 128}
                      rx={live?.rx ?? 128}
                      ry={live?.ry ?? 128}
                      windows={[stick.deadzone(profile.sticks[0]), stick.deadzone(profile.sticks[1])]}
                    /></div>
                    <div className="stick-readouts">
                      <div className={`stick-readout${which === 0 ? ' selected' : ''}`}><span>{t('cal.left')}</span><strong>{live?.lx ?? '—'}<i>,</i>{live?.ly ?? '—'}</strong></div>
                      <div className={`stick-readout${which === 1 ? ' selected' : ''}`}><span>{t('cal.right')}</span><strong>{live?.rx ?? '—'}<i>,</i>{live?.ry ?? '—'}</strong></div>
                    </div>
                  </div><section className="card stick-visible-section">
                    <div className="stick-extra-body">
                    <h3>{t('sticks.outer')} — {outerUnlimited ? t('sticks.noLimitTitle') : t('sticks.custom')}</h3>
                    <Hint>{t('sticks.outerHint')}</Hint>
                    <div className="row spread" style={{ margin: '10px 0' }}>
                      <div>
                        <div style={{ fontSize: 13.5 }}>{t('sticks.noLimitTitle')}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                          {outerUnlimited ? t('sticks.outerActive') : t('sticks.outerOff')}
                        </div>
                      </div>
                      <button
                        className={`choice-btn${outerUnlimited ? ' active' : ''}`}
                        onClick={() => {
                          if (outerUnlimited) {
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 900, endAnti: 1000 }))
                          } else {
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 1000, endAnti: 1000 }))
                          }
                        }}
                      >
                        <span className="choice-label">{outerUnlimited ? t('sticks.infiniteOn') : t('sticks.setInfinite')}</span>
                      </button>
                    </div>
                    <Hint>
                      <strong>{t('sticks.outerWhatTitle')}</strong> {t('sticks.outerWhat')}
                      <br /><br />
                      <strong>{t('sticks.outerSteamTitle')}</strong> {t('sticks.outerSteam')}
                    </Hint>
                    {!outerUnlimited && (
                      <div className="note warn" style={{ marginTop: 8 }}>
                        This stick currently carries a custom boundary: <span className="mono">{outerBuffer >= 0 ? `max at ${(100 - outerBuffer).toFixed(0)}% deflection` : `output tops at ${(100 + outerBuffer).toFixed(0)}%`}</span>.
                        Tap <strong>Set ∞</strong> to clear it back to the full range.
                      </div>
                    )}
                    </div>
                  </section><section className="card stick-visible-section">
                    <div className="stick-extra-body">
                    <h3>{t('sticks.shape')}</h3>
                    <Hint>{t('sticks.shapeHint')}</Hint>
                    <div className="stack" style={{ gap: 8 }}>
                      {(
                        [
                          { key: 'round', hintKey: 'sticks.shapeHintRound' },
                          { key: 'square', hintKey: 'sticks.shapeHintRaw' }
                        ] as const
                      ).map((s) => {
                        const active = stick.enabled(pkt) && stick.squareGate(pkt) === (s.key === 'square')
                        const label = s.key === 'round' ? t('sticks.shapeRound') : t('sticks.shapeRaw')
                        return (
                          <button
                            key={s.key}
                            className={`choice-btn${active ? ' active' : ''}`}
                            title={t(s.hintKey)}
                            onClick={() => {
                              edit(() => {
                                stick.setEnabled(pkt, true)
                                stick.setSquareGate(pkt, s.key === 'square')
                              })
                            }}
                          >
                            <span className="choice-label">{label}</span>
                          </button>
                        )
                      })}
                    </div>
                    {stick.isProfileBypassed(pkt) && (
                      <div className="note" style={{ marginTop: 8 }}>{t('sticks.shapeBypass')}</div>
                    )}
                    </div>
                  </section></div>
                  <div className="stack stick-clean-controls"><div className="card stick-primary-card">
                    <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.inputLabel')}</span><h3>{t('sticks.inputTitle')}</h3></div><span className="pill">0.1%</span></div>
                    <p className="stick-intro">{t('sticks.inputHelp')}</p>
                    <div className="stick-primary-sliders">
                      <Slider label={t('sticks.innerLabel')} value={dz.begin / 10} min={0} max={20} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t('sticks.outerLabel')} value={dz.end / 10} min={10} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                    </div>

                  </div><div className="card stick-output-card"><div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('sticks.outputLabel')}</span><h3>{t('sticks.outputTitle')}</h3></div></div><p className="stick-intro">{t('sticks.outputHelp')}</p>                    <div className="stack" style={{ gap: 12, marginTop: 8 }}>
                      <Slider label={t('sticks.floorLabel')} value={dz.beginAnti / 10} min={0} max={50} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t('sticks.ceilingLabel')} value={dz.endAnti / 10} min={50} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), endAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                    </div>
</div></div>
                </div>
              </>}
              {tab === 'curves' && <div className="curves-workspace">
                <div className="tuning-page-heading"><h2>{t('nav.curves')}</h2><p>{t('sticks.curvesHelp')}</p></div>
<div className="card stick-curve-card">
                    <h3>{t('sticks.curve')} — {design.length} {t('sticks.points')}</h3>
                    <Hint>{t('sticks.curveHint')}</Hint>
                    <SplineControl enabled={spline} slots={5} onChange={enabled => { setSplineModes(prev => ({ ...prev, [splineKey]: enabled })); stageDesign(design.length >= 2 ? design : padCurve, enabled) }} />
<div className="curve-edit-layout"><div className="curve-graph-panel"><CurvePlot spline={spline} height={320}
                      points={design.length >= 2 ? design : padCurve}
                      onChange={(next) => stageDesign(next)}
                      onAddPoint={(point) => {
                        const base = design.length >= 2 ? design : padCurve
                        const insertAt = base.findIndex((p) => p.x > point.x)
                        if (insertAt > 0 && insertAt < base.length) {
                          stageDesign([...base.slice(0, insertAt), point, ...base.slice(insertAt)])
                        }
                      }}
                      maxPoints={DESIGN_MAX_POINTS}
                      overlay={quantized}
                    />
                    <div className="curve-edit-hint"><span className="curve-hint-symbol">↗</span><span>{t('sticks.curveClickHint')}</span></div>
                    <div className="row spread stick-curve-status">
                      <span>{t('sticks.curve')}</span>
                      <span className={`pill ${design.length === padCurve.length && design.every((p, i) => p.x === padCurve[i]?.x && p.y === padCurve[i]?.y) ? 'good' : 'warn'}`}>
                        {design.length === padCurve.length && design.every((p, i) => p.x === padCurve[i]?.x && p.y === padCurve[i]?.y) ? t('sticks.matches') : t('sticks.differs')}
                      </span>
                    </div>
                    <div className="row" style={{ gap: 8, margin: '8px 0' }}>
                      <button className="btn sm" disabled={design.length >= DESIGN_MAX_POINTS} onClick={() => stageDesign(addDesignPoint(design.length >= 2 ? design : padCurve))}>{t('sticks.addPoint')}</button>
                      <div style={{ flex: 1 }} />
                      <button className="btn sm ghost" disabled={busy} onClick={() => void reloadCurveFromPad()}>{t('sticks.reload')}</button>
                    </div>
                    </div><section className="curve-point-editor">
                      <h4>{t('sticks.pointEditor')}</h4>
                      <div className="stick-extra-body">
                    <table className="tbl" style={{ marginTop: 8 }}>
                      <thead><tr><th>#</th><th>X</th><th>Y</th><th /></tr></thead>
                      <tbody>
                        {design.map((p, i) => (
                          <tr key={i}>
                            <td className="mono">{i + 1}</td>
                            <td><input className="input" type="number" min={0} max={255} value={p.x} onChange={(e) => { const next = design.map((q) => ({ ...q })); const lo = i > 0 ? next[i - 1].x : 0; const hi = i < next.length - 1 ? next[i + 1].x : 255; next[i].x = Math.max(lo, Math.min(hi, Math.max(0, Math.min(255, Number(e.target.value))))); stageDesign(next) }} /></td>
                            <td><input className="input" type="number" min={0} max={255} value={p.y} onChange={(e) => { const next = design.map((q) => ({ ...q })); next[i].y = Math.max(0, Math.min(255, Number(e.target.value))); stageDesign(next) }} /></td>
                            <td>
                              <button className="btn sm ghost" disabled={design.length <= DESIGN_MIN_POINTS} title={t('sticks.removePoint')} onClick={() => stageDesign(design.filter((_, j) => j !== i))}>−</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="note" style={{ marginTop: 8 }}>
                      {t('sticks.hwPreview')} <span className="mono">{quantized.map((q) => `${q.x}/${q.y}`).join(' · ')}</span>
                    </div>
                      </div>
                    </section></div><div className="curve-preset-area"><section className="curve-presets-visible">
                      <h4>{t('sticks.presetsAndSaved')}</h4>
                      <div className="stick-extra-body">
                    {CURVE_GROUPS.map((g) => (
                      <div key={g.titleKey} className="curve-preset-group">
                        <h5>{t(g.titleKey)}</h5>
                        <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
                          {g.curves.map(([key, c]) => (
                            <button
                              key={key}
                              className="choice-btn"
                              title={c.hint}
                              onClick={() => stageDesign(c.pts.map((p) => ({ ...p })))}
                            >
                              <span className="row curve-preset-label"><CurveMiniIcon points={c.pts} /><span className="choice-label">{c.label}</span></span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    <div className="row wrap" style={{ gap: 8, margin: '8px 0', alignItems: 'center' }}>
                      <button
                        className="btn sm"
                        title={t('sticks.saveTitle')}
                        onClick={saveCurrentCurvePreset}
                      >
                        {t('sticks.saveCurrent')}
                      </button>
                      {presets.length === 0 && <span className="saved-curve-empty">{t('sticks.noSavedCurves')}</span>}
                      {presets.map((p) => <SavedCurvePreset key={p.name} preset={p} onApply={() => stageDesign(p.pts.map((q) => ({ ...q })))} onRename={(name) => renameCurvePreset(p.name, name)} onDelete={() => setPresets((prev) => prev.filter((q) => q.name !== p.name))} />)}
                    </div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button
                        className="btn sm ghost"
                        title={t('sticks.copyCurve')}
                        onClick={() => {
                          if (!profile || !pkt) return
                          const other = profile.sticks[which === 0 ? 1 : 0]
                          edit(() => { stick.setCurve(other, stick.curve(pkt).map((p) => ({ ...p }))); stick.markCurveIdentity(other) })
                        }}
                      >
                        {t('sticks.copyCurve')}
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() => stageDesign(LINEAR_CURVE.map((p) => ({ ...p })))}
                      >
                        {t('sticks.resetCurve')}
                      </button>
                    </div>
                      </div>
                    </section>
                    </div>
                  </div>
              </div>}
              {tab === 'device' && (
              <div className="two device-workspace" style={{ alignItems: 'start' }}>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card device-polling-card">
                    <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('nav.device')}</span><h3>{t('device.polling')}</h3></div><DeviceIcon kind="polling" size={24} /></div>
                    <div className="device-summary-pills">{allRates.map((o) => <span className="pill" key={o.gear}>{o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz}`} Hz</span>)}</div>
                    <Hint>Report-rate gear (Fun_Data +14){model ? ` · ${model.marketingName} offers ${allRates.length} gears` : ''}. Hz labels are the vendor's claim; measured input stays ~250–500/s.</Hint>
                    <div className="choice" style={{ margin: '10px 0' }}>
                      {allRates.map((o) => (
                        <button
                          key={o.gear}
                          className={`choice-btn${fun.extend.reportRateGear(fd) === o.gear ? ' active' : ''}`}
                          title={o.confirmed ? `gear ${o.gear}` : `gear ${o.gear} (unconfirmed on this model)`}
                          onClick={() => edit(() => fun.extend.setReportRateGear(fd, o.gear))}
                        >
                          <span className="choice-label">{o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz} Hz`}{o.confirmed ? '' : '*'}</span>
                        </button>
                      ))}
                    </div>
                  </div>


                  <div className="card device-bits-card">
                    <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('nav.device')}</span><h3>{t('device.bits')}</h3></div><DeviceIcon kind="resolution" size={24} /></div>
                    <Hint>{t('device.bitHint')}</Hint>
                    <div className="choice" style={{ margin: '10px 0 6px' }}>
                      {STICK_RESOLUTION_OPTIONS.filter((o) => o.bits === 12).map((o) => (
                        <button
                          key={o.bits}
                          className={`choice-btn${resBits === o.bits ? ' active' : ''}`}
                          title={o.bits === 12 ? 'Full sensor resolution' : `Step ${o.step}`}
                          onClick={() => edit(() => fun.extend.setStickResolutionBits(fd, o.bits))}
                        >
                          <span className="choice-label">{o.bits === 12 ? 'Unlimited (12-bit)' : `${o.bits}-bit`}</span>
                        </button>
                      ))}
                    </div>
                    <div className="choice" style={{ margin: '0 0 6px' }}>
                      {[...STICK_RESOLUTION_OPTIONS].filter((o) => o.bits !== 12).sort((a, b) => b.bits - a.bits).map((o) => (
                        <button
                          key={o.bits}
                          className={`choice-btn${resBits === o.bits ? ' active' : ''}`}
                          title={o.bits === 12 ? 'Full sensor resolution' : `Step ${o.step}`}
                          onClick={() => edit(() => fun.extend.setStickResolutionBits(fd, o.bits))}
                        >
                          <span className="choice-label">{o.bits === 12 ? 'Unlimited (12-bit)' : `${o.bits}-bit`}</span>
                        </button>
                      ))}
                    </div>
                    <Hint style={{ marginTop: 8 }}>
                      {t('device.bitNote')}
                    </Hint>
                    {!resInfo.standard && (
                      <div className="note bad" style={{ marginTop: 8 }}>
                        {t('device.nonStdFull').replace('{wire}', String(resInfo.wire)).replace('{bits}', String(resInfo.bits))}
                      </div>
                    )}
                  </div>



                </div>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card device-rate-card">
                    <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('nav.device')}</span><h3>{t('device.rate')}</h3></div><DeviceIcon kind="rate" size={24} /></div>
                    <Hint>{t('device.rateHint')}</Hint>
                    <div className="stack" style={{ gap: 12 }}>
                      <div className="row spread">
                        <div>
                          <div style={{ fontSize: 13.5 }}>{t('device.rateConst')}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                            {t('device.rateApplies')}
                          </div>
                        </div>
                        <span className="mono">{t('device.stored')}: {stick.mouseDpi(pkt)}</span>
                      </div>
                      <div className="row wrap" style={{ gap: 8 }}>
                        {[{ rate: null as number | null }, ...[100, 150, 200, 250, 300].map((rate) => ({ rate: rate as number | null }))].map((opt) => {
                          const label = opt.rate === null ? t('device.none') : `${opt.rate}${opt.rate > 255 ? '*' : ''}`
                          const wire = opt.rate === null ? 50 : Math.min(opt.rate, 255)
                          const active = stick.mouseDpi(pkt) === wire
                          return (
                            <button
                              key={label}
                              className={`choice-btn${active ? ' active' : ''}`}
                              title={opt.rate === null ? t('device.stock50') : opt.rate > 255 ? `Firmware byte caps at 255 — stores ${wire}` : `Stores ${wire}`}
                              onClick={() => edit(() => stick.setMouseDpi(pkt, wire))}
                            >
                              <span className="choice-label">{label}</span>
                            </button>
                          )
                        })}
                        {stick.mapIndex(pkt) === 4 && (
                          <button
                            className="btn sm ghost"
                            title={t('device.restoreStick')}
                            onClick={() => edit(() => { stick.setMapIndex(pkt, which === 0 ? 1 : 2); stick.setMapped(pkt, true) })}
                          >
                            {which === 0 ? t('device.backLeft') : t('device.backRight')}
                          </button>
                        )}
                      </div>
                      <div className="row" style={{ gap: 8, marginTop: 8 }}>
                        <button
                          className={`choice-btn${outLock[which] ? ' active' : ''}`}
                          title={t('device.lockOutTitle')}
                          onClick={() => setOutLock((prev) => (which === 0 ? [!prev[0], prev[1]] : [prev[0], !prev[1]]))}
                        >
                          <span className="choice-label">{t('device.lockOut')}</span>
                        </button>
                      </div>
                      <Hint>{t('device.rateNote')}</Hint>
                    </div>
                  </div>

                </div>
              </div>
              )}
            </>
          )}
          {tab === 'device' && connected && profile && !isLj && ['G7ProCE', 'T3CE'].includes(modelId) && <section className="card clean-profile-card">
            <div className="stick-panel-heading"><div><span className="stick-eyebrow">{t('clean.eyebrow').replace('{slot}', String(slot))}</span><h3>{t('clean.title')}</h3></div></div>
            <p>{t('clean.scope')}</p>
            <div className="clean-profile-summary"><span>{t('clean.sticks')}</span><span>{t('clean.bindings')}</span><span>{t('clean.other')}</span></div>
            <p className="clean-profile-detail">{t('clean.limits')}</p>
            <div className="row wrap" style={{ gap: 10 }}><button type="button" className="btn" disabled={busy || locked || calibrationRunning} onClick={stageCleanProfile}>{t('clean.action')}</button>{freshUndo?.path === connPath && freshUndo?.slot === slot && freshUndo?.model === modelId && <button type="button" className="btn ghost" disabled={busy || calibrationRunning} onClick={undoCleanProfile}>{t('clean.undo')}</button>}</div>
          </section>}
          {tab === 'buttons' && connected && profile && (
            <>
            <div className="buttons-workspace gamesir-buttons-workspace">
            <TriggerSettings profile={profile} edit={edit} disabled={busy || locked || calibrationRunning} />
            <RemapWorkspace
              captureFamily="gamesir"
              disabled={busy || locked}
              help={<>{t('buttons.hint')}<br /><br />{t('buttons.backs')}{modelId === 'G7ProCE' && (<><br /><br />{t('buttons.backsExtra')}</>)}{modelId === 'T3CE' && (<><br /><br />{t('buttons.frontExtra')}<br /><br />{t('buttons.tExtra')}</>)}</>}
              rows={([
                ...STANDARD_BUTTONS.map((name, i) => ({ name: keyLabel(i + 1), value: i + 1, pkt: profile.buttons[i] ?? null as Packet | null })),
                    ...(profile.functionKeys[0] && profile.functionKeys[0].length === 169
                      ? [{ name: 'FL1 · L4', value: 17, tag: 'L4', pkt: profile.functionKeys[0] as Packet | null }]
                      : []),
                    ...(profile.functionKeys[1] && profile.functionKeys[1].length === 169
                      ? [{ name: 'FR1 · R4', value: 18, tag: 'R4', pkt: profile.functionKeys[1] as Packet | null }]
                      : []),
                    ...(modelId === 'G7ProCE' && profile.functionKeys[2] && profile.functionKeys[2].length === 169
                      ? [{ name: 'FL2 · L5', value: 17, tag: 'L5', pkt: profile.functionKeys[2] as Packet | null }]
                      : []),
                    ...(modelId === 'G7ProCE' && profile.functionKeys[3] && profile.functionKeys[3].length === 169
                      ? [{ name: 'FR2 · R5', value: 18, tag: 'R5', pkt: profile.functionKeys[3] as Packet | null }]
                      : []),
                    // Tarantula extras, packet order proven two ways: press
                    // C1/C2/C3 fires packets 2/3/4 on live hardware, and
                    // Connect's own T3CE config maps Ext1..Ext7 to
                    // C1,C2,C3,C4,T1,T2,T3 — 7 names plus FL1/FR1 is exactly
                    // the 9 function packets. T1/T2/T3 confirmed the same
                    // way: T1 fires packet 6 (D-pad Up), T2's packet holds
                    // inert index 36 (unbound), T3's holds 37 (Screenshot).
                    // Full order: [FL1,FR1,C1,C2,C3,C4,T1,T2,T3].
                    ...(modelId === 'T3CE' && profile.functionKeys[2] && profile.functionKeys[2].length === 169
                      ? [{ name: 'C1', value: 17, tag: 'C1', pkt: profile.functionKeys[2] as Packet | null }]
                      : []),
                    ...(modelId === 'T3CE' && profile.functionKeys[3] && profile.functionKeys[3].length === 169
                      ? [{ name: 'C2', value: 17, tag: 'C2', pkt: profile.functionKeys[3] as Packet | null }]
                      : []),
                    ...(modelId === 'T3CE' && profile.functionKeys[4] && profile.functionKeys[4].length === 169
                      ? [{ name: 'C3', value: 17, tag: 'C3', pkt: profile.functionKeys[4] as Packet | null }]
                      : []),
                    ...(modelId === 'T3CE' && profile.functionKeys[5] && profile.functionKeys[5].length === 169
                      ? [{ name: 'C4', value: 17, tag: 'C4', pkt: profile.functionKeys[5] as Packet | null }]
                      : []),
                    ...(modelId === 'T3CE' && profile.functionKeys[6] && profile.functionKeys[6].length === 169
                      ? [{ name: 'T1', value: 17, tag: 'T1', pkt: profile.functionKeys[6] as Packet | null }]
                      : []),
                    ...(modelId === 'T3CE' && profile.functionKeys[7] && profile.functionKeys[7].length === 169
                      ? [{ name: 'T2', value: 17, tag: 'T2', pkt: profile.functionKeys[7] as Packet | null }]
                      : []),
                    ...(modelId === 'T3CE' && profile.functionKeys[8] && profile.functionKeys[8].length === 169
                      ? [{ name: 'T3', value: 17, tag: 'T3', pkt: profile.functionKeys[8] as Packet | null }]
                      : [])
                  ] as Array<{ name: string; value: number; tag?: string; pkt: Packet | null }>).flatMap((row, index) => {
                const pkt = row.pkt
                if (!pkt) return []
                const values = button.mapValues(pkt)
                const current = values.find(v => v !== 0) ?? 0
                return [{ id: row.name, name: row.name, icon: <KeyIcon value={row.value} tag={row.tag} size={27} />, current, effective: displayMapping(values), outputIcon: current ? <KeyIcon value={current} size={28} /> : null, extra: index >= STANDARD_BUTTONS.length, known: true, onPick: (v: number) => edit(() => button.setMap(pkt, [v, 0, 0])) }]
              })}
            />
            </div>
            </>
          )}
          {tab === 'profiles' && (
            isLj ? (
              <div className="msg">
                <h3>{modelName} — {t('lj.profilesLockedTitle')}</h3>
                <p>{t('lj.profilesLockedBody')}</p>
              </div>
            ) : (
              <ProfilesPanel connected={connected} activeSlot={info?.currentProfile ?? null} locked={locked} modelId={modelId} modelLen={modelLen} dumpLength={model?.dumpLength ?? 0} modelName={model?.marketingName ?? null} />
            )
          )}
          {tab === 'calibrate' && (
            connected && model?.support === 'full' ? (
              isLj
                ? <LeadJoyCalibrationPanel live={ljLive} onOpenSticks={() => setTab('sticks')} />
                : <HardwareCalibrationPanel dirty={dirty} blocked={busy || locked} onActiveChange={setCalibrationRunning} />
            ) : (
              <div className="msg"><h3>{t('cal.connectTitle')}</h3><p>{t('cal.connectBody')}</p></div>
            )
          )}
          {tab === 'language' && (
            <LanguagePanel />
          )}
          {tab === 'theme' && (
            <ThemePanel />
          )}
          {tab === 'lab' && (
          <>
          <AnalyticsPanel
            context={
              profile && fd
                ? 'Now editing P' + slot + ': set ' + gearHz.toLocaleString() + ' Hz (gear ' + gear + ') · ' + resBits + '-bit (' + bitsToLevels(resBits).toLocaleString() + ' levels) — green chart is measured input, not the set rate.'
                : 'Connect and load a slot — then switch gear, write, and watch this chart.'
            }
            setHz={profile && fd ? gearHz : 0}
            gear={profile && fd ? gear : 0}
          />
          <LinearityBench live={live} connected={connected} />
          <DeepPollCard vid={model?.vendorId ?? 0x3537} pid={pid} setHz={profile && fd ? gearHz : 0} connected={connected} />
          <ResetEverythingCard profile={profile} fd={fd} edit={edit} onReload={syncDesignFromCopy} notify={setMsg} />
          </>
          )}
          </div>
        </div>
      </main>
    </div>
    </ThemeContext.Provider>
    </LangContext.Provider>
  )
}

function ThemePanel(): JSX.Element {
  const { theme, setTheme } = useContext(ThemeContext)
  const t = useT()
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('theme.title')}</h3>
      <Hint>{t('theme.hint')}</Hint>
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        {THEMES.map((o) => (
          <button
            key={o.id}
            className={`choice-btn${theme === o.id ? ' active' : ''}`}
            onClick={() => setTheme(o.id)}
          >
            <span className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span style={{ display: 'inline-flex', gap: 3 }}>
                {[o.vars['--bg-2'] ?? '#000', o.vars['--accent'] ?? '#888', o.vars['--good'] ?? '#888'].map((c) => (
                  <span key={c} style={{ width: 12, height: 12, borderRadius: '50%', background: c, border: '1px solid var(--line-2)' }} />
                ))}
              </span>
              {o.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function LanguagePanel(): JSX.Element {
  const { lang, setLang } = useContext(LangContext)
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{tr(lang, 'lang.title')}</h3>
      <Hint>{tr(lang, 'lang.hint')}</Hint>
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        {LANGS.map((o) => (
          <button
            key={o.id}
            className={`choice-btn${lang === o.id ? ' active' : ''}`}
            onClick={() => setLang(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
