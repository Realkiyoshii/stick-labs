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
import { LANGUAGES, setLang, useLang, useT } from './i18n'

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
// Labels and hints live in i18n `curves`, keyed the same way.
const AIM_CURVES: Record<string, { pts: Array<{ x: number; y: number }> }> = {
  linear: { pts: [...LINEAR_CURVE] },
  fpsAim: {
    pts: [{ x: 0, y: 0 }, { x: 64, y: 38 }, { x: 128, y: 100 }, { x: 191, y: 185 }, { x: 255, y: 255 }]
  },
  micro: {
    pts: [{ x: 0, y: 0 }, { x: 64, y: 28 }, { x: 128, y: 80 }, { x: 191, y: 170 }, { x: 255, y: 255 }]
  },
  flick: {
    pts: [{ x: 0, y: 0 }, { x: 64, y: 100 }, { x: 128, y: 160 }, { x: 191, y: 215 }, { x: 255, y: 255 }]
  },
  snappy: {
    pts: [{ x: 0, y: 0 }, { x: 64, y: 78 }, { x: 128, y: 140 }, { x: 191, y: 200 }, { x: 255, y: 255 }]
  },
  steady: {
    pts: [{ x: 0, y: 0 }, { x: 64, y: 52 }, { x: 128, y: 112 }, { x: 191, y: 188 }, { x: 255, y: 255 }]
  },
  expo: {
    pts: [{ x: 0, y: 0 }, { x: 64, y: 16 }, { x: 128, y: 70 }, { x: 191, y: 158 }, { x: 255, y: 255 }]
  },
  sacreds: {
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
    pts: [
      { x: 0, y: 0 },
      { x: 20, y: 15 },
      { x: 82, y: 61 },
      { x: 133, y: 99 },
      { x: 184, y: 138 },
      { x: 235, y: 176 },
      { x: 255, y: 240 }
    ]
  }
}

