/**
 * Controller model registry — multi-pad support.
 *
 * Each entry describes one pad's wire identity and what Stick Labs may do
 * with it. Tuning stays gated per model: `full` only where the profile
 * geometry (offsets, lengths, wire semantics) is proven against hardware or
 * byte-identical fixtures. Anything else is `detect-only` — the app names
 * the pad and reads live input, but refuses profile writes.
 *
 * NEVER match a device on productId for opening it (it varies by color and
 * mode); pids[] is documentation for the UI, not a filter.
 */

export type SupportLevel = 'full' | 'detect-only'

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
    support: 'full',
    supportNote: 'Profile codec proven byte-exact against hardware fixtures.'
  },
  {
    id: 'G7ProS',
    marketingName: 'GameSir G7 Pro',
    vendorId: 0x3537,
    usagePage: 0xfff0,
    usage: 0x40,
    pids: [0x0908, 0x0909, 0x0921, 0x0922],
    productHints: ['G7 Pro S', 'G7ProS'],
    reportRates: [
      { gear: 0, hz: 250, confirmed: false },
      { gear: 1, hz: 500, confirmed: false },
      { gear: 2, hz: 1000, confirmed: false }
    ],
    profileLength: 1070,
    support: 'full',
    supportNote: 'Reuses the G7ProCE proxy wholesale in the GameSir bundle: identical 1070-byte profile, 36-byte stick packet, Fun_Data offsets and 0xFE calibration. Only the gear table (250/500/1000) differs.'
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
    support: 'full',
    supportNote: 'Layout proven: 1935-byte blob (Name32, Fun32, 16x7, 9x169, 2x32 triggers, 2x36 sticks at 0x6E1, 2x41 motion, Ext8/9), same 36-byte stick packet and Fun_Data offsets as G7ProCE, same 0xFE calibration. Verified against live dumps.'
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
  for (const m of MODELS) {
    if (m.id !== 'G7ProCE' && m.productHints.some((h) => hay.includes(h.toLowerCase()))) return m
  }
  return null
}
