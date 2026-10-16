import { GyroTuning } from './Gyro'
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

function CurvePlot({ points, onChange, overlay, max = 255 }: { points: Array<{ x: number; y: number }>; onChange?: (next: Array<{ x: number; y: number }>) => void; overlay?: Array<{ x: number; y: number }>; max?: number }): JSX.Element {
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
    const h = 200
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
    const h = 200
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
    // Drawn exactly as placed: the design is a polyline, and the pad samples it
    // straight at its 5 slots, so the canvas shows the same thing the pad gets.
    points.forEach((p, i) => {
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
  }, [points, overlay, max])
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
  zamilitox: {
    label: 'Zamilitox',
    hint: 'shared S-curve: hot start, settled edge',
    pts: [{ x: 0, y: 0 }, { x: 26, y: 48 }, { x: 71, y: 89 }, { x: 128, y: 128 }, { x: 184, y: 166 }, { x: 230, y: 204 }, { x: 255, y: 255 }]
  },
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

function CalibrationPanel(): JSX.Element {
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
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('cal.bench')}</h3>
      <Hint>{t('cal.intro')}</Hint>
      <div className="row" style={{ gap: 20, justifyContent: 'center', margin: '12px 0' }}>
        {live ? (
          <>
            <StickDial x={live.lx} y={live.ly} label={t('cal.left')} />
            <StickDial x={live.rx} y={live.ry} label={t('cal.right')} />
          </>
        ) : (
          <Hint>{t('cal.waiting')}</Hint>
        )}
      </div>
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
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <span className="label">{t('cal.manual')}</span>
        <button className="btn sm" disabled={busy || !!flow || inCal} onClick={() => void enter()}>1 · {t('cal.open')}</button>
        <button className="btn sm primary" disabled={busy || !!flow || !inCal} onClick={() => void commit()}>2 · {t('cal.commit')}</button>
        <button className="btn sm ghost" disabled={busy || !!flow || !inCal} onClick={() => void cancel()}>{t('cal.cancel')}</button>
      </div>
      {note && <div className="note" style={{ marginBottom: 8 }}>{note}</div>}
      {err && <div className="note bad" style={{ marginBottom: 8 }}>{err}</div>}
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
      <Hint style={{ marginTop: 8 }}>{t('cal.tipRest')}</Hint>
      <div className="note warn" style={{ marginTop: 8 }}>{t('cal.driftWarn')} {t('cal.driftWarn2')}</div>
    </div>
  )
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
      return glyphWrap(s, <><circle cx={10} cy={10} r={8} fill="#33333d" /><circle cx={10} cy={10} r={3} fill="#8a8a96" /></>)
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
    default: return null
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
    default: return null
  }
}

/**
 * Icon dropdown for remap targets — native <select> cannot render icons,
 * so this renders a button + a portal popup (position:fixed, so card and
 * table scrolling cannot clip it). Closes on pick, Escape, outside click,
 * scroll or resize. Only one row's popup is open at a time (lifted state).
 */
