/**
 * UI localisation. Each language is a typed dictionary with the same shape as
 * `en`, so a missing or mis-typed key in another language fails typecheck.
 * Values are plain strings, formatters for interpolated text, or JSX where a
 * sentence carries inline markup.
 *
 * The choice is persisted per machine; first run follows the system locale.
 */
import { useSyncExternalStore } from 'react'

export type Lang = 'en' | 'ru'

export const LANGUAGES: ReadonlyArray<{ id: Lang; name: string }> = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' }
]

type CurveText = { label: string; hint: string }

const en = {
  language: 'Language',

  // Curve presets
  curves: {
    linear: { label: 'Linear', hint: '1:1 raw' },
    fpsAim: { label: 'Kiyoshi Curve', hint: 'calm centre, hot edge' },
    micro: { label: 'Micro-aim', hint: 'extra-fine centre for tracking' },
    flick: { label: 'Flick/Snap', hint: 'fast start for 180s' },
    snappy: { label: 'Snappy mid', hint: 'COD-style boosted mid' },
    steady: { label: 'Steady track', hint: 'Apex-style even pull' },
    expo: { label: 'Expo', hint: 'late surge' },
    sacreds: { label: 'Sacreds', hint: 'Hyperstrike-style smooth fast start, 10 points' },
    machixo: { label: 'Machixo', hint: 'Slow-start desensitized, tops at 94%' }
  } as Record<string, CurveText>,

  // Model support notes, keyed by model id
  supportNotes: {
    G7ProCE: 'Profile codec proven byte-exact against hardware fixtures.',
    G7ProS: 'Reuses the G7ProCE proxy wholesale in the GameSir bundle: identical 1070-byte profile, 36-byte stick packet, Fun_Data offsets and 0xFE calibration. Only the gear table (250/500/1000) differs.',
    G7SE: 'Firmware-update-only in the GameSir bundle (Modes:[] — no config UI, no vendor-interface matcher). No tuning channel is known; tuning stays locked.',
    T3CE: 'Layout proven: 1935-byte blob (Name32, Fun32, 16x7, 9x169, 2x32 triggers, 2x36 sticks at 0x6E1, 2x41 motion, Ext8/9), same 36-byte stick packet and Fun_Data offsets as G7ProCE, same 0xFE calibration. Verified against live dumps.',
    T3Pro: 'This model is driven by GameSir’s native DLL (HandleByDll), not the HID command channel — it has no 0x0F listener, so even the handshake cannot answer. Use GameSir Connect for it; no HID app can configure it.',
    C2: 'Third protocol family (680-byte profile, 32-byte single-byte stick packets, no resolution/anti-jitter bytes, 0xFD calibration). Layout mapped from the GameSir bundle — tuning locked until a live dump proves it.'
  } as Record<string, string>,

  // Analytics
  analyticsTitle: 'Analytics — polling, latency, stick range',
  hzNow: (v: string): string => `${v} Hz now`,
  hzAvg: (v: string): string => `${v} Hz avg`,
  frames: (n: string): string => `${n} frames`,
  pause: 'Pause',
  resume: 'Resume',
  pollNote: 'Measured from the 0x12 input stream. Gear 5 streams ~500/s; gears 0–4 ~250/s — the 1K–8K labels are the USB poll claim, not the state rate.',
  measuring: 'Measuring…',
  runPings: 'Run 15 pings',
  pingResult: (median: string, mean: string, min: string, max: string): string => `median ${median} ms · mean ${mean} ms · min ${min} · max ${max}`,
  pingNote: 'Ping times ReadCurrentProfile end-to-end (USB + firmware). Under ~3 ms is healthy; near 100 ms means contention.',
  observedRange: 'Observed stick range (session)',
  reset: 'Reset',
  colAxis: 'Axis',
  colMin: 'Min',
  colMax: 'Max',
  colSpan: 'Span',
  extentsNote: (n: string): string => `${n} samples. Full span ≈ 255; rest should sit near 128 — a stuck min/max far from centre means drift or a bad calibration.`,
  extentsEmpty: 'Move both sticks through their full range to map it.',
  analyticsEditing: (slot: number, hz: string, gear: number, bits: number, levels: string): string =>
    `Now editing P${slot}: set ${hz} Hz (gear ${gear}) · ${bits}-bit (${levels} levels) — green chart is measured input, not the set rate.`,
  analyticsIdle: 'Connect and load a slot — then switch gear or RC, write, and watch this chart.',

  // Profiles
  slotsFailed: (n: number): string => `${n} slot(s) failed to read — Retry them individually`,
  readAll4: 'Read all 4 stick profiles',
  jsonNoBytes: 'JSON file has no bytes field',
  expectedBytes: (expected: number, got: number): string => `expected ${expected} bytes, got ${got}`,
  rejectedRestored: 'rejected — previous contents restored',
  didNotVerify: 'did not verify',
  imported: (file: string, slot: number): string => `Imported ${file} → P${slot} · verified`,
  importFailed: (m: string): string => `Import failed: ${m}`,
  confirmOverwrite: (to: number, from: number): string => `Overwrite P${to} with P${from}?`,
  copied: (from: number, to: number): string => `Copied P${from} → P${to} · verified`,
  copyFailed: (m: string): string => `Copy failed: ${m}`,
  backupDownloaded: 'Backup downloaded',
  backupFailed: (m: string): string => `Backup failed: ${m}`,
  noProfilesInFile: 'that file holds no profiles',
  confirmRestore: (count: number, list: string): string => `Write ${count} profile(s)? ${list}`,
  slotExpectedBytes: (slot: number, expected: number, got: number): string => `P${slot}: expected ${expected} bytes, got ${got}`,
  slotRejected: (slot: number): string => `P${slot} rejected — restored`,
  slotNotVerified: (slot: number): string => `P${slot} did not verify`,
  restored: (list: string): string => `Restored ${list} · all verified`,
  restoreFailed: (partial: string | null, m: string): string => `Restore failed: ${partial ? `restored ${partial} before failing — ` : ''}${m}`,
  connectToManage: 'Connect a controller to manage stick profiles.',
  lockedTitle: (name: string | null): string => `Locked — ${name ?? 'unknown model'}`,
  lockedHint: 'Profile backup is disabled for this model — its profile layout is unverified, so reads and writes stay off.',
  dumpTitle: 'Read-only: dumps all 4 slots for support analysis. Writes nothing.',
  dumpDownloaded: 'Dump downloaded — send it to RealKiyoshi to unlock this model.',
  dumpFailed: (m: string): string => `Dump failed: ${m}`,
  reading: 'Reading…',
  exportDump: 'Export raw dump for support',
  noDumpLength: 'No dump length is known for this model yet, so even read-only export stays off.',
  profilesTitle: 'Stick profiles — backup & transfer',
  profilesHint: 'Each slot is a 1070-byte blob; this card only reads/writes whole slots, so stick bytes are never half-merged.',
  working: 'Working…',
  readAll: 'Read all from controller',
  backupAll: 'Backup all → JSON',
  restoreAll: 'Restore all → controller',
  colSlot: 'Slot',
  colName: 'Name',
  colActive: 'Active',
  colActions: 'Actions',
  readingSlot: 'reading…',
  retry: 'Retry',
  unnamed: 'unnamed',
  current: 'current',
  exportBin: 'Export',
  exportJson: 'JSON',
  importFile: 'Import…',
  copyTo: 'Copy to…',

  // Connection / status messages
  padRestarted: 'Pad restarted to apply the write — if the sidebar shows disconnected, hit Rescan USB + Connect again.',
  padRebooting: 'Pad rebooted to apply the change — reconnecting automatically…',
  reconnected: 'Reconnected — profile reloaded.',
  detected: (name: string, note: string): string => `${name} detected — ${note}`,
  provingUnknown: 'Unknown edition — proving compatibility (read-only check)…',
  unlistedEdition: (pid: string): string =>
    `Unlisted edition (PID 0x${pid}) — family proven live by structural check. Report this PID to add it permanently.`,
  unknownNotFamily: (pid: string): string =>
    `Unknown model (PID 0x${pid}) — its profile does not read as G7-family, so it stays locked. Report the PID and model name to add it.`,
  unknownCheckFailed: (m: string): string =>
    `Unknown model — compatibility check failed (${m}). Locked as a safety default; report the PID to add it.`,
  writtenNotLive: (slot: number, live: number): string =>
    `Slot ${slot} written + verified — but the pad is running P${live}, so nothing changed yet. Use Activate P${slot} in the top bar to apply it (the pad reboots ~2 s).`,
  written: (slot: number): string =>
    `Slot ${slot} written + read-back verified. If the pad reboots (~1-2 s), it is applying the change — reconnect if needed.`,
  writeNotVerified: 'Write did not verify — previous bytes restored.',

  // Sidebar
  rescanUsb: 'Rescan USB',
  copyDiagTitle: 'Copy device + app details for support (nothing personal)',
  diagCopied: 'Diagnostics copied — paste it to RealKiyoshi.',
  copyDiag: 'Copy diagnostics',
  unknownDevice: (pid: string): string => `Unknown 0x${pid}`,
  disconnect: 'Disconnect',
  matchNote: 'Match: VID 0x3537 + usagePage 0xFFF0/0x40. Never match PID — it varies by color/mode.',
  fwLine: (fw: string, slot: number): string => `FW ${fw} · live slot P${slot}`,
  tuningLockedSuffix: ' · tuning locked',
  interfacePid: (pid: string): string => `Interface PID 0x${pid}`,
  receiverWarning: (
    <>
      That PID is the <strong>receiver</strong>, not the pad — reads time out on it. Disconnect and connect the ★ interface instead.
    </>
  ),
  connected: 'Connected',
  disconnected: 'Disconnected',
  developedBy: 'Developed by RealKiyoshi',

  // Top bar
  subtitle: 'bit depth + raw unlock · curves · live sticks',
  writeToController: 'Write to controller',
  activateTitle: 'Make this slot the active profile on the pad',
  slotNowActive: (slot: number): string => `Slot ${slot} is now active.`,
  slotActive: (slot: number): string => `P${slot} active`,
  activateSlot: (slot: number): string => `Activate P${slot}`,

  // First-run safety card
  safetyTitle: 'First — read this (30 seconds)',
  safetyItems: [
    <><strong>Back up first</strong> — Stick profiles card → Backup all → JSON. You can always restore.</>,
    <><strong>Close GameSir Connect</strong> — it holds the controller and blocks this app.</>,
    <><strong>Wired or 2.4G only</strong> — Bluetooth pads don't appear here, ever.</>,
    <><strong>Writing the active profile reboots the pad</strong> for ~2 seconds. Normal — it reconnects by itself.</>,
    <><strong>Tournaments</strong> — check your event's rules before competing on a tuned profile.</>
  ],
  gotIt: 'Got it',

  unsaved: 'Unsaved stick changes — write to apply. Writing the running slot reboots the pad (~1-2 s).',
  connectTitle: 'Connect a controller',
  connectBody: 'G7 Pro 8K · G7 Pro · Tarantula 8K (plus new 8K editions via auto-check). Rescan, then connect the vendor interface. Close GameSir Connect first — it holds the handle.',
  modelLocked: (name: string): string => `${name} — tuning locked`,
  unknownLockedTitle: 'Unknown controller — tuning locked',
  unknownLockedBody: 'This USB ID is not in the verified model table, so profile access stays off as a safety default.',
  liveStillWorks: 'Live input below still works. Profile reads/writes stay disabled until the layout is verified on hardware.',
  loadingProfile: 'Loading profile…',
  stickNames: ['Left stick', 'Right stick'],
  bitsPill: (bits: number, levels: string): string => `${bits}-bit · ${levels} levels`,

  // Polling
  pollingTitle: (list: string): string => `Polling rate — ${list}`,
  pollingHint: (model: string | null, gears: number): string =>
    `Report-rate gear (Fun_Data +14)${model ? ` · ${model} offers ${gears} gears` : ''}. Hz labels are the vendor's claim; measured input stays ~250–500/s.`,
  gearTitle: (g: number): string => `gear ${g}`,
  gearInferredTitle: (g: number): string => `gear ${g} (inferred — no vendor label)`,
  gearLabel: (g: number): string => `Gear: ${g}`,
  twoKInferred: '*2K inferred — completes the 250/500/1000/…/4000/8000 ladder',

  // Bit depth
  bitDepthTitle: 'Bit depth — 8–24',
  bitDepthHint: 'Hardware tops at 12-bit — past that the pad clamps or ignores, prove it on the crosshair.',
  beyondSiliconTitle: 'Beyond silicon — writes the implied raw wire, expect clamp/ignore',
  adcNote: '*The ADC tops at 12-bit and the USB stick report is 8-bit per axis — games see 256 steps no matter what.',
  nonStandardWire: (wire: number, bits: number): string =>
    `Non-standard wire ${wire} → effective ${bits}-bit. The firmware only documents 0–4 (12–8 bit); anything else may quantise oddly or be ignored. Verify on the live sticks before keeping it.`,

  // Dead zone
  deadzoneTitle: 'Dead zone + anti-deadzone — 0.1% steps',
  deadzoneHint: (
    <>
      Stored ×10 (50 = 5%). <strong>Start/End</strong> bound the input: below Start = no output, past End = already full. <strong>Anti-deadzone</strong> is the output floor/ceiling: raising Anti-start lifts the minimum output so small deflections bite sooner — the snap setting for FPS.
    </>
  ),
  sliderStart: 'Start (input below = 0)',
  sliderEnd: 'End (input above = full)',
  sliderAntiStart: 'Anti-deadzone start (output floor — snap)',
  sliderAntiEnd: 'Anti-deadzone end (output ceiling)',
  fieldStart: 'Start',
  fieldEnd: 'End',
  fieldAntiStart: 'Anti-start',
  fieldAntiEnd: 'Anti-end',
  physics: 'Physics: 0% + linear',
  factory5: 'Factory 5%',
  aimEndTitle: 'Full output at 80% deflection — pairs with FPS Aim',
  aimEnd: 'Aim End 80%',
  flickEndTitle: 'Full output at 65% — pairs with Flick/Snap',
  flickEnd: 'Flick End 65%',
  antiSnapTitle: 'Output floor 8% — small deflections bite sooner',
  antiSnap: 'Anti snap 8%',
  antiMaxTitle: 'Output floor 15% — maximum snap, watch for drift',
  antiMax: 'Anti max 15%',
  antiOffTitle: 'Neutral output window',
  antiOff: 'Anti off',
  centerGuardTitle: 'Watch this stick untouched for 10 s, then recommend the Start % that swallows its wander',
  measuringWander: (left: number): string => `Measuring… ${left}s — don't touch`,
  centerGuard: 'Center guard: measure wander',
  maxWander: (dev: number): string => `Max wander ${dev} steps off centre.`,
  setStart: (pct: number): string => `Set Start ${pct}%`,
  dismiss: 'Dismiss',

  // Outer threshold
  outerTitle: (unlimited: boolean): string => `Outer Threshold — ${unlimited ? '∞ no limit' : 'custom'}`,
  outerHint: <>The boundary of max stick input. This app offers one setting: <strong>no limit</strong>.</>,
  outerNoLimit: '∞ No limit (neutral 0)',
  outerActive: 'Active — full physical range',
  outerOff: 'Off — mild +10 boundary parked',
  outerOn: '∞ On',
  outerSet: 'Set ∞',
  outerWhat: (
    <>
      <strong>What this does.</strong> The outer threshold is the deflection where the stick hits maximum output.
      A positive buffer pulls that boundary inward, so max arrives earlier (hotter rim); a negative buffer
      soft-caps output below max instead (tamer rim — the zone where extra yaw/pitch-style effects bite).
      Neutral <strong>0 / ∞</strong> removes the boundary entirely: End 100%, output ceiling 100%, the pad's
      full physical range with nothing clipped or boosted at the rim.
    </>
  ),
  outerSame: (
    <>
      <strong>Same bytes, other names.</strong> Steam's Outer Threshold and the deadzone End / output-ceiling
      sliders all write the same two firmware fields (input-saturation End, output ceiling). They are just
      different labels for this boundary — setting ∞ here is identical to End 100% + ceiling 100% over there.
    </>
  ),
  outerCustom: 'This stick currently carries a custom boundary:',
  outerMaxAt: (pct: string): string => `max at ${pct}% deflection`,
  outerTopsAt: (pct: string): string => `output tops at ${pct}%`,
  outerTapSet: <>Tap <strong>Set ∞</strong> to clear it back to the full range.</>,

  // Live sticks
  liveTitle: 'Live sticks',
  liveHint: '0x12 vendor report, 0–255, centre 128. Move the sticks.',

  // Curve designer
  designerTitle: (n: number): string => `Custom curve designer — ${n} points`,
  designerHint: (
    <>
      The pad stores exactly <strong>5 points</strong>, so this is a free-point canvas (2–10): <span style={{ color: '#7db8ff' }}>● blue = your design, drag it</span>, <span style={{ color: 'var(--warn)' }}>▢ orange dashed = the 5 bytes that will be written</span>. Dual-zone presets mimic a dynamic response — the pad has no speed sensing, so this is the static LUT a dynamic curve averages to.
    </>
  ),
  designPending: 'design ≠ pad — send it',
  designMatches: 'pad matches design',
  send5: 'Send 5 to pad',
  reloadFromPad: 'Reload from pad',
  addPoint: (n: number, max: number): string => `+ Add point (${n}/${max})`,
  copyCurveTitle: "Copy this stick's pad curve to the other stick",
  copyCurve: 'Copy pad curve → other stick',
  removePoint: 'Remove point',
  hwBytes: 'Hardware bytes (quantized preview):',

  // Controller rate
  rateTitle: 'Controller Rate',
  rateHint: (
    <>
      How fast this stick answers in Mouse mode — higher moves the cursor more per deflection. It does <strong>not</strong> change how often the pad sends inputs; that is the Polling card.
    </>
  ),
  rateConstant: 'Rate — constant per pick',
  rateOnlyMouse: 'Only applies while Output is Mouse · firmware byte caps at 255',
  rateStored: (v: number): string => `stored: ${v}`,
  rateCapsTitle: (wire: number): string => `Firmware byte caps at 255 — stores ${wire}`,
  rateStoresTitle: (wire: number): string => `Stores ${wire}`,
  restoreStickTitle: 'Restore this stick to normal stick output',
  backToStick: (left: boolean): string => `← Back to ${left ? 'Left' : 'Right'} stick`,
  rateNote: 'Picks always write (100 / 150 / 200 / 250 / 255-max shown as 300*), but the pad only honors the byte while Output is Mouse. *300 exceeds the byte — the pad stores 255.',

  // Shape
  shapeTitle: 'Shape',
  shapeHint: 'Three shapes for this stick — processing on for the first two, fully bypassed for raw.',
  shapes: {
    round: { label: 'Round diagonals', hint: 'Uniform reach all directions (FPS aim)' },
    square: { label: 'Square gate', hint: 'Diagonals reach full deflection (hotter corners)' },
    raw: { label: 'Pure raw 1:1', hint: 'No processing — untouched magnetic signal' }
  },

  // Reset
  resetTitle: 'Reset everything',
  resetHint: 'Returns every byte this app can write to stock neutral — both sticks (deadzone, curve, flips, gate, axis, mouse rate, outputs), outer unlimited, 12-bit, 8K polling, RC off. Names, triggers, buttons and macros are untouched. Then Write to apply.',
  resetConfirm: 'Reset EVERYTHING this app controls to stock neutral?\n\nBoth sticks, outer, detail, polling, RC. Names, triggers, buttons and macros are kept.',
  resetDone: 'Everything reset to stock neutral — Write to apply it to the pad.',
  resetButton: 'RESET EVERYTHING'
}

