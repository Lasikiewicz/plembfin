# Phase D paced Chrome sample - 18 September 2026

The first attempt to repeat the matrix navigated too quickly and hit Plembfin's general
API rate limiter. Those throttled rows are not used as measurements. This follow-up used
Chrome, one authenticated tab, normal cache, and approximately three seconds between
navigations.

## Result

- 31/31 navigations completed.
- 0 rate-limited pages, navigation errors, or load errors.
- Maximum load event: 469.8 ms.
- p95 load event: 443.4 ms.
- Maximum document TTFB: 235 ms; p95 TTFB: 163 ms.
- No load event exceeded five seconds.
- All 16 routes were exercised; 15 routes had two samples and the final movie route had one.

The per-route request, transfer, and decoded-byte maxima are in the companion
[JSON artifact](application-speed-2026-09-18-phase-d-paced-sample.json).

## Gate status

This is strong evidence that the pacing issue, rather than a repeatable request stall,
caused the invalid burst. It is still not the plan's final gate: the protocol requires
separate isolated populations, cold/warm cache separation, six loads per route, and TV
detail primary-ready/request inventories. No provider or media-server state was mutated.
