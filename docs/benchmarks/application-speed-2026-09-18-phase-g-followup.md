# Application speed Phase G CLS and auth follow-up - 18 September 2026

The raw summary is in [`application-speed-2026-09-18-phase-g-followup.json`](application-speed-2026-09-18-phase-g-followup.json).
All checks used the local server at `http://localhost:5055`; no live site was opened.

| Check | Result |
| --- | --- |
| Desktop signed-in CLS after the fix | `/` **0**, `/about` **0.000183**, `/settings/media-servers` **0.000183**; all are below the `< 0.1` target. |
| Mobile signed-in CLS after the fix | At 760 px, `/settings/media-servers` **0**; the collapsed navigation remains 56 px high and the page shell starts at y=56. |
| Root cause addressed | The locked shell now reserves the sidebar footprint while keeping navigation invisible and non-interactive, so the page shell remains at x=192 when authentication resolves. |
| Isolated auth expiry and restoration | A disposable Playwright context showed the authenticated shell, cleared only that context's cookies to show the sign-in form, restored the saved local session cookie, and confirmed the authenticated shell returned. No credentials were entered. |
| Build after the fix | `npm run build` passed **1,025/1,025** tests plus documentation, asset-version, and Plembfin build checks. |

The remaining release exception is the manually skipped browser mutation checklist from decision 5
(Now Playing/manual watch/Up Next/provider-arrival behavior). Those checks require an explicitly
approved local integration run because they can write watch state to the configured local media apps;
the live site and live browser were not used.
