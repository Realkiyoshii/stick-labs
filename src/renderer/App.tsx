import { useEffect, useRef, useState } from 'react'
import { api, b64ToBytes, bytesToB64, type Candidate, type DeviceInfo, type DeviceStats, type LiveSample, type PingResult } from './api'
import { parseProfile, serializeProfile, fun, stick, LINEAR_CURVE, looksLikeCEProfile } from '@shared/profile'
import { PROFILE_LENGTH, REPORT_RATE_OPTIONS, STICK_RESOLUTION_OPTIONS } from '@shared/protocol'
import { identifyModel, MODELS, type ControllerModel } from '@shared/models'
import {
  describeRawResolution,
  bitsToLevels,
  bitsToWireRaw,
  EXTENDED_BITS,
  resampleCurve,
  addDesignPoint,
  DESIGN_MIN_POINTS,
  DESIGN_MAX_POINTS,
  outerBufferFromBytes,
  isOuterUnlimited
} from '@shared/sticklab'

function Slider(props: {
  label: string
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

function CurvePlot({ points, onChange, overlay }: { points: Array<{ x: number; y: number }>; onChange?: (next: Array<{ x: number; y: number }>) => void; overlay?: Array<{ x: number; y: number }> }): JSX.Element {
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
    next[i] = { x, y }
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
    ctx.strokeStyle = '#262c3a'
    for (let i = 0; i <= 4; i++) {
      const t = (i / 4) * (w - pad * 2) + pad
      ctx.beginPath()
      ctx.moveTo(t, pad)
      ctx.lineTo(t, h - pad)
      ctx.stroke()
    }
    ctx.strokeStyle = '#3a4256'
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
    ctx.strokeStyle = '#4f9dff'
    ctx.lineWidth = 2
    ctx.beginPath()
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
      ctx.fillStyle = drag.current !== null ? '#f5b544' : '#7db8ff'
      ctx.beginPath()
      ctx.arc(toX(p.x), toY(p.y), 5, 0, Math.PI * 2)
      ctx.fill()
    })
  }, [points, overlay])
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
 * curve bytes only, +14..+23.
 */
const AIM_CURVES: Record<string, { label: string; hint: string; pts: Array<{ x: number; y: number }> }> = {
  linear: { label: 'Linear', hint: '1:1 raw', pts: [...LINEAR_CURVE] },
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
  },
  expo: {
    label: 'Expo',
    hint: 'late surge',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 16 }, { x: 128, y: 70 }, { x: 191, y: 158 }, { x: 255, y: 255 }]
  }
}

