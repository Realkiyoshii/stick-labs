import { useContext, useEffect, useRef, useState } from 'react'
import { api, b64ToBytes, bytesToB64, type Candidate, type DeviceInfo, type DeviceStats, type LiveSample, type PingResult } from './api'
import { parseProfile, serializeProfile, fun, stick, button, trigger, LINEAR_CURVE, looksLikeCEProfile, type Packet, type Profile } from '@shared/profile'
import { PROFILE_LENGTH, REPORT_RATE_OPTIONS, STICK_RESOLUTION_OPTIONS, STANDARD_BUTTONS, CENTER_NUDGE } from '@shared/protocol'
import { identifyModel, MODELS, type ControllerModel } from '@shared/models'
import {
  describeRawResolution,
  bitsToLevels,
  bitsToWireRaw,
  resampleCurve,
  resampleSpline,
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
import { LangContext, tr, useLangState, useT } from './i18n'
import { applyTheme } from './theme'

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

function Slider(props: {  label: string
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

function CurvePlot({ points, onChange, overlay, smooth }: { points: Array<{ x: number; y: number }>; onChange?: (next: Array<{ x: number; y: number }>) => void; overlay?: Array<{ x: number; y: number }>; smooth?: boolean }): JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const drag = useRef<number | null>(null)

  function toPx(w: number, h: number): { toX: (v: number) => number; toY: (v: number) => number } {
    const pad = 10
    return {
      toX: (v: number): number => pad + (v / 255) * (w - pad * 2),
      toY: (v: number): number => h - pad - (v / 255) * (h - pad * 2)
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
    const h = 200
    const pad = 10
    const x = Math.max(0, Math.min(255, Math.round(((e.clientX - rect.left - pad) / (w - pad * 2)) * 255)))
    const y = Math.max(0, Math.min(255, Math.round((1 - (e.clientY - rect.top - pad) / (h - pad * 2)) * 255)))
    const next = points.map((p) => ({ ...p }))
    // Keep x-ordered: a dragged point may not cross its neighbours, or the
    // drawn polyline zigzags and the table rows leave slot order.
    const lo = i > 0 ? next[i - 1].x : 0
    const hi = i < next.length - 1 ? next[i + 1].x : 255
    next[i] = { x: Math.max(lo, Math.min(hi, x)), y }
    onChange(next)
  }
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = c.clientWidth
    const h = 200
    c.width = w * dpr
    c.height = h * dpr
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const pad = 10
    const toX = (v: number): number => pad + (v / 255) * (w - pad * 2)
    const toY = (v: number): number => h - pad - (v / 255) * (h - pad * 2)
    ctx.strokeStyle = '#3a2230'
    for (let i = 0; i <= 4; i++) {
      const t = (i / 4) * (w - pad * 2) + pad
      ctx.beginPath()
      ctx.moveTo(t, pad)
      ctx.lineTo(t, h - pad)
      ctx.stroke()
    }
    ctx.strokeStyle = '#552c38'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(toX(0), toY(0))
    ctx.lineTo(toX(255), toY(255))
    ctx.stroke()
    ctx.setLineDash([])
    // Max X / Y boundary lines (255 edges) with labels.
    ctx.strokeStyle = 'rgba(62,207,142,0.55)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(toX(255), pad)
    ctx.lineTo(toX(255), h - pad)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(pad, toY(255))
    ctx.lineTo(w - pad, toY(255))
    ctx.stroke()
    ctx.fillStyle = '#3ecf8e'
    ctx.font = '10px system-ui'
    ctx.fillText('X max 255', toX(255) - 52, pad + 11)
    ctx.fillText('Y max 255', pad + 4, toY(255) + 13)
    // Endpoint projections: actual max X / max Y reached by the design.
    if (points.length > 0) {
      const maxX = Math.max(...points.map((p) => p.x))
      const maxY = Math.max(...points.map((p) => p.y))
      ctx.strokeStyle = 'rgba(245,181,68,0.8)'
      ctx.setLineDash([5, 4])
      ctx.beginPath()
      ctx.moveTo(toX(maxX), toY(0))
      ctx.lineTo(toX(maxX), toY(255))
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(toX(0), toY(maxY))
      ctx.lineTo(toX(255), toY(maxY))
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#f5b544'
      ctx.fillText(`max X ${maxX}`, Math.min(toX(maxX) + 5, w - 52), h - pad - 5)
      ctx.fillText(`max Y ${maxY}`, pad + 4, toY(maxY) - 5)
    }
    ctx.strokeStyle = '#f43f52'
    ctx.lineWidth = 2
    ctx.beginPath()
    const line = smooth ? traceSpline(points) : points
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
  }, [points, overlay, smooth])
  return (
    <canvas
      ref={ref}
      className="plot"
      style={{ height: 200, cursor: onChange ? 'grab' : 'default', touchAction: 'none' }}
      onPointerDown={(e) => {
        if (!onChange || !ref.current) return
        const i = pointAt(e, ref.current.clientWidth, 200)
        if (i !== null) {
          drag.current = i
          ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
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

/**
 * FPS curve pack — static 5-point dual-zone approximations of a "dynamic"
 * response (fine centre for micro-aim, hot edge for flicks). The pad has no
 * speed-sensing, so true velocity-dynamic curves are impossible; these bend
 * the same LUT a dynamic curve would average out to. All verified byte-safe:
 * curve bytes only, +14..+23. The Dynamic (CoD) entry is digitized from the
 * game's own published curve chart (thumbstick movement → rotation speed):
 * above the diagonal early, crossing at mid, settled below it late.
 */
export const AIM_CURVES: Record<string, { label: string; hint: string; pts: Array<{ x: number; y: number }> }> = {
  linear: { label: 'Linear', hint: '1:1 raw', pts: [...LINEAR_CURVE] },
  dynamic: {
    label: 'Dynamic (CoD)',
    hint: 'digitized from CoD chart: hot start, settled mid',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 89 }, { x: 128, y: 128 }, { x: 191, y: 173 }, { x: 255, y: 255 }]
  },
  fpsAim: {
    label: 'Kiyoshi Curve',
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
  sacreds: {    label: 'Sacreds',
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


function KeyIcon({ value, tag, size = 18 }: { value: number; tag?: string; size?: number }): JSX.Element | null {
  const s = size
  const wrap = (inner: JSX.Element): JSX.Element => (
    <svg width={s} height={s} viewBox="0 0 20 20" style={{ verticalAlign: 'middle', flexShrink: 0 }}>{inner}</svg>
  )
  const label = (bg: string, ch: string, fg = '#fff', fs = 10): JSX.Element =>
    wrap(<><circle cx={10} cy={10} r={8.5} fill={bg} /><text x={10} y={10.5} fontSize={fs} fill={fg} fontWeight={800} textAnchor="middle" dominantBaseline="central">{ch}</text></>)
  const arrow = (pts: string): JSX.Element =>
    wrap(<><rect x={2.5} y={2.5} width={15} height={15} rx={4.5} fill="#33333d" /><polygon points={pts} fill="#fff" /></>)
  const pill = (ch: string, tall: boolean): JSX.Element =>
    wrap(<><rect x={2} y={tall ? 3 : 6.5} width={16} height={tall ? 14 : 7} rx={3.5} fill={tall ? '#3a3a46' : '#4a4a55'} /><text x={10} y={10.5} fontSize={6} fill="#fff" fontWeight={800} textAnchor="middle" dominantBaseline="central">{ch}</text></>)
  const paddle = (ch: string): JSX.Element =>
    wrap(<><rect x={3.5} y={3.5} width={13} height={13} rx={5.5} fill="#4a4a55" stroke="#7a7a88" strokeWidth={1} /><text x={10} y={10.5} fontSize={6} fill="#fff" fontWeight={800} textAnchor="middle" dominantBaseline="central">{ch}</text></>)
  switch (value) {
    case 9: return label('#2ca243', 'A')
    case 10: return label('#e74856', 'B')
    case 11: return label('#2f7de1', 'X')
    case 12: return label('#f2b90d', 'Y')
    case 1: return arrow('10,5.5 14.5,12 5.5,12')
    case 2: return arrow('10,14.5 14.5,8 5.5,8')
    case 3: return arrow('5.5,10 12,5.5 12,14.5')
    case 4: return arrow('14.5,10 8,5.5 8,14.5')
    case 5: return pill('LB', false)
    case 6: return pill('RB', false)
    case 19: return pill('LT', true)
    case 20: return pill('RT', true)
    case 7:
    case 8:
      return wrap(<><circle cx={10} cy={10} r={8} fill="#33333d" /><circle cx={10} cy={10} r={3} fill="#8a8a96" /></>)
    case 13:
      return wrap(<><circle cx={10} cy={10} r={8} fill="none" stroke="#8a8a96" strokeWidth={2} /><circle cx={10} cy={10} r={2.5} fill="#8a8a96" /></>)
    case 14:
      return wrap(<><rect x={3} y={6} width={9} height={8} rx={1.5} fill="none" stroke="#8a8a96" strokeWidth={1.5} /><rect x={8} y={8.5} width={9} height={8} rx={1.5} fill="#33333d" stroke="#8a8a96" strokeWidth={1.5} /></>)
    case 15:
      return wrap(<><rect x={2.5} y={2.5} width={15} height={15} rx={4.5} fill="#33333d" /><path d="M6 7.5h8M6 10h8M6 12.5h8" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" /></>)
    case 16:
      return wrap(<><rect x={2.5} y={6} width={15} height={9} rx={2} fill="#33333d" /><circle cx={10} cy={10.5} r={2.8} fill="none" stroke="#8a8a96" strokeWidth={1.5} /><rect x={8} y={4} width={4} height={2.5} rx={1} fill="#33333d" /></>)
    case 17: return paddle(tag ?? 'FL1')
    case 18: return paddle(tag ?? 'FR1')
    default: return null
  }
}

/**
 * Icon dropdown for remap targets — native <select> cannot render icons,
 * so this renders a button + a portal popup (position:fixed, so card and
 * table scrolling cannot clip it). Closes on pick, Escape, outside click,
 * scroll or resize. Only one row's popup is open at a time (lifted state).
 */
function KeySelect({ value, disabled, open, onToggle, onClose, onPick }: {
  value: number
  disabled?: boolean
  open: boolean
  onToggle: () => void
  onClose: () => void
  onPick: (v: number) => void
}): JSX.Element {
  const t = useT()
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
  const options = [{ value: 0, label: t('buttons.unmapped') }, ...REMAP_TARGETS.filter((k) => k.value !== 0)]
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
          {value !== 0 && <KeyIcon value={value} />}
          <span>{value === 0 ? t('buttons.unmapped') : keyLabel(value)}</span>
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
          {options.map((o) => (
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
              <KeyIcon value={o.value} />
              <span>{o.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </span>
  )
}

function TriggerDeadzoneCard({ profile, edit }: {
  profile: Profile
  edit: (fn: () => void) => void
}): JSX.Element {
  const t = useT()
  return (
    <div className="card">
      <h3>{t('trig.title')}</h3>
      <Hint>{t('trig.hint')}</Hint>
      {([0, 1] as const).map((ti) => {
        const tpkt = profile.triggers[ti]
        if (!tpkt) return null
        const tdz = trigger.deadzonePercent(trigger.deadzone(tpkt))
        const ten = trigger.deadEnabled(tpkt)
        return (
          <div key={ti} style={{ marginTop: 8 }}>
            <div className="row spread" style={{ marginBottom: 6, alignItems: 'center' }}>
              <span className="label">{ti === 0 ? 'LT' : 'RT'}</span>
              <button
                className={`choice-btn${ten ? ' active' : ''}`}
                onClick={() => edit(() => trigger.setDeadEnabled(tpkt, !ten))}
              >
                <span className="choice-label">{t('trig.enable')}</span>
              </button>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              <Slider label={t('sticks.start')} value={tdz.begin} min={0} max={20} step={0.1} unit="%" onChange={(v) => edit(() => trigger.setDeadzone(tpkt, { ...trigger.deadzone(tpkt), begin: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
              <Slider label={t('sticks.end')} value={tdz.end} min={10} max={100} step={0.1} unit="%" onChange={(v) => edit(() => trigger.setDeadzone(tpkt, { ...trigger.deadzone(tpkt), end: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StickCross({ lx, ly, rx, ry }: { lx: number; ly: number; rx: number; ry: number }): JSX.Element {
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
    const draw = (x: number, y: number, cx: number, label: string): void => {
      const r = 62
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
    }
    draw(lx, ly, w * 0.27, `L ${lx},${ly}`)
    draw(rx, ry, w * 0.73, `R ${rx},${ry}`)
  }, [lx, ly, rx, ry])
  return <canvas ref={ref} className="plot" style={{ height: 190 }} />
}

export default function App(): JSX.Element {
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [connPath, setConnPath] = useState<string | null>(null)
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
  const [connected, setConnected] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
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
  const [tab, setTab] = useState<'sticks' | 'device' | 'buttons'>('sticks')
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
  // slot+stick so a half-finished shape survives a reload.
  const [design, setDesign] = useState<Array<{ x: number; y: number }>>([])
  // Slot sampling mode for the curve designer: straight segments (linear)
  // or the smoothed spline. Only changes the 5 bytes that get written —
  // the red design stays exactly as drawn.
  const [spline, setSpline] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('sticklabs.spline') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem('sticklabs.spline', spline ? '1' : '0')
    } catch {
      /* storage full/blocked — sampling mode still works for the session */
    }
  }, [spline])
  // Which remap row's icon dropdown is open (row key, or null).
  const [bindOpen, setBindOpen] = useState<string | null>(null)
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
  const t = (key: string): string => tr(lang, key)
  // Single default theme — applied once on launch, no picker.
  useEffect(() => {
    applyTheme()
  }, [])
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
      if (pre && pre.support === 'detect-only') {
        // Named but layout-unproven (e.g. LeadJoy Saber Plus): show it as
        // detected + locked without sending the GameSir handshake at all —
        // foreign bytes on another vendor's pad buy nothing and the timeout
        // only confuses. Live input still flows; tuning unlocks per feature.
        setModel(pre)
        setPid(cand?.productId ?? null)
        setBlob(null)
        setMsg(`${pre.marketingName} detected — ${pre.supportNote}`)
        return
      }
      const res = await api().connect(path)
      setConnPath(path)
      setConnected(true)
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

  const quantized = design.length >= 2 ? (spline ? resampleSpline(design) : resampleCurve(design)) : pts
  const locked = connected && (!model || model.support !== 'full')
  const modelId = model?.id ?? 'G7ProCE'
  const modelLen = model && model.profileLength > 0 ? model.profileLength : PROFILE_LENGTH
  modelLenRef.current = modelLen
  const padCurve = pts

  function reloadDesignFromPad(): void {
    if (pkt) setDesign(stick.curve(pkt).map((p) => ({ ...p })))
  }

  /**
   * Curve edits apply immediately, like every other control: the design
   * canvas updates AND the sampled slots are written into the working copy
   * (marked dirty — the top Write button commits to the pad). No-op when
   * the sampled design already equals the working copy, so loading and
   * no-change touches never dirty the profile.
   */
  function stageDesign(next: Array<{ x: number; y: number }>, useSpline: boolean = spline): void {
    setDesign(next)
    if (!pkt || next.length < 2) return
    const q = useSpline ? resampleSpline(next) : resampleCurve(next)
    const cur = stick.curve(pkt)
    if (q.length === cur.length && q.every((p, i) => p.x === cur[i].x && p.y === cur[i].y)) return
    edit(() => {
      stick.setCurve(pkt, q.map((p) => ({ ...p })))
      stick.markCurveIdentity(pkt)
    })
  }

  return (
    <LangContext.Provider value={{ lang, setLang }}>
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Stick Labs <span>Zamilitox</span></h1>
        </div>
        <nav className="nav">
          <div className="nav-group">
            <h4>{t('nav.tuning')}</h4>
            <button type="button" className={`nav-item${tab === 'sticks' ? ' active' : ''}`} onClick={() => setTab('sticks')}>
              {t('nav.sticks')}
            </button>
            <button type="button" className={`nav-item${tab === 'device' ? ' active' : ''}`} onClick={() => setTab('device')}>
              {t('nav.device')}
            </button>
            <button type="button" className={`nav-item${tab === 'buttons' ? ' active' : ''}`} onClick={() => setTab('buttons')}>
              {t('nav.buttons')}
            </button>
          </div>
        </nav>
        <div className="stack" style={{ gap: 10 }}>
          <button className="btn ghost sm" onClick={() => void refresh()}>{t('side.rescan')}</button>
          <button
            className="btn ghost sm"
            title={t('side.copyTitle')}
            onClick={() => {
              const lines = [
                `Stick Labs Zamilitox v${appVersion ?? '?'} ${new Date().toISOString()}`,
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
          {visibleCandidates.map((c) => {
            const known = identifyModel(c.product, c.productId)
            return (
              <button key={c.path} className="btn sm" onClick={() => void connect(c.path)}>
                {known ? known.marketingName : (c.product || `Unknown 0x${c.productId.toString(16)}`)}{c.preferred ? ' ★' : ''}
              </button>
            )
          })}
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
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginTop: 6 }}
            onClick={() => void api().openExternal('https://www.youtube.com/@realkiyoshi').catch(() => undefined)}
          >
            YouTube @realkiyoshi
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="row" style={{ gap: 12 }}>
            <h2>Stick Labs Zamilitox</h2>
            <span className="sub">{t('topbar.sub')}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {[1, 2, 3, 4].map((s) => (
              <button
                key={s}
                className={`choice-btn${s === slot ? ' active' : ''}`}
                disabled={!connected || busy || locked}
                onClick={() => void loadSlot(s)}
              >
                <span className="choice-label">P{s}</span>
              </button>
            ))}
            <button className="btn sm primary" disabled={!connected || !dirty || busy || locked} onClick={() => void write()}>
              {busy ? t('common.working') : t('top.write')}
            </button>
            {dirty && <span className="pill warn">{t('msg.unsaved')}</span>}
            {!dirty && savedAt && savedAt.slot === slot && (
              <span className="pill good" title={t('msg.verifiedTitle')}>
                {t('msg.saved')} {new Date(savedAt.at).toLocaleTimeString()}
              </span>
            )}
          </div>
        </header>
        <div className="content">
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
          {dirty && <div className="note warn">{t('msg.dirty')}</div>}
          {!connected && (
            <div className="msg"><h3>{t('msg.connect')}</h3><p>{t('msg.models')} {t('msg.connectBody')}</p></div>
          )}
          {connected && !profile && (
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
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                {(['Left', 'Right'] as const).map((n, i) => (
                  <button key={n} className={`choice-btn${i === which ? ' active' : ''}`} onClick={() => setWhich(i)}>
                    <span className="choice-label">{(n === 'Left' ? t('cal.left') : t('cal.right'))} {t('sticks.stick')}</span>
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="pill">{resBits}-bit · {bitsToLevels(resBits).toLocaleString()} {t('device.levels')}</span>
              </div>
              {tab === 'sticks' && (
              <div className="two" style={{ alignItems: 'start' }}>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card">
                    <h3>{t('sticks.live')}</h3>
                    <Hint>{t('sticks.liveNote')} {t('sticks.liveHint')}</Hint>
                    <StickCross lx={live?.lx ?? 128} ly={live?.ly ?? 128} rx={live?.rx ?? 128} ry={live?.ry ?? 128} />
                    <div className="row spread">
                      <span className="mono">L {live?.lx ?? '—'},{live?.ly ?? '—'}</span>
                      <span className="mono">R {live?.rx ?? '—'},{live?.ry ?? '—'}</span>
                    </div>
                  </div>


                  <div className="card">
                    <h3>{t('sticks.deadzone')} — {t('sticks.steps01')}</h3>
                    <Hint>{t('sticks.dzHint')}</Hint>
                    <div className="stack" style={{ gap: 12, marginTop: 8 }}>
                      <Slider label={t('sticks.start')} value={dz.begin / 10} min={0} max={20} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t('sticks.end')} value={dz.end / 10} min={10} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t('sticks.antiStart')} value={dz.beginAnti / 10} min={0} max={50} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t('sticks.antiEnd')} value={dz.endAnti / 10} min={50} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), endAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                      {(
                        [
                          { label: t('sticks.nStart'), key: 'begin', value: dz.begin / 10 },
                          { label: t('sticks.nEnd'), key: 'end', value: dz.end / 10 },
                          { label: t('sticks.nAntiStart'), key: 'beginAnti', value: dz.beginAnti / 10 },
                          { label: t('sticks.nAntiEnd'), key: 'endAnti', value: dz.endAnti / 10 }
                        ] as const
                      ).map((f) => (
                        <label key={f.key} className="row" style={{ gap: 6, fontSize: 12 }}>
                          <span className="label">{f.label}</span>
                          <input
                            className="input"
                            style={{ width: 76 }}
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={Number(f.value.toFixed(1))}
                            onChange={(e) => {
                              const v = Math.max(0, Math.min(100, Number(e.target.value)))
                              if (!Number.isFinite(v)) return
                              edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), [f.key]: Math.round(v * 10) }))
                            }}
                          />
                          <span style={{ color: 'var(--text-3)' }}>%</span>
                        </label>
                      ))}
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                      <button className="btn sm" onClick={() => edit(() => stick.applyPhysics(pkt))}>{t('sticks.physics')}</button>
                      <button className="choice-btn" onClick={() => edit(() => stick.setDeadzone(pkt, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 }))}><span className="choice-label">{t('sticks.factory')}</span></button>
                      <button className="choice-btn" title={t('sticks.tAim')} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 800 }))}><span className="choice-label">{t('sticks.aimEnd')}</span></button>
                      <button className="choice-btn" title={t('sticks.tFlick')} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 650 }))}><span className="choice-label">{t('sticks.flickEnd')}</span></button>
                      <button className="choice-btn" title={t('sticks.tSnap')} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 80 }))}><span className="choice-label">{t('sticks.antiSnap')}</span></button>
                      <button className="choice-btn" title={t('sticks.tMax')} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 150 }))}><span className="choice-label">{t('sticks.antiMax')}</span></button>
                      <button className="choice-btn" title={t('sticks.tOff')} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 0, endAnti: 1000 }))}><span className="choice-label">{t('sticks.antiOff')}</span></button>
                      <button
                        className="btn sm ghost"
                        title={t('sticks.watchTitle')}
                        disabled={!live || measuring !== null}
                        onClick={() => {
                          wanderRef.current = 0
                          setMeasuring({ left: 10, suggestion: null })
                        }}
                      >
                        {measuring ? `${t('sticks.measuring')} ${measuring.left}s` : t('sticks.centerGuard')}
                      </button>
                    </div>
                    {measuring?.suggestion !== null && measuring?.suggestion !== undefined && (
                      <div className="note warn" style={{ marginTop: 8 }}>
                        {t('sticks.suggest').replace('{dev}', String(measuring.suggestion.dev))}{' '}
                        <button
                          className="btn sm primary"
                          style={{ marginLeft: 8 }}
                          onClick={() => {
                            const pct10 = measuring.suggestion!.pct10
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: pct10 }))
                            setMeasuring(null)
                          }}
                        >
                          {t('sticks.setStart').replace('{pct}', String(measuring.suggestion.pct10 / 10))}
                        </button>{' '}
                        <button className="btn sm ghost" onClick={() => setMeasuring(null)}>{t('common.dismiss')}</button>
                      </div>
                    )}
                  </div>


                  <div className="card">
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
                </div>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card">
                    <h3>{t('sticks.curve')} — {design.length} {t('sticks.points')}</h3>
                    <Hint>{t('sticks.curveHint')}</Hint>
                    <CurvePlot points={design.length >= 2 ? design : padCurve} onChange={(next) => stageDesign(next)} overlay={quantized} smooth={spline} />
                    <div className="row" style={{ gap: 8, margin: '8px 0' }}>
                      <div style={{ flex: 1 }} />
                      <button className={`choice-btn${!spline ? ' active' : ''}`} onClick={() => { setSpline(false); stageDesign(design, false) }}><span className="choice-label">{t('sticks.linear')}</span></button>
                      <button className={`choice-btn${spline ? ' active' : ''}`} onClick={() => { setSpline(true); stageDesign(design, true) }}><span className="choice-label">{t('sticks.spline')}</span></button>
                      <button className="btn sm ghost" onClick={reloadDesignFromPad}>{t('sticks.reload')}</button>
                    </div>
                    <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
                      {Object.entries(AIM_CURVES).map(([key, c]) => (
                        <button
                          key={key}
                          className="choice-btn"
                          title={c.hint}
                          onClick={() => stageDesign(c.pts.map((p) => ({ ...p })))}
                        >
                          <span className="choice-label">{c.label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="row wrap" style={{ gap: 8, margin: '8px 0', alignItems: 'center' }}>
                      <button
                        className="btn sm"
                        title={t('sticks.saveTitle')}
                        onClick={() => {
                          const name = window.prompt('Name this curve:')
                          if (!name || !name.trim()) return
                          const clean = name.trim().slice(0, 24)
                          setPresets((prev) => {
                            const next = prev.filter((p) => p.name !== clean)
                            next.unshift({ name: clean, pts: design.map((p) => ({ ...p })) })
                            return next.slice(0, 20)
                          })
                        }}
                      >
                        {t('sticks.saveCurrent')}
                      </button>
                      {presets.map((p) => (
                        <span key={p.name} className="row" style={{ gap: 4, alignItems: 'center' }}>
                          <button
                            className="btn sm ghost"
                            title={`Apply ${p.name}`}
                            onClick={() => stageDesign(p.pts.map((q) => ({ ...q })))}
                          >
                            {p.name}
                          </button>
                          <button
                            className="btn sm ghost"
                            title={`Delete ${p.name}`}
                            onClick={() => setPresets((prev) => prev.filter((q) => q.name !== p.name))}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button
                        className="btn sm"
                        disabled={design.length >= DESIGN_MAX_POINTS}
                        onClick={() => stageDesign(addDesignPoint(design.length >= 2 ? design : padCurve))}
                      >
                        {t('sticks.addPoint')} ({design.length}/{DESIGN_MAX_POINTS})
                      </button>
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


                  <div className="card">
                    <h3>{t('sticks.shape')}</h3>
                    <Hint>{t('sticks.shapeHint')}</Hint>
                    <div className="stack" style={{ gap: 8 }}>
                      {(
                        [
                          { key: 'round', hintKey: 'sticks.shapeHintRound' },
                          { key: 'square', hintKey: 'sticks.shapeHintSquare' },
                          { key: 'raw', hintKey: 'sticks.shapeHintRaw' }
                        ] as const
                      ).map((s) => {
                        const isRaw = stick.isRawState(pkt)
                        const isSquare = stick.enabled(pkt) && stick.squareGate(pkt) && !isRaw
                        const isRound = stick.enabled(pkt) && !stick.squareGate(pkt) && !isRaw
                        const active = (s.key === 'round' && isRound) || (s.key === 'square' && isSquare) || (s.key === 'raw' && isRaw)
                        const label = s.key === 'round' ? t('sticks.shapeRound') : s.key === 'square' ? t('sticks.shapeSquare') : t('sticks.shapeRaw')
                        return (
                          <button
                            key={s.key}
                            className={`choice-btn${active ? ' active' : ''}`}
                            title={t(s.hintKey)}
                            onClick={() => {
                              edit(() => {
                                if (s.key === 'raw') {
                                  // True bypass: the untouched sensor output with real
                                  // circularity. All other bytes are left alone, so
                                  // leaving raw restores the previous tune exactly.
                                  stick.setEnabled(pkt, false)
                                } else {
                                  stick.setEnabled(pkt, true)
                                  stick.setSquareGate(pkt, s.key === 'square')
                                }
                              })
                            }}
                          >
                            <span className="choice-label">{label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                </div>
              </div>
              )}
              {tab === 'device' && (
              <div className="two" style={{ alignItems: 'start' }}>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card">
                    <h3>{t('device.polling')} - {allRates.map((o) => (o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz}`)).join(' / ')}</h3>
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


                  <div className="card">
                    <h3>{t('device.bits')} - 8-12</h3>
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
                  <div className="card">
                    <h3>{t('device.rate')}</h3>
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
                  <div className="card">
                    <h3>RC filter — {(which === 0 ? t('cal.left') : t('cal.right'))}</h3>
                    <Hint>Stick anti-jitter per stick, −10…+10, 0 = off. Stock and Connect-kept at 0 (Connect resets it). Higher steadies micro-jitter and adds a touch of lag. Tournament-legal smoothing — no macros, no turbo.</Hint>
                    <div className="stack" style={{ gap: 12, marginTop: 8 }}>
                      <Slider
                        label="RC level"
                        value={which === 0 ? fun.extend.lsRcLevel(fd) : fun.extend.rsRcLevel(fd)}
                        min={-10}
                        max={10}
                        step={1}
                        unit=""
                        onChange={(v) => edit(() => {
                          const level = Math.max(-10, Math.min(10, Math.round(v)))
                          if (which === 0) fun.extend.setLsRcLevel(fd, level)
                          else fun.extend.setRsRcLevel(fd, level)
                        })}
                        format={(v) => (v === 0 ? 'off' : `${v > 0 ? '+' : ''}${Math.round(v)}`)}
                      />
                      <div className="row wrap" style={{ gap: 8 }}>
                        <button
                          className={`choice-btn${(which === 0 ? fun.extend.lsRcLevel(fd) : fun.extend.rsRcLevel(fd)) === 0 ? ' active' : ''}`}
                          title="Wire 11 — stock, Connect-kept"
                          onClick={() => edit(() => {
                            if (which === 0) fun.extend.setLsRcLevel(fd, 0)
                            else fun.extend.setRsRcLevel(fd, 0)
                          })}
                        >
                          <span className="choice-label">Off (0)</span>
                        </button>
                        <span className="mono">stored wire: {which === 0 ? fun.extend.lsAntiJitter(fd) : fun.extend.rsAntiJitter(fd)}</span>
                      </div>
                    </div>
                  </div>

                </div>
              </div>
              )}
            </>
          )}
          {tab === 'buttons' && connected && profile && (
            <>
            <TriggerDeadzoneCard profile={profile} edit={edit} />
            <div className="card" style={{ marginTop: 16 }}>
              <h3>{t('buttons.title')}</h3>
              <Hint>
                {t('buttons.hint')}
                <br /><br />
                {t('buttons.backs')}
                {modelId === 'G7ProCE' && (<><br /><br />{t('buttons.backsExtra')}</>)}
                {modelId === 'T3CE' && (<><br /><br />{t('buttons.frontExtra')}<br /><br />{t('buttons.tExtra')}</>)}
              </Hint>
              <table className="tbl" style={{ marginTop: 8 }}>
                <thead><tr><th>{t('buttons.source')}</th><th>{t('buttons.target')}</th><th>{t('buttons.effective')}</th></tr></thead>
                <tbody>
                  {([
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
                  ] as Array<{ name: string; value: number; tag?: string; pkt: Packet | null }>).map((row) => {
                    const pkt = row.pkt
                    if (!pkt) return null
                    const values = button.mapValues(pkt)
                    const current = values.find((v) => v !== 0) ?? 0
                    return (
                      <tr key={row.name}>
                        <td><span className="row" style={{ gap: 7, alignItems: 'center' }}><KeyIcon value={row.value} tag={row.tag} />{row.name}</span></td>
                        <td>
                          <KeySelect
                            value={current}
                            disabled={busy || locked}
                            open={bindOpen === row.name}
                            onToggle={() => setBindOpen(bindOpen === row.name ? null : row.name)}
                            onClose={() => setBindOpen(null)}
                            onPick={(v) => edit(() => button.setMap(pkt, [v, 0, 0]))}
                          />
                        </td>
                        <td><span className="row" style={{ gap: 7, alignItems: 'center' }}>{current !== 0 && <KeyIcon value={current} />}{displayMapping(values)}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </main>
    </div>
    </LangContext.Provider>
  )
}

