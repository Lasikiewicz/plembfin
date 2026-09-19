# Application speed Phase A probe - 18 September 2026

This is an initial post-change probe, not a release gate. It used one authenticated Chrome
session and one navigation per main route with the browser's default cache state. Chrome
DevTools request/load events supplied document timing, request counts, and transfer bytes.

The probe is useful for selecting the next investigation, but it is not comparable to the
earlier six-load baseline until cold-cache, warm-cache, and SPA-transition populations are
repeated with the same protocol. The Movies and TV Shows event streams exceeded the CDP event
buffer and are explicitly marked truncated in the JSON artifact.

See [the raw measurements](application-speed-2026-09-18-phase-a-probe.json). The next run must
add six samples per population, decoded-byte and paint metrics, and request inventories before
any scorecard budget is marked complete.
