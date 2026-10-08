/**
 * Tarantula (T3CE) read-only probe — zero writes, safe to run any time.
 *
 *   node scripts/probe.mjs [path-substring]
 *
 * Enumerates the vendor interface, handshakes (enter config + FW + current
 * profile), then dumps profiles 1-4 at the T3CE 1935-byte length into
 * fixtures/tarantula/. Refuses to run while GameSir Connect holds the device.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discover } from '../src/main/hid.ts'
import { Controller } from '../src/main/controller.ts'

const T3CE_LENGTH = 1935

function connectRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq GameSir Connect.exe" /FO CSV', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return out.split('\n').filter((l) => l.includes('GameSir Connect.exe')).length > 0
  } catch {
    return false
  }
}

const cands = discover()
console.log(`candidates on 0x3537/FFF0:40: ${cands.length}`)
for (const c of cands) {
  console.log(`  pid=0x${c.productId.toString(16)} preferred=${c.preferred} product=${JSON.stringify(c.product)} path=${c.path}`)
}
if (cands.length === 0) {
  console.error('No vendor interface found — plug the Tarantula in (or its receiver) and rescan.')
  process.exit(2)
}

if (connectRunning()) {
  console.error('GameSir Connect is running — close it first, it holds the HID handle.')
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
console.log(`probing pid=0x${target.productId.toString(16)} product=${JSON.stringify(target.product)}`)

const controller = new Controller()
try {
  const info = await controller.connect(target.path)
  console.log(`handshake ok — firmware=${info.firmware} dongle=${info.dongle || 'n/a'} currentProfile=${info.currentProfile}`)

  const dir = join(process.cwd(), 'fixtures', 'tarantula')
  mkdirSync(dir, { recursive: true })
  const dumps = new Map<number, Uint8Array>()
  for (const slot of [1, 2, 3, 4]) {
    try {
      const bytes = await controller.readProfile(slot, T3CE_LENGTH)
      const allZero = bytes.every((b) => b === 0)
      writeFileSync(join(dir, `profile_${slot}.bin`), bytes)
      dumps.set(slot, bytes)
      const name = readName(bytes)
      console.log(`slot ${slot}: ${bytes.length} bytes, allZero=${allZero}, name=${JSON.stringify(name)}`)
    } catch (err) {
      console.error(`slot ${slot}: READ FAILED — ${(err as Error).message}`)
    }
  }

  // Identical-bytes write-back on a non-running slot: proves the 1935-byte
  // write path end-to-end without changing a single setting. Gated behind
  // WRITE_TEST=1 and refused on the running slot.
  if (process.env.WRITE_TEST === '1') {
    const idle = [1, 2, 3, 4].find((s) => s !== info.currentProfile && dumps.has(s))
    if (idle === undefined) {
      console.error('write test refused: no non-running slot with a dump')
    } else {
      console.log(`write test: identical ${T3CE_LENGTH}-byte write-back on idle slot ${idle}…`)
      const result = await controller.writeProfileVerified(idle, dumps.get(idle)!, T3CE_LENGTH)
      console.log(`write test: verified=${result.verified} rolledBack=${result.rolledBack}`)
      if (!result.verified) process.exitCode = 5
    }
  }
} catch (err) {
  console.error(`handshake failed — ${(err as Error).message}`)
  process.exitCode = 4
} finally {
  controller.disconnect()
}
console.log('probe done — dumps in fixtures/tarantula/')

function readName(bytes: Uint8Array): string {
  let end = bytes.indexOf(0, 0)
  if (end < 0 || end > 32) end = 32
  return new TextDecoder().decode(bytes.subarray(0, end)).replace(/\0/g, '').trim()
}
