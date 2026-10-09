/**
 * StickAdvanceConfig probe — read-only, never writes.
 *
 * GameSir's bundle routes an "advance" stick config (true sensitivity gain,
 * per-stick curve type/rate) through module 101 via the 0xE2 extended
 * transfer. The wire framing was never captured, so this tries the plausible
 * query shapes and logs ANY command response. Silence on all = unreachable.
 *
 *   node scripts/probe_adv.mjs [path-substring]
 */
import { execSync } from 'node:child_process'
import { discover } from '../src/main/hid.ts'
import { Controller } from '../src/main/controller.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function connectRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq GameSir Connect.exe" /FO CSV', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.split('\n').filter((l) => l.includes('GameSir Connect.exe')).length > 0
  } catch {
    return false
  }
}

function pad64(head: number[]): number[] {
  const out = new Array<number>(64).fill(0)
  head.forEach((b, i) => {
    if (i < 64) out[i] = b & 0xff
  })
  return out
}

// Plausible read-only query shapes for module 101 (StickAdvanceConfig).
// Round 2: baseline silence check + module sweep (does the payload EVER
// change?) + length variations.
const CANDIDATES: Array<{ name: string; bytes: number[] | null }> = [
  { name: 'BASELINE (send nothing, 4s)', bytes: null },
  { name: 'mod=99', bytes: pad64([0x0f, 0xe2, 99, 0, 0, 54]) },
  { name: 'mod=100', bytes: pad64([0x0f, 0xe2, 100, 0, 0, 54]) },
  { name: 'mod=101', bytes: pad64([0x0f, 0xe2, 101, 0, 0, 54]) },
  { name: 'mod=102', bytes: pad64([0x0f, 0xe2, 102, 0, 0, 54]) },
  { name: 'mod=103', bytes: pad64([0x0f, 0xe2, 103, 0, 0, 54]) },
  { name: 'mod=101 len=0', bytes: pad64([0x0f, 0xe2, 101, 0, 0, 0]) },
  { name: 'mod=101 len=8', bytes: pad64([0x0f, 0xe2, 101, 0, 0, 8]) }
]

const cands = discover()
console.log(`candidates: ${cands.length}`)
for (const c of cands) {
  console.log(`  pid=0x${c.productId.toString(16)} preferred=${c.preferred} product=${JSON.stringify(c.product)}`)
}
if (cands.length === 0) {
  console.error('No vendor interface — plug the pad in first.')
  process.exit(2)
}
if (connectRunning()) {
  console.error('GameSir Connect is running — close it first.')
  process.exit(3)
}

const wanted = process.argv[2]
let target = cands.find((c) => c.preferred) ?? cands[0]
if (wanted) {
  const hit = cands.find((c) => c.path.includes(wanted) || (c.product ?? '').toLowerCase().includes(wanted.toLowerCase()))
  if (!hit) {
    console.error(`No candidate matches ${JSON.stringify(wanted)}`)
    process.exit(2)
  }
  target = hit
}

const controller = new Controller()
const heard: Array<{ at: number; type: number; hex: string }> = []
const off = controller.transport.onResponse((raw) => {
  heard.push({
    at: Date.now(),
    type: raw[1],
    hex: Array.from(raw.slice(0, 32)).map((b) => b.toString(16).padStart(2, '0')).join(' ')
  })
})

try {
  const info = await controller.connect(target.path)
  console.log(`handshake ok — firmware=${info.firmware} currentProfile=${info.currentProfile}`)
  for (const cand of CANDIDATES) {
    heard.length = 0
    if (cand.bytes) controller.transport.write(cand.bytes)
    await sleep(4000)
    if (heard.length === 0) {
      console.log(`${cand.name}: silence`)
    } else {
      for (const h of heard) console.log(`${cand.name}: type=${h.type} ${h.hex}`)
    }
    controller.transport.heartbeat()
  }
} catch (err) {
  console.error(`probe failed — ${(err as Error).message}`)
  process.exitCode = 4
} finally {
  off()
  controller.disconnect()
}
console.log('advance probe done')
