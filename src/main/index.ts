/**
 * G7 Stick Lab — stick-only Electron main. No remap/macros/lighting code.
 * IPC: discover/connect, profile 1-4 read/write (verified), switch, calibration.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import { TRAY_ICON_PNG_BASE64 } from './trayIcon'
import { join } from 'node:path'
import { Controller, type DeviceInfo } from './controller'
import { Transport } from './hid'
import { discover, discoverLive } from './hid'
import { ljReadButtonTable, ljReadMainSnapshot, ljReadSnapshot, ljWriteButtonVerified, ljWriteStickVerified } from './leadjoy'
import type { LjButtonTarget, LjStickPatch } from '../shared/leadjoy'
import { ljButtonWriteRecord } from '../shared/leadjoy'
import { steamInfo, exportApexDeadzones, listInstalledGames, exportDeadzonesToGames } from './steam'
import { PROFILE_LENGTH, isFineCalibrationStatus } from '../shared/protocol'
import { runDeepPoll } from './deeppoll'

const controller = new Controller(new Transport(), discover)
let window_: BrowserWindow | null = null

// A second launch should reveal the existing tray instance instead of
// creating another Electron process and another tray icon.
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow()
    else void app.whenReady().then(showMainWindow)
  })
}

function send(channel: string, ...args: unknown[]): void {
  if (window_ && !window_.isDestroyed()) window_.webContents.send(channel, ...args)
}

const INPUT_SAMPLE_MS = 33
let lastSampleAt = 0
let samplePending = false
let lastFineCalibrationStatus = ''

controller.onInput((input) => {
  // GameSir Connect only treats a report as calibration progress when it
  // names both sticks and carries a documented fine-step value. Ordinary
  // live reports are commonly 0/0 and must not clear the UI's active stage.
  if (isFineCalibrationStatus(input.fineTarget, input.fineStep)) {
    const fineStatus = `${input.fineTarget}:${input.fineStep}`
    if (fineStatus !== lastFineCalibrationStatus) {
      // GameSir Connect consumes each valid report immediately. A dwell filter
      // can discard the G7 Pro 8K's brief progress report between input frames.
      lastFineCalibrationStatus = fineStatus
      send('calibration:status', {
        target: input.fineTarget,
        step: input.fineStep,
        timestamp: Date.now()
      })
    }
  } else {
    // Idle frames can be interleaved with calibration reports. Ignore them for
    // progress; retaining the last stable stage prevents it flickering gray.
  }
  const now = Date.now()
  const emit = (): void => {
    lastSampleAt = Date.now()
    const input = controller.latestInput
    if (input) send('input:sample', input)
  }
  if (now - lastSampleAt < INPUT_SAMPLE_MS) {
    if (samplePending) return
    samplePending = true
    setTimeout(() => {
      samplePending = false
      emit()
    }, INPUT_SAMPLE_MS)
    return
  }
  emit()
})

controller.transport.on('stats', (stats) => send('device:stats', stats))

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let reconnecting = false
let sessionEpoch = 0
/**
 * The pad drops its USB interface for ~1-2 s when a change is applied live
 * (write to the running slot, or switch onto a changed slot). Instead of
 * making the user Rescan + Connect by hand, re-open the first stable
 * interface: the PID reappears before it is usable, so presence is
 * re-checked after a gap before opening (same lesson as the write path).
 * Gives up after ~30 s and falls back to manual reconnect.
 */
async function autoReconnect(reason: string): Promise<void> {
  if (reconnecting) return
  reconnecting = true
  const epoch = sessionEpoch
  try {
    send('device:reconnecting', reason)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (epoch !== sessionEpoch || controller.transport.isOpen) return
      await sleepMs(800)
      if (epoch !== sessionEpoch || controller.transport.isOpen) return
      const cands = discover()
      const target = cands.find((c) => c.preferred) ?? cands[0]
      if (!target) continue
      await sleepMs(600)
      if (epoch !== sessionEpoch || controller.transport.isOpen) return
      if (!discover().some((c) => c.path === target.path)) continue
      try {
        const info = await controller.connect(target.path)
        controller.attachInputDecoder()
        controller.transport.startWatchdog(4000, () => void autoReconnect('silent'))
        send('device:reconnected', info)
        return
      } catch {
        /* keep trying until the deadline */
      }
    }
    send('device:stale', controller.transport.currentPath)
  } finally {
    reconnecting = false
  }
}

controller.transport.on('disconnected', (err: Error) => {
  void autoReconnect(err?.message ?? 'disconnected')
})

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
function fromB64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) }
    }
  })
}

