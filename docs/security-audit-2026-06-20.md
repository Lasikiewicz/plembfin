# Plembfin Security Audit Report

**Date:** 2026-06-20  
**Auditor:** Claude Sonnet 4.6 (Anthropic)  
**Repository:** `plembfin` — `main` branch (commit `a9ca122`)  
**Companion checklist:** [security-checklist.md](security-checklist.md)

---

## A. Executive Summary

Plembfin is a self-hosted, single-process Node.js application that bridges watch-state data between Plex, Emby, and Jellyfin. It uses Express, better-sqlite3, and a plain ES-module SPA. The authentication design for the admin dashboard is solid — scrypt hashing, HMAC-signed stateless session cookies, and timing-safe comparisons throughout. The database layer uses parameterised statements exclusively: **no SQL injection was found**.

However, the audit identified **one Critical finding that makes the application fully compromisable from the network with no credentials at all**. Combined with a High-severity finding of no rate limiting and several Medium-severity issues that amplify the blast radius, the application in its current state **must not be exposed to the public internet without remediation**.

For a home-network installation that is never port-forwarded, the risk profile is significantly lower, but several medium issues still apply.

**Overall posture: HIGH risk when internet-facing; MEDIUM risk on a trusted LAN.**

---

## B. Architecture Overview

```
Internet / LAN
      │
      ▼
  Express (port 5055)
      ├── /media/*          ← static; immutable cached artwork (public)
      ├── /changelog.json   ← public
      ├── /api/*            ← all API routes (raw body captured)
      │     ├── /api/ping          (unauthenticated — intentional)
      │     ├── /api/webhook       ← ⚠ UNAUTHENTICATED WRITE SURFACE
      │     ├── /api/tmdb-poster   ← ⚠ UNAUTHENTICATED PROXY
      │     ├── /api/tmdb-profile  ← ⚠ UNAUTHENTICATED PROXY
      │     ├── /api/login         (auth handler)
      │     └── everything else    (requireAdmin guard)
      │
      ├── SQLite DB (data/plembfin.db)
      ├── In-process scheduler (runScheduledTick every 60 s)
      └── Plex WebSocket listener (plexNotificationListener)

External integrations (outbound only):
  Plex, Emby, Jellyfin, TMDB, Seerr, YouTube Data API,
  Dropbox, OneDrive, Backblaze B2, WebDAV, local folder
```

### Trust Boundaries

| Boundary | Who crosses it |
|---|---|
| Admin session cookie / API key | Dashboard browser, webhook sender, Plex notification listener |
| Webhook endpoint | Media servers (Plex/Emby/Jellyfin) — currently **no auth** |
| Outbound HTTP | TMDB, Seerr, cloud backup destinations |
| SQLite file | The single Node process only |

---

## C. Attack Surface Map

| Surface | Method | Auth Required | Notes |
|---|---|---|---|
| `POST /api/webhook` | POST | **No** | Full write access to watch state |
| `GET /api/tmdb-poster` | GET | **No** | TMDB image proxy + disk cache |
| `GET /api/tmdb-profile` | GET | **No** | TMDB image proxy + disk cache |
| `GET /api/ping` | GET | No | Intentional; returns timestamp only |
| `POST /api/login` | POST | No | Login handler — no rate limit |
| `GET /api/auth/status` | GET | No (probe) | Returns API key if authed |
| All other `/api/*` | ANY | **Yes** | requireAdmin guard |
| `GET /media/*` | GET | No | Static files; cached posters only |
| Port 5055 TCP | — | — | Exposed to LAN/Internet |

---

## D. Findings

---

### CRITICAL-1 — Webhook Endpoint Has No Authentication

**File:** `server/src/index.js:2125–2510`  
**Endpoint:** `POST /api/webhook`

**Description**

`handleWebhook()` is dispatched directly without any call to `requireAdmin()`. Any HTTP client that can reach port 5055 can POST arbitrary webhook payloads:

```javascript
// dispatch() — server/src/index.js:3580
if (path === "webhook") return handleWebhook(req, res);
// No auth guard before this call.
```

**Impact**

An unauthenticated attacker who can reach the port can:

1. Insert fake watch records into the SQLite database (`phase: completed`)
2. Trigger cross-platform propagation — calls `syncMediaPlaystate()` which marks items watched on Plex, Emby, and Jellyfin using the stored admin credentials
3. Mark every item unwatched across all connected platforms (`phase: unplayed`) — calls `applyManualUnwatch()` which fans out to all targets
4. Delete watch records from the database via the `unplayed` path
5. Fill the `sync_history` table with unlimited records (15 MB per request, no rate limit)
6. Flood `active_sessions` and `live_tracking_cache` tables via `phase: active` webhooks
7. Trigger the post-restore webhook suppression guard, blocking all legitimate webhooks for up to 10 minutes

**Exploitability:** Trivially exploitable with `curl`. No credentials needed.

**Remediation**

```javascript
// In handleWebhook, before normalizeWebhook():
if (!(await requireAdmin(req, res))) return;
```

---

### HIGH-1 — Default `changeme` Password in `docker-compose.yml`

