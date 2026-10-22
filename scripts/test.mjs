/**
 * Test runner: bundles the TS tests with esbuild, then executes them in Node.
 * Keeps us free of a separate ts-node/tsx dependency.
 *
 *   node scripts/test.mjs                 (safe default suite)
 *   node scripts/test.mjs tests/leadjoy.ts (one or more named tests)
 */
import { build } from 'esbuild'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const tests = process.argv.slice(2)
// Keep the default suite to deterministic codec/model tests. Live hardware and
// system-integration probes stay opt-in and must be named explicitly.
const entry =
  tests.length > 0
    ? tests
    : [
        'tests/rawbytes.ts',
        'tests/models.ts',
        'tests/t3ce.ts',
        'tests/c2.ts',
        'tests/leadjoy.ts',
        'tests/sharecode.ts',
        'tests/community.ts',
        'tests/shiftlayer.ts',
        'tests/curveidentity.ts',
        'tests/splinecurve.ts',
        'tests/splinemode.ts',
        'tests/linearity.ts',
        'tests/linearstack.ts',
        'tests/curvemodels.ts',
        'tests/dynamic.ts',
        'tests/writeverify.ts',
        'tests/buttonremap.ts',
        'tests/centertrim.ts',
        'tests/steamcfg.ts'
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
