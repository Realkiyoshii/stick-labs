/**
 * "Live on YouTube" status for the creator's channel, with no API key.
 *
 * A channel's /live page points its canonical link at the stream's watch URL
 * and carries "isLiveNow":true while a stream is on air; otherwise it points
 * back at the channel (and a scheduled stream says isLiveNow false). The
 * desktop app reads that page directly. Browsers can't (no CORS), so the
 * youtube-live workflow reads it every few minutes and publishes the result
 * as live.json on the status branch, which the web build fetches.
 *
 * No imports: the workflow runs this file with Node's TypeScript stripping.
 */

export const YT_CHANNEL_URL = 'https://www.youtube.com/@realkiyoshi'
export const YT_LIVE_PAGE = `${YT_CHANNEL_URL}/live`
export const YT_STATUS_URL = 'https://raw.githubusercontent.com/Realkiyoshii/stick-labs/status/live.json'

export interface YtLive {
  live: boolean
  /** The stream's watch URL while live, else null. */
  url: string | null
}

export const YT_OFFLINE: YtLive = { live: false, url: null }

const WATCH_URL = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/

/** Read the live state out of the channel's /live page HTML. */
export function parseLivePage(html: string): YtLive {
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? ''
  if (!WATCH_URL.test(canonical) || !/"isLiveNow":true/.test(html)) return YT_OFFLINE
  return { live: true, url: canonical }
}

/** Validate the published live.json; anything unexpected reads as offline. */
export function parseLiveStatus(data: unknown): YtLive {
  if (!data || typeof data !== 'object') return YT_OFFLINE
  const { live, url } = data as { live?: unknown; url?: unknown }
  return live === true && typeof url === 'string' && WATCH_URL.test(url) ? { live: true, url } : YT_OFFLINE
}

/** True when the page came back as a real channel page (not a consent or bot-check page). */
export function looksLikeChannelPage(html: string): boolean {
  return /<link rel="canonical" href="https:\/\/www\.youtube\.com\//.test(html)
}