**File:** `docker-compose.yml:14`

```yaml
- ADMIN_PASSWORD=changeme
```

Any operator who runs `docker compose up` without editing the file immediately has a reachable admin login with a well-known password.

**Remediation**

```yaml
# REQUIRED: set a strong password before first boot.
# - ADMIN_PASSWORD=
```

---

### HIGH-2 — No Rate Limiting on Any Endpoint

No rate limiting exists anywhere. Critical paths: `POST /api/login` (brute force), `POST /api/webhook` (flooding with C-1), `GET /api/tmdb-poster` (disk filling with H-3).

**Remediation**

```javascript
import rateLimit from "express-rate-limit";

app.use("/api/login", rateLimit({ windowMs: 15 * 60 * 1000, max: 10 }));
app.use("/api/webhook", rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use("/api/tmdb-poster", rateLimit({ windowMs: 60_000, max: 30 }));
app.use("/api/tmdb-profile", rateLimit({ windowMs: 60_000, max: 30 }));
```

---

### HIGH-3 — `/api/tmdb-poster` and `/api/tmdb-profile` Are Unauthenticated

**File:** `server/src/index.js:2714`, `server/src/index.js:2742`

Both handlers fetch images from `image.tmdb.org`, resize them with `sharp`, and write the result to `data/media/` permanently. Neither calls `requireAdmin()`. An attacker can fill the disk or use the server as an anonymising TMDB image proxy.

**Remediation:** Add `if (!(await requireAdmin(req, res))) return;` to both handlers.

---

### MEDIUM-1 — Session Cookie Lacks `Secure` Flag

**File:** `server/src/utils/auth.js:87–92`

The cookie is transmitted in cleartext over HTTP. Many self-hosted deployments run HTTP internally without TLS.

**Remediation**

```javascript
res.cookie(COOKIE_NAME, signSession(username), {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.COOKIE_SECURE === "true",
  maxAge: SESSION_TTL_MS,
  path: "/",
});
```

---

### MEDIUM-2 — API Key Accepted via URL Query Parameter

**File:** `server/src/utils/auth.js:38`

```javascript
return String(req.query?.api_key || req.query?.token || req.query?.admin_token || "").trim();
```

Query parameters appear in access logs, browser history, and `Referer` headers on redirects.

**Remediation:** Remove the `req.query` branch; require `X-Api-Key` header or `Authorization: Bearer` only.

---

### MEDIUM-3 — Raw API Key Returned in Every Auth Response

**File:** `server/src/utils/auth.js:93`, `auth.js:104`, `auth.js:135`

```javascript
return sendJson(res, { ok: true, username, apiKey: AUTH.apiKey });
```

The plaintext API key is present in every `/api/auth/status` response. A single XSS vulnerability allows an attacker to steal it with a trivial `fetch('/api/auth/status')`. The key never expires.

**Remediation:** Remove `apiKey` from these responses. Add a dedicated admin-only `GET /api/auth/apikey` endpoint.

---

### MEDIUM-4 — No HTTP Security Headers

**File:** `server/server.js`

None of the following headers are set: `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`.

**Remediation**

```javascript
app.use((req, res, next) => {
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

---

### MEDIUM-5 — `handleCronSync` and `handleDedupHistory` Return HTTP 200 Before Auth Check

**File:** `server/src/index.js:2000–2006`, `server/src/index.js:2983–2987`

```javascript
res.write("Cron Sync started...\n");       // HTTP 200 sent here
const admin = await requireAdminStreaming(req, res);  // auth checked after
```

Unauthenticated requests get HTTP 200 status. The auth failure is only in the body.

**Remediation:** Call `requireAdmin()` synchronously before setting any response headers or writing any body content.

---

### MEDIUM-6 — Dockerfile Runs Container as Root

**File:** `Dockerfile`

No `USER` instruction; the process runs as root (UID 0). Container escape exploits become more impactful.

**Remediation**

```dockerfile
RUN groupadd -r plembfin && useradd -r -g plembfin -u 1000 plembfin
RUN chown -R plembfin:plembfin /app
USER plembfin
```

---

### MEDIUM-7 — Webhook Raw Payload Echoed to Unauthenticated Callers

**File:** `server/src/index.js:2174`

```javascript
return sendJson(res, {
  ok: true,
  skipped: true,
  debug: media.rawPayloadDebug,  // full JSON.stringify(json) for Emby/Jellyfin
});
```

An unauthenticated caller can probe the parsing logic and see exactly how payloads are interpreted.

**Remediation:** Remove the `debug` field from the unauthenticated skip/invalid path.

---

### MEDIUM-8 — SSRF via `/api/test-connection`

**File:** `server/src/index.js:2519–2528`

An authenticated admin can supply an arbitrary `url` body field, which the server fetches directly. Enables probing internal services (metadata endpoints, localhost admin panels) once the admin account is compromised.

**Remediation**

```javascript
const parsed = new URL(baseUrl);
if (!["http:", "https:"].includes(parsed.protocol)) {
  return sendJson(res, { ok: false, error: "Only http/https URLs are allowed" }, 400);
}
```

---

### LOW-1 — Plex Token Embedded in Poster URL Query Parameters

**File:** `server/src/index.js:143–145`

`X-Plex-Token` is appended to poster fetch URLs. These appear in the browser network tab, browser history, and HTTP logs.

**Remediation:** Pass the token via a request header (`X-Plex-Token`) where the Plex API supports it.

---

### LOW-2 — No Audit Log for Administrative Actions

No persistent record of: login attempts, configuration changes, credential updates, media deletion, backup restores.

**Remediation:** Add an `audit_log` SQLite table and write entries for these events.

---

### LOW-3 — Session TTL is 30 Days With No Server-Side Revocation

**File:** `server/src/utils/auth.js:7`

A stolen session cookie is valid for 30 days. There is no revocation mechanism other than rotating the session secret (which also logs out everyone).

**Remediation:** Reduce TTL to 7 days. Add `POST /api/auth/sessions/revoke-all` that rotates `sessionSecret`.

---

### LOW-4 — YouTube Data API Key Sent as URL Query Parameter

**File:** `server/src/index.js:3488`

```javascript
`https://www.googleapis.com/youtube/v3/videos?...&key=${encodeURIComponent(ytApiKey)}`
```

The key appears in Google's access logs and potentially in `Referer` headers.

**Remediation:** Use the `X-goog-api-key` request header instead.

---

### LOW-5 — No Dockerfile `HEALTHCHECK`

Without a health check, Docker cannot detect a silent crash or scheduler hang.

**Remediation**

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5055/api/ping', r => { process.exit(r.statusCode === 200 ? 0 : 1) })"
```

