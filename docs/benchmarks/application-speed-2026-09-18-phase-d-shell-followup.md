# Application-speed Phase D shell follow-up - 18 September 2026

This is a focused Chrome follow-up for the R7 route-loading work. It is not a
replacement for the required cold, warm, and SPA Phase A matrix.

## Change measured

- `changelog-channels.js` moved out of `SHELL_ROUTE_MODULES` and into the
  Settings route group.
- The large onboarding module moved out of the static `app.js` graph and its
  `modulepreload` list. It loads for `/setup`, claim-required sessions, the
  Dashboard dependency that renders the onboarding checklist, and the delayed
  signed-in onboarding-status check.
- The delayed onboarding-status check uses a real 1.8 second timer. Using
  `requestIdleCallback` here would run immediately on an idle page and defeat
  the route split.

## Chrome evidence

The local authenticated app was tested in Chrome with cache disabled for the
reload. The initial About route was usable at `readyState=complete` with a
182.7 ms load event and no console errors or warnings.

Before this slice, the comparable post-Changelog-split About probe recorded 48
protocol requests and 681,293 bytes transferred; the global module list still
included `onboarding.js` and the Changelog helper had not yet been removed from
the shell for that run.

After the slice, Resource Timing entries started within the first 500 ms of the
About navigation measured:

| Window | Resources | Transfer | Decoded | Notes |
| --- | ---: | ---: | ---: | --- |
| Initial shell (`startTime <= 500 ms`) | 37 | 614,526 B | 2,405,193 B | No `onboarding.js`; the request/transfer budgets remain just above target. |
| After deferred onboarding check | 44 | 645,822 B | 2,561,057 B | `onboarding.js` began at 2,010.6 ms and added 22,265 B. |

The initial shell remains over the plan's 35-request, 600 KB-transfer, and
1.75 MB-decoded targets. The result is therefore recorded as an improvement,
not a passing budget gate.

Route smoke checks in the same Chrome session:

- `/setup` rendered the onboarding wizard (`Step 9 of 10`) and loaded
  `onboarding.js`; console errors/warnings: none.
- `/` rendered Dashboard and the Up Next rail, with the Dashboard dependency
  loading `onboarding.js`; console errors/warnings: none.
- About's initial module list did not contain `onboarding.js`; it appeared only
  after the delayed status check.

## Verification

- `npm test -- test/routeModules.test.js test/frontendLazyGraph.test.js test/frontendStartupRequests.test.js`: 24/24 passed.
- `node --check public/app.js`, `node --check public/modules/app-events.js`, and `node --check public/modules/route-modules.js`: passed.
- `git diff --check`: passed.
- `npm run build`: passed, including documentation and asset checks and all 1,014 tests.

## Remaining interpretation

This slice closes the Changelog/onboarding route-scope implementation and its
focused Chrome smoke checks. R7 remains open because the shell is still just
over the request/transfer budgets, the full cold/warm/SPA matrix and no-stall
gate are not closed, and the mutation-path checks remain intentionally
untriggered against connected media-server state.
