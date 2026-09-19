# Phase E movie-detail follow-up

**Date:** 18 September 2026  
**Browser:** Chrome 153, authenticated local app on `http://localhost:5055/`  
**Protocol:** six hard navigations per route; first sample discarded; post-warm median reported.

## Results

| Route | Post-warm primary-ready samples | Median | API calls (post-warm) | Console errors/warnings |
| --- | --- | ---: | --- | ---: |
| `/movie/jackass-presents-bad-grandpa` | 1,192; 823; 1,228; 707; 680 ms | **823 ms** | 21, 21, 21, 21, 21 | 0 in every sample |
| `/movie/a-quiet-place` | 1,175; 739; 725; 710; 752 ms | **739 ms** | 20, 20, 20, 20, 20 | 0 in every sample |

Both representative warm populations meet the movie primary-ready budget of 2 seconds. The
route-wide cold/SPA benchmark matrix and settled-shell budgets remain open, so this does not
claim release readiness by itself.

## Verification

- Chrome `readyState=complete` for all 12 navigations.
- The existing `markDetailPrimaryReady("movie")` performance mark was captured in every sample.
- No watch, unwatch, sync, or other mutating control was triggered.
