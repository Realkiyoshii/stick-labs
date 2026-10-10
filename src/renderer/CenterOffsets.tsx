import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { api, type LiveSample } from './api'
import type { CenterDirection } from '@shared/center'

export function CenterOffsets({ busy }: { busy: boolean }): JSX.Element {
  const [sample, setSample] = useState<LiveSample | null>(null)
  const [now, setNow] = useState(Date.now())
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState('')
  const [steps, setSteps] = useState([0, 0])
  const drag = useRef<{ side: number; x: number; y: number; queue: CenterDirection[] } | null>(null)
  const working = useRef(false)
  const latest = useRef({ sample, busy })
  latest.current = { sample, busy }
  useEffect(() => {
    const off = api().on('input:sample', (s) => setSample(s as unknown as LiveSample))
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => { drag.current = null; off(); window.clearInterval(timer) }
  }, [])
  const fresh = !!sample?.live && !sample.calMask && now - sample.timestamp < 1000
  const raw = sample?.centerRaw
  async function adjust(side: number, direction: CenterDirection): Promise<void> {
    if (working.current) return
    working.current = true
    setSending(true)
    setMessage('Applying one center nudge…')
    try {
      await api().adjustCenter(side, direction)
      setSteps((s) => s.map((v, i) => i === side ? v + 1 : v))
      setMessage('Controller acknowledged the nudge. Check the live center; no profile write is needed.')
    } catch (e) { setMessage((e as Error).message) }
    finally { working.current = false; setSending(false) }
  }
  async function drainDrag(): Promise<void> {
    if (working.current) return
    working.current = true
    setSending(true)
    try {
      while (drag.current?.queue.length) {
        const active = drag.current
        const { sample: live, busy: blocked } = latest.current
        const axes = live?.centerRaw
        const x = axes ? active.side === 0 ? axes.lx : axes.rx : NaN
        const y = axes ? active.side === 0 ? axes.ly : axes.ry : NaN
        if (blocked || !live?.live || !!live.calMask || Date.now() - live.timestamp >= 1000 || !(Math.abs(x) <= .3 && Math.abs(y) <= .3)) {
          drag.current = null
          setMessage('Dragging stopped. Release the stick near center and wait for fresh input.')
          break
        }
        await api().adjustCenter(active.side, active.queue.shift()!)
        setSteps((s) => s.map((v, i) => i === active.side ? v + 1 : v))
        setMessage('Controller acknowledged the mouse nudge. Release the mouse to stop.')
        await new Promise((resolve) => window.setTimeout(resolve, 80))
      }
    } catch (e) {
      drag.current = null
      setMessage((e as Error).message)
    } finally { working.current = false; setSending(false) }
  }
  function moveDrag(event: PointerEvent<SVGSVGElement>): void {
    const active = drag.current
    if (!active) return
    // Bound pending work so fast mouse movement cannot create a long command backlog.
    while (active.queue.length < 8) {
      const rx = event.clientX - active.x
      const ry = event.clientY - active.y
      if (Math.max(Math.abs(rx), Math.abs(ry)) < 6) break
      if (Math.abs(rx) >= Math.abs(ry)) {
        active.queue.push(rx > 0 ? 'right' : 'left')
        active.x += Math.sign(rx) * 6
      } else {
        active.queue.push(ry > 0 ? 'down' : 'up')
        active.y += Math.sign(ry) * 6
      }
    }
    if (active.queue.length === 8) { active.x = event.clientX; active.y = event.clientY }
    void drainDrag()
  }
  return <div className="stack" style={{ gap: 16 }}>
    <div className="card">
      <h3>Center offsets</h3>
      <p className="hint">Fine-tune the resting center of each stick with the same directional nudges as GameSir Connect 1.16.7.</p>
      <div className="note">Each arrow applies immediately to the controller across all profiles. These offsets are separate from exported profiles. GameSir restores the default through stick recalibration; there is no verified reset or absolute-offset readback here.</div>
      <p className="hint">Leave the sticks untouched. Drag inside a preview to nudge its center in the direction you move, or use the arrows for individual steps. Release the mouse to stop; one command already sent may still finish. The dot shows live original-axis values, not a simulated offset.</p>
    </div>
    <div className="two">
      {[0, 1].map((side) => {
        const x = raw ? side === 0 ? raw.lx : raw.rx : 0
        const y = raw ? side === 0 ? raw.ly : raw.ry : 0
        const ready = fresh && !!raw && Math.abs(x) <= .3 && Math.abs(y) <= .3
        const disabled = busy || sending || !ready
        return <div className="card" key={side}>
          <h3>{side === 0 ? 'Left stick' : 'Right stick'}</h3>
          <svg viewBox="0 0 260 260" width="100%" style={{ maxHeight: 260, touchAction: 'none', cursor: disabled ? 'default' : 'grab' }} role="img" aria-label={`${side === 0 ? 'Left' : 'Right'} live center preview`}
            onPointerDown={(event) => {
              if (disabled || working.current || event.button !== 0) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { side, x: event.clientX, y: event.clientY, queue: [] }
            }}
            onPointerMove={moveDrag}
            onPointerUp={() => { drag.current = null }}
            onPointerCancel={() => { drag.current = null }}
            onLostPointerCapture={() => { drag.current = null }}>
            <circle cx="130" cy="130" r="100" fill="var(--bg)" stroke="var(--line-2)" />
            <path d="M30 130H230 M130 30V230" stroke="var(--text-2)" />
            {[.1, .2].map((v) => <circle key={v} cx="130" cy="130" r={v * 300} fill="none" stroke="var(--line-2)" opacity=".7" />)}
            {fresh && raw && <circle cx={130 + Math.max(-.3, Math.min(.3, x)) * 300} cy={130 + Math.max(-.3, Math.min(.3, y)) * 300} r="5" fill="var(--accent, #e84950)" />}
          </svg>
          <p className="mono">{fresh && raw ? `X ${(x * 100).toFixed(2)}% · Y ${(y * 100).toFixed(2)}%` : 'Waiting for live original-axis values…'}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, maxWidth: 240, margin: '0 auto' }}>
            <span /><button className="btn" aria-label={`${side === 0 ? 'Left' : 'Right'} center up`} disabled={disabled} onClick={() => void adjust(side, 'up')}>↑</button><span />
            <button className="btn" aria-label={`${side === 0 ? 'Left' : 'Right'} center left`} disabled={disabled} onClick={() => void adjust(side, 'left')}>←</button><span className="hint" style={{ alignSelf: 'center', textAlign: 'center' }}>Nudge</span><button className="btn" aria-label={`${side === 0 ? 'Left' : 'Right'} center right`} disabled={disabled} onClick={() => void adjust(side, 'right')}>→</button>
            <span /><button className="btn" aria-label={`${side === 0 ? 'Left' : 'Right'} center down`} disabled={disabled} onClick={() => void adjust(side, 'down')}>↓</button><span />
          </div>
          <p className="hint">{steps[side]} acknowledged nudges this session. {fresh && raw && !ready ? 'Release the stick near its center before adjusting.' : 'Display zoom: ±30%. Positive Y points down.'}</p>
        </div>
      })}
    </div>
    {message && <p role="status" className="note">{message}</p>}
  </div>
}