handle('device:discover', () => discoverLive())
handle('leadjoy:readMain', (path: string) => ljReadMainSnapshot(path))
handle('leadjoy:readSlot', (req: { path: string; slot: number }) => {
  if (typeof req?.path !== 'string' || req.path.length === 0) throw new Error('leadjoy: refusing read without a device path')
  if (req.slot !== 0 && req.slot !== 1 && req.slot !== 2) throw new Error(`leadjoy: slot ${req.slot} is not Main/Sub1/Sub2`)
  return ljReadSnapshot(req.path, req.slot)
})
/**
 * LeadJoy extra-button remap (tournament-safe 1:1 only). Target is a button
 * id (A=1 B=2 X=4 Y=5) or null for stock/Origin; anything else is refused
 * here, not just in the UI. Proven path: single-record 61/w write + ack +
 * readback (docs/leadjoy-saber.md).
 */
handle('leadjoy:writeButton', async (req: { path: string; slot: number; id: number; target: LjButtonTarget | null }) => {
  const { path, slot, id, target } = req ?? {}
  if (typeof path !== 'string' || path.length === 0) throw new Error('leadjoy: refusing write without a device path')
  if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`leadjoy: slot ${slot} is not Main/Sub1/Sub2`)
  return ljWriteButtonVerified(path, slot, ljButtonWriteRecord(id, target))
})
handle('leadjoy:writeStick', async (req: { path: string; slot: number; side: number; patch: Record<string, unknown> }) => {
  const { path, slot, side, patch } = req ?? {}
  if (typeof path !== 'string' || path.length === 0) throw new Error('leadjoy: refusing write without a device path')
  if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`leadjoy: slot ${slot} is not Main/Sub1/Sub2`)
  if (side !== 0 && side !== 1) throw new Error(`leadjoy: side ${side} is not left/right`)
  return ljWriteStickVerified(path, slot, side, (patch ?? {}) as LjStickPatch)
})
handle('device:connect', async (path: string): Promise<DeviceInfo> => {
  sessionEpoch++
  lastFineCalibrationStatus = ''
  const info = await controller.connect(path)
  controller.attachInputDecoder()
  controller.transport.startWatchdog(4000, () => void autoReconnect('silent'))
  return info
})
handle('device:disconnect', () => {
  sessionEpoch++
  controller.disconnect()
  return true
})
handle('profile:read', async (profile: number, total?: number) => {
  const length = total ?? PROFILE_LENGTH
  if (!Number.isInteger(length) || length < 100 || length > 4096) throw new Error(`refusing read of ${length} bytes`)
  const bytes = await controller.readProfile(profile, length)
  return { bytes: b64(bytes), length: bytes.length }
})
handle('profile:write', async (profile: number, dataB64: string, length?: number) => {
  const bytes = fromB64(dataB64)
  const total = length ?? PROFILE_LENGTH
  if (bytes.length !== total) throw new Error(`payload is ${bytes.length} bytes, expected ${total}`)
  return controller.writeProfileVerified(profile, bytes, total)
})
handle('profile:switch', async (profile: number) => {
  await controller.switchProfile(profile)
  return true
})
handle('profile:current', async () => controller.getCurrentProfile())
handle('device:calibration', (state: number, partMask?: number, mode?: number) => {
  if (state === 0 && mode === 1) {
    lastFineCalibrationStatus = ''
  }
  return controller.calibration(state, partMask, mode)
})
handle('device:stickCenter', async (stick: number, direction: number) => {
  await controller.nudgeCenter(stick, direction)
  return true
})
handle('system:openExternal', (url: string) => {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('blocked URL')
  void shell.openExternal(url)
  return true
})
handle('system:version', () => app.getVersion())
// The renderer reports staged-but-unwritten edits (with its own translated
// wording) so hiding to the tray or quitting can warn first.
type UnsavedPrompt = { message: string; detail: string; confirm: string; cancel: string }
let unsaved: { dirty: boolean; hide?: UnsavedPrompt; quit?: UnsavedPrompt } = { dirty: false }
handle('system:setUnsaved', (state: typeof unsaved) => {
  unsaved = state && typeof state.dirty === 'boolean' ? state : { dirty: false }
  return true
})
/** True when the user chose to go ahead (or nothing is unsaved). */
function confirmUnsaved(prompt?: UnsavedPrompt): boolean {
  if (!unsaved.dirty || !prompt || !window_) return true
  const choice = dialog.showMessageBoxSync(window_, {
    type: 'warning', buttons: [prompt.confirm, prompt.cancel], defaultId: 1, cancelId: 1,
    message: prompt.message, detail: prompt.detail, noLink: true
  })
  return choice === 0
}
handle('steam:info', () => steamInfo())
handle('steam:export', (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) =>
  exportApexDeadzones(left, right, mouseRate ?? null, curveExp ?? null)
)
handle('steam:games', () => listInstalledGames())
handle('steam:exportAll', (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) => {
  const games = listInstalledGames()
  return { games: listInstalledGames(), result: exportDeadzonesToGames(left, right, games, mouseRate ?? null, curveExp ?? null) }
})
handle('diag:ping', async (count: number) => {
  const n = Math.max(1, Math.min(50, count))
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const started = performance.now()
    await controller.getCurrentProfile()
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: samples.length,
    samples,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length
  }
})
handle('diag:deeppoll', async (vid: number, pid: number, seconds?: number) => {
  if (!Number.isInteger(vid) || !Number.isInteger(pid)) throw new Error('refusing deep poll without VID:PID')
  return runDeepPoll({ vid, pid, seconds })
})