function AnalyticsPanel({ context }: { context: string }): JSX.Element {
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
        ctx.strokeStyle = '#262c3a'
        for (let i = 1; i <= 3; i++) {
          const y = h - (i / 3) * h
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
        }
        history.forEach((v, i) => {
          const bh = (v / max) * h
          ctx.fillStyle = v >= 480 ? '#3ecf8e' : v >= 200 ? '#4f9dff' : '#f5b544'
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
      <h3>Analytics — polling, latency, stick range</h3>
      <div className="hint">{context}</div>
      <div className="two" style={{ alignItems: 'start', marginTop: 10 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`pill${rate >= 480 ? ' good' : rate > 0 ? ' warn' : ''}`}>{rate || '—'} Hz now</span>
            <span className="pill">{avg || '—'} Hz avg</span>
            <span className="pill">{frames.toLocaleString()} frames</span>
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</button>
          </div>
          <canvas ref={chartRef} className="plot" style={{ height: 120 }} />
          <div className="note">Measured from the 0x12 input stream. Gear 5 streams ~500/s; gears 0–4 ~250/s — the 1K–8K labels are the USB poll claim, not the state rate.</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" disabled={pinging} onClick={() => void runPing()}>{pinging ? 'Measuring…' : 'Run 15 pings'}</button>
            {pingError && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{pingError}</span>}
            {ping && <span className="mono">median {ping.median.toFixed(1)} ms · mean {ping.mean.toFixed(1)} ms · min {ping.min.toFixed(1)} · max {ping.max.toFixed(1)}</span>}
          </div>
          <div className="note">Ping times ReadCurrentProfile end-to-end (USB + firmware). Under ~3 ms is healthy; near 100 ms means contention.</div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row spread">
            <span className="label">Observed stick range (session)</span>
            <button className="btn sm ghost" onClick={() => setExtents(null)}>Reset</button>
          </div>
          <table className="tbl">
            <thead><tr><th>Axis</th><th>Min</th><th>Max</th><th>Span</th></tr></thead>
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
          <div className="note">
            {extents ? `${extents.n.toLocaleString()} samples. Full span ≈ 255; rest should sit near 128 — a stuck min/max far from centre means drift or a bad calibration.` : 'Move both sticks through their full range to map it.'}
          </div>
        </div>
      </div>
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

function ProfilesPanel({ connected, activeSlot, locked, modelId, modelLen, dumpLength, modelName }: { connected: boolean; activeSlot: number | null; locked: boolean; modelId: string; modelLen: number; dumpLength: number; modelName: string | null }): JSX.Element {
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

  if (!connected) return <div className="note">Connect a controller to manage stick profiles.</div>
  if (locked) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Locked — {modelName ?? 'unknown model'}</h3>
        <div className="hint">Profile backup is disabled for this model — its profile layout is unverified, so reads and writes stay off.</div>
        {dumpLength > 0 ? (
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button
              className="btn sm"
              disabled={busy}
              title="Read-only: dumps all 4 slots for support analysis. Writes nothing."
              onClick={() => void (async () => {
                setBusy(true)
                setMessage(null)
                try {
                  const dump: Record<string, { name: string; bytes: string }> = {}
                  for (const s of [1, 2, 3, 4]) {
                    const res = await api().readProfile(s, dumpLength)
                    const bytes = b64ToBytes(res.bytes)
                    let name = ''
                    try {
                      name = parseProfile(bytes, modelId).name
                    } catch {
                      name = ''
                    }
                    dump[String(s)] = { name, bytes: bytesToB64(bytes) }
                  }
                  download(
                    `sticklabs-dump-${modelId}-${new Date().toISOString().slice(0, 10)}.json`,
                    JSON.stringify({ version: 1, app: 'stick-labs-dump', model: modelId, length: dumpLength, profiles: dump }, null, 2)
                  )
                  setMessage('Dump downloaded — send it to RealKiyoshi to unlock this model.')
                } catch (e) {
                  setMessage(`Dump failed: ${(e as Error).message}`)
                } finally {
                  setBusy(false)
                }
              })()}
            >
              {busy ? 'Reading…' : 'Export raw dump for support'}
            </button>
            {message && <span className="pill">{message}</span>}
          </div>
        ) : (
          <div className="note" style={{ marginTop: 10 }}>No dump length is known for this model yet, so even read-only export stays off.</div>
        )}
      </div>
    )
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Stick profiles — backup &amp; transfer</h3>
      <div className="hint">Each slot is a 1070-byte blob; this card only reads/writes whole slots, so stick bytes are never half-merged.</div>
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn sm" disabled={busy} onClick={() => void refreshAll()}>{busy ? 'Working…' : 'Read all from controller'}</button>
        <button className="btn sm" disabled={busy} onClick={() => void backupAll()}>Backup all → JSON</button>
        <button className="btn sm" disabled={busy} onClick={restoreAll}>Restore all → controller</button>
        {message && <span className="pill">{message}</span>}
      </div>
      <table className="tbl">
        <thead><tr><th>Slot</th><th>Name</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.index}>
              <td className="mono">P{entry.index}</td>
              <td>{entry.loading ? 'reading…' : entry.error ? <span style={{ color: 'var(--bad)' }}>{entry.error} <button className="btn sm ghost" disabled={busy} onClick={() => void readSlot(entry.index)}>Retry</button></span> : (entry.name || <span style={{ color: 'var(--text-3)' }}>unnamed</span>)}</td>
              <td>{entry.index === activeSlot ? <span className="pill good">current</span> : <span className="tag">—</span>}</td>
              <td>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm ghost" disabled={busy} onClick={() => void exportSlot(entry, 'bin')}>Export</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => void exportSlot(entry, 'json')}>JSON</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => handleImport(entry)}>Import…</button>
                  <select className="input" style={{ width: 110 }} disabled={busy} value="" onChange={(e) => { if (e.target.value) void copyTo(entry, Number(e.target.value)) }}>
                    <option value="">Copy to…</option>
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
      ctx.strokeStyle = '#262c3a'
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
      ctx.fillStyle = '#4f9dff'
      ctx.beginPath()
      ctx.arc(px, py, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#8b93a7'
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
  // everything rather than an empty list.
  const visibleCandidates = candidates.some((c) => c.live === true)
    ? candidates.filter((c) => c.live === true || c.live === null || c.path === connPath)
    : candidates
  const [connected, setConnected] = useState(false)
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [pid, setPid] = useState<number | null>(null)
  const [model, setModel] = useState<ControllerModel | null>(null)
  const [slot, setSlot] = useState(3)
  const [blob, setBlob] = useState<Uint8Array | null>(null)
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [which, setWhich] = useState(0)
  const [live, setLive] = useState<LiveSample | null>(null)
  const [rawRes, setRawRes] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadId, setLoadId] = useState(0)
  const [measuring, setMeasuring] = useState<{ left: number; suggestion: { dev: number; pct10: number } | null } | null>(null)
  const wanderRef = useRef(0)
  const modelLenRef = useRef(PROFILE_LENGTH)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [showSafety, setShowSafety] = useState(() => {
    try {
      return window.localStorage.getItem('sticklabs.seenSafety') !== '1'
    } catch {
      return true
    }
  })
  // Free-point curve design (2–8 pts). The pad only stores 5, so this is a
  // design canvas — `quantized` is what actually gets written. Persisted per
  // slot+stick so a half-finished shape survives a reload.
  const [design, setDesign] = useState<Array<{ x: number; y: number }>>([])
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
      setMsg('Reconnected — profile reloaded.')
      void loadSlot(slot)
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
      setErr((e as Error).message)
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
      setRawRes('')
      setLoadId((n) => n + 1)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function write(): Promise<void> {
    if (!blob) return
    setBusy(true)
    setMsg(null)
    setErr(null)
    try {
      const res = await api().writeProfile(slot, bytesToB64(blob), modelLen)
      if (res.verified) {
        const liveNow = info?.currentProfile
        if (liveNow !== undefined && liveNow !== slot) {
          setMsg(`Slot ${slot} written + verified — but the pad is running P${liveNow}, so nothing changed yet. Use Activate P${slot} in the top bar to apply it (the pad reboots ~2 s).`)
        } else {
          setMsg(`Slot ${slot} written + read-back verified. If the pad reboots (~1-2 s), it is applying the change — reconnect if needed.`)
        }
        setDirty(false)
      } else if (res.rolledBack) {
        setErr('Write did not verify — previous bytes restored.')
        await loadSlot(slot)
      }
    } catch (e) {
      setErr((e as Error).message)
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

  const quantized = design.length >= 2 ? resampleCurve(design) : pts
  const locked = connected && (!model || model.support !== 'full')
  const modelId = model?.id ?? 'G7ProCE'
  const modelLen = model && model.profileLength > 0 ? model.profileLength : PROFILE_LENGTH
  modelLenRef.current = modelLen
  const padCurve = pts
  const curvePending = quantized.length === padCurve.length && quantized.some((q, i) => q.x !== padCurve[i].x || q.y !== padCurve[i].y)

  function reloadDesignFromPad(): void {
    if (pkt) setDesign(stick.curve(pkt).map((p) => ({ ...p })))
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>Stick <span>Labs</span></h1>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <button className="btn ghost sm" onClick={() => void refresh()}>Rescan USB</button>
          <button
            className="btn ghost sm"
            title="Copy device + app details for support (nothing personal)"
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
            Copy diagnostics
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
              }}
            >
              Disconnect
            </button>
          )}
          <div className="note">
            Match: VID 0x3537 + usagePage 0xFFF0/0x40. Never match PID — it varies by color/mode.
            {info && <><br />FW {info.firmware} · live slot P{info.currentProfile}</>}
            {model && <><br />{model.marketingName}{model.support !== 'full' ? ' · tuning locked' : ''}</>}
            {pid !== null && <><br />Interface PID 0x{pid.toString(16)}</>}
          </div>
          {pid === 0x0575 && (
            <div className="note bad">
              That PID is the <strong>receiver</strong>, not the pad — reads time out on it. Disconnect and connect the ★ interface instead.
            </div>
          )}
        </div>
        <div className="status-bar">
          <div className="status-row">
            <span className={`dot ${connected ? 'good' : 'bad'}`} />
            {connected ? 'Connected' : 'Disconnected'}
            {appVersion && <span style={{ color: 'var(--text-3)' }}>v{appVersion}</span>}
          </div>
          <div className="status-row" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Developed by RealKiyoshi</span>
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
            <h2>Stick Labs</h2>
            <span className="sub">bit depth + raw unlock · curves · live sticks</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {[1, 2, 3, 4].map((s) => (
              <button
                key={s}
                className={`btn sm${s === slot ? ' primary' : ' ghost'}`}
                disabled={!connected || busy || locked}
                onClick={() => void loadSlot(s)}
              >
                P{s}
              </button>
            ))}
            <button className="btn sm primary" disabled={!connected || !dirty || busy || locked} onClick={() => void write()}>
              {busy ? 'Working…' : 'Write to controller'}
            </button>
            <button
              className="btn sm ghost"
              title="Make this slot the active profile on the pad"
              disabled={!connected || busy || locked || info?.currentProfile === slot}
              onClick={() => {
                setErr(null)
                void api()
                  .switchProfile(slot)
                  .then(() => {
                    setInfo((prev) => (prev ? { ...prev, currentProfile: slot } : prev))
                    setMsg(`Slot ${slot} is now active.`)
                  })
                  .catch((e: Error) => setErr(e.message))
              }}
            >
              {info?.currentProfile === slot ? `P${slot} active` : `Activate P${slot}`}
            </button>
          </div>
        </header>
        <div className="content">
          {showSafety && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
              <h3>First — read this (30 seconds)</h3>
              <div className="stack" style={{ gap: 6, fontSize: 13 }}>
                <span>1. <strong>Back up first</strong> — Stick profiles card → Backup all → JSON. You can always restore.</span>
                <span>2. <strong>Close GameSir Connect</strong> — it holds the controller and blocks this app.</span>
                <span>3. <strong>Wired or 2.4G only</strong> — Bluetooth pads don't appear here, ever.</span>
                <span>4. <strong>Writing the active profile reboots the pad</strong> for ~2 seconds. Normal — it reconnects by itself.</span>
                <span>5. <strong>Tournaments</strong> — check your event's rules before competing on a tuned profile.</span>
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
                  Got it
                </button>
              </div>
            </div>
          )}
          {err && <div className="note bad">{err}</div>}
          {msg && <div className="note">{msg}</div>}
          {dirty && <div className="note warn">Unsaved stick changes — write to apply. Writing the running slot reboots the pad (~1-2 s).</div>}
          {!connected && (
            <div className="msg"><h3>Connect a controller</h3><p>G7 Pro 8K · G7 Pro · Tarantula 8K (plus new 8K editions via auto-check). Rescan, then connect the vendor interface. Close GameSir Connect first — it holds the handle.</p></div>
          )}
          {connected && !profile && (
            !model || model.support !== 'full' ? (
              <div className="msg">
                <h3>{model ? `${model.marketingName} — tuning locked` : 'Unknown controller — tuning locked'}</h3>
                <p>{model ? model.supportNote : 'This USB ID is not in the verified model table, so profile access stays off as a safety default.'}</p>
                <p>Live input below still works. Profile reads/writes stay disabled until the layout is verified on hardware.</p>
              </div>
            ) : (
              <div className="msg"><h3>Loading profile…</h3></div>
            )
          )}
          {connected && profile && pkt && dz && fd && (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                {(['Left', 'Right'] as const).map((n, i) => (
                  <button key={n} className={`btn${i === which ? ' primary' : ' ghost'}`} onClick={() => setWhich(i)}>
                    {n} stick
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="pill">{resBits}-bit · {bitsToLevels(resBits).toLocaleString()} levels</span>
              </div>

              <div className="two" style={{ alignItems: 'start' }}>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card">
                    <h3>Polling rate — {rates.map((o) => (o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz}`)).join(' / ')}</h3>
                    <div className="hint">Report-rate gear (Fun_Data +14){model ? ` · ${model.marketingName} offers ${rates.length} gears` : ''}. Hz labels are the vendor's claim; measured input stays ~250–500/s.</div>
                    <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
                      {rates.filter((o) => o.hz >= 1000).map((o) => (
                        <button
                          key={o.gear}
                          className={`btn sm${fun.extend.reportRateGear(fd) === o.gear ? ' primary' : ' ghost'}`}
                          title={o.confirmed ? `gear ${o.gear}` : `gear ${o.gear} (inferred — no vendor label)`}
                          onClick={() => edit(() => fun.extend.setReportRateGear(fd, o.gear))}
                        >
                          {o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz} Hz`}{o.confirmed ? '' : '*'}
                        </button>
                      ))}
                    </div>
                    <div className="row spread">
                      <span className="label">Gear: {fun.extend.reportRateGear(fd)}</span>
                      <span className="mono">*2K inferred — completes the 250/500/1000/…/4000/8000 ladder</span>
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                      {rates.filter((o) => o.hz < 1000).map((o) => (
                        <button
                          key={o.gear}
                          className={`btn sm${fun.extend.reportRateGear(fd) === o.gear ? ' primary' : ' ghost'}`}
                          title={`gear ${o.gear}`}
                          onClick={() => edit(() => fun.extend.setReportRateGear(fd, o.gear))}
                        >
                          {o.hz} Hz
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="card">
                    <h3>Bit depth — 8–12 bit + raw unlock</h3>
                    <div className="hint">Hardware ADC max is 12-bit (4096 levels). Wire = 12 − bits. Raw bytes outside 0–4 are experimental.</div>
                    <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
                      {STICK_RESOLUTION_OPTIONS.map((o) => (
                        <button
                          key={o.bits}
                          className={`btn sm${resBits === o.bits ? ' primary' : ' ghost'}`}
                          onClick={() => edit(() => fun.extend.setStickResolutionBits(fd, o.bits))}
                        >
                          {o.bits}-bit · {bitsToLevels(o.bits).toLocaleString()}
                        </button>
                      ))}
                    </div>
                    <div className="row spread">
                      <span className="label">Wire byte (Fun_Data +16): {resWire}</span>
                      <span className="mono">{resInfo.label}</span>
                    </div>
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <input
                        className="input"
                        style={{ width: 120 }}
                        placeholder={`wire ${resWire}`}
                        value={rawRes}
                        onChange={(e) => setRawRes(e.target.value)}
                      />
                      <button
                        className="btn sm"
                        onClick={() => {
                          const w = Number(rawRes)
                          if (!Number.isFinite(w)) return
                          edit(() => fun.extend.setStickResolution(fd, Math.max(0, Math.min(255, Math.round(w)))))
                          setRawRes('')
                        }}
                      >
                        Set raw wire 0–255
                      </button>
                      <button className="btn sm ghost" onClick={() => edit(() => fun.extend.setStickResolutionBits(fd, 12))}>
                        Back to 12-bit
                      </button>
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                      <span className="label">Beyond silicon (experimental):</span>
                      {EXTENDED_BITS.map((bits) => (
                        <button
                          key={bits}
                          className="btn sm ghost"
                          title={`Writes raw wire ${bitsToWireRaw(bits)} — the 12-bit ADC cannot resolve this; the pad will clamp or ignore it`}
                          onClick={() => edit(() => fun.extend.setStickResolution(fd, bitsToWireRaw(bits)))}
                        >
                          {bits}-bit*
                        </button>
                      ))}
                    </div>
                    <div className="note" style={{ marginTop: 8 }}>
                      *The ADC tops at 12-bit and the USB stick report is 8-bit per axis — games see 256 steps no matter what. These buttons write the implied raw wire so you can prove it on the live crosshair; expect the pad to clamp or ignore them.
                    </div>
                    {!resInfo.standard && (
                      <div className="note bad" style={{ marginTop: 8 }}>
                        Non-standard wire {resInfo.wire} → effective {resInfo.bits}-bit. The firmware only documents 0–4 (12–8 bit);
                        anything else may quantise oddly or be ignored. Verify on the live sticks before keeping it.
                      </div>
                    )}
                  </div>

                  <div className="card">
                    <h3>Dead zone + anti-deadzone — 0.1% steps</h3>
                    <div className="hint">Stored ×10 (50 = 5%). <strong>Start/End</strong> bound the input: below Start = no output, past End = already full. <strong>Anti-deadzone</strong> is the output floor/ceiling: raising Anti-start lifts the minimum output so small deflections bite sooner — the snap setting for FPS.</div>
                    <div className="stack" style={{ gap: 12, marginTop: 8 }}>
                      <Slider label="Start (input below = 0)" value={dz.begin / 10} min={0} max={20} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label="End (input above = full)" value={dz.end / 10} min={10} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label="Anti-deadzone start (output floor — snap)" value={dz.beginAnti / 10} min={0} max={50} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label="Anti-deadzone end (output ceiling)" value={dz.endAnti / 10} min={50} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), endAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                      {(
                        [
                          { label: 'Start', key: 'begin', value: dz.begin / 10 },
                          { label: 'End', key: 'end', value: dz.end / 10 },
                          { label: 'Anti-start', key: 'beginAnti', value: dz.beginAnti / 10 },
                          { label: 'Anti-end', key: 'endAnti', value: dz.endAnti / 10 }
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
                      <button className="btn sm" onClick={() => edit(() => stick.applyPhysics(pkt))}>Physics: 0% + linear</button>
                      <button className="btn sm ghost" onClick={() => edit(() => stick.setDeadzone(pkt, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 }))}>Factory 5%</button>
                      <button className="btn sm ghost" title="Full output at 80% deflection — pairs with FPS Aim" onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 800 }))}>Aim End 80%</button>
                      <button className="btn sm ghost" title="Full output at 65% — pairs with Flick/Snap" onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 650 }))}>Flick End 65%</button>
                      <button className="btn sm ghost" title="Output floor 8% — small deflections bite sooner" onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 80 }))}>Anti snap 8%</button>
                      <button className="btn sm ghost" title="Output floor 15% — maximum snap, watch for drift" onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 150 }))}>Anti max 15%</button>
                      <button className="btn sm ghost" title="Neutral output window" onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 0, endAnti: 1000 }))}>Anti off</button>
                      <button
                        className="btn sm ghost"
                        title="Watch this stick untouched for 10 s, then recommend the Start % that swallows its wander"
                        disabled={!live || measuring !== null}
                        onClick={() => {
                          wanderRef.current = 0
                          setMeasuring({ left: 10, suggestion: null })
                        }}
                      >
                        {measuring ? `Measuring… ${measuring.left}s — don't touch` : 'Center guard: measure wander'}
                      </button>
                    </div>
                    {measuring?.suggestion !== null && measuring?.suggestion !== undefined && (
                      <div className="note warn" style={{ marginTop: 8 }}>
                        Max wander {measuring.suggestion.dev} steps off centre.{' '}
                        <button
                          className="btn sm primary"
                          style={{ marginLeft: 8 }}
                          onClick={() => {
                            const pct10 = measuring.suggestion!.pct10
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: pct10 }))
                            setMeasuring(null)
                          }}
                        >
                          Set Start {measuring.suggestion.pct10 / 10}%
                        </button>{' '}
                        <button className="btn sm ghost" onClick={() => setMeasuring(null)}>Dismiss</button>
                      </div>
                    )}
                  </div>

                  <div className="card">
                    <h3>Outer Threshold — {outerUnlimited ? '∞ no limit' : 'custom'}</h3>
                    <div className="hint">The boundary of max stick input. This app offers one setting: <strong>no limit</strong>.</div>
                    <div className="row spread" style={{ margin: '10px 0' }}>
                      <div>
                        <div style={{ fontSize: 13.5 }}>∞ No limit (neutral 0)</div>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                          {outerUnlimited ? 'Active — full physical range' : 'Off — mild +10 boundary parked'}
                        </div>
                      </div>
                      <button
                        className={`btn sm${outerUnlimited ? ' primary' : ' ghost'}`}
                        onClick={() => {
                          if (outerUnlimited) {
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 900, endAnti: 1000 }))
                          } else {
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 1000, endAnti: 1000 }))
                          }
                        }}
                      >
                        {outerUnlimited ? '∞ On' : 'Set ∞'}
                      </button>
                    </div>
                    <div className="note">
                      <strong>What this does.</strong> The outer threshold is the deflection where the stick hits maximum output.
                      A positive buffer pulls that boundary inward, so max arrives earlier (hotter rim); a negative buffer
                      soft-caps output below max instead (tamer rim — the zone where extra yaw/pitch-style effects bite).
                      Neutral <strong>0 / ∞</strong> removes the boundary entirely: End 100%, output ceiling 100%, the pad's
                      full physical range with nothing clipped or boosted at the rim.
                    </div>
                    <div className="note" style={{ marginTop: 8 }}>
                      <strong>Same bytes, other names.</strong> Steam's Outer Threshold and the deadzone End / output-ceiling
                      sliders all write the same two firmware fields (input-saturation End, output ceiling). They are just
                      different labels for this boundary — setting ∞ here is identical to End 100% + ceiling 100% over there.
                    </div>
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
                    <h3>Live sticks</h3>
                    <div className="hint">0x12 vendor report, 0–255, centre 128. Move the sticks.</div>
                    <StickCross lx={live?.lx ?? 128} ly={live?.ly ?? 128} rx={live?.rx ?? 128} ry={live?.ry ?? 128} />
                    <div className="row spread">
                      <span className="mono">L {live?.lx ?? '—'},{live?.ly ?? '—'}</span>
                      <span className="mono">R {live?.rx ?? '—'},{live?.ry ?? '—'}</span>
                    </div>
                  </div>

                  <div className="card">
                    <h3>Custom curve designer — {design.length} points</h3>
                    <div className="hint">The pad stores exactly <strong>5 points</strong>, so this is a free-point canvas (2–8): <span style={{ color: '#7db8ff' }}>● blue = your design, drag it</span>, <span style={{ color: 'var(--warn)' }}>▢ orange dashed = the 5 bytes that will be written</span>. Dual-zone presets mimic a dynamic response — the pad has no speed sensing, so this is the static LUT a dynamic curve averages to.</div>
                    <CurvePlot points={design.length >= 2 ? design : padCurve} onChange={(next) => setDesign(next)} overlay={quantized} />
                    <div className="row" style={{ gap: 8, margin: '8px 0' }}>
                      <span className={curvePending ? 'pill warn' : 'pill good'}>{curvePending ? 'design ≠ pad — send it' : 'pad matches design'}</span>
                      <div style={{ flex: 1 }} />
                      <button className="btn sm primary" disabled={!curvePending} onClick={() => edit(() => { if (pkt) stick.setCurve(pkt, quantized.map((p) => ({ ...p }))) })}>Send 5 to pad</button>
                      <button className="btn sm ghost" onClick={reloadDesignFromPad}>Reload from pad</button>
                    </div>
                    <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
                      {Object.entries(AIM_CURVES).map(([key, c]) => (
                        <button
                          key={key}
                          className="btn sm ghost"
                          title={c.hint}
                          onClick={() => setDesign(c.pts.map((p) => ({ ...p })))}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button
                        className="btn sm"
                        disabled={design.length >= DESIGN_MAX_POINTS}
                        onClick={() => setDesign((d) => addDesignPoint(d.length >= 2 ? d : padCurve))}
                      >
                        + Add point ({design.length}/{DESIGN_MAX_POINTS})
                      </button>
                      <button
                        className="btn sm"
                        title="Left = movement (linear), right = aim (FPS Aim)"
                        onClick={() => {
                          if (!profile || !pkt) return
                          edit(() => {
                            stick.setCurve(profile.sticks[0], AIM_CURVES.linear.pts.map((p) => ({ ...p })))
                            stick.setCurve(profile.sticks[1], AIM_CURVES.fpsAim.pts.map((p) => ({ ...p })))
                          })
                          reloadDesignFromPad()
                          setMsg('FPS split applied: left linear (move), right Kiyoshi Curve. Write to keep it.')
                        }}
                      >
                        FPS split L/R
                      </button>
                      <button
                        className="btn sm ghost"
                        title="Copy this stick's pad curve to the other stick"
                        onClick={() => {
                          if (!profile || !pkt) return
                          const other = profile.sticks[which === 0 ? 1 : 0]
                          edit(() => stick.setCurve(other, stick.curve(pkt).map((p) => ({ ...p }))))
                        }}
                      >
                        Copy pad curve → other stick
                      </button>
                    </div>
                    <table className="tbl" style={{ marginTop: 8 }}>
                      <thead><tr><th>#</th><th>X</th><th>Y</th><th /></tr></thead>
                      <tbody>
                        {design.map((p, i) => (
                          <tr key={i}>
                            <td className="mono">{i + 1}</td>
                            <td><input className="input" type="number" min={0} max={255} value={p.x} onChange={(e) => { const next = design.map((q) => ({ ...q })); next[i].x = Math.max(0, Math.min(255, Number(e.target.value))); setDesign(next) }} /></td>
                            <td><input className="input" type="number" min={0} max={255} value={p.y} onChange={(e) => { const next = design.map((q) => ({ ...q })); next[i].y = Math.max(0, Math.min(255, Number(e.target.value))); setDesign(next) }} /></td>
                            <td>
                              <button className="btn sm ghost" disabled={design.length <= DESIGN_MIN_POINTS} title="Remove point" onClick={() => setDesign((d) => d.filter((_, j) => j !== i))}>−</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="note" style={{ marginTop: 8 }}>
                      Hardware bytes (quantized preview): <span className="mono">{quantized.map((q) => `${q.x}/${q.y}`).join(' · ')}</span>
                    </div>
                  </div>

                  <div className="card">
                    <h3>Controller Rate</h3>
                    <div className="hint">How fast this stick answers in Mouse mode — higher moves the cursor more per deflection. It does <strong>not</strong> change how often the pad sends inputs; that is the Polling card.</div>
                    <div className="stack" style={{ gap: 12 }}>
                      <div className="row spread">
                        <div>
                          <div style={{ fontSize: 13.5 }}>Rate — constant per pick</div>
                          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                            Only applies while Output is Mouse · firmware byte caps at 255
                          </div>
                        </div>
                        <span className="mono">stored: {stick.mouseDpi(pkt)}</span>
                      </div>
                      <div className="row wrap" style={{ gap: 8 }}>
                        {[100, 150, 200, 250, 300].map((rate) => {
                          const wire = Math.min(rate, 255)
                          const active = stick.mouseDpi(pkt) === wire
                          return (
                            <button
                              key={rate}
                              className={`btn sm${active ? ' primary' : ' ghost'}`}
                              title={rate > 255 ? `Firmware byte caps at 255 — stores ${wire}` : `Stores ${wire}`}
                              onClick={() => edit(() => stick.setMouseDpi(pkt, wire))}
                            >
                              {rate}{rate > 255 ? '*' : ''}
                            </button>
                          )
                        })}
                        {stick.mapIndex(pkt) === 4 && (
                          <button
                            className="btn sm ghost"
                            title="Restore this stick to normal stick output"
                            onClick={() => edit(() => { stick.setMapIndex(pkt, which === 0 ? 1 : 2); stick.setMapped(pkt, true) })}
                          >
                            ← Back to {which === 0 ? 'Left' : 'Right'} stick
                          </button>
                        )}
                      </div>
                      <div className="note">Picks always write (100 / 200 / 255-max shown as 300*), but the pad only honors the byte while Output is Mouse — hence the switch button. *300 exceeds the byte — the pad stores 255.</div>
                    </div>
                  </div>

                </div>
              </div>
            </>
          )}
          <ProfilesPanel connected={connected} activeSlot={info?.currentProfile ?? null} locked={locked} modelId={modelId} modelLen={modelLen} dumpLength={model?.dumpLength ?? 0} modelName={model?.marketingName ?? null} />
          <AnalyticsPanel
            context={
              profile && fd
                ? 'Now editing P' + slot + ': set ' + gearHz.toLocaleString() + ' Hz (gear ' + gear + ') · ' + resBits + '-bit (' + bitsToLevels(resBits).toLocaleString() + ' levels) — green chart is measured input, not the set rate.'
                : 'Connect and load a slot — then switch gear or RC, write, and watch this chart.'
            }
          />
        </div>
      </main>
    </div>
  )
}