function AnalyticsPanel({ context }: { context: string }): JSX.Element {
  const t = useT()
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
      <h3>{t.analyticsTitle}</h3>
      <div className="hint">{context}</div>
      <div className="two" style={{ alignItems: 'start', marginTop: 10 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`pill${rate >= 480 ? ' good' : rate > 0 ? ' warn' : ''}`}>{t.hzNow(rate ? String(rate) : '—')}</span>
            <span className="pill">{t.hzAvg(avg ? String(avg) : '—')}</span>
            <span className="pill">{t.frames(frames.toLocaleString())}</span>
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => setPaused((p) => !p)}>{paused ? t.resume : t.pause}</button>
          </div>
          <canvas ref={chartRef} className="plot" style={{ height: 120 }} />
          <div className="note">{t.pollNote}</div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm primary" disabled={pinging} onClick={() => void runPing()}>{pinging ? t.measuring : t.runPings}</button>
            {pingError && <span style={{ color: 'var(--bad)', fontSize: 12 }}>{pingError}</span>}
            {ping && <span className="mono">{t.pingResult(ping.median.toFixed(1), ping.mean.toFixed(1), ping.min.toFixed(1), ping.max.toFixed(1))}</span>}
          </div>
          <div className="note">{t.pingNote}</div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <div className="row spread">
            <span className="label">{t.observedRange}</span>
            <button className="btn sm ghost" onClick={() => setExtents(null)}>{t.reset}</button>
          </div>
          <table className="tbl">
            <thead><tr><th>{t.colAxis}</th><th>{t.colMin}</th><th>{t.colMax}</th><th>{t.colSpan}</th></tr></thead>
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
            {extents ? t.extentsNote(extents.n.toLocaleString()) : t.extentsEmpty}
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
    setMessage(failed ? t.slotsFailed(failed) : t.readAll4)
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
          if (!parsed.bytes) throw new Error(t.jsonNoBytes)
          bytes = b64ToBytes(parsed.bytes)
        } else {
          bytes = new Uint8Array(await file.arrayBuffer())
        }
        if (bytes.length !== modelLen) throw new Error(t.expectedBytes(modelLen, bytes.length))
        setBusy(true)
        const result = await api().writeProfile(entry.index, bytesToB64(bytes), modelLen)
        if (!result.verified) throw new Error(result.rolledBack ? t.rejectedRestored : t.didNotVerify)
        setMessage(t.imported(file.name, entry.index))
        await readSlot(entry.index)
      } catch (e) {
        setMessage(t.importFailed((e as Error).message))
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  async function copyTo(from: SlotEntry, toIndex: number): Promise<void> {
    if (!window.confirm(t.confirmOverwrite(toIndex, from.index))) return
    try {
      const bytes = from.bytes ?? (await readSlot(from.index))
      setBusy(true)
      const result = await api().writeProfile(toIndex, bytesToB64(bytes))
      if (!result.verified) throw new Error(result.rolledBack ? t.rejectedRestored : t.didNotVerify)
      setMessage(t.copied(from.index, toIndex))
      await readSlot(toIndex)
    } catch (e) {
      setMessage(t.copyFailed((e as Error).message))
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
      setMessage(t.backupDownloaded)
    } catch (e) {
      setMessage(t.backupFailed((e as Error).message))
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
        if (slots.length === 0) throw new Error(t.noProfilesInFile)
        if (!window.confirm(t.confirmRestore(slots.length, slots.map((x) => `P${x.slot} ${x.entry.name || ''}`).join(', ')))) return
        setBusy(true)
        for (const { slot, entry } of slots) {
          const bytes = b64ToBytes(entry.bytes as string)
          if (bytes.length !== modelLen) throw new Error(t.slotExpectedBytes(slot, modelLen, bytes.length))
          const result = await api().writeProfile(slot, bytesToB64(bytes), modelLen)
          if (!result.verified) throw new Error(result.rolledBack ? t.slotRejected(slot) : t.slotNotVerified(slot))
          written.push(`P${slot}`)
          await readSlot(slot)
        }
        setMessage(t.restored(written.join(', ')))
      } catch (e) {
        setMessage(t.restoreFailed(written.length ? written.join(', ') : null, (e as Error).message))
      } finally {
        setBusy(false)
      }
    }
    input.click()
  }

  if (!connected) return <div className="note">{t.connectToManage}</div>
  if (locked) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h3>{t.lockedTitle(modelName)}</h3>
        <div className="hint">{t.lockedHint}</div>
        {dumpLength > 0 ? (
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button
              className="btn sm"
              disabled={busy}
              title={t.dumpTitle}
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
                  setMessage(t.dumpDownloaded)
                } catch (e) {
                  setMessage(t.dumpFailed((e as Error).message))
                } finally {
                  setBusy(false)
                }
              })()}
            >
              {busy ? t.reading : t.exportDump}
            </button>
            {message && <span className="pill">{message}</span>}
          </div>
        ) : (
          <div className="note" style={{ marginTop: 10 }}>{t.noDumpLength}</div>
        )}
      </div>
    )
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t.profilesTitle}</h3>
      <div className="hint">{t.profilesHint}</div>
      <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
        <button className="btn sm" disabled={busy} onClick={() => void refreshAll()}>{busy ? t.working : t.readAll}</button>
        <button className="btn sm" disabled={busy} onClick={() => void backupAll()}>{t.backupAll}</button>
        <button className="btn sm" disabled={busy} onClick={restoreAll}>{t.restoreAll}</button>
        {message && <span className="pill">{message}</span>}
      </div>
      <table className="tbl">
        <thead><tr><th>{t.colSlot}</th><th>{t.colName}</th><th>{t.colActive}</th><th>{t.colActions}</th></tr></thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.index}>
              <td className="mono">P{entry.index}</td>
              <td>{entry.loading ? t.readingSlot : entry.error ? <span style={{ color: 'var(--bad)' }}>{entry.error} <button className="btn sm ghost" disabled={busy} onClick={() => void readSlot(entry.index)}>{t.retry}</button></span> : (entry.name || <span style={{ color: 'var(--text-3)' }}>{t.unnamed}</span>)}</td>
              <td>{entry.index === activeSlot ? <span className="pill good">{t.current}</span> : <span className="tag">—</span>}</td>
              <td>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn sm ghost" disabled={busy} onClick={() => void exportSlot(entry, 'bin')}>{t.exportBin}</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => void exportSlot(entry, 'json')}>{t.exportJson}</button>
                  <button className="btn sm ghost" disabled={busy} onClick={() => handleImport(entry)}>{t.importFile}</button>
                  <select className="input" style={{ width: 130 }} disabled={busy} value="" onChange={(e) => { if (e.target.value) void copyTo(entry, Number(e.target.value)) }}>
                    <option value="">{t.copyTo}</option>
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
  const t = useT()
  const lang = useLang()
  // Device listeners are registered once; read strings through a ref so a
  // language switch reaches them too.
  const tRef = useRef(t)
  tRef.current = t
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
  // Free-point curve design (2–10 pts). The pad only stores 5, so this is a
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
      setMsg(tRef.current.padRestarted)
    })
    const offReconnecting = api().on('device:reconnecting', () => {
      setMsg(tRef.current.padRebooting)
    })
    const offReconnected = api().on('device:reconnected', (incoming) => {
      const info = incoming as unknown as DeviceInfo
      setConnected(true)
      setInfo(info)
      setMsg(tRef.current.reconnected)
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

  // Keep <html lang> and the main process (update dialog) in step with the UI.
  useEffect(() => {
    document.documentElement.lang = lang
    void api().setLanguage(lang).catch(() => undefined)
  }, [lang])

  const supportNote = (m: ControllerModel): string => t.supportNotes[m.id] ?? m.supportNote

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
        setMsg(t.detected(pre.marketingName, supportNote(pre)))
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
        setMsg(t.detected(m.marketingName, supportNote(m)))
      } else {
        // Unknown PID (new editions like Royal2): prove the family live.
        // Handshake already answered; a 1070-byte read that parses as a
        // CE-family profile unlocks it as an unverified variant. Anything
        // else stays locked — this is what keeps a foreign layout safe.
        setMsg(t.provingUnknown)
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
              supportNote: t.unlistedEdition((cand?.productId ?? 0).toString(16))
            }
            setModel(variant)
            await loadSlot(slot, variant.profileLength)
          } else {
            setBlob(null)
            setMsg(t.unknownNotFamily(cand ? cand.productId.toString(16) : '?'))
          }
        } catch (e) {
          setBlob(null)
          setMsg(t.unknownCheckFailed((e as Error).message))
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
          setMsg(t.writtenNotLive(slot, liveNow))
        } else {
          setMsg(t.written(slot))
        }
        setDirty(false)
      } else if (res.rolledBack) {
        setErr(t.writeNotVerified)
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
          <button className="btn ghost sm" onClick={() => void refresh()}>{t.rescanUsb}</button>
          <button
            className="btn ghost sm"
            title={t.copyDiagTitle}
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
                  () => setMsg(t.diagCopied),
                  () => setMsg(text)
                )
              } catch {
                setMsg(text)
              }
            }}
          >
            {t.copyDiag}
          </button>
          {visibleCandidates.map((c) => {
            const known = identifyModel(c.product, c.productId)
            return (
              <button key={c.path} className="btn sm" onClick={() => void connect(c.path)}>
                {known ? known.marketingName : (c.product || t.unknownDevice(c.productId.toString(16)))}{c.preferred ? ' ★' : ''}
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
              {t.disconnect}
            </button>
          )}
          <div className="note">
            {t.matchNote}
            {info && <><br />{t.fwLine(info.firmware, info.currentProfile)}</>}
            {model && <><br />{model.marketingName}{model.support !== 'full' ? t.tuningLockedSuffix : ''}</>}
            {pid !== null && <><br />{t.interfacePid(pid.toString(16))}</>}
          </div>
          {pid === 0x0575 && (
            <div className="note bad">
              {t.receiverWarning}
            </div>
          )}
        </div>
        <div className="lang-section">
          <span className="label">{t.language}</span>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`btn sm${l.id === lang ? ' primary' : ' ghost'}`}
                style={{ flex: 1 }}
                onClick={() => setLang(l.id)}
              >
                {l.name}
              </button>
            ))}
          </div>
        </div>
        <div className="status-bar">
          <div className="status-row">
            <span className={`dot ${connected ? 'good' : 'bad'}`} />
            {connected ? t.connected : t.disconnected}
            {appVersion && <span style={{ color: 'var(--text-3)' }}>v{appVersion}</span>}
          </div>
          <div className="status-row" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{t.developedBy}</span>
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
            <span className="sub">{t.subtitle}</span>
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
              {busy ? t.working : t.writeToController}
            </button>
            <button
              className="btn sm ghost"
              title={t.activateTitle}
              disabled={!connected || busy || locked || info?.currentProfile === slot}
              onClick={() => {
                setErr(null)
                void api()
                  .switchProfile(slot)
                  .then(() => {
                    setInfo((prev) => (prev ? { ...prev, currentProfile: slot } : prev))
                    setMsg(t.slotNowActive(slot))
                  })
                  .catch((e: Error) => setErr(e.message))
              }}
            >
              {info?.currentProfile === slot ? t.slotActive(slot) : t.activateSlot(slot)}
            </button>
          </div>
        </header>
        <div className="content">
          {showSafety && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--warn)' }}>
              <h3>{t.safetyTitle}</h3>
              <div className="stack" style={{ gap: 6, fontSize: 13 }}>
                {t.safetyItems.map((item, i) => (
                  <span key={i}>{i + 1}. {item}</span>
                ))}
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
                  {t.gotIt}
                </button>
              </div>
            </div>
          )}
          {err && <div className="note bad">{err}</div>}
          {msg && <div className="note">{msg}</div>}
          {dirty && <div className="note warn">{t.unsaved}</div>}
          {!connected && (
            <div className="msg"><h3>{t.connectTitle}</h3><p>{t.connectBody}</p></div>
          )}
          {connected && !profile && (
            !model || model.support !== 'full' ? (
              <div className="msg">
                <h3>{model ? t.modelLocked(model.marketingName) : t.unknownLockedTitle}</h3>
                <p>{model ? supportNote(model) : t.unknownLockedBody}</p>
                <p>{t.liveStillWorks}</p>
              </div>
            ) : (
              <div className="msg"><h3>{t.loadingProfile}</h3></div>
            )
          )}
          {connected && profile && pkt && dz && fd && (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                {t.stickNames.map((n, i) => (
                  <button key={i} className={`btn${i === which ? ' primary' : ' ghost'}`} onClick={() => setWhich(i)}>
                    {n}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <span className="pill">{t.bitsPill(resBits, bitsToLevels(resBits).toLocaleString())}</span>
              </div>

              <div className="two" style={{ alignItems: 'start' }}>
                <div className="stack" style={{ gap: 16 }}>
                  <div className="card">
                    <h3>{t.pollingTitle(rates.map((o) => (o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz}`)).join(' / '))}</h3>
                    <div className="hint">{t.pollingHint(model ? model.marketingName : null, rates.length)}</div>
                    <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
                      {rates.filter((o) => o.hz >= 1000).map((o) => (
                        <button
                          key={o.gear}
                          className={`btn sm${fun.extend.reportRateGear(fd) === o.gear ? ' primary' : ' ghost'}`}
                          title={o.confirmed ? t.gearTitle(o.gear) : t.gearInferredTitle(o.gear)}
                          onClick={() => edit(() => fun.extend.setReportRateGear(fd, o.gear))}
                        >
                          {o.hz >= 1000 ? `${o.hz / 1000}K` : `${o.hz} Hz`}{o.confirmed ? '' : '*'}
                        </button>
                      ))}
                    </div>
                    <div className="row spread">
                      <span className="label">{t.gearLabel(fun.extend.reportRateGear(fd))}</span>
                      <span className="mono">{t.twoKInferred}</span>
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                      {rates.filter((o) => o.hz < 1000).map((o) => (
                        <button
                          key={o.gear}
                          className={`btn sm${fun.extend.reportRateGear(fd) === o.gear ? ' primary' : ' ghost'}`}
                          title={t.gearTitle(o.gear)}
                          onClick={() => edit(() => fun.extend.setReportRateGear(fd, o.gear))}
                        >
                          {o.hz} Hz
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="card">
                    <h3>{t.bitDepthTitle}</h3>
                    <div className="hint">{t.bitDepthHint}</div>
                    <div className="row wrap" style={{ gap: 8, margin: '10px 0' }}>
                      {STICK_RESOLUTION_OPTIONS.map((o) => (
                        <button
                          key={o.bits}
                          className={`btn sm${resBits === o.bits ? ' primary' : ' ghost'}`}
                          onClick={() => edit(() => fun.extend.setStickResolutionBits(fd, o.bits))}
                        >
                          {o.bits}-bit
                        </button>
                      ))}
                      {EXTENDED_BITS.map((bits) => (
                        <button
                          key={bits}
                          className={`btn sm ghost${resWire === bitsToWireRaw(bits) ? ' primary' : ''}`}
                          title={t.beyondSiliconTitle}
                          onClick={() => edit(() => fun.extend.setStickResolution(fd, bitsToWireRaw(bits)))}
                        >
                          {bits}-bit*
                        </button>
                      ))}
                    </div>
                    <div className="note" style={{ marginTop: 8 }}>
                      {t.adcNote}
                    </div>
                    {!resInfo.standard && (
                      <div className="note bad" style={{ marginTop: 8 }}>
                        {t.nonStandardWire(resInfo.wire, resInfo.bits)}
                      </div>
                    )}
                  </div>

                  <div className="card">
                    <h3>{t.deadzoneTitle}</h3>
                    <div className="hint">{t.deadzoneHint}</div>
                    <div className="stack" style={{ gap: 12, marginTop: 8 }}>
                      <Slider label={t.sliderStart} value={dz.begin / 10} min={0} max={20} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t.sliderEnd} value={dz.end / 10} min={10} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t.sliderAntiStart} value={dz.beginAnti / 10} min={0} max={50} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                      <Slider label={t.sliderAntiEnd} value={dz.endAnti / 10} min={50} max={100} step={0.1} unit="%" onChange={(v) => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), endAnti: Math.round(v * 10) }))} format={(v) => `${v.toFixed(1)}%`} />
                    </div>
                    <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                      {(
                        [
                          { label: t.fieldStart, key: 'begin', value: dz.begin / 10 },
                          { label: t.fieldEnd, key: 'end', value: dz.end / 10 },
                          { label: t.fieldAntiStart, key: 'beginAnti', value: dz.beginAnti / 10 },
                          { label: t.fieldAntiEnd, key: 'endAnti', value: dz.endAnti / 10 }
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
                      <button className="btn sm" onClick={() => edit(() => stick.applyPhysics(pkt))}>{t.physics}</button>
                      <button className="btn sm ghost" onClick={() => edit(() => stick.setDeadzone(pkt, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 }))}>{t.factory5}</button>
                      <button className="btn sm ghost" title={t.aimEndTitle} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 800 }))}>{t.aimEnd}</button>
                      <button className="btn sm ghost" title={t.flickEndTitle} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), end: 650 }))}>{t.flickEnd}</button>
                      <button className="btn sm ghost" title={t.antiSnapTitle} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 80 }))}>{t.antiSnap}</button>
                      <button className="btn sm ghost" title={t.antiMaxTitle} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 150 }))}>{t.antiMax}</button>
                      <button className="btn sm ghost" title={t.antiOffTitle} onClick={() => edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), beginAnti: 0, endAnti: 1000 }))}>{t.antiOff}</button>
                      <button
                        className="btn sm ghost"
                        title={t.centerGuardTitle}
                        disabled={!live || measuring !== null}
                        onClick={() => {
                          wanderRef.current = 0
                          setMeasuring({ left: 10, suggestion: null })
                        }}
                      >
                        {measuring ? t.measuringWander(measuring.left) : t.centerGuard}
                      </button>
                    </div>
                    {measuring?.suggestion !== null && measuring?.suggestion !== undefined && (
                      <div className="note warn" style={{ marginTop: 8 }}>
                        {t.maxWander(measuring.suggestion.dev)}{' '}
                        <button
                          className="btn sm primary"
                          style={{ marginLeft: 8 }}
                          onClick={() => {
                            const pct10 = measuring.suggestion!.pct10
                            edit(() => stick.setDeadzone(pkt, { ...stick.deadzone(pkt), begin: pct10 }))
                            setMeasuring(null)
                          }}
                        >
                          {t.setStart(measuring.suggestion.pct10 / 10)}
                        </button>{' '}
                        <button className="btn sm ghost" onClick={() => setMeasuring(null)}>{t.dismiss}</button>
                      </div>
                    )}
                  </div>

                  <div className="card">
                    <h3>{t.outerTitle(outerUnlimited)}</h3>
                    <div className="hint">{t.outerHint}</div>
                    <div className="row spread" style={{ margin: '10px 0' }}>
                      <div>
                        <div style={{ fontSize: 13.5 }}>{t.outerNoLimit}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                          {outerUnlimited ? t.outerActive : t.outerOff}
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
                        {outerUnlimited ? t.outerOn : t.outerSet}
                      </button>
                    </div>
                    <div className="note">
                      {t.outerWhat}
                    </div>
                    <div className="note" style={{ marginTop: 8 }}>
                      {t.outerSame}
                    </div>
                    {!outerUnlimited && (
                      <div className="note warn" style={{ marginTop: 8 }}>
                        {t.outerCustom} <span className="mono">{outerBuffer >= 0 ? t.outerMaxAt((100 - outerBuffer).toFixed(0)) : t.outerTopsAt((100 + outerBuffer).toFixed(0))}</span>.{' '}
                        {t.outerTapSet}
                      </div>
                    )}
                  </div>
                </div>

                <div className="stack" style={{ gap: 16 }}>
                  <div className="card">
                    <h3>{t.liveTitle}</h3>
                    <div className="hint">{t.liveHint}</div>
                    <StickCross lx={live?.lx ?? 128} ly={live?.ly ?? 128} rx={live?.rx ?? 128} ry={live?.ry ?? 128} />
                    <div className="row spread">
                      <span className="mono">L {live?.lx ?? '—'},{live?.ly ?? '—'}</span>
                      <span className="mono">R {live?.rx ?? '—'},{live?.ry ?? '—'}</span>
                    </div>
                  </div>

                  <div className="card">
                    <h3>{t.designerTitle(design.length)}</h3>
                    <div className="hint">{t.designerHint}</div>
                    <CurvePlot points={design.length >= 2 ? design : padCurve} onChange={(next) => setDesign(next)} overlay={quantized} />
                    <div className="row" style={{ gap: 8, margin: '8px 0' }}>
                      <span className={curvePending ? 'pill warn' : 'pill good'}>{curvePending ? t.designPending : t.designMatches}</span>
                      <div style={{ flex: 1 }} />
                      <button className="btn sm primary" disabled={!curvePending} onClick={() => edit(() => { if (pkt) stick.setCurve(pkt, quantized.map((p) => ({ ...p }))) })}>{t.send5}</button>
                      <button className="btn sm ghost" onClick={reloadDesignFromPad}>{t.reloadFromPad}</button>
                    </div>
                    <div className="row wrap" style={{ gap: 8, margin: '8px 0' }}>
                      {Object.entries(AIM_CURVES).map(([key, c]) => (
                        <button
                          key={key}
                          className="btn sm ghost"
                          title={t.curves[key]?.hint}
                          onClick={() => setDesign(c.pts.map((p) => ({ ...p })))}
                        >
                          {t.curves[key]?.label ?? key}
                        </button>
                      ))}
                    </div>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <button
                        className="btn sm"
                        disabled={design.length >= DESIGN_MAX_POINTS}
                        onClick={() => setDesign((d) => addDesignPoint(d.length >= 2 ? d : padCurve))}
                      >
                        {t.addPoint(design.length, DESIGN_MAX_POINTS)}
                      </button>
                      <button
                        className="btn sm ghost"
                        title={t.copyCurveTitle}
                        onClick={() => {
                          if (!profile || !pkt) return
                          const other = profile.sticks[which === 0 ? 1 : 0]
                          edit(() => stick.setCurve(other, stick.curve(pkt).map((p) => ({ ...p }))))
                        }}
                      >
                        {t.copyCurve}
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
                              <button className="btn sm ghost" disabled={design.length <= DESIGN_MIN_POINTS} title={t.removePoint} onClick={() => setDesign((d) => d.filter((_, j) => j !== i))}>−</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="note" style={{ marginTop: 8 }}>
                      {t.hwBytes} <span className="mono">{quantized.map((q) => `${q.x}/${q.y}`).join(' · ')}</span>
                    </div>
                  </div>

                  <div className="card">
                    <h3>{t.rateTitle}</h3>
                    <div className="hint">{t.rateHint}</div>
                    <div className="stack" style={{ gap: 12 }}>
                      <div className="row spread">
                        <div>
                          <div style={{ fontSize: 13.5 }}>{t.rateConstant}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                            {t.rateOnlyMouse}
                          </div>
                        </div>
                        <span className="mono">{t.rateStored(stick.mouseDpi(pkt))}</span>
                      </div>
                      <div className="row wrap" style={{ gap: 8 }}>
                        {[100, 150, 200, 250, 300].map((rate) => {
                          const wire = Math.min(rate, 255)
                          const active = stick.mouseDpi(pkt) === wire
                          return (
                            <button
                              key={rate}
                              className={`btn sm${active ? ' primary' : ' ghost'}`}
                              title={rate > 255 ? t.rateCapsTitle(wire) : t.rateStoresTitle(wire)}
                              onClick={() => edit(() => stick.setMouseDpi(pkt, wire))}
                            >
                              {rate}{rate > 255 ? '*' : ''}
                            </button>
                          )
                        })}
                        {stick.mapIndex(pkt) === 4 && (
                          <button
                            className="btn sm ghost"
                            title={t.restoreStickTitle}
                            onClick={() => edit(() => { stick.setMapIndex(pkt, which === 0 ? 1 : 2); stick.setMapped(pkt, true) })}
                          >
                            {t.backToStick(which === 0)}
                          </button>
                        )}
                      </div>
                      <div className="note">{t.rateNote}</div>
                    </div>
                  </div>

                  <div className="card">
                    <h3>{t.shapeTitle}</h3>
                    <div className="hint">{t.shapeHint}</div>
                    <div className="stack" style={{ gap: 8 }}>
                      {(['round', 'square', 'raw'] as const).map((id) => {
                        const s = t.shapes[id]
                        const isRaw = !stick.enabled(pkt)
                        const isSquare = stick.enabled(pkt) && stick.squareGate(pkt)
                        const isRound = stick.enabled(pkt) && !stick.squareGate(pkt)
                        const active = (id === 'round' && isRound) || (id === 'square' && isSquare) || (id === 'raw' && isRaw)
                        return (
                          <button
                            key={id}
                            className={`btn sm${active ? ' primary' : ' ghost'}`}
                            title={s.hint}
                            onClick={() => {
                              edit(() => {
                                if (id === 'raw') {
                                  stick.setEnabled(pkt, false)
                                } else {
                                  stick.setEnabled(pkt, true)
                                  stick.setSquareGate(pkt, id === 'square')
                                }
                              })
                            }}
                          >
                            {s.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="card" style={{ borderColor: 'var(--bad)' }}>
                    <h3>{t.resetTitle}</h3>
                    <div className="hint">{t.resetHint}</div>
                    <button
                      className="btn danger"
                      style={{ width: '100%', padding: '14px', fontSize: 15, fontWeight: 700, letterSpacing: '0.08em', marginTop: 10 }}
                      onClick={() => {
                        if (!profile || !fd) return
                        if (!window.confirm(t.resetConfirm)) return
                        edit(() => {
                          profile.sticks.forEach((s, i) => {
                            stick.setDeadzone(s, { begin: 50, end: 1000, beginAnti: 0, endAnti: 1000 })
                            stick.setCurve(s, LINEAR_CURVE.map((p) => ({ ...p })))
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
                          fun.extend.setLsAntiJitter(fd, 11)
                          fun.extend.setRsAntiJitter(fd, 11)
                        })
                        reloadDesignFromPad()
                        setMsg(t.resetDone)
                      }}
                    >
                      {t.resetButton}
                    </button>
                  </div>

                </div>
              </div>
            </>
          )}
          <ProfilesPanel connected={connected} activeSlot={info?.currentProfile ?? null} locked={locked} modelId={modelId} modelLen={modelLen} dumpLength={model?.dumpLength ?? 0} modelName={model?.marketingName ?? null} />
          <AnalyticsPanel
            context={
              profile && fd
                ? t.analyticsEditing(slot, gearHz.toLocaleString(), gear, resBits, bitsToLevels(resBits).toLocaleString())
                : t.analyticsIdle
            }
          />
        </div>
      </main>
    </div>
  )
}
