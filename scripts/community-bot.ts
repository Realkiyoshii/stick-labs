/**
 * Community curves bot, run by .github/workflows/community-curves.yml.
 *
 *   validate <issue>  check one submission; label it `live`, or label it
 *                     `rejected`, say why and close it
 *   rebuild           write curves.json on the community-data branch from
 *                     every open `live` submission, with 👍/👎 counts
 *
 * The issues are the source of truth: closing one (the author, or the repo
 * owner removing it) drops it from the feed on the next rebuild.
 */
import { decodeCurve } from '../src/shared/sharecode'
import {
  COMMUNITY_BRANCH, COMMUNITY_GAMES, COMMUNITY_LABEL, COMMUNITY_LIMITS, COMMUNITY_REPO,
  cleanCurveName, parseFeed, parseIssueForm, sameCurve, serializeFeed, type CommunityCurve
} from '../src/shared/community'

const repo = process.env.GITHUB_REPOSITORY || COMMUNITY_REPO
const token = process.env.GITHUB_TOKEN
if (!token) throw new Error('GITHUB_TOKEN is required')

interface Issue {
  number: number
  state: 'open' | 'closed'
  title: string
  body: string | null
  created_at: string
  user: { login: string; type: string }
  labels: Array<{ name: string }>
  reactions?: { '+1': number; '-1': number }
  pull_request?: unknown
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...init.headers }
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  return (res.status === 204 ? null : await res.json()) as T
}

const has = (issue: Issue, label: string): boolean => issue.labels.some((l) => l.name === label)

async function liveIssues(): Promise<Issue[]> {
  const out: Issue[] = []
  for (let page = 1; ; page++) {
    const batch = await gh<Issue[]>(`/repos/${repo}/issues?labels=${COMMUNITY_LABEL},live&state=open&per_page=100&page=${page}`)
    out.push(...batch.filter((i) => !i.pull_request))
    if (batch.length < 100) return out
  }
}

/** Read a submission into a curve, or the reasons it can't be one. */
function readSubmission(issue: Issue): { curve?: CommunityCurve; errors: string[] } {
  const form = parseIssueForm(issue.body ?? '')
  const errors: string[] = []
  const name = cleanCurveName(form.name)
  if (!name) errors.push('The curve name must be 2–24 characters and follow the community rules.')
  const game = COMMUNITY_GAMES.find((g) => g === form.game)
  if (!game) errors.push('Pick a game from the list.')
  let decoded: ReturnType<typeof decodeCurve> | null = null
  try {
    decoded = decodeCurve(form.code)
  } catch {
    errors.push('The curve code is missing or damaged. In Stick Labs, press "Copy curve code" on the Curves tab and paste it again.')
  }
  if (errors.length || !name || !game || !decoded) return { errors }
  return {
    errors,
    curve: { id: issue.number, name, game, author: issue.user.login, scale: decoded.scale, pts: decoded.pts, likes: issue.reactions?.['+1'] ?? 0, created: issue.created_at }
  }
}

