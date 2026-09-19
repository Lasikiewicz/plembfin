# Application speed Phase G bounded cache diagnostic - 19 September 2026

The raw measurements are in [`application-speed-2026-09-19-phase-g-cache-diagnostic.json`](application-speed-2026-09-19-phase-g-cache-diagnostic.json). This was a bounded diagnostic on the local Plembfin server at `http://localhost:5055`, using the authenticated Chrome session, `ROLE=web`, and immutable asset caching. The live site and live browser were not opened.

It captured two local samples per exception route after a fixed 1.6-second delay. It is diagnostic evidence, not a replacement for the formal six-load, two-population acceptance matrix.

| Route | Sample | Document TTFB | Document load | Images | Transfer-zero images | Last image end | Max image duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 0 | 8.7 ms | 120.3 ms | 27 | 26 | 612.1 ms | 25.9 ms |
| `/` | 1 | 70.7 ms | 391.7 ms | 27 | 26 | 697.2 ms | 52.1 ms |
| `/tvshows` | 0 | 9.6 ms | 85.5 ms | 91 | 90 | 1,249.2 ms | 71.9 ms |
| `/tvshows` | 1 | 8.2 ms | 156.2 ms | 91 | 90 | 301.1 ms | 18.4 ms |
| `/discover` | 0 | 13.7 ms | 171.3 ms | 30 | 29 | 1,324.8 ms | 582.4 ms |
| `/discover` | 1 | 9.5 ms | 77.1 ms | 30 | 29 | 208.5 ms | 19.4 ms |
| `/movie/a-quiet-place` | 0 | 8.3 ms | 180.9 ms | 26 | 25 | 1,336.1 ms | 117.7 ms |
| `/movie/a-quiet-place` | 1 | 10.3 ms | 120.7 ms | 26 | 25 | 426.3 ms | 19.7 ms |

The diagnostic confirms that most poster transfers are cache hits while first-use image completion and decode duration can still vary substantially. The Dashboard sample also shows document-load variance without a matching increase in image completion, so there is no single safe application-side change supported by this evidence. The formal warm rerun therefore keeps its four-route consistency exception explicit; strict closure would require a controlled fresh-profile benchmark or a revised consistency protocol.