function createWindow(): void {
  window_ = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#14090d',
    title: 'Stick Labs',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window_.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window_.loadFile(join(__dirname, '../renderer/index.html'))
  window_.on('closed', () => {
    window_ = null
  })
}

function showMainWindow(): void {
  if (!window_ || window_.isDestroyed()) createWindow()
  if (window_?.isMinimized()) window_.restore()
  window_?.show()
  window_?.focus()
}

app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // WebHID for Flydigi Apex 5 (interrupt-OUT reports node-hid cannot send).
    // requestDevice still needs a user gesture; this only stops auto-deny.
    // (cast: Electron's Permission union predates the 'hid' literal.)
    callback((permission as string) === 'hid')
  })
  // This is the actual WebHID gate in Electron: without it the device
  // picker comes up empty. GameSir path is unaffected (node-hid).
  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'hid') return false
    const device = details.device as unknown as { vendorId?: number } | undefined
    // device may be undefined on some code paths — grant those too, the
    // requestDevice filters + user pick remain the real gate.
    return device?.vendorId === undefined || device.vendorId === 0x37d7
  })
  createWindow()

  // Self-update from GitHub Releases (packaged builds only — never in dev).
  // Silent by design: no dialogs. State is pushed to the renderer, which shows
  // the update button + badge in the sidebar; installing is the user's click.
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
      autoUpdater.autoDownload = true
      const push = (): void => send('update:status', updateStatus)
      autoUpdater.on('checking-for-update', () => {
        updateStatus = { state: 'checking' }
        push()
      })
      autoUpdater.on('update-available', (info) => {
        updateStatus = { state: 'downloading', version: info?.version, percent: 0 }
        push()
      })
      autoUpdater.on('update-not-available', () => {
        updateStatus = { state: 'current' }
        push()
      })
      autoUpdater.on('download-progress', (p) => {
        updateStatus = { state: 'downloading', version: updateStatus.version, percent: Math.round(p?.percent ?? 0) }
        push()
      })
      autoUpdater.on('update-downloaded', (info) => {
        updateStatus = { state: 'ready', version: info?.version }
        push()
      })
      autoUpdater.on('error', (err) => {
        updateStatus = { state: 'error', message: err?.message ?? 'update check failed' }
        push()
      })
      updateCheck = () => autoUpdater.checkForUpdates()
      updateInstall = () => autoUpdater.quitAndInstall()
      void autoUpdater.checkForUpdates().catch(() => undefined)
    } catch (err) {
      console.error(`[updater] disabled: ${(err as Error).message}`)
    }
  }
  // Close to tray: hiding keeps the app (and the pad's config session) alive.
  window_?.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      if (confirmUnsaved(unsaved.hide)) window_?.hide()
    }
  })
  createTray()

  app.on('activate', () => {
    showMainWindow()
  })
})

let quitting = false
let tray: Tray | null = null

/** Tray icon + menu. Quit here is the only path that really exits the app. */
function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`)
  tray = new Tray(icon)
  tray.setToolTip('Stick Labs')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Show Stick Labs',
        click: showMainWindow
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', showMainWindow)
}

// --- self-update surface (no dialogs; the renderer shows it) ----------------
interface UpdateStatus {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'
  version?: string
  percent?: number
  message?: string
}
let updateStatus: UpdateStatus = { state: 'idle' }
let updateCheck: (() => unknown) | null = null
let updateInstall: (() => unknown) | null = null

handle('update:status', () => updateStatus)
handle('update:check', async () => {
  if (!updateCheck) throw new Error('updates are handled by the packaged app — this build checks nothing')
  await updateCheck()
  return true
})
handle('update:install', async () => {
  updateInstall?.()
  return true
})

app.on('window-all-closed', () => {
  // With close-to-tray the window is hidden rather than destroyed, so this only
  // matters on the way out; quitting is handled below.
  if (process.platform !== 'darwin') return
})

/**
 * Leaving config mode with save=true is what commits the profile on the pad —
 * without it the session state can be dropped when the socket closes, which is
 * how settings appear to revert once the app is closed. Hold the quit until that
 * frame has gone out, then exit for real.
 */
app.on('before-quit', (event) => {
  if (quitting) return
  if (!confirmUnsaved(unsaved.quit)) {
    event.preventDefault()
    return
  }
  quitting = true
  event.preventDefault()
  void (async () => {
    try {
      await controller.exitConfig(true)
    } catch {
      /* device already gone — nothing to save */
    }
    controller.disconnect()
    app.quit()
  })()
})
