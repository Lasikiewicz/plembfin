# Upcoming Page

The Upcoming page shows a month calendar of historical and future TV episode air dates
for tracked shows. It uses the same TV metadata split as detail pages: TheTVDB supplies season,
episode, title, and air-date structure, while TMDB identity is used for show navigation.

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

The calendar starts on the current month and can move month-by-month with previous,
next, and Today controls. Desktop renders a 7-column calendar. At `<=760px`, it becomes
an agenda list: empty days and outside-month cells are hidden, and days with episodes
stack full-width for touch use.

The search box filters the selected month by show title, episode title, and episode code
such as `S2E4`. When a search is active, the page also checks the next 12 months through
the same `/api/upcoming` endpoint and lists matching episodes outside the selected month
below the calendar.

Posters use `posterMarkup()` and `hydratePosters()` from `public/modules/images.js`, so
the standard local poster cache and fallback pipeline applies.