export type Dict = typeof en

const ru: Dict = {
  language: 'Язык',

  curves: {
    linear: { label: 'Линейная', hint: '1:1 без изменений' },
    fpsAim: { label: 'Kiyoshi Curve', hint: 'спокойный центр, резкий край' },
    micro: { label: 'Микро-прицел', hint: 'сверхточный центр для трекинга' },
    flick: { label: 'Флик/Снап', hint: 'быстрый старт для разворотов на 180°' },
    snappy: { label: 'Резкая середина', hint: 'усиленная середина в стиле COD' },
    steady: { label: 'Ровный трекинг', hint: 'равномерная тяга в стиле Apex' },
    expo: { label: 'Экспонента', hint: 'поздний рывок' },
    sacreds: { label: 'Sacreds', hint: 'плавный быстрый старт в стиле Hyperstrike, 10 точек' },
    machixo: { label: 'Machixo', hint: 'медленный старт, пониженная чувствительность, максимум 94%' }
  },

  supportNotes: {
    G7ProCE: 'Кодек профиля побайтно проверен на эталонных дампах с устройства.',
    G7ProS: 'В бандле GameSir целиком использует прокси G7ProCE: тот же 1070-байтный профиль, 36-байтный пакет стика, смещения Fun_Data и калибровка 0xFE. Отличается только таблица частот (250/500/1000).',
    G7SE: 'В бандле GameSir поддерживается только обновление прошивки (Modes:[] — нет интерфейса настроек и сопоставления вендорского интерфейса). Канал настройки неизвестен, поэтому настройка заблокирована.',
    T3CE: 'Раскладка подтверждена: блок 1935 байт (Name32, Fun32, 16x7, 9x169, 2x32 триггера, 2x36 стика по 0x6E1, 2x41 датчики движения, Ext8/9), тот же 36-байтный пакет стика и смещения Fun_Data, что у G7ProCE, та же калибровка 0xFE. Проверено на живых дампах.',
    T3Pro: 'Эта модель управляется нативной DLL GameSir (HandleByDll), а не HID-каналом команд — у неё нет обработчика 0x0F, поэтому она не отвечает даже на рукопожатие. Используйте GameSir Connect: ни одно HID-приложение не сможет её настроить.',
    C2: 'Третье семейство протокола (профиль 680 байт, 32-байтные пакеты стиков с однобайтовыми полями, нет байтов разрядности/антидребезга, калибровка 0xFD). Раскладка восстановлена по бандлу GameSir — настройка заблокирована, пока её не подтвердит живой дамп.'
  },

  analyticsTitle: 'Аналитика — опрос, задержка, диапазон стиков',
  hzNow: (v) => `${v} Гц сейчас`,
  hzAvg: (v) => `${v} Гц в среднем`,
  frames: (n) => `${n} кадров`,
  pause: 'Пауза',
  resume: 'Продолжить',
  pollNote: 'Измеряется по входному потоку 0x12. Режим 5 даёт ~500/с, режимы 0–4 — ~250/с. Метки 1K–8K — заявленная частота опроса USB, а не частота обновления состояния.',
  measuring: 'Измерение…',
  runPings: 'Запустить 15 пингов',
  pingResult: (median, mean, min, max) => `медиана ${median} мс · среднее ${mean} мс · мин ${min} · макс ${max}`,
  pingNote: 'Пинг измеряет ReadCurrentProfile целиком (USB + прошивка). До ~3 мс — норма; около 100 мс — значит, устройство занято.',
  observedRange: 'Наблюдаемый диапазон стиков (за сессию)',
  reset: 'Сбросить',
  colAxis: 'Ось',
  colMin: 'Мин',
  colMax: 'Макс',
  colSpan: 'Размах',
  extentsNote: (n) => `${n} замеров. Полный размах ≈ 255; в покое значение должно быть около 128 — застрявший мин/макс далеко от центра означает дрейф или плохую калибровку.`,
  extentsEmpty: 'Проведите оба стика по всему диапазону, чтобы его измерить.',
  analyticsEditing: (slot, hz, gear, bits, levels) =>
    `Редактируется P${slot}: задано ${hz} Гц (режим ${gear}) · ${bits} бит (${levels} уровней) — зелёный график показывает измеренный ввод, а не заданную частоту.`,
  analyticsIdle: 'Подключите контроллер и загрузите слот — затем смените режим опроса или RC, запишите и следите за графиком.',

  slotsFailed: (n) => `Не удалось прочитать слотов: ${n} — повторите их по отдельности`,
  readAll4: 'Все 4 профиля стиков прочитаны',
  jsonNoBytes: 'в JSON-файле нет поля bytes',
  expectedBytes: (expected, got) => `ожидалось ${expected} байт, получено ${got}`,
  rejectedRestored: 'отклонено — прежнее содержимое восстановлено',
  didNotVerify: 'проверка не пройдена',
  imported: (file, slot) => `${file} импортирован → P${slot} · проверено`,
  importFailed: (m) => `Ошибка импорта: ${m}`,
  confirmOverwrite: (to, from) => `Перезаписать P${to} содержимым P${from}?`,
  copied: (from, to) => `P${from} скопирован → P${to} · проверено`,
  copyFailed: (m) => `Ошибка копирования: ${m}`,
  backupDownloaded: 'Резервная копия сохранена',
  backupFailed: (m) => `Ошибка резервного копирования: ${m}`,
  noProfilesInFile: 'в файле нет профилей',
  confirmRestore: (count, list) => `Записать профилей: ${count}? ${list}`,
  slotExpectedBytes: (slot, expected, got) => `P${slot}: ожидалось ${expected} байт, получено ${got}`,
  slotRejected: (slot) => `P${slot} отклонён — восстановлен`,
  slotNotVerified: (slot) => `P${slot} не прошёл проверку`,
  restored: (list) => `Восстановлено: ${list} · всё проверено`,
  restoreFailed: (partial, m) => `Ошибка восстановления: ${partial ? `до сбоя восстановлено ${partial} — ` : ''}${m}`,
  connectToManage: 'Подключите контроллер, чтобы управлять профилями стиков.',
  lockedTitle: (name) => `Заблокировано — ${name ?? 'неизвестная модель'}`,
  lockedHint: 'Резервное копирование профилей для этой модели отключено — раскладка её профиля не проверена, поэтому чтение и запись выключены.',
  dumpTitle: 'Только чтение: выгружает все 4 слота для анализа поддержкой. Ничего не записывает.',
  dumpDownloaded: 'Дамп сохранён — отправьте его RealKiyoshi, чтобы разблокировать эту модель.',
  dumpFailed: (m) => `Ошибка дампа: ${m}`,
  reading: 'Чтение…',
  exportDump: 'Экспорт сырого дампа для поддержки',
  noDumpLength: 'Длина дампа для этой модели пока неизвестна, поэтому даже экспорт только для чтения отключён.',
  profilesTitle: 'Профили стиков — резервная копия и перенос',
  profilesHint: 'Каждый слот — блок в 1070 байт; эта карточка читает и пишет только слоты целиком, поэтому байты стиков никогда не смешиваются наполовину.',
  working: 'Выполняется…',
  readAll: 'Прочитать всё с контроллера',
  backupAll: 'Сохранить всё → JSON',
  restoreAll: 'Восстановить всё → контроллер',
  colSlot: 'Слот',
  colName: 'Имя',
  colActive: 'Активен',
  colActions: 'Действия',
  readingSlot: 'чтение…',
  retry: 'Повторить',
  unnamed: 'без имени',
  current: 'текущий',
  exportBin: 'Экспорт',
  exportJson: 'JSON',
  importFile: 'Импорт…',
  copyTo: 'Копировать в…',

  padRestarted: 'Геймпад перезапустился, чтобы применить запись — если в боковой панели «Отключено», нажмите «Пересканировать USB» и подключитесь снова.',
  padRebooting: 'Геймпад перезагрузился, чтобы применить изменения — переподключаемся автоматически…',
  reconnected: 'Переподключено — профиль перезагружен.',
  detected: (name, note) => `Обнаружен ${name} — ${note}`,
  provingUnknown: 'Неизвестная версия — проверяем совместимость (только чтение)…',
  unlistedEdition: (pid) =>
    `Версия не из списка (PID 0x${pid}) — принадлежность к семейству подтверждена структурной проверкой. Сообщите этот PID, чтобы добавить его навсегда.`,
  unknownNotFamily: (pid) =>
    `Неизвестная модель (PID 0x${pid}) — её профиль не читается как профиль семейства G7, поэтому она заблокирована. Сообщите PID и название модели, чтобы её добавить.`,
  unknownCheckFailed: (m) =>
    `Неизвестная модель — проверка совместимости не удалась (${m}). Заблокировано из соображений безопасности; сообщите PID, чтобы её добавить.`,
  writtenNotLive: (slot, live) =>
    `Слот ${slot} записан и проверен — но геймпад работает на P${live}, поэтому пока ничего не изменилось. Нажмите «Активировать P${slot}» на верхней панели, чтобы применить (геймпад перезагрузится ~2 с).`,
  written: (slot) =>
    `Слот ${slot} записан, обратное чтение подтверждено. Если геймпад перезагружается (~1–2 с), он применяет изменения — при необходимости переподключитесь.`,
  writeNotVerified: 'Запись не прошла проверку — прежние байты восстановлены.',

  rescanUsb: 'Пересканировать USB',
  copyDiagTitle: 'Скопировать данные устройства и приложения для поддержки (ничего личного)',
  diagCopied: 'Диагностика скопирована — отправьте её RealKiyoshi.',
  copyDiag: 'Копировать диагностику',
  unknownDevice: (pid) => `Неизвестное 0x${pid}`,
  disconnect: 'Отключить',
  matchNote: 'Поиск: VID 0x3537 + usagePage 0xFFF0/0x40. Никогда не ищите по PID — он зависит от цвета и режима.',
  fwLine: (fw, slot) => `Прошивка ${fw} · активный слот P${slot}`,
  tuningLockedSuffix: ' · настройка заблокирована',
  interfacePid: (pid) => `PID интерфейса 0x${pid}`,
  receiverWarning: (
    <>
      Этот PID принадлежит <strong>приёмнику</strong>, а не геймпаду — чтение с него завершается по таймауту. Отключитесь и подключите интерфейс со ★.
    </>
  ),
  connected: 'Подключено',
  disconnected: 'Отключено',
  developedBy: 'Разработчик: RealKiyoshi',

  subtitle: 'разрядность и raw-режим · кривые · стики в реальном времени',
  writeToController: 'Записать в контроллер',
  activateTitle: 'Сделать этот слот активным профилем на геймпаде',
  slotNowActive: (slot) => `Слот ${slot} теперь активен.`,
  slotActive: (slot) => `P${slot} активен`,
  activateSlot: (slot) => `Активировать P${slot}`,

  safetyTitle: 'Сначала прочитайте это (30 секунд)',
  safetyItems: [
    <><strong>Сделайте резервную копию</strong> — карточка «Профили стиков» → «Сохранить всё → JSON». Восстановить можно всегда.</>,
    <><strong>Закройте GameSir Connect</strong> — он занимает контроллер и блокирует это приложение.</>,
    <><strong>Только провод или 2.4G</strong> — геймпады по Bluetooth здесь не появятся никогда.</>,
    <><strong>Запись активного профиля перезагружает геймпад</strong> примерно на 2 секунды. Это нормально — он переподключится сам.</>,
    <><strong>Турниры</strong> — проверьте правила мероприятия, прежде чем играть на настроенном профиле.</>
  ],
  gotIt: 'Понятно',

  unsaved: 'Есть несохранённые изменения стиков — запишите, чтобы применить. Запись активного слота перезагружает геймпад (~1–2 с).',
  connectTitle: 'Подключите контроллер',
  connectBody: 'G7 Pro 8K · G7 Pro · Tarantula 8K (а также новые 8K-версии через автопроверку). Пересканируйте и подключите вендорский интерфейс. Сначала закройте GameSir Connect — он удерживает устройство.',
  modelLocked: (name) => `${name} — настройка заблокирована`,
  unknownLockedTitle: 'Неизвестный контроллер — настройка заблокирована',
  unknownLockedBody: 'Этого USB ID нет в таблице проверенных моделей, поэтому доступ к профилям отключён из соображений безопасности.',
  liveStillWorks: 'Ввод в реальном времени ниже по-прежнему работает. Чтение и запись профилей отключены, пока раскладка не будет проверена на устройстве.',
  loadingProfile: 'Загрузка профиля…',
  stickNames: ['Левый стик', 'Правый стик'],
  bitsPill: (bits, levels) => `${bits} бит · ${levels} уровней`,

  pollingTitle: (list) => `Частота опроса — ${list}`,
  pollingHint: (model, gears) =>
    `Режим частоты отчётов (Fun_Data +14)${model ? ` · у ${model} режимов: ${gears}` : ''}. Значения в Гц заявлены производителем; измеренный ввод остаётся ~250–500/с.`,
  gearTitle: (g) => `режим ${g}`,
  gearInferredTitle: (g) => `режим ${g} (выведен — у производителя нет метки)`,
  gearLabel: (g) => `Режим: ${g}`,
  twoKInferred: '*2K выведен — дополняет ряд 250/500/1000/…/4000/8000',

  bitDepthTitle: 'Разрядность — 8–24',
  bitDepthHint: 'Железо ограничено 12 битами — выше геймпад обрезает или игнорирует значение, проверьте на прицеле.',
  beyondSiliconTitle: 'За пределами железа — записывает соответствующий сырой байт, ожидайте обрезку или игнорирование',
  adcNote: '*АЦП ограничен 12 битами, а USB-отчёт стика — 8 бит на ось: игры в любом случае видят 256 шагов.',
  nonStandardWire: (wire, bits) =>
    `Нестандартный байт ${wire} → фактически ${bits} бит. Прошивка документирует только 0–4 (12–8 бит); остальное может квантоваться странно или игнорироваться. Проверьте на живых стиках, прежде чем оставлять.`,

  deadzoneTitle: 'Мёртвая зона + анти-мёртвая зона — шаг 0,1%',
  deadzoneHint: (
    <>
      Хранится ×10 (50 = 5%). <strong>Начало/Конец</strong> ограничивают ввод: ниже Начала — нет вывода, после Конца — уже максимум. <strong>Анти-мёртвая зона</strong> — нижняя/верхняя граница вывода: поднятие Анти-начала увеличивает минимальный вывод, и малые отклонения срабатывают раньше — «резкая» настройка для шутеров.
    </>
  ),
  sliderStart: 'Начало (ввод ниже = 0)',
  sliderEnd: 'Конец (ввод выше = максимум)',
  sliderAntiStart: 'Начало анти-мёртвой зоны (минимум вывода — резкость)',
  sliderAntiEnd: 'Конец анти-мёртвой зоны (потолок вывода)',
  fieldStart: 'Начало',
  fieldEnd: 'Конец',
  fieldAntiStart: 'Анти-начало',
  fieldAntiEnd: 'Анти-конец',
  physics: 'Физика: 0% + линейная',
  factory5: 'Заводские 5%',
  aimEndTitle: 'Полный вывод при 80% отклонения — в паре с прицельной кривой',
  aimEnd: 'Конец для прицела 80%',
  flickEndTitle: 'Полный вывод при 65% — в паре с Флик/Снап',
  flickEnd: 'Конец для фликов 65%',
  antiSnapTitle: 'Минимум вывода 8% — малые отклонения срабатывают раньше',
  antiSnap: 'Анти: резко 8%',
  antiMaxTitle: 'Минимум вывода 15% — максимальная резкость, следите за дрейфом',
  antiMax: 'Анти: максимум 15%',
  antiOffTitle: 'Нейтральное окно вывода',
  antiOff: 'Анти: выкл',
  centerGuardTitle: 'Наблюдать за неподвижным стиком 10 с, затем предложить Начало в %, перекрывающее его дрейф',
  measuringWander: (left) => `Измерение… ${left} с — не трогайте`,
  centerGuard: 'Защита центра: измерить дрейф',
  maxWander: (dev) => `Максимальный дрейф — ${dev} шагов от центра.`,
  setStart: (pct) => `Установить Начало ${pct}%`,
  dismiss: 'Закрыть',

  outerTitle: (unlimited) => `Внешний порог — ${unlimited ? '∞ без ограничения' : 'свой'}`,
  outerHint: <>Граница максимального ввода стика. Это приложение предлагает одну настройку: <strong>без ограничения</strong>.</>,
  outerNoLimit: '∞ Без ограничения (нейтраль 0)',
  outerActive: 'Включено — полный физический диапазон',
  outerOff: 'Выключено — мягкая граница +10',
  outerOn: '∞ Вкл',
  outerSet: 'Установить ∞',
  outerWhat: (
    <>
      <strong>Что это делает.</strong> Внешний порог — это отклонение, при котором стик выдаёт максимальный вывод.
      Положительный буфер сдвигает границу внутрь, и максимум достигается раньше (более резкий край); отрицательный буфер
      мягко ограничивает вывод ниже максимума (более спокойный край — зона, где срабатывают дополнительные эффекты вроде yaw/pitch).
      Нейтральное значение <strong>0 / ∞</strong> полностью убирает границу: Конец 100%, потолок вывода 100% — весь
      физический диапазон геймпада без обрезки и усиления на краю.
    </>
  ),
  outerSame: (
    <>
      <strong>Те же байты, другие названия.</strong> Outer Threshold в Steam и ползунки Конец / потолок вывода мёртвой зоны
      записывают одни и те же два поля прошивки (Конец насыщения ввода, потолок вывода). Это просто разные названия
      одной границы — установить ∞ здесь равносильно Концу 100% + потолку 100% там.
    </>
  ),
  outerCustom: 'Сейчас у этого стика своя граница:',
  outerMaxAt: (pct) => `максимум при ${pct}% отклонения`,
  outerTopsAt: (pct) => `вывод ограничен ${pct}%`,
  outerTapSet: <>Нажмите <strong>Установить ∞</strong>, чтобы вернуть полный диапазон.</>,

  liveTitle: 'Стики в реальном времени',
  liveHint: 'Вендорский отчёт 0x12, 0–255, центр 128. Подвигайте стиками.',

  designerTitle: (n) => `Конструктор кривой — точек: ${n}`,
  designerHint: (
    <>
      Геймпад хранит ровно <strong>5 точек</strong>, поэтому здесь холст со свободными точками (2–10): <span style={{ color: '#7db8ff' }}>● синие — ваш дизайн, перетаскивайте</span>, <span style={{ color: 'var(--warn)' }}>▢ оранжевый пунктир — 5 байт, которые будут записаны</span>. Двухзонные пресеты имитируют динамический отклик — у геймпада нет датчика скорости, так что это статическая таблица, к которой в среднем сводится динамическая кривая.
    </>
  ),
  designPending: 'дизайн ≠ геймпад — отправьте',
  designMatches: 'геймпад совпадает с дизайном',
  send5: 'Отправить 5 точек',
  reloadFromPad: 'Загрузить с геймпада',
  addPoint: (n, max) => `+ Добавить точку (${n}/${max})`,
  copyCurveTitle: 'Скопировать кривую этого стика с геймпада на другой стик',
  copyCurve: 'Копировать кривую → другой стик',
  removePoint: 'Удалить точку',
  hwBytes: 'Байты для железа (квантованный предпросмотр):',

  rateTitle: 'Скорость контроллера',
  rateHint: (
    <>
      Насколько быстро стик откликается в режиме мыши — чем выше, тем дальше курсор на то же отклонение. Это <strong>не</strong> меняет частоту отправки ввода — за неё отвечает карточка «Частота опроса».
    </>
  ),
  rateConstant: 'Скорость — фиксированная для каждого варианта',
  rateOnlyMouse: 'Действует, только когда вывод — мышь · байт прошивки ограничен 255',
  rateStored: (v) => `сохранено: ${v}`,
  rateCapsTitle: (wire) => `Байт прошивки ограничен 255 — сохранится ${wire}`,
  rateStoresTitle: (wire) => `Сохранится ${wire}`,
  restoreStickTitle: 'Вернуть этому стику обычный вывод стика',
  backToStick: (left) => `← Обратно на ${left ? 'левый' : 'правый'} стик`,
  rateNote: 'Значение записывается всегда (100 / 150 / 200 / 250 / максимум 255 показан как 300*), но геймпад учитывает байт, только когда вывод — мышь. *300 превышает байт — геймпад сохранит 255.',

  shapeTitle: 'Форма',
  shapeHint: 'Три формы для этого стика — обработка включена для первых двух и полностью отключена для raw.',
  shapes: {
    round: { label: 'Круглые диагонали', hint: 'Одинаковый охват во всех направлениях (прицеливание в шутерах)' },
    square: { label: 'Квадратный ход', hint: 'Диагонали достигают полного отклонения (резкие углы)' },
    raw: { label: 'Чистый raw 1:1', hint: 'Без обработки — нетронутый магнитный сигнал' }
  },

  resetTitle: 'Сбросить всё',
  resetHint: 'Возвращает каждый байт, который может записать это приложение, к заводским нейтральным значениям — оба стика (мёртвая зона, кривая, инверсия, форма, оси, скорость мыши, вывод), внешний порог без ограничения, 12 бит, опрос 8K, RC выкл. Имена, триггеры, кнопки и макросы не меняются. Затем нажмите «Записать».',
  resetConfirm: 'Сбросить ВСЁ, чем управляет это приложение, к заводским нейтральным значениям?\n\nОба стика, внешний порог, разрядность, опрос, RC. Имена, триггеры, кнопки и макросы сохранятся.',
  resetDone: 'Всё сброшено к заводским значениям — нажмите «Записать», чтобы применить на геймпаде.',
  resetButton: 'СБРОСИТЬ ВСЁ'
}

const DICTS: Record<Lang, Dict> = { en, ru }
const STORAGE_KEY = 'sticklabs.lang'

function isLang(v: unknown): v is Lang {
  return LANGUAGES.some((l) => l.id === v)
}

function detect(): Lang {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    /* storage blocked — fall back to the system locale */
  }
  const sys = (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase()
  return /^(ru|uk|be|kk)\b/.test(sys) ? 'ru' : 'en'
}

let current: Lang = detect()
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang): void {
  current = lang
  try {
    window.localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* choice still applies for this session */
  }
  document.documentElement.lang = lang
  listeners.forEach((fn) => fn())
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang)
}

export function useT(): Dict {
  return DICTS[useLang()]
}
