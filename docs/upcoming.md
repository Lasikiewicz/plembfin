# Upcoming Page

The Upcoming page shows a continuously scrollable calendar of historical and future TV
episode air dates for tracked shows. It uses the same TV metadata split as detail pages:
TheTVDB supplies season, episode, title, and air-date structure, while TMDB identity is
used for show navigation.

## Files

| File | Role |
| --- | --- |
| `public/modules/upcoming.js` | Month navigation, client-side search, calendar rendering, poster hydration, show navigation |
| `public/app.js` | Route binding for `/upcoming`, element binding, module initialization |
| `public/index.html` | Upcoming nav item, page shell, month controls, search field, calendar container |
| `public/styles.css` | Calendar grid, mobile agenda layout, search results, poster sizing |
| `server/src/routes/metadata.js` | Authenticated `handleUpcoming` API response |
| `server/src/utils/upcomingCalendarCache.js` | Persistent month results, historical backfill, future checks, and new-show merging |
| `server/src/index.js` | Dispatches `GET /api/upcoming` |

## Backend

`GET /api/upcoming?month=YYYY-MM` returns episodes airing in the requested
month. The handler:

1. Returns the requested month immediately when it exists in
   `data/upcoming-calendar-cache.json`.
2. On a cache miss, reads the TV Shows library and `data/next-airing-cache.json`.
3. Uses the next-airing cache to skip irrelevant shows for future months, and scans all
   tracked shows for the current or a historical month.
4. Fetches merged TMDB/TVDB show details to resolve the TVDB id.
5. Reads the current and next season for current/future calendars, or all known seasons
   for a historical calendar, from the TVDB season cache.
6. Stores and returns episodes whose air dates fall within the requested month.

The scheduler checks the persistent calendar cache every 10 minutes. It progressively
builds the previous 24 months once and checks the current month plus the next 12 months
for changes every 6 hours. A check only rewrites a month when its episode data changed;
historical months are not periodically refreshed. Up to 60 month results survive server
restarts, so revisiting a month does not repeat metadata pulls.

Each month records the tracked shows included in its result. Opening a cached calendar
after another show enters the library fetches only that missing show and merges its
episodes immediately. The browser revalidates the selected month whenever the Upcoming
page opens or month navigation returns to it, while the response remains a fast local
cache read when no shows were added.

## Frontend Behavior

Opening the page (via nav click or direct URL) always scrolls to and highlights today's
date, regardless of where a previous visit left off. Each visible month renders as a
7-column grid of day cards — the same card style used across the app for a single day
(weekday name, date number, episode entries) — stacked one month after another with a
sticky month heading (e.g. "July 2026") pinned below the topbar while that month is in
view. Leading/trailing days that fall outside a month are invisible spacers that
preserve column alignment without drawing a box.

The calendar loads a small buffer of months around the current one, then extends
further back or forward automatically as the user scrolls near the top or bottom of the
loaded range, fetching any missing months from `/api/upcoming` on demand. Scrolling
upward preserves the user's viewport position as older months are prepended. The
Previous/Next/Today controls jump the scroll position to a specific month or to today,
extending the loaded range first if needed.

At `<=760px`, each month's 7-column grid collapses to a single-column agenda list, and
empty or outside-month day cards are hidden so only days with episodes are shown.

The search box switches the page to a dedicated results view: a flat, month-grouped list
of every matching episode (filtered by show title, episode title, or an episode code
such as `S2E4`) across all months currently cached, including a 12-month lookahead that
prefetches in the background while typing. Clearing the search returns to the normal
scrollable month grid.

Posters use `posterMarkup()` and `hydratePosters()` from `public/modules/images.js`, so
the standard local poster cache and fallback pipeline applies.
