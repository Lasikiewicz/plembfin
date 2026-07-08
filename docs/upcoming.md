# Upcoming Page

The Upcoming page shows a month calendar of future TV episode air dates for tracked
shows. It uses the same TV metadata split as detail pages: TheTVDB supplies season,
episode, title, and air-date structure, while TMDB identity is used for show navigation.

## Files

| File | Role |
| --- | --- |
| `public/modules/upcoming.js` | Month navigation, client-side search, calendar rendering, poster hydration, show navigation |
| `public/app.js` | Route binding for `/upcoming`, element binding, module initialization |
| `public/index.html` | Upcoming nav item, page shell, month controls, search field, calendar container |
| `public/styles.css` | Calendar grid, mobile agenda layout, search results, poster sizing |
| `server/src/routes/metadata.js` | `handleUpcoming` and month-level episode collection |
| `server/src/index.js` | Dispatches `GET /api/upcoming` |

## Backend

`GET /api/upcoming?month=YYYY-MM` returns future episodes airing in the requested
month. The handler:

1. Reads the TV Shows library and `data/next-airing-cache.json`.
2. Skips shows whose cached next-airing date falls after the requested month.
3. Fetches merged TMDB/TVDB show details to resolve the TVDB id.
4. Reads the current and next season from the TVDB season cache.
5. Returns only episodes with air dates from today through the end of the requested
   month.

Responses are memoized in-process for 10 minutes per month, up to 12 months.

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
