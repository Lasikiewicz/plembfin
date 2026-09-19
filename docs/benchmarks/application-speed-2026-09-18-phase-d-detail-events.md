# Phase D detail-event route scope

**Date:** 18 September 2026  
**Browser:** Chrome, authenticated local app on `http://localhost:5055/`  
**Purpose:** verify that the detail-page event graph no longer loads as part of the global shell.

## Change verified

`media-detail-events.js` is no longer in `SHELL_ROUTE_MODULES`. It is now included in
`DETAIL_ROUTE_MODULES`, and Settings still requests it explicitly for the library Force Sync
panel. The global `app-events.js` module remains responsible for document-wide navigation and
shell behavior.

## Chrome smoke evidence

| Route | Ready state | Relevant modules | Console errors/warnings |
| --- | --- | --- | ---: |
| `/about?codex_route_scope=1` | `complete` | `app-events.js`, `changelog-channels.js`; no `media-detail-events.js` | 0 |
| `/tvshow/tvdb/435298-ludwig?codex_route_scope=1` | `complete` | `media-detail-events.js` plus the detail graph (`media-detail.js`, `media-detail-show.js`, `media-detail-shared.js`, `watch-action.js`, and dependencies) | 0 |

The About page rendered its normal navigation and About content. The Ludwig page rendered the
TV detail view and its watch controls. This confirms the event module is absent from the global
shell but available when detail behavior is required.

## Verification

- `npm test -- test/routeModules.test.js test/frontendLazyGraph.test.js test/frontendStartupRequests.test.js` - 24/24 passed.
- `node --check public/app.js` - passed.
- `node --check public/modules/route-modules.js` - passed.
- `git diff --check` - passed.
- `npm run build` - passed after this change: documentation consistency, asset-version checks,
  all 1,014 tests, and the Plembfin build check.

This slice reduces global shell work but does not close the broader settled-shell, isolated
population, cold/SPA, provider-stall, or mutation-path gates.
