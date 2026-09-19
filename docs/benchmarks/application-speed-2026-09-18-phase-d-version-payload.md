# Phase D startup version payload

**Date:** 18 September 2026  
**Browser:** Chrome 153, local app on `http://localhost:5056/`  
**Purpose:** remove the full changelog history from the global startup path.

## Change verified

`loadAppVersion()` now requests `/version.json` for the installed sidebar version. The full
`/changelog.json` document remains available for the Changelog screen, and `/api/changelog`
continues to perform the advisory update check.

## Chrome evidence

From an About page in Chrome, a same-origin fetch of `/version.json` returned:

```json
{"version":"1.1.2"}
```

The browser's resource timing entry measured:

| Resource | Transfer | Encoded body | Decoded body |
| --- | ---: | ---: | ---: |
| Previous `/changelog.json` startup request | 117,982 bytes | - | 448,644 bytes |
| New `/version.json` startup request | 319 bytes | 19 bytes | 19 bytes |

The previous values are from the current About resource inventory captured before this slice;
the new value is a live Chrome measurement against the fresh web process. The version response
was HTTP 200 with `application/json` and `Cache-Control: no-store`.

## Verification

- `npm test -- test/frontendStartupRequests.test.js test/routeModules.test.js` - 12/12 passed.
- `node --check server/server.js` - passed.
- `git diff --check` - passed.
- `npm run build` - passed after this change: documentation consistency, asset-version checks,
  all 1,014 tests, and the Plembfin build check.

This removes a large global startup transfer but does not by itself close the critical-shell
request count, decoded-byte, isolated-population, cold/SPA, provider-stall, or mutation gates.
