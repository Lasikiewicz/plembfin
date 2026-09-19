# Application speed Phase G local mutation checklist - 18 September 2026

The raw results are in [`application-speed-2026-09-18-phase-g-mutation.json`](application-speed-2026-09-18-phase-g-mutation.json).
All browser actions used the local Plembfin server at `http://localhost:5055` and approved local media-server sessions. The live site and live browser were not opened.

| Check | Result | Evidence |
| --- | --- | --- |
| Up Next rail → Mark Watched | **Pass** | Ludwig S02E02 disappeared from the local rail without reload and appeared in local history. It was marked unwatched again afterward. |
| Discover detail → Mark Watched | **Pass** | The Old Man changed from 0/15 to 15/15 and disappeared from Discover after returning without reload. It was restored to 0/15. |
| Now Playing destination | **Pass** | The local card opened the Ludwig detail at `/tvshow/tmdb/243360-ludwig#season0`. The temporary Plex playback was stopped and the local rail cleared. |
| Generic provider watched arrival | **Safeguarded** | Plex's watched flag was intentionally ignored while Plembfin was canonically unwatched, leaving the event in manual review. |
| Provider-arrival redraw on Movies/TV/History/Stats/open detail | **Pass** | The generic Plex watched flag remained safeguarded, then real accepted Emby threshold completions for Ludwig S02E02, S02E03, and S02E04 supplied exact live-session provenance (`ingest_path=live_session`, `event=playback.complete`, `phase=completed`, `confidence=exact`). The open detail changed from 11/12 to 12/12 without reload; the local Movies, TV Shows, History, and Stats routes then rendered the canonical 12/12 state without page reload. |

The browser check exposed an ID-less Now Playing session route gap. The shell click wiring and route helper now keep the card actionable, reuse a loaded local show identity when available, and strip provider-only release-year suffixes from the title fallback. The durable-record identity fallback repairs provider identity rekeys, and TV Shows now refreshes in place with the other live-history views. The targeted canonical-transition and frontend helper tests passed 24/24, `git diff --check` passed, and the final `npm run build` passed 1,030/1,030 tests plus documentation, asset-version, and Plembfin build checks.
