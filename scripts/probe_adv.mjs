/** One-shot runner for tests/probe_advance.ts (see probe.mjs for the pattern). */
import { build } from 'esbuild'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, '.probe-tmp')

try {
  mkdirSync(outDir, { recursive: true })
  const result = await build({
    entryPoints: [join(root, 'tests', 'probe_advance.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['node-hid', 'electron'],
    outdir: outDir,
    write: false,
    sourcemap: 'inline',
    logLevel: 'warning',
    absWorkingDir: root
  })
  if (result.errors.length > 0) process.exit(1)
  for (const file of result.outputFiles ?? []) {
    const dest = join(outDir, 'probe_adv.mjs')
    writeFileSync(dest, file.contents)
    const run = spawnSync(process.execPath, [dest, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root })
    process.exit(run.status ?? 1)
  }
} catch (err) {
  console.error(err)
  process.exit(1)
} finally {
  try {
    rmSync(outDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
