/**
 * Controller model registry — multi-pad support.
 *
 * Each entry describes one pad's wire identity and what Stick Labs may do
 * with it. `full` means the model has a verified editing path, which may use
 * its own protocol instead of the GameSir profile blob. GameSir profile
 * geometry is enabled only where offsets, lengths, and wire semantics are
 * proven. `detect-only` models are named but kept read-only.
 *
 * NEVER match a device on productId for opening it (it varies by color and
 * mode); pids[] is documentation for the UI, not a filter.
 */

export type SupportLevel = 'full' | 'detect-only' | 'unsupported'

export interface ReportRateGear {
  gear: number
  hz: number
  confirmed: boolean
}

export interface ControllerModel {
  /** Internal product key, mirroring GameSir Connect's proxy names. */
  id: string
  marketingName: string
  vendorId: number
  usagePage: number
  usage: number
  /** Product IDs seen in the wild — display only, never a match filter. */
  pids: number[]
  /** USB product-string fragments used to tell models apart. */
  productHints: string[]
  reportRates: ReportRateGear[]
  /** Total profile blob length; 0 when unconfirmed. */
  profileLength: number
  /**
   * Read length for support dumps (bundle-known even when the layout is
   * unverified). 0 = unknown, dump button stays off.
   */
  dumpLength: number
  support: SupportLevel
  supportNote: string
}

export const MODELS: ReadonlyArray<ControllerModel> = [
  {
    id: 'G7ProCE',
    marketingName: 'GameSir G7 Pro 8K',
    vendorId: 0x3537,
    usagePage: 0xfff0,
    usage: 0x40,
    pids: [0x0913, 0x0914, 0x0927, 0x0928, 0x0929, 0x092a, 0x1032, 0x1033, 0x1034, 0x1035, 0x1036, 0x1037, 0x10b7, 0x10b9, 0x10c5, 0x10c6, 0x10c7, 0x10c8, 0x10c9, 0x10ca, 0x10cb, 0x10cc, 0x10cd, 0x10ce, 0x10fb, 0x10fc, 0x10fd, 0x10fe],
    productHints: ['G7 Pro 8K', 'G7ProCE'],
    reportRates: [
      { gear: 0, hz: 250, confirmed: true },
      { gear: 1, hz: 500, confirmed: true },
      { gear: 2, hz: 1000, confirmed: true },
      { gear: 3, hz: 2000, confirmed: false },
      { gear: 4, hz: 4000, confirmed: true },
      { gear: 5, hz: 8000, confirmed: true }
    ],
    profileLength: 1070,
    dumpLength: 1070,
    support: 'full',
    supportNote: 'Profile codec proven byte-exact against hardware fixtures.'
  },
  {
    // Legacy internal family ID retained: the Saber Plus and Xeno Pro share
    // the generic 4131:3519 configuration identity, so USB cannot name one reliably.
    id: 'SaberPlus',
    marketingName: 'LeadJoy Saber Plus / Xeno Pro',
    vendorId: 0x4131,
    usagePage: 0xff80,
    usage: 0x01,
    pids: [0x3519],
    productHints: ['Xeno Pro', 'Xeno', 'Saber', 'LeadJoy'],
    reportRates: [],
    profileLength: 0,
    dumpLength: 0,
    support: 'full',
    supportNote: 'Shared LeadJoy protocol for Saber Plus / Xeno Pro: button remaps, stick curves/deadzones, shape and stick-to-mouse sensitivity. Trigger settings remain read-only. Readback/restore protection is used for every supported write. USB product IDs do not distinguish these two models.'
  },
  {
    id: 'G7SE',
    marketingName: 'GameSir G7 SE',
    vendorId: 0x3537,
    usagePage: 0xfff0,
    usage: 0x40,
    pids: [0x10a3],
    productHints: ['G7 SE', 'G7SE', 'SL3101', '3101'],
    reportRates: [],
    profileLength: 0,
    dumpLength: 0,
    support: 'detect-only',
    supportNote: 'Firmware-update-only in the GameSir bundle (Modes:[] — no config UI, no vendor-interface matcher). No tuning channel is known; tuning stays locked.'
  },
  {
    id: 'T3CE',
    marketingName: 'GameSir Tarantula 8K (T3CE)',
    vendorId: 0x3537,
    usagePage: 0xfff0,
    usage: 0x40,
    pids: [0x103d, 0x10ff, 0x090d],
    productHints: ['Tarantula', 'T3CE'],
    reportRates: [
      { gear: 0, hz: 250, confirmed: false },
      { gear: 2, hz: 1000, confirmed: false },
      { gear: 4, hz: 4000, confirmed: false },
      { gear: 5, hz: 8000, confirmed: false }
    ],
    profileLength: 1935,
    dumpLength: 1935,
    support: 'full',
    supportNote: 'Layout proven: 1935-byte blob (Name32, Fun32, 16x7, 9x169, 2x32 triggers, 2x36 sticks at 0x6E1, 2x41 motion, Ext8/9), same 36-byte stick packet and Fun_Data offsets as G7ProCE, same 0xFE calibration. Verified against live dumps.'
  },
  {
    id: 'T3Pro',
    marketingName: 'GameSir Tarantula Pro',
    vendorId: 0x3537,
    usagePage: 0xfff0,
    usage: 0x40,
    pids: [0x1050, 0x103e, 0x100b, 0x1042],
    productHints: ['Tarantula Pro', 'T3Pro'],
    reportRates: [],
    profileLength: 0,
    dumpLength: 0,
    support: 'unsupported',
    supportNote: 'This model is driven by GameSir\u2019s native DLL (HandleByDll), not the HID command channel — it has no 0x0F listener, so even the handshake cannot answer. Use GameSir Connect for it; no HID app can configure it.'
  },
  {
    id: 'C2',
    marketingName: 'GameSir Cyclone 2',
    vendorId: 0x3537,
    usagePage: 0xfff0,
    usage: 0x40,
    pids: [0x101d, 0x102a, 0x1053, 0x100b],
    productHints: ['Cyclone', 'C2'],
    reportRates: [
      { gear: 0, hz: 250, confirmed: false },
      { gear: 2, hz: 1000, confirmed: false },
      { gear: 4, hz: 4000, confirmed: false },
      { gear: 5, hz: 8000, confirmed: false }
    ],
    profileLength: 0,
    dumpLength: 680,
    support: 'detect-only',
    supportNote: 'Third protocol family (680-byte profile, 32-byte single-byte stick packets, no resolution/anti-jitter bytes, 0xFD calibration). Layout mapped from the GameSir bundle — tuning locked until a live dump proves it.'
  },
  {
    id: 'HyperStrike',
    marketingName: 'HyperStrike',
    vendorId: 0x0170,
    usagePage: 0xff60,
    usage: 0x61,
    pids: [0xbb80],
    productHints: ['HyperStrike'],
    reportRates: [],
    profileLength: 0,
    dumpLength: 0,
    support: 'detect-only',
    supportNote: 'Read-only: Stick Labs reads polling, sampling, resolution and curves over the HyperStrike Driver interface (proven on fw 2.66). Nothing is written.'
  },
  {
    id: 'Apex5',
    marketingName: 'Flydigi Apex 5',
    vendorId: 0x37d7,
    usagePage: 0xffa0,
    usage: 0x01,
    pids: [0x2501],
    productHints: ['APEX5', 'Apex 5'],
    reportRates: [],
    profileLength: 0,
    dumpLength: 0,
    support: 'detect-only',
    supportNote: 'Stick curves, deadzones, shape, button binds (incl. M1–M6) and device settings over the Flydigi vendor interface; every write is read back and restored on mismatch (proven on fw 7.0.4.5).'
  }
]

