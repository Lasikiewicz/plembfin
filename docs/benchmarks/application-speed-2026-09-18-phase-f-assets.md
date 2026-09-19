# Application-speed Phase F shared assets - 18 September 2026

This focused Chrome check covers the shared branding assets and favicon
fallback after the R7 shell graph work. It is not the required full cold,
warm, and SPA matrix.

## Change

The existing transparent header logos were re-encoded with palette PNG
compression without changing their dimensions or URLs:

- `plembfin_header_logo_dark.png`: 183,293 B -> 60,143 B
- `plembfin_header_logo_light.png`: 188,725 B -> 53,388 B

The shell now declares the existing 345-byte `favicon.svg`. The server also
serves that SVG from `/favicon.ico` so an older browser profile cannot receive
the full SPA HTML from the favicon fallback route.

## Chrome evidence

Chrome used the current source on a fresh web-only server at port 5058 with an
authenticated session and cache disabled. Three About reloads measured
Resource Timing entries that started within the first 1,000 ms:

| Sample | Resources | Transfer | Decoded | Load |
| --- | ---: | ---: | ---: | ---: |
| 1 | 39 | 396,787 B | 1,395,340 B | 205.5 ms |
| 2 | 38 | 390,723 B | 1,329,419 B | 292.6 ms |
| 3 | 38 | 396,142 B | 1,394,995 B | 201.1 ms |
| Median | 38 | 396,142 B | 1,394,995 B | 205.5 ms |

The dark logo loaded at 60,443 B transferred / 60,143 B decoded. The version
response was 19 B, and the favicon fallback was 645 B transferred / 345 B
decoded when Chrome requested it. About loaded neither `help-content.js`,
`onboarding.js`, nor `settings-services.js` in this initial window.

Direct `/settings/media-servers` reached `readyState=complete`, rendered Plex,
Emby, and Jellyfin, and loaded both `help-content.js` and
`settings-services.js`.

## Verification

- `npm test -- test/routeModules.test.js test/frontendLazyGraph.test.js test/frontendStartupRequests.test.js`: 24/24 passed.
- `npm run docs:check`: passed.
- `git diff --check`: passed.
- `npm run build`: passed, including documentation and asset checks and all 1,014 tests.
- Chrome confirmed both logo variants remain `1260x205` and the dark logo rendered with `naturalWidth=1260`, `naturalHeight=205`.

The focused shell transfer and decoded budgets pass in this current-server
window. The request-count budget is still about three requests over target,
and the full route matrix, no-stall gate, and state-mutating browser paths
remain open.
