# Phase D route-scope Chrome verification - 18 September 2026

This probe verifies the incremental route-scope change after the interrupted Claude
session. It was run against the local app in Chrome through the CUA browser harness.

## Results

| Route | Result | Resources | Route-only evidence | Console errors/warnings |
| --- | --- | ---: | --- | ---: |
| `/about` | `readyState=complete` | 53 | no tracker/rating/watchlist/Tautulli module resources | 0 |
| `/settings/tools` | `readyState=complete` | 75 | `tautulli-import.js?v=1.1.2.0.0` loaded | 0 |
| `/settings/media-servers` under Slow 4G | `readyState=complete` | 73 | Plex, Emby, and Jellyfin controls rendered | 0 |

The Slow 4G emulation used 150 ms latency, 200,000 bytes/second down, 100,000
bytes/second up, and a disabled cache. The document TTFB was 16.6 ms and the load
event was 4,796.6 ms; the 7,328 ms wall-clock figure includes the settled-wait period
used to let deferred route work finish.

## Scope and limits

This closes the previously blocked browser check for the route-scope slice. It does not
close the full performance plan: the isolated six-load matrix, TTFB/no-stall gate,
settled critical-shell budget, TV-detail primary-ready/request inventories, and the
remaining Now Playing/manual-watch mutation checks are still open.

The Chrome version was not captured by this probe. No provider or media-server state was
mutated.
