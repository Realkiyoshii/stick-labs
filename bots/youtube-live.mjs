// src/shared/youtubeLive.ts
var YT_CHANNEL_URL = "https://www.youtube.com/@realkiyoshi";
var YT_LIVE_PAGE = `${YT_CHANNEL_URL}/live`;
var YT_OFFLINE = { live: false, url: null };
var WATCH_URL = /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/;
function parseLivePage(html2) {
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html2)?.[1] ?? "";
  if (!WATCH_URL.test(canonical) || !/"isLiveNow":true/.test(html2)) return YT_OFFLINE;
  return { live: true, url: canonical };
}
function looksLikeChannelPage(html2) {
  return /<link rel="canonical" href="https:\/\/www\.youtube\.com\//.test(html2);
}

// scripts/youtube-live.ts
var res = await fetch(YT_LIVE_PAGE, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: "CONSENT=YES+1"
  },
  signal: AbortSignal.timeout(2e4)
});
var html = await res.text();
if (!res.ok || !looksLikeChannelPage(html)) {
  console.error(`youtube-live: unexpected page (HTTP ${res.status}), keeping the last status`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(parseLivePage(html))}
`);
