# Security Remediation Checklist

Generated from: [security-audit-2026-06-20.md](security-audit-2026-06-20.md)  
Audit date: 2026-06-20  
Last updated: 2026-06-20

Tick a box when the fix is merged. For each item the affected file(s) and the minimum change are noted so fixes can be reviewed quickly.

---

## Phase 1 — Day 1 (ship-blockers; do before any internet exposure)

- [x] **[C-1] Add `requireAdmin` guard to `handleWebhook`**  
  `server/src/index.js`  
  Added `if (!(await requireAdmin(req, res))) return;` as the first statement inside `handleWebhook`, before `normalizeWebhook(req)` is called.  
  _Without this, any unauthenticated caller can insert/delete watch records and trigger sync operations to Plex/Emby/Jellyfin._

- [x] **[H-1] Remove default `changeme` password from `docker-compose.yml`**  
  `docker-compose.yml`  
  Commented out the `ADMIN_PASSWORD` line so operators are forced to supply a value before starting the container.

- [x] **[H-2] Install `express-rate-limit` and add rate limiters to critical endpoints**  
  `server/server.js`  
  Added limiters before the generic `/api/*` handler:
  - `/api/login` — 10 requests per 15 minutes per IP
  - `/api/webhook` — 60 requests per minute per IP
  - `/api/tmdb-poster` — 30 requests per minute per IP
  - `/api/tmdb-profile` — 30 requests per minute per IP

- [x] **[H-3] Add `requireAdmin` to `handleTmdbPoster` and `handleTmdbProfile`**  
  `server/src/index.js`  
  Added `if (!(await requireAdmin(req, res))) return;` near the top of each handler (after the OPTIONS check).

- [x] **[M-7] Remove raw payload `debug` field from unauthenticated webhook responses**  
  `server/src/index.js`  
  Deleted `debug: media.rawPayloadDebug` from the `sendJson` call in the `!media.isValid` / skipped-webhook branch.

---

## Phase 2 — Day 8–30 (admin surface hardening)

- [x] **[M-1] Add `Secure` flag to session cookie**  
  `server/src/utils/auth.js`  
  Added `secure: process.env.COOKIE_SECURE === "true"` to all cookie-setting calls. Documented `COOKIE_SECURE=true` in `docker-compose.yml`.

- [x] **[M-2] Remove API key acceptance via URL query parameters**  
  `server/src/utils/auth.js`  
  Deleted the `req.query` branch from `apiKeyFromRequest()` so only the `X-Api-Key` header and `Authorization: Bearer` are accepted.

- [x] **[M-3] Stop returning the raw API key in auth responses; add a dedicated endpoint**  
  `server/src/utils/auth.js`, `server/src/index.js`  
  Removed `apiKey: AUTH.apiKey` from the `login`, `auth/status`, and `credentials` responses.  
  Added `GET /api/auth/apikey` (admin-only) and `POST /api/auth/sessions/revoke-all` routes.

- [x] **[M-4] Add HTTP security headers middleware**  
  `server/server.js` — inserted before the `/api/*` handler:
  ```javascript
  app.use((_req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: https://image.tmdb.org; " +
      "script-src 'self'; style-src 'self' 'unsafe-inline';"
    );
    next();
  });
  ```

- [x] **[M-5] Fix `handleCronSync` and `handleDedupHistory` to authenticate before streaming**  
  `server/src/index.js`  
  Moved the `requireAdmin` call in `handleCronSync` to before the first `res.setHeader` / `res.write` call. `handleDedupHistory` was already correct.

- [x] **[M-6] Add a non-root user to the Dockerfile**  
  `Dockerfile`  
  Added `groupadd`/`useradd plembfin` (UID 1000), `chown /app /data`, and `USER plembfin` before the `VOLUME` directive.

- [x] **[M-8] Add URL scheme validation to `/api/test-connection` to prevent SSRF**  
  `server/src/index.js`  
  After parsing `baseUrl` with `new URL()`, rejects anything that is not `http:` or `https:`.

---

## Phase 3 — Day 31–90 (defence in depth)

- [x] **[L-1] Pass Plex token via request header instead of URL query parameter**  
  `server/src/utils/posterCache.js`, `server/src/index.js`  
  In `cacheArtworkFromUrl`: strips `X-Plex-Token` from the fetch URL and moves it to a request header.  
  In `handleTestConnection`: passes `X-Plex-Token` as a header instead of a query param.

- [x] **[L-2] Add a SQLite `audit_log` table and write entries for key events**  
  `server/src/schema.sql`, `server/src/db.js`, `server/src/utils/auth.js`, `server/src/index.js`  
  Added `audit_log` table and `writeAuditLog()` helper. Entries written for: login success/failure, credential updates, session revocation, settings saves, media deletion, and backup restores.

- [x] **[L-3] Reduce session TTL from 30 days to 7 days; add session revocation**  
  `server/src/utils/auth.js`  
  Changed `SESSION_TTL_MS` to 7 days.  
  Added `POST /api/auth/sessions/revoke-all` that calls `updateAdminCredentials` to rotate `AUTH.sessionSecret`, invalidating all existing cookies while issuing a fresh one to the caller.

- [x] **[L-4] Move YouTube Data API key from URL query parameter to request header**  
  `server/src/index.js`  
  Replaced `&key=${encodeURIComponent(ytApiKey)}` in the URL with an `X-goog-api-key: ${ytApiKey}` request header.

- [x] **[L-5] Add a `HEALTHCHECK` instruction to the Dockerfile**  
  `Dockerfile`  
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:5055/api/ping',r=>{process.exit(r.statusCode===200?0:1)})"
  ```

- [x] **[L-6] Add `scratch/` and `docs/` to `.dockerignore`**  
  `.dockerignore`  
  Added `scratch/` (`.dockerignore` already excluded `docs/` and `*.md`).

- [x] **[I-1] Tighten `config.json` file permissions after every write**  
  `server/src/appConfig.js`  
  Added `fs.chmodSync(CONFIG_PATH, 0o600)` immediately after `fs.writeFileSync(...)`, wrapped in try/catch for non-POSIX filesystems.

---

## Summary

| ID | Severity | Title | Done |
|---|---|---|---|
| C-1 | Critical | Webhook endpoint has no authentication | ✅ |
| H-1 | High | Default `changeme` password in docker-compose | ✅ |
| H-2 | High | No rate limiting | ✅ |
| H-3 | High | tmdb-poster / tmdb-profile unauthenticated | ✅ |
| M-1 | Medium | Session cookie lacks `Secure` flag | ✅ |
| M-2 | Medium | API key accepted via URL query params | ✅ |
| M-3 | Medium | Raw API key in every auth response | ✅ |
| M-4 | Medium | No HTTP security headers | ✅ |
| M-5 | Medium | CronSync/DedupHistory return 200 before auth | ✅ |
| M-6 | Medium | Container runs as root | ✅ |
| M-7 | Medium | Webhook raw payload echoed unauthenticated | ✅ |
| M-8 | Medium | SSRF via test-connection baseUrl | ✅ |
| L-1 | Low | Plex token in URL query params | ✅ |
| L-2 | Low | No audit log | ✅ |
| L-3 | Low | 30-day session TTL, no revocation | ✅ |
| L-4 | Low | YouTube API key in URL | ✅ |
| L-5 | Low | No Docker HEALTHCHECK | ✅ |
| L-6 | Low | `scratch/` in Docker image | ✅ |
| I-1 | Info | config.json world-readable by default umask | ✅ |
