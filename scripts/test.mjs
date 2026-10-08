/**
 * Test runner: bundles the TS tests with esbuild, then executes them in Node.
 * Keeps us free of a separate ts-node/tsx dependency.
 *
 *   node scripts/test.mjs
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const tests = process.argv.slice(2)
// Hardware tests (device.ts, gearsweep.ts, inspect.ts) are opt-in — they need a
// controller attached and, for gearsweep, GameSir Connect closed.
const entry =
  tests.length > 0
    ? tests
    : [
        'tests/roundtrip.ts',
        'tests/commands.ts',
        'tests/sticks.ts',
        'tests/writeguard.ts',
        'tests/autoswitch.ts',
        'tests/backup.ts',
        'tests/foreground.ts'
      ]

// Must live inside the project so node can resolve node_modules (ESM does not
// honour NODE_PATH, and a system temp dir has no node_modules above it).
const outDir = join(root, '.test-tmp')

try {
  mkdirSync(outDir, { recursive: true })

  const result = await build({
    entryPoints: entry.map((t) => join(root, t)),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    // Native modules must be require()d at runtime, not bundled.
    external: ['node-hid', 'electron'],
    outdir: outDir,
    write: false,
    sourcemap: 'inline',
    logLevel: 'warning',
    absWorkingDir: root
  })

  if (result.errors.length > 0) process.exit(1)

  let failed = 0
  for (const file of result.outputFiles ?? []) {
    // .mjs so Node treats the bundle as ESM regardless of package.json type.
    const base = (file.path.split(/[/\\]/).pop() ?? 'test.js').replace(/\.js$/, '')
    const dest = join(outDir, `${base}.mjs`)
    writeFileSync(dest, file.contents)
    // cwd = project root so tests can locate fixtures/ via process.cwd()
    const run = spawnSync(process.execPath, [dest], { stdio: 'inherit', cwd: root })
    if (run.status !== 0) failed++
  }

  process.exit(failed > 0 ? 1 : 0)
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
