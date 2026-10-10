/**
 * Minimal VDF (Valve Data Format) parse / serialize / patch for Steam Input
 * controller configs.
 *
 * VDF here means: quoted keys/values, `{` `}` nesting, `//` comments.
 * Repeated keys (e.g. several `group` blocks) are preserved by modelling a
 * node as an ordered list of pairs rather than a Map.
 */

export interface VdfPair {
  key: string
  value: string | VdfPair[]
}

function isPairArray(v: string | VdfPair[]): v is VdfPair[] {
  return Array.isArray(v)
}

/** Tokenize: quoted strings, braces; `//` comments dropped. */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let out = ''
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) {
          out += text[j + 1]
          j += 2
        } else {
          out += text[j]
          j++
        }
      }
      tokens.push(out)
      i = j + 1
      continue
    }
    if (c === '{' || c === '}') {
      tokens.push(c)
      i++
      continue
    }
    i++
  }
  return tokens
}

export function parseVdf(text: string): VdfPair[] {
  const tokens = tokenize(text)
  let pos = 0

  function parseBlock(): VdfPair[] {
    const pairs: VdfPair[] = []
    while (pos < tokens.length && tokens[pos] !== '}') {
      const key = tokens[pos++]
      if (key === '{' || key === '}') continue
      if (pos >= tokens.length) break
      if (tokens[pos] === '{') {
        pos++
        pairs.push({ key, value: parseBlock() })
        if (tokens[pos] === '}') pos++
      } else {
        pairs.push({ key, value: tokens[pos++] ?? '' })
      }
    }
    return pairs
  }

  return parseBlock()
}

export function serializeVdf(pairs: VdfPair[], depth = 0): string {
  const pad = '\t'.repeat(depth)
  let out = ''
  for (const p of pairs) {
    if (isPairArray(p.value)) {
      out += `${pad}"${p.key}"\n${pad}{\n${serializeVdf(p.value, depth + 1)}${pad}}\n`
    } else {
      out += `${pad}"${p.key}"\t\t"${p.value}"\n`
    }
  }
  return out
}

function childBlock(pairs: VdfPair[], key: string): VdfPair[] | null {
  for (const p of pairs) {
    if (p.key === key && isPairArray(p.value)) return p.value
  }
  return null
}

function childValue(pairs: VdfPair[], key: string): string | null {
  for (const p of pairs) {
    if (p.key === key && !isPairArray(p.value)) return p.value
  }
  return null
}

function setKey(pairs: VdfPair[], key: string, value: string): void {
  for (const p of pairs) {
    if (p.key === key && !isPairArray(p.value)) {
      p.value = value
      return
    }
  }
  pairs.push({ key, value })
}

export interface StickWindow {
  /** Input deadzone %, 0-100. */
  begin: number
  /** Input saturation %, 0-100. */
  end: number
  /** Anti-deadzone %, 0-100 — exported as Steam's on/off flag. */
  anti?: number
}

const STEAM_FULL = 32767

/** GameSir tenths-of-percent deadzone → Steam 0-32767 stick window. */
export function deadzoneToSteam(beginTenths: number, endTenths: number): { inner: number; outer: number } {
  const clampPct = (t: number): number => Math.max(0, Math.min(100, t / 10))
  return {
    inner: Math.round((clampPct(beginTenths) / 100) * STEAM_FULL),
    outer: Math.round((clampPct(endTenths) / 100) * STEAM_FULL)
  }
}

/**
 * Fit arbitrary curve points to Steam's exponent language (y = x^k).
 *
 * Steam stores no point lists — only `curve_exponent` / `custom_curve_exponent`
 * (confirmed in Steam's own binary vocabulary + a joystick_mouse group using
 * `curve_exponent`). This least-squares fit translates a design into that
 * language under standard math convention (k>1 calms the start, k<1 heats
 * it). DIRECTION ON THE PAD IS UNCONFIRMED — the exporter gates this behind
 * an explicit experimental opt-in until feel-verified in game.
 */
export function fitCurveExponent(points: Array<{ x: number; y: number }>): number {
  const pts = points
    .map((p) => ({
      x: Math.min(1, Math.max(0, p.x / 255)),
      y: Math.min(1, Math.max(0, p.y / 255))
    }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x)
  if (pts.length < 2) return 1
  let bestK = 1
  let bestErr = Number.POSITIVE_INFINITY
  for (let k = 0.2; k <= 5.0001; k += 0.05) {
    let err = 0
    for (const p of pts) {
      const d = p.y - Math.pow(p.x, k)
      err += d * d
    }
    if (err < bestErr) {
      bestErr = err
      bestK = k
    }
  }
  return Math.round(bestK * 100) / 100
}

/**
 * Inject deadzone settings into stick groups of a controller_mappings VDF,
 * plus optional joystick-mouse sensitivity (group 2 only).
 * `windows` maps group id ("2","3","6") to its deadzone window. `mouse`
 * writes `sensitivity` into group 2's settings when defined — pass null to
 * leave Steam's default alone. Returns the reserialized document.
 */
export function injectStickSettings(
  vdfText: string,
  windows: Record<string, StickWindow>,
  mouse: number | null = null,
  curveExp: number | null = null
): string {
  const root = parseVdf(vdfText)
  const mappings = childBlock(root, 'controller_mappings')
  if (!mappings) throw new Error('no controller_mappings block — not a Steam controller config')
  for (const p of mappings) {
    if (p.key !== 'group' || !isPairArray(p.value)) continue
    const id = childValue(p.value, 'id')
    if (!id) continue
    const settings = childBlock(p.value, 'settings')
    if (!settings) continue
    if (id in windows) {
      const w = windows[id]
      const { inner, outer } = deadzoneToSteam(w.begin * 10, w.end * 10)
      setKey(settings, 'deadzone', String(inner))
      setKey(settings, 'deadzone_outer_radius', String(outer))
      if (w.anti !== undefined) {
        setKey(settings, 'anti_deadzone', w.anti > 0 ? '1' : '0')
      }
    }
    if (id === '2' && mouse !== null) {
      setKey(settings, 'sensitivity', String(Math.max(0, Math.min(255, Math.round(mouse)))))
    }
    if (id === '2' && curveExp !== null) {
      const v = Math.round(curveExp * 100) / 100
      setKey(settings, 'curve_exponent', String(v))
    }
  }
  return serializeVdf(root)
}
