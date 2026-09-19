# Application speed remediation: TV-detail budget follow-up - 18 September 2026

This Chrome follow-up measured the two representative TV detail routes named by Phase E:
Ludwig and Reacher. Each route was hard-navigated six times in the authenticated local
Chrome tab; the first sample was discarded. The page already exposes the
`plembfin:detail-primary-ready` milestone after the title, primary artwork, watch state,
synopsis, and primary actions are rendered from real data.

| Route | Primary-ready median | API median | Images | CDP transfer median | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Ludwig | 904 ms | 26 | 30 | 941 KB | Meets Phase E budgets |
| Reacher | 885 ms | 27 | 33 | 950 KB | Meets Phase E budgets |

The Phase E budgets are 2,500 ms primary-ready, 30 API calls, 35 image requests, and 2 MB
transferred. Both routes stayed below every budget after warm-up, and both had zero Chrome
console errors or warnings.

Compared with the recorded baseline, Ludwig fell from 66 API calls and 5,605 ms primary
ready, while Reacher fell from 71 API calls and 4,547 ms primary ready. No provider
concurrency or media-server state was changed by this test.

This closes the representative warm TV-detail budget evidence. It does not close the full
Phase A cold/warm/SPA matrix, the settled critical-shell budget, the document TTFB/no-stall
gate, or the remaining browser mutation checks.
