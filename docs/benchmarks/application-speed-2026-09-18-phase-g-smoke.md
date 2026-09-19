# Application speed Phase G signed-in smoke checks - 18 September 2026

The raw result is in [`application-speed-2026-09-18-phase-g-smoke.json`](application-speed-2026-09-18-phase-g-smoke.json).
All checks used direct Playwright control against `http://localhost:5055`; no watch, sync, media-server,
or other provider-write action was invoked.

| Check | Result |
| --- | --- |
| Mobile navigation at 760 px | `/settings` reached `readyState=complete`; document and body scroll widths were both 760 px; primary navigation was present; no console or page errors. |
| Slow 4G at 760 px | Cache disabled, 150 ms latency, 750 kbit/s down, 250 kbit/s up. `/settings/media-servers` reached `readyState=complete` in 3,915.1 ms and rendered Plex, Emby, and Jellyfin controls; no console or page errors. |
| Auth expiry | Clearing the browser session cookie and local storage produced the sign-in/password form on `/about`; the expiry behavior is confirmed. The automation context did not verify automatic session restoration afterward, and no credentials were requested or entered. |
| Signed-in CLS sample | `/`, `/about`, and `/settings/media-servers` recorded CLS values of 0.1500, 0.1502, and 0.1502. This remains a follow-up rather than a pass for the plan's no-measurable-CLS-regression gate. |

The diagnostic pass attributed the same 0.15-sized shift, after the session had been cleared, to the
authentication shell's `MAIN.page-shell` moving from full width to the sidebar-offset width when the
sidebar opens. That attribution is not sufficient to close the signed-in CLS gate, so the measured
values remain explicitly recorded.