function KeySelect({ value, disabled, open, onToggle, onClose, onPick, options, getLabel, renderIcon }: {
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
          {opts.map((o) => (
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
  trigger: LjTriggerZones | null
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
function LjLiveCard({ live }: { live: { lx: number; ly: number; rx: number; ry: number } | null }): JSX.Element {
  const t = useT()
  return (
    <div className="card">
      <h3>{t('sticks.live')}</h3>
      <Hint>{t('lj.liveHint')}</Hint>
      <StickCross lx={live?.lx ?? 128} ly={live?.ly ?? 128} rx={live?.rx ?? 128} ry={live?.ry ?? 128} />
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
  const box = (key: keyof LjStickZones, label: string): JSX.Element => (
    <label className="row" style={{ gap: 6, fontSize: 12 }}>
      <span className="label">{label}</span>
      <input
        className="input"
        style={{ width: 76 }}
        type="number"
        min={0}
        max={100}
        step={0.1}
        value={Number((z[key] / 10).toFixed(1))}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isFinite(v)) return
          apply({ [key]: Math.round(Math.max(0, Math.min(100, v)) * 10) })
        }}
      />
      <span style={{ color: 'var(--text-3)' }}>%</span>
    </label>
  )
  return (
    <div className="card">
      <h3>{t('sticks.deadzone')} — {t('sticks.steps01')}</h3>
      <Hint>{t('lj.zoneHint')}</Hint>
      <div className="stack" style={{ gap: 12, marginTop: 8 }}>
        {slider('start', t('sticks.start'))}
        {slider('end', t('sticks.end'))}
        {slider('antiStart', t('sticks.antiStart'))}
        {slider('antiEnd', t('sticks.antiEnd'))}
      </div>
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        {box('start', t('sticks.nStart'))}
        {box('end', t('sticks.nEnd'))}
        {box('antiStart', t('sticks.nAntiStart'))}
        {box('antiEnd', t('sticks.nAntiEnd'))}
      </div>
      <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn sm" onClick={() => onChange(toPts(ljLinearCurve({ ...z, antiStart: 0, antiEnd: 1000 })))}>{t('sticks.physics')}</button>
        <button className="choice-btn" onClick={() => apply({ start: 50, end: 1000, antiStart: 0, antiEnd: 1000 })}><span className="choice-label">{t('sticks.factory')}</span></button>
        <button className="choice-btn" title={t('sticks.tAim')} onClick={() => apply({ end: 800 })}><span className="choice-label">{t('sticks.aimEnd')}</span></button>
        <button className="choice-btn" title={t('sticks.tFlick')} onClick={() => apply({ end: 650 })}><span className="choice-label">{t('sticks.flickEnd')}</span></button>
        <button className="choice-btn" title={t('sticks.tSnap')} onClick={() => apply({ antiStart: 80 })}><span className="choice-label">{t('sticks.antiSnap')}</span></button>
        <button className="choice-btn" title={t('sticks.tMax')} onClick={() => apply({ antiStart: 150 })}><span className="choice-label">{t('sticks.antiMax')}</span></button>
        <button className="choice-btn" title={t('sticks.tOff')} onClick={() => apply({ antiStart: 0, antiEnd: 1000 })}><span className="choice-label">{t('sticks.antiOff')}</span></button>
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
    <div className="card">
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
    <div className="card">
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

function LjCurveCard({ snap, side, points, onChange, onReset, onCopyToOther }: {
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
  const zones = ljCurveZones(toPairs(points))
  const setPoint = (i: number, axis: 'x' | 'y', v: number): void => {
    if (!Number.isFinite(v)) return
    const next = points.map((p) => ({ ...p }))
    if (axis === 'x') {
      const lo = i > 0 ? next[i - 1].x : 0
      const hi = i < next.length - 1 ? next[i + 1].x : 1000
      next[i].x = Math.max(lo, Math.min(hi, Math.round(v * 10)))
    } else {
      next[i].y = Math.max(0, Math.min(1000, Math.round(v * 10)))
    }
    onChange(next)
  }
  return (
    <div className="card">
      <h3>{t('sticks.curve')} — 8 {t('sticks.points')}</h3>
      <Hint>{t('lj.stickHint')}</Hint>
      <CurvePlot points={points} max={1000} overlay={padPts} onChange={(next) => onChange(next.map((p) => ({ ...p })))} />
      <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
        {Object.entries(AIM_CURVES).map(([key, c]) => (
          <button key={key} className="choice-btn" title={c.hint} onClick={() => onChange(toPts(ljSampleDesign(c.pts, zones)))}>
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
              next.unshift({ name: clean, pts: points.map((p) => ({ ...p })) })
              return next.slice(0, 20)
            })
          }}
        >
          {t('sticks.saveCurrent')}
        </button>
        {presets.map((p) => (
          <span key={p.name} className="row" style={{ gap: 4, alignItems: 'center' }}>
            <button className="btn sm ghost" title={`Apply ${p.name}`} onClick={() => onChange(p.pts.map((q) => ({ ...q })))}>
              {p.name}
            </button>
            <button className="btn sm ghost" title={`Delete ${p.name}`} onClick={() => setPresets((prev) => prev.filter((q) => q.name !== p.name))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn sm" disabled title={t('lj.fixedPoints')}>{t('sticks.addPoint')} (8/8)</button>
        <button className="btn sm ghost" title={t('lj.copyOther')} onClick={onCopyToOther}>{t('sticks.copyCurve')}</button>
        <button className="btn sm ghost" onClick={() => onChange(toPts(ljLinearCurve(zones)))}>{t('sticks.resetCurve')}</button>
        <button className="btn sm ghost" disabled={!dirty} onClick={onReset}>{t('sticks.reload')}</button>
      </div>
      <table className="tbl" style={{ marginTop: 8 }}>
        <thead><tr><th>#</th><th>X</th><th>Y</th></tr></thead>
        <tbody>
          {points.map((p, i) => (
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
  )
}

/**
 * LeadJoy trigger editor: LT/RT inner/outer deadzones. Modes and vibration
 * thresholds pass through from the pad read untouched; edits stage upward and
 * the topbar Write sends the whole trigger image with readback.
 */
function LjTriggerCard({ value, onChange, onReset }: {
  value: LjTriggerZones
  onChange: (zones: LjTriggerZones) => void
  onReset: () => void
}): JSX.Element {
  const t = useT()
  const num = (v: number): number => Math.max(0, Math.min(100, Math.round(v)))
  return (
    <div className="card">
      <h3>{t('lj.trigTitle')}</h3>
      <Hint>{t('lj.trigHint')}</Hint>
      <div className="stack" style={{ gap: 12, marginTop: 8 }}>
        <Slider label={`LT ${t('lj.inner')}`} value={value.leftInner} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => onChange({ ...value, leftInner: Math.min(num(v), value.leftOuter) })} />
        <Slider label={`LT ${t('lj.outer')}`} value={value.leftOuter} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => onChange({ ...value, leftOuter: Math.max(num(v), value.leftInner) })} />
        <Slider label={`RT ${t('lj.inner')}`} value={value.rightInner} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => onChange({ ...value, rightInner: Math.min(num(v), value.rightOuter) })} />
        <Slider label={`RT ${t('lj.outer')}`} value={value.rightOuter} min={0} max={100} step={1} format={(v) => `${v}%`} onChange={(v) => onChange({ ...value, rightOuter: Math.max(num(v), value.rightInner) })} />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm ghost" onClick={onReset}>{t('lj.reset')}</button>
      </div>
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
    <div className="card">
      <h3>{t('device.rate')}</h3>
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
  // LeadJoy Saber Plus — surfaced through the same UI as the GameSir pads.
  // Edits stage into `ljDraft`; the topbar Write commits them record by
  // record (each verified with readback); slots switch from the topbar.
  const [ljPath, setLjPath] = useState<string | null>(null)
  const [ljSnap, setLjSnap] = useState<LjSnapshot | null>(null)
  const [ljBusy, setLjBusy] = useState(false)
  const [ljSlot, setLjSlot] = useState<0 | 1 | 2>(0)
  const [ljDraft, setLjDraft] = useState<LjDraft>({ buttons: {}, sticks: {}, trigger: null, shapes: {}, mouse: {} })
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
  const [tab, setTab] = useState<'sticks' | 'device' | 'buttons' | 'gyro' | 'profiles' | 'lab' | 'calibrate' | 'language' | 'theme'>('sticks')
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
  // slot+stick so a half-finished shape survives a reload. Sampling is always
  // straight-line: the pad interpolates its 5 slots linearly, so smoothing the
  // design first would only invent values the hardware never sees.
  const [design, setDesign] = useState<Array<{ x: number; y: number }>>([])
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
    setLjDraft({ buttons: {}, sticks: {}, trigger: null, shapes: {}, mouse: {} })
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

  /** Stage the trigger deadzones; `null` reverts to the pad. */
  function stageLjTrigger(zones: LjTriggerZones | null): void {
    setLjDraft((prev) => ({ ...prev, trigger: zones }))
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
      if (ljDraft.trigger && JSON.stringify(ljDraft.trigger) !== JSON.stringify(ljPadZones)) {
        await api().leadjoyWriteTrigger({ path: ljPath, slot: ljSlot, zones: ljDraft.trigger })
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
      if (pre && pre.support === 'detect-only') {
        // Named but layout-unproven: no GameSir handshake — foreign bytes on
        // another vendor's pad buy nothing and the timeout only confuses. The
        // Saber Plus drives the same UI from here (connected, slot read on
        // connect); other detect-only pads stay locked as before.
        setModel(pre)
        setPid(cand?.productId ?? null)
        setBlob(null)
        setLjSnap(null)
        setLjDraft({ buttons: {}, sticks: {}, trigger: null, shapes: {}, mouse: {} })
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
  const ljZones = ljDraft.trigger ?? ljPadZones
  const ljDirty =
    isLj &&
    (Object.entries(ljDraft.buttons).some(([id, v]) => !ljSameTarget(v, ljPadTarget(Number(id)))) ||
      ([0, 1] as const).some((s) => ljDraft.sticks[s] !== undefined && JSON.stringify(ljDraft.sticks[s]) !== JSON.stringify(ljPadGrid(s))) ||
      Object.entries(ljDraft.shapes).some(([side, code]) => code !== ljPadShape(Number(side) as 0 | 1)) ||
      Object.entries(ljDraft.mouse).some(([side, m]) => {
        const pad = ljPadMouse(Number(side) as 0 | 1)
        return m.enabled !== pad.enabled || m.rate !== pad.rate
      }) ||
      (ljDraft.trigger !== null && JSON.stringify(ljDraft.trigger) !== JSON.stringify(ljPadZones)))

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

  const quantized = design.length >= 2 ? resampleCurve(design) : pts
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
  function stageDesign(next: Array<{ x: number; y: number }>): void {
    setDesign(next)
    if (!pkt || next.length < 2) return
    const q = resampleCurve(next)
    const cur = stick.curve(pkt)
    if (q.length === cur.length && q.every((p, i) => p.x === cur[i].x && p.y === cur[i].y)) return
    edit(() => {
      stick.setCurve(pkt, q.map((p) => ({ ...p })))
      stick.markCurveIdentity(pkt)
    })
  }

  return (
    <LangContext.Provider value={{ lang, setLang }}>
    <ThemeContext.Provider value={{ theme, setTheme }}>
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Stick <span>Labs</span></h1>
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
            <button type="button" className={`nav-item${tab === 'gyro' ? ' active' : ''}`} onClick={() => setTab('gyro')}>
              Gyro
            </button>
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
              <>{model?.marketingName}<br />{t('lj.version')} {ljSnap.version} · {t('lj.board')} {ljSnap.board}</>
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
            <h2>Stick Labs</h2>
            <span className="sub">{t('topbar.sub')}</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {isLj
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
                    disabled={!connected || busy || locked}
                    onClick={() => void loadSlot(s)}
                  >
                    <span className="choice-label">P{s}</span>
                  </button>
                ))}
            <button
              className="btn sm primary"
              disabled={isLj ? ljBusy || !ljDirty : !connected || !dirty || busy || locked}
              onClick={() => void (isLj ? writeLeadJoyDraft() : write())}
            >
              {(isLj ? ljBusy : busy) ? t('common.working') : t('top.write')}
            </button>
            {(isLj ? ljDirty : dirty) && <span className="pill warn">{t('msg.unsaved')}</span>}
            {!(isLj ? ljDirty : dirty) && savedAt && savedAt.slot === (isLj ? ljSlot + 1 : slot) && (
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
          {(isLj ? ljDirty : dirty) && <div className="note warn">{t('msg.dirty')}</div>}
          {!connected && (
            <div className="msg"><h3>{t('msg.connect')}</h3><p>{t('msg.models')} {t('msg.connectBody')}</p></div>
          )}
          {isLj && (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                {(['Left', 'Right'] as const).map((n, i) => (
                  <button key={n} className={`choice-btn${i === which ? ' active' : ''}`} onClick={() => setWhich(i)}>
                    <span className="choice-label">{(n === 'Left' ? t('cal.left') : t('cal.right'))} {t('sticks.stick')}</span>
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="pill">{model?.marketingName} · {(['Main', 'Sub1', 'Sub2'] as const)[ljSlot]}</span>
              </div>
              {!ljSnap && <div className="msg"><h3>{ljBusy ? t('lj.reading') : t('msg.loading')}</h3></div>}
              {ljSnap && tab === 'sticks' && (() => {
                const side = (which === 0 ? 0 : 1) as 0 | 1
                const other = (side === 0 ? 1 : 0) as 0 | 1
                const pts = ljStickPoints(side)
                return (
                  <div className="two" style={{ alignItems: 'start' }}>
                    <div className="stack" style={{ gap: 16 }}>
                      <LjLiveCard live={ljLive} />
                      <LjZonesCard points={pts} onChange={(next) => stageLjStick(side, next)} />
                      <LjOuterCard points={pts} onChange={(next) => stageLjStick(side, next)} />
                    </div>
                    <div className="stack" style={{ gap: 16 }}>
                      <LjCurveCard
                        snap={ljSnap}
                        side={side}
                        points={pts}
                        onChange={(next) => stageLjStick(side, next)}
                        onReset={() => stageLjStick(side, null)}
                        onCopyToOther={() => stageLjStick(other, pts.map((p) => ({ ...p })))}
                      />
                      <LjShapeCard shape={ljDraft.shapes[side] ?? ljPadShape(side)} busy={ljBusy} onChange={(code) => stageLjShape(side, code)} />
                    </div>
                  </div>
                )
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
                <>
                  {ljZones && <LjTriggerCard value={ljZones} onChange={stageLjTrigger} onReset={() => stageLjTrigger(null)} />}
                  <div className="card" style={{ marginTop: 16 }}>
                    <h3>{t('buttons.title')}</h3>
                    <Hint>{t('lj.bindHint')}</Hint>
                    <table className="tbl" style={{ marginTop: 8 }}>
                      <thead><tr><th>{t('buttons.source')}</th><th>{t('buttons.target')}</th><th>{t('buttons.effective')}</th></tr></thead>
                      <tbody>
                        {(() => {
                          const ljOptions = [
                            { value: 0, label: t('buttons.unmapped') },
                            ...ljSnap.buttons.map((b) => ({ value: b.id, label: b.label })),
                            ...LJ_HID_KEYS.map((k) => ({ value: LJ_TARGET_KEY_BASE + k.code, label: k.label })),
                            ...LJ_MOUSE_BUTTONS.map((k) => ({ value: LJ_TARGET_MOUSE_BASE + k.code, label: k.label }))
                          ]
                          const ljLabel = (v: number): string => ljTargetLabel(ljDecodeTarget(v)) ?? t('buttons.unmapped')
                          // Gamepad targets get the pad glyphs; keys/mouse are text-only.
                          const ljIcon = (v: number): JSX.Element | null =>
                            v > 0 && v < LJ_TARGET_KEY_BASE ? <LjKeyIcon id={v} /> : null
                          const rows = [
                            ...[24, 25, 26, 27].map((id) => ({ id, phys: LJ_PHYSICAL[id] ?? '' })),
                            ...ljSnap.buttons.filter((b) => b.id !== 24 && b.id !== 25 && b.id !== 26 && b.id !== 27).map((b) => ({ id: b.id, phys: '' }))
                          ]
                          return rows.map((row) => {
                            const snap = ljSnap.buttons.find((b) => b.id === row.id)
                            const staged = ljDraft.buttons[row.id]
                            const padMap = snap?.map && snap.map.t !== 0 ? snap.map : null
                            const current = staged !== undefined ? staged : padMap
                            // An uncaptured kind (e.g. Macro) stays read-only text.
                            const known = current === null || [LJ_MAP_GAMEPAD, LJ_MAP_KEYBOARD, LJ_MAP_MOUSE].includes(current.t)
                            const label = current ? (ljTargetLabel(current) ?? t('buttons.unmapped')) : t('buttons.unmapped')
                            const sourceName = row.phys ? `${row.phys} · ${snap?.label ?? ''}` : (snap?.label ?? `ID ${row.id}`)
                            return (
                              <tr key={row.id}>
                                <td><span className="row" style={{ gap: 7, alignItems: 'center' }}><LjKeyIcon id={row.id} />{sourceName}</span></td>
                                <td>
                                  {known ? (
                                    <KeySelect
                                      value={current ? ljEncodeTarget(current) : 0}
                                      disabled={ljBusy}
                                      open={bindOpen === `lj-${row.id}`}
                                      onToggle={() => setBindOpen(bindOpen === `lj-${row.id}` ? null : `lj-${row.id}`)}
                                      onClose={() => setBindOpen(null)}
                                      onPick={(v) => stageLjButton(row.id, v === 0 ? null : ljDecodeTarget(v))}
                                      options={ljOptions}
                                      getLabel={ljLabel}
                                      renderIcon={ljIcon}
                                    />
                                  ) : (
                                    <span className="mono">{label}</span>
                                  )}
                                </td>
                                <td><span className="row" style={{ gap: 7, alignItems: 'center' }}>{current && ljIcon(ljEncodeTarget(current))}{label}</span></td>
                              </tr>
                            )
                          })
                        })()}
                      </tbody>
                    </table>
                  </div>
                </>
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
                    <CurvePlot points={design.length >= 2 ? design : padCurve} onChange={(next) => stageDesign(next)} overlay={quantized} />
                    <div className="row" style={{ gap: 8, margin: '8px 0' }}>
                      <div style={{ flex: 1 }} />
                      <button className="btn sm ghost" disabled={busy} onClick={() => void reloadCurveFromPad()}>{t('sticks.reload')}</button>
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

                </div>
              </div>
              )}
            </>
          )}
          {tab === 'gyro' && (connected && profile && !locked && modelId === 'G7ProCE'
            ? <GyroTuning key={`${slot}:${loadId}`} profile={profile} edit={edit} busy={busy} />
            : <div className="note">Connect a supported G7 Pro 8K and load a profile to edit gyro settings.</div>)}
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
          {tab === 'profiles' && (
            isLj ? (
              <div className="msg">
                <h3>{model?.marketingName} — {t('lj.profilesLockedTitle')}</h3>
                <p>{t('lj.profilesLockedBody')}</p>
              </div>
            ) : (
              <ProfilesPanel connected={connected} activeSlot={info?.currentProfile ?? null} locked={locked} modelId={modelId} modelLen={modelLen} dumpLength={model?.dumpLength ?? 0} modelName={model?.marketingName ?? null} />
            )
          )}
          {tab === 'calibrate' && (
            connected && model?.support === 'full' ? (
              <CalibrationPanel />
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