---

### LOW-6 — `scratch/` Directory Included in Docker Image

**File:** `scratch/` (no `.dockerignore` entry)

Development scripts ship in the production image.

**Remediation:** Add `scratch/` and `docs/` to `.dockerignore`.

---

### INFO-1 — `config.json` Has No Explicit File Permissions

**File:** `server/src/appConfig.js:16`

`data/config.json` is written with the process umask (typically 022, world-readable). It contains the API key, session secret, and scrypt password hash.

**Remediation**

```javascript
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
fs.chmodSync(CONFIG_PATH, 0o600);
```

---

## E. 30 / 60 / 90-Day Remediation Roadmap

### Phase 1 — Day 1 (ship-blockers)

- C-1: Add `requireAdmin` to `handleWebhook`
- H-1: Remove default password from `docker-compose.yml`
- H-2: Install `express-rate-limit`, add limiters to `/api/login` and `/api/webhook`
- H-3: Add `requireAdmin` to `handleTmdbPoster` and `handleTmdbProfile`
- M-7: Remove `debug` field from unauthenticated webhook responses

### Phase 2 — Day 8–30 (admin surface hardening)

- M-1: Add `Secure` flag to session cookie
- M-2: Remove query-parameter API key acceptance
- M-3: Remove raw API key from auth responses; add `/api/auth/apikey` endpoint
- M-4: Add HTTP security headers middleware
- M-5: Fix `handleCronSync` / `handleDedupHistory` to auth before streaming
- M-6: Add non-root user to Dockerfile
- M-8: Add URL scheme validation to `/api/test-connection`

### Phase 3 — Day 31–90 (defence in depth)

- L-1: Pass Plex token via request header instead of URL
- L-2: Add `audit_log` SQLite table; log auth, config, and destructive events
- L-3: Reduce session TTL to 7 days; add revocation endpoint
- L-4: Move YouTube API key to `X-goog-api-key` header
- L-5: Add `HEALTHCHECK` to Dockerfile
- L-6: Add `scratch/` and `docs/` to `.dockerignore`
- I-1: Call `fs.chmodSync` after every `config.json` write

---

## F. Files Inspected

| File | Status |
|---|---|
| `server/server.js` | Fully reviewed |
| `server/src/index.js` | Fully reviewed (all 3693 lines) |
| `server/src/utils/auth.js` | Fully reviewed |
| `server/src/appConfig.js` | Fully reviewed |
| `server/src/db.js` | Fully reviewed |
| `server/src/schema.sql` | Fully reviewed |
| `server/src/utils/parsers.js` | Fully reviewed |
| `server/src/utils/posterCache.js` | Fully reviewed |
| `server/src/utils/configStore.js` | Fully reviewed |
| `server/src/utils/watchHistoryBackups.js` | Key functions reviewed |
| `docker-compose.yml` | Fully reviewed |
| `Dockerfile` | Fully reviewed |
| `.env.example` | Reviewed |

**Not yet reviewed (follow-up recommended):**

- `server/src/utils/plexClient.js` — request construction, token handling
- `server/src/utils/embyClient.js` / `jellyfinClient.js` — same
- `server/src/utils/syncOrchestrator.js` — loop detection, propagation logic
- `server/src/utils/backupDestinations/*.js` — S3, WebDAV, Dropbox credential storage
- `server/src/utils/diagnosticLogger.js` — what is logged and whether it persists sensitive data
- `public/app.js` — 9000-line SPA; XSS surface in rendered metadata
- `server/src/utils/plexNotificationListener.js` — WebSocket connection, reconnect logic
