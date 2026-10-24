/**
 * Used by .github/workflows/youtube-live.yml: read the channel's /live page and
 * print the live.json the web build fetches. Exits 2 (and prints nothing) when
 * YouTube returns something that isn't the channel page, so the last published
 * status stays as it is instead of flipping to offline on a bad fetch.
 *
 * Run with: node --experimental-strip-types scripts/youtube-live.ts
 */
import { YT_LIVE_PAGE, looksLikeChannelPage, parseLivePage } from '../src/shared/youtubeLive.ts'

const res = await fetch(YT_LIVE_PAGE, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Cookie: 'CONSENT=YES+1'
  },
  signal: AbortSignal.timeout(20000)
})
const html = await res.text()
if (!res.ok || !looksLikeChannelPage(html)) {
  console.error(`youtube-live: unexpected page (HTTP ${res.status}), keeping the last status`)
  process.exit(2)
}
process.stdout.write(`${JSON.stringify(parseLivePage(html))}\n`)
