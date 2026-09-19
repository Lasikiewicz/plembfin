# Application-speed Phase D Settings service split - 18 September 2026

This focused Chrome check follows the Changelog/onboarding route slice. It is
not the required full cold, warm, and SPA matrix.

## Change

`settings-services.js` is now a registered Settings route module. Its
`settings-ui.js` dependency is no longer preloaded globally. Onboarding declares
the service module as a dependency because its setup checklist and Options flow
use the same Settings service renderer. A direct Settings config load waits for
the route module before applying the returned config, preventing a no-op
placeholder from swallowing saved values.

## Chrome results

Chrome used an authenticated local session and cache-disabled reloads.

| Route / window | Result |
| --- | --- |
| About initial graph | `readyState=complete`, 271.7 ms load, 35 Resource Timing entries, 623,833 B transferred, 2,551,316 B decoded |
| About initial module list | No `settings-services.js` or `settings-ui.js` |
| Settings → Media servers | Rendered Plex, Emby, and Jellyfin controls; loaded `settings-services.js` and `settings-ui.js` |
| Console | No errors or warnings on either route |

The request-count budget is met for this initial About window. Transfer remains
23,833 B above the 600 KB target and decoded bytes remain above 1.75 MB, so this
does not close the shell budget.

## Verification

- `npm test -- test/routeModules.test.js test/frontendLazyGraph.test.js`: 24/24 passed.
- `node --check public/app.js` and `node --check public/modules/route-modules.js`: passed.
- `git diff --check`: passed.
- `npm run build`: passed, including documentation and asset checks and all 1,014 tests.

The full Phase A/B matrix, no-stall gate, and state-mutating browser paths
remain open.
