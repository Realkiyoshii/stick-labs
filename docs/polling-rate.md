# Polling rate: what the Tarantula 8K really sends

Measured 2026-10-19 on a Tarantula 8K (T3CE, PID 103D, firmware 0243), P1
active at the 8K gear (wire gear 5). Read only: no profile bytes written.

## Kernel trace (DeepPoll, ETW UCX/USBHUB3, 10 s, sticks moving)

| Metric | Value |
| --- | --- |
| Mean rate | 7,444 Hz (75,659 transfers in 10 s) |
| Median interval | 125 µs (exactly one USB High-Speed microframe) |
| p95 interval | 254 µs (a skipped microframe) |
| Host stalls | 0 |
| Intervals in 7,038–8,351 Hz bin | 88.4% |
| Faster than 8,351 Hz | 4.8% (timestamp jitter around 125 µs, paired with the late ones) |
| Slower than 3,941 Hz | 5.0% |

The pad delivers one report per 125 µs microframe, and about 7% of
microframes carry none, so "8K" means 8,000 slots and about 7,450 real reports
per second. Nothing in the trace shows two or three transfers per microframe,
which is what a rate above 8,000 would need.

## Why 10k/12k isn't a USB rate

A High-Speed interrupt endpoint is polled at most once per 125 µs microframe
(8,000/s). Only a high-bandwidth endpoint (2–3 transactions per microframe)
can go higher, and then only to 16k or 24k. 10k and 12k aren't reachable
intervals. GameSir Connect 1.16.7 offers gears 0/2/4/5 (250/1000/4000/8000 Hz)
and nothing above 5.

## Why testers show 20–40k

User-mode counters see different things than the USB bus. The app's vendor
interface (FFF0/0040) received 477 reports/s in the same session, while the
bus carried about 7,450/s. Browser or app testers can also count duplicated
events, several HID interfaces of one pad together (this pad exposes 3), or
timer artefacts. Only a kernel transfer trace counts real reports.

## Undocumented gears 6 and 7 (tested)

Same session, inactive P4 (backup SHA-256 prefix `d40dd672505e81ec`, stock gear
2). Wrote gear 6, then gear 7: each changed only profile offset 46 and read
back exactly, so the pad stores any value. With P4 active, the kernel trace
showed the pad (3537:103D) at 250 Hz with 289 transfers in 10 s for both
values: the firmware treats unknown gears as its slowest mode. (The steady
1,000 Hz `3537:0575` device in both traces is a separate GameSir device, not
this pad.) Returned to P1 (gear 5), restored P4 and verified it byte for byte.

Conclusion: 8,000 Hz (gear 5) is the Tarantula 8K firmware ceiling. Higher
rates would need GameSir firmware with a high-bandwidth endpoint.
