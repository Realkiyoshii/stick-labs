import { YT_OFFLINE, looksLikeChannelPage, parseLivePage, parseLiveStatus } from '../src/shared/youtubeLive'

let failed = 0
function check(name: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// Trimmed from real /live pages (2026-10-24): a channel on air and one that isn't.
const LIVE = '<link rel="canonical" href="https://www.youtube.com/watch?v=0sfDth4lMLc"><script>{"isLiveNow":true,"isLive":true}</script>'
const OFFLINE = '<link rel="canonical" href="https://www.youtube.com/channel/UCUoDoW4HaKh-7CjbgpjWDEA">'
const SCHEDULED = '<link rel="canonical" href="https://www.youtube.com/watch?v=abcdefghijk"><script>{"isLiveNow":false,"isUpcoming":true}</script>'
const CONSENT = '<html><title>Before you continue to YouTube</title></html>'

check('live page → live with the watch URL', same(parseLivePage(LIVE), { live: true, url: 'https://www.youtube.com/watch?v=0sfDth4lMLc' }))
check('channel page → offline', same(parseLivePage(OFFLINE), YT_OFFLINE))
check('scheduled stream → offline', same(parseLivePage(SCHEDULED), YT_OFFLINE))
check('consent page → offline', same(parseLivePage(CONSENT), YT_OFFLINE))
check('consent page is not a channel page', !looksLikeChannelPage(CONSENT))
check('offline channel page is a channel page', looksLikeChannelPage(OFFLINE))

check('status: live json', same(parseLiveStatus({ live: true, url: 'https://www.youtube.com/watch?v=0sfDth4lMLc' }), { live: true, url: 'https://www.youtube.com/watch?v=0sfDth4lMLc' }))
check('status: offline json', same(parseLiveStatus({ live: false, url: null }), YT_OFFLINE))
check('status: foreign URL refused', same(parseLiveStatus({ live: true, url: 'https://evil.example/watch?v=0sfDth4lMLc' }), YT_OFFLINE))
check('status: garbage refused', same(parseLiveStatus('nope'), YT_OFFLINE) && same(parseLiveStatus(null), YT_OFFLINE))

if (failed) {
  console.log(`${failed} YOUTUBE LIVE TEST(S) FAILED`)
  process.exit(1)
}
console.log('ALL YOUTUBE LIVE TESTS PASSED')
