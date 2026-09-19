# Application-speed Phase D help-content split - 18 September 2026

This focused Chrome check follows the Settings service split. It is not the
required full cold, warm, and SPA matrix.

## Change

`help-content.js` is now a registered route module. The global `app.js` and
`app-events.js` graphs use non-loading `ifLoaded` wrappers, while
`settings-services.js` owns the dependency for provider/settings guides.
The global modulepreload for `help-content.js` was removed. Settings and
onboarding still load the same guide exports through the route registry.

## Chrome evidence

Chrome used an authenticated local session with cache disabled. About was
loaded three times, and Resource Timing entries that started within the first
1,000 ms were measured:

| Sample | Resources | Transfer | Decoded | Help module | Load |
| --- | ---: | ---: | ---: | --- | ---: |
| 1 | 39 | 621,760 B | 2,581,113 B | absent | 170.4 ms |
| 2 | 40 | 590,900 B | 2,357,793 B | absent | 155.6 ms |
| 3 | 41 | 622,453 B | 2,581,206 B | absent | 149.2 ms |
| Median | 40 | 621,760 B | 2,581,113 B | absent | 155.6 ms |

The narrower first-window probe also recorded 35 resources and 557,925 B
transferred, but the full settled shell remains the authoritative open budget
measurement. The shared logo, stylesheet, and core `app.js` remain the largest
initial payload contributors.

Direct `/settings/media-servers` rendered Plex, Emby, and Jellyfin controls and
loaded both `help-content.js` and `settings-services.js`. No console errors or
warnings were observed on either route.

## Verification

- `npm test -- test/routeModules.test.js test/frontendLazyGraph.test.js test/frontendStartupRequests.test.js`: 24/24 passed.
- `node --check public/app.js` and `node --check public/modules/route-modules.js`: passed.
- `git diff --check`: passed.
- `npm run build`: passed, including documentation and asset checks and all 1,014 tests.

The critical-shell transfer/decoded budgets, full route matrix, no-stall gate,
and state-mutating browser paths remain open.
