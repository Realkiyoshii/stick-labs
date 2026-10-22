/**
 * Community curves: a public feed of curves people submit through a GitHub
 * issue form. A bot (scripts/community-bot.ts) checks each submission and
 * publishes every live one to `curves.json` on the `community-data` branch;
 * the app reads that file. The feed is remote data, so everything read from
 * it is validated here the same way a pasted share code is.
 * No Node imports: shared by the renderer, the browser build and the bot.
 */
import { decodeCurve, encodeCurve } from './sharecode'

export const COMMUNITY_REPO = 'Realkiyoshii/stick-labs'
export const COMMUNITY_BRANCH = 'community-data'
export const COMMUNITY_FEED_URL = `https://raw.githubusercontent.com/${COMMUNITY_REPO}/${COMMUNITY_BRANCH}/curves.json`
export const COMMUNITY_TEMPLATE = 'community-curve.yml'
export const COMMUNITY_LABEL = 'community-curve'

export const COMMUNITY_GAMES = [
  'Apex Legends',
  'Call of Duty',
  'Fortnite',
  'Rainbow Six Siege',
  'Overwatch 2',
  'Marvel Rivals',
  'The Finals',
  'Battlefield',
  'Valorant',
  'Other'
] as const

/** Bot limits — kept here so the form text and the bot never disagree. */
export const COMMUNITY_LIMITS = {
  perDay: 5,
  perAuthor: 50,
  /** Hidden once reports reach this and outnumber likes. */
  hideReports: 5,
  feedMax: 5000
}

export interface CommunityCurve {
  /** Issue number — also the curve's page: github.com/<repo>/issues/<id>. */
  id: number
  name: string
  game: string
  author: string
  scale: 255 | 1000
  pts: Array<{ x: number; y: number }>
  likes: number
  /** ISO date the curve went live. */
  created: string
}

// A short list of words a public curve name must not contain. Matching is on
// letters only, so spacing and punctuation tricks still match.
const BLOCKED = ['nigg', 'fagg', 'retard', 'kike', 'chink', 'tranny', 'whore', 'slut', 'cunt', 'nazi', 'hitler', 'porn', 'fuck', 'shit', 'bitch', 'pussy']

/** Tidy a submitted name; null when it is empty, too long, or not allowed. */
export function cleanCurveName(raw: string): string | null {
  const name = raw
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[<>`@#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length < 2 || name.length > 24) return null
  const letters = name.toLowerCase().normalize('NFKD').replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4]/g, 'a').replace(/[5$]/g, 's').replace(/[^a-z]/g, '')
  if (BLOCKED.some((w) => letters.includes(w))) return null
  return name
}

/** Points on the 0..255 scale, for comparing and drawing. */
export function to255(curve: Pick<CommunityCurve, 'scale' | 'pts'>): Array<{ x: number; y: number }> {
  const k = 255 / curve.scale
  return curve.pts.map((q) => ({ x: Math.round(q.x * k), y: Math.round(q.y * k) }))
}

export function sameCurve(a: Pick<CommunityCurve, 'scale' | 'pts'>, b: Pick<CommunityCurve, 'scale' | 'pts'>): boolean {
  return JSON.stringify(to255(a)) === JSON.stringify(to255(b))
}

/** Validate the downloaded feed; bad entries are dropped, never trusted. */
export function parseFeed(data: unknown): CommunityCurve[] {
  const list = (data as { curves?: unknown })?.curves
  if (!Array.isArray(list)) return []
  const out: CommunityCurve[] = []
  for (const raw of list.slice(0, COMMUNITY_LIMITS.feedMax)) {
    const e = raw as Record<string, unknown>
    try {
      if (!Number.isInteger(e.id) || (e.id as number) < 1) continue
      const name = typeof e.name === 'string' ? cleanCurveName(e.name) : null
      const game = COMMUNITY_GAMES.find((g) => g === e.game) ?? 'Other'
      const author = typeof e.author === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(e.author) ? e.author : null
      if (!name || !author) continue
      const flat = Array.isArray(e.pts) ? (e.pts as unknown[]) : []
      const curve = decodeCurve(encodeCurve({ scale: e.scale === 1000 ? 1000 : 255, pts: pairs(flat) }))
      const likes = Number.isInteger(e.likes) && (e.likes as number) > 0 ? (e.likes as number) : 0
      const created = typeof e.created === 'string' && !Number.isNaN(Date.parse(e.created)) ? e.created : new Date(0).toISOString()
      out.push({ id: e.id as number, name, game, author, scale: curve.scale, pts: curve.pts, likes, created })
    } catch {
      /* skip this entry */
    }
  }
  return out
}

function pairs(flat: unknown[]): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i] as number, y: flat[i + 1] as number })
  return pts
}

/** The feed file the bot writes: points flattened like a share code. */
export function serializeFeed(curves: CommunityCurve[], updated: string): string {
  return JSON.stringify({
    version: 1,
    updated,
    curves: curves.map((c) => ({ id: c.id, name: c.name, game: c.game, author: c.author, scale: c.scale, pts: c.pts.flatMap((q) => [q.x, q.y]), likes: c.likes, created: c.created }))
  })
}

export type CommunitySort = 'top' | 'new'

export function filterCurves(list: CommunityCurve[], opts: { query?: string; game?: string; sort?: CommunitySort }): CommunityCurve[] {
  const q = (opts.query ?? '').trim().toLowerCase()
  const shown = list.filter((c) => (!opts.game || c.game === opts.game) && (!q || c.name.toLowerCase().includes(q) || c.author.toLowerCase().includes(q)))
  return shown.sort((a, b) => (opts.sort === 'new' ? 0 : b.likes - a.likes) || b.created.localeCompare(a.created) || b.id - a.id)
}

/** Prefilled GitHub issue form for submitting a curve. */
export function submitUrl(code: string, name = '', game = ''): string {
  const params = new URLSearchParams({ template: COMMUNITY_TEMPLATE, title: `Curve: ${name || 'my curve'}`, code })
  if (name) params.set('name', name)
  if (game) params.set('game', game)
  return `https://github.com/${COMMUNITY_REPO}/issues/new?${params.toString()}`
}

export function curvePageUrl(id: number): string {
  return `https://github.com/${COMMUNITY_REPO}/issues/${id}`
}

/**
 * Read a submitted issue form. GitHub renders each field as
 * "### <label>\n\n<value>", with "_No response_" for empty optional ones.
 */
export function parseIssueForm(body: string): { name: string; game: string; code: string } {
  const fields: Record<string, string> = {}
  const parts = body.replace(/\r/g, '').split(/^### /m).slice(1)
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const label = part.slice(0, nl < 0 ? undefined : nl).trim().toLowerCase()
    const value = nl < 0 ? '' : part.slice(nl + 1).trim()
    fields[label] = value === '_No response_' ? '' : value
  }
  return { name: fields['curve name'] ?? '', game: fields['game'] ?? '', code: (fields['curve code'] ?? '').replace(/```\w*/g, '').trim() }
}