/** Identify a model from a USB product string; null when unknown. */
export function identifyModel(product: string | undefined, productId?: number): ControllerModel | null {
  // PID first: Windows reports generic product strings ("Xbox 360 Controller
  // for Windows") on the vendor interface, so names cannot be trusted.
  // (PIDs only LABEL the pad after opening it — never filter by them.)
  if (productId !== undefined) {
    for (const m of MODELS) {
      if (m.pids.includes(productId)) return m
    }
  }
  if (!product) return null
  const hay = product.toLowerCase()
  // 8K variant first — its name contains the base model's name.
  for (const m of MODELS) {
    if (m.id === 'G7ProCE' && m.productHints.some((h) => hay.includes(h.toLowerCase()))) return m
  }
  // Longest hint wins, so 'Tarantula Pro' beats 'Tarantula'.
  let best: ControllerModel | null = null
  let bestLen = -1
  for (const m of MODELS) {
    if (m.id === 'G7ProCE') continue
    for (const h of m.productHints) {
      if (hay.includes(h.toLowerCase()) && h.length > bestLen) {
        best = m
        bestLen = h.length
      }
    }
  }
  return best
}

/** Observed, user-confirmed LeadJoy signatures. Never infer a model from a
 * version prefix: unknown/new firmware keeps the shared family display name.
 * Display only; both products continue to use the same LeadJoy transport.
 */
export function identifyLeadJoyName(version: string | undefined, board: string | undefined): string | null {
  if (board !== 'DEFAULT_BOARD') return null
  switch (version?.trim()) {
    case '57.16.15': return 'LeadJoy Xeno Pro'
    case '36.16.12': return 'LeadJoy Saber Plus'
    default: return null
  }
}
