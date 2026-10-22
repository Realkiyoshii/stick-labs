// Community curves: feed validation, names, filters, issue-form parsing.
import { cleanCurveName, filterCurves, parseFeed, parseIssueForm, sameCurve, serializeFeed, submitUrl, type CommunityCurve } from '../src/shared/community'
import { decodeCurve, encodeCurve } from '../src/shared/sharecode'

function check(name: string, pass: boolean): void {
  if (!pass) throw new Error(name)
  console.log(`✓ ${name}`)
}

check('plain name kept', cleanCurveName('  Apex   All-Round ') === 'Apex All-Round')
check('links and mentions stripped', cleanCurveName('cool @guy https://x.y/z curve') === 'cool guy curve')
check('too short rejected', cleanCurveName('a') === null)
check('too long rejected', cleanCurveName('x'.repeat(25)) === null)
check('slur rejected even with tricks', cleanCurveName('n.i.g.g.a curve') === null && cleanCurveName('f u c k') === null)
check('normal words not caught', cleanCurveName('Grape Peacock Spicy') === 'Grape Peacock Spicy')

const curve = (id: number, name: string, likes: number, created: string, y = 60): CommunityCurve => ({ id, name, game: 'Apex Legends', author: 'kai-1', scale: 255, pts: [{ x: 0, y: 0 }, { x: 64, y }, { x: 255, y: 255 }], likes, created })
const list = [curve(1, 'Old Hot', 9, '2026-01-01T00:00:00Z'), curve(2, 'New Calm', 1, '2026-10-01T00:00:00Z', 40), curve(3, 'Mid', 5, '2026-05-01T00:00:00Z', 50)]
const feed = JSON.parse(serializeFeed(list, '2026-10-21T00:00:00Z'))
const back = parseFeed(feed)
check('feed round-trips', JSON.stringify(back) === JSON.stringify(list))

const hostile = { curves: [
  ...feed.curves,
  { id: 4, name: '<script>', game: 'Apex Legends', author: 'x', scale: 255, pts: [0, 0, 255, 255], likes: 1, created: '2026-01-01' },
  { id: 5, name: 'Bad pts', game: 'Apex Legends', author: 'x', scale: 255, pts: [0, 0, 300, 9], likes: 1, created: '2026-01-01' },
  { id: 6, name: 'Bad author', game: 'Apex Legends', author: 'a b/../', scale: 255, pts: [0, 0, 255, 255], likes: 1, created: '2026-01-01' },
  { id: 7, name: 'Odd game', game: 'Nope', author: 'ok', scale: 1000, pts: [0, 0, 1000, 1000], likes: -4, created: 'never' },
  'junk', null
] }
const safe = parseFeed(hostile)
check('bad entries dropped, odd fields cleaned', safe.length === 5 && safe[3].name === 'script' && safe[4].game === 'Other' && safe[4].likes === 0)
check('non-feed data gives an empty list', parseFeed(null).length === 0 && parseFeed({ curves: 'x' }).length === 0)

check('top sort by likes', filterCurves(list, { sort: 'top' }).map((c) => c.id).join() === '1,3,2')
check('new sort by date', filterCurves(list, { sort: 'new' }).map((c) => c.id).join() === '2,3,1')
check('search by name or author', filterCurves(list, { query: 'calm' }).length === 1 && filterCurves(list, { query: 'KAI' }).length === 3)
check('game filter', filterCurves(list, { game: 'Fortnite' }).length === 0)
check('same curve across scales', sameCurve(curve(1, 'a', 0, ''), { scale: 1000, pts: [{ x: 0, y: 0 }, { x: 251, y: 235 }, { x: 1000, y: 1000 }] }))

const code = encodeCurve({ scale: 255, pts: list[0].pts })
const body = `### Curve name\n\nOld Hot\n\n### Game\n\nApex Legends\n\n### Curve code\n\n${code}\n`
const form = parseIssueForm(body)
check('issue form parsed', form.name === 'Old Hot' && form.game === 'Apex Legends' && decodeCurve(form.code).pts.length === 3)
check('empty optional field reads as empty', parseIssueForm('### Curve name\n\n_No response_').name === '')
const url = new URL(submitUrl(code, 'Old Hot'))
check('submit link prefills the form', url.searchParams.get('template') === 'community-curve.yml' && url.searchParams.get('code') === code && url.searchParams.get('name') === 'Old Hot')

console.log('ALL COMMUNITY TESTS PASSED')
