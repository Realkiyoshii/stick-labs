/**
 * Web build config — the same renderer UI, served as a plain browser app.
 *
 * Separate from electron.vite.config.ts on purpose: the Electron build bundles
 * `src/main` (node-hid, Electron), while this one must never touch it. The only
 * files pulled in from outside `src/web` are the renderer UI and `src/shared`
 * codecs (both dependency-free) plus the Node-free GameSir session
 * (`src/main/controller.ts`, transport-injected since the web port).
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  root: resolve('src/web'),
  base: './',
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true,
    target: 'es2022'
  },
  resolve: {
    alias: {
      '@': resolve('src/renderer'),
      '@shared': resolve('src/shared')
    }
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react()]
})