async function comment(n: number, text: string): Promise<void> {
  await gh(`/repos/${repo}/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body: text }) })
}

async function validate(n: number): Promise<void> {
  const issue = await gh<Issue>(`/repos/${repo}/issues/${n}`)
  if (!has(issue, COMMUNITY_LABEL) || issue.pull_request) return console.log(`#${n}: not a curve submission`)
  // A closed issue that wasn't rejected was removed on purpose; leave it.
  if (issue.state === 'closed' && !has(issue, 'rejected')) return console.log(`#${n}: closed, skipping`)

  const { curve, errors } = readSubmission(issue)
  const user = await gh<{ created_at: string; type: string }>(`/users/${encodeURIComponent(issue.user.login)}`)
  const ageDays = (Date.now() - Date.parse(user.created_at)) / 86_400_000
  if (user.type !== 'User') errors.push('Only personal GitHub accounts can post curves.')
  if (ageDays < COMMUNITY_LIMITS.minAccountAgeDays) errors.push(`Your GitHub account must be at least ${COMMUNITY_LIMITS.minAccountAgeDays} days old.`)

  const others = (await liveIssues()).filter((i) => i.number !== n)
  const mine = others.filter((i) => i.user.login === issue.user.login)
  if (mine.filter((i) => Date.now() - Date.parse(i.created_at) < 86_400_000).length >= COMMUNITY_LIMITS.perDay) errors.push(`You can post ${COMMUNITY_LIMITS.perDay} curves a day. Try again tomorrow.`)
  if (mine.length >= COMMUNITY_LIMITS.perAuthor) errors.push(`You already have ${COMMUNITY_LIMITS.perAuthor} curves posted. Close an old one first.`)
  if (curve) {
    const copy = others.map(readSubmission).find((s) => s.curve && sameCurve(s.curve, curve))
    if (copy?.curve) errors.push(`This curve is already posted as "${copy.curve.name}" (#${copy.curve.id}).`)
  }

  if (errors.length === 0 && curve) {
    if (!has(issue, 'live')) {
      await gh(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: JSON.stringify({ labels: ['live'] }) })
      if (has(issue, 'rejected')) await gh(`/repos/${repo}/issues/${n}/labels/rejected`, { method: 'DELETE' })
      if (issue.state === 'closed') await gh(`/repos/${repo}/issues/${n}`, { method: 'PATCH', body: JSON.stringify({ state: 'open' }) })
      await comment(n, `✅ **${curve.name}** is live in Community curves in the app and the web app.\n\nReact 👍 if you like it. React 👎 to report it.`)
    }
    console.log(`#${n}: live`)
    return
  }
  if (has(issue, 'live')) await gh(`/repos/${repo}/issues/${n}/labels/live`, { method: 'DELETE' })
  if (!has(issue, 'rejected')) await gh(`/repos/${repo}/issues/${n}/labels`, { method: 'POST', body: JSON.stringify({ labels: ['rejected'] }) })
  await comment(n, `❌ This curve wasn't posted:\n\n${errors.map((e) => `- ${e}`).join('\n')}\n\nEdit this issue to fix it and the bot checks it again.`)
  if (issue.state === 'open') await gh(`/repos/${repo}/issues/${n}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) })
  console.log(`#${n}: rejected — ${errors.join(' | ')}`)
}

async function rebuild(): Promise<void> {
  const curves: CommunityCurve[] = []
  for (const issue of await liveIssues()) {
    const { curve } = readSubmission(issue)
    if (!curve) continue
    const likes = issue.reactions?.['+1'] ?? 0
    const reports = issue.reactions?.['-1'] ?? 0
    if (reports >= COMMUNITY_LIMITS.hideReports && reports > likes) continue
    if (curves.some((c) => sameCurve(c, curve))) continue
    curves.push(curve)
  }
  curves.sort((a, b) => b.created.localeCompare(a.created))

  const path = `/repos/${repo}/contents/curves.json`
  let sha: string | undefined
  let current = ''
  try {
    const file = await gh<{ sha: string; content: string }>(`${path}?ref=${COMMUNITY_BRANCH}`)
    sha = file.sha
    current = Buffer.from(file.content, 'base64').toString('utf8')
  } catch {
    /* first write */
  }
  const strip = (json: string): string => { try { return JSON.stringify(parseFeed(JSON.parse(json))) } catch { return '' } }
  const next = serializeFeed(curves, new Date().toISOString())
  if (current && strip(current) === strip(next)) return console.log(`feed unchanged (${curves.length} curves)`)
  await gh(path, { method: 'PUT', body: JSON.stringify({ message: `community: ${curves.length} curves`, content: Buffer.from(next).toString('base64'), branch: COMMUNITY_BRANCH, sha }) })
  console.log(`feed written (${curves.length} curves)`)
}

const [mode, arg] = process.argv.slice(2)
if (mode === 'validate') await validate(Number(arg))
else if (mode === 'rebuild') await rebuild()
else throw new Error('usage: community-bot validate <issue> | rebuild')
