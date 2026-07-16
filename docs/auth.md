# Authentication & Secrets

Local single-admin auth: username/password login, a signed session cookie, an API key
for integrations, and a separate webhook secret. No external identity provider.

## Files

| File | Role |
| --- | --- |
| `server/src/appConfig.js` | Resolves credentials/secrets at boot (env → `data/config.json` → generate), scrypt password hashing, secret rotation, startup security warnings |
| `server/src/utils/auth.js` | Session cookie sign/verify, `requireAdmin`, all `/api/auth/*` + `/api/login|logout` handlers |
| `public/modules/auth.js` | Frontend: sign in/out, `onAuthChange`, credential updates, webhook-secret rotation |
| `server/src/db.js` | `writeAuditLog` — security event log |

## The four credentials

| Credential | Purpose | Storage | Rotation |
| --- | --- | --- | --- |
| Admin username + password | Dashboard login | scrypt hash in `data/config.json` (`ADMIN_USERNAME`/`ADMIN_PASSWORD` env override until credentials are managed in-app) | Settings → Account & Security |
| Session secret | Signs the `plembfin_session` cookie | `data/config.json` (`SESSION_SECRET` pins it) | Rotating it (credential change, revoke-all, env change + restart) invalidates every session at once |
| API key | Integrations/automation: `X-Api-Key` or `Authorization: Bearer` | `data/config.json` (`API_KEY` pins it) | Set a new `API_KEY` and restart |
| Webhook secret | Authorizes `/api/webhook` only | `data/config.json` (`WEBHOOK_SECRET` pins it) | Settings → Connections → Webhooks → Rotate Secret (`POST /api/auth/webhook-secret`) — independent of everything else |

First boot: if `ADMIN_PASSWORD` is unset, a random password is generated and printed
**once** to the server console; only the scrypt hash is stored. Secrets shorter than 32
chars fail startup (`assertMinSecretLength`); a default `admin` password triggers a
forced-change flow (`mustChangePassword` in `/api/auth/status` pins the UI to Settings →
Account & Security).

When credentials are changed from Settings or all sessions are revoked,
`authManagedInApp: true` is written to `data/config.json`. While that flag is present,
`ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables are ignored on startup. The
server logs a `[security]` notice if those env vars are set but inactive; remove
`authManagedInApp` from `data/config.json` to restore env-var control.

## Sessions

- Stateless: the cookie value is `base64url(payload).hmacSHA256(payload,
  sessionSecret)` with the issue time inside; 7-day TTL checked on verify.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Secure` when `COOKIE_SECURE=true`,
  path `/`.
- Revocation is global-only: rotating `sessionSecret` invalidates every cookie.
  `POST /api/auth/sessions/revoke-all` does exactly that, then issues the caller a
  fresh cookie so they stay signed in.

## Request authentication

`requireAdmin(req, res)` (used by nearly every handler in `index.js`) accepts either:

1. a valid `plembfin_session` cookie, or
2. the API key via `X-Api-Key` or `Authorization: Bearer` (query-parameter API keys
   are deliberately **not** accepted)

and 401s otherwise. `resolveAdminPrincipal` is the no-response variant.

The webhook endpoint authenticates separately with `verifyWebhookToken` — see
[webhooks.md](webhooks.md). Timing-safe comparison is used for every secret check.

## Routes

| Route | Handler | Notes |
| --- | --- | --- |
| `POST /api/login` | `handleLogin` | Rate-limited 10/15min per IP; audit-logged success/failure |
| `POST /api/logout` | `handleLogout` | Clears the cookie |
| `GET /api/auth/status` | `handleAuthStatus` | `{ authenticated, username, mustChangePassword }` — never 401s |
| `GET /api/auth/apikey` | `handleAuthApiKey` | Returns the API key; admin-only, fetched on demand by the UI |
| `GET/POST /api/auth/webhook-secret` | `handleAuthWebhookSecret` | GET returns it, POST rotates it |
| `POST /api/auth/credentials` | `handleAuthCredentials` | Requires current password; rotates session secret; re-issues cookie |
| `POST /api/auth/sessions/revoke-all` | `handleRevokeAllSessions` | Global session invalidation |

## Frontend flow

`onAuthChange()` (`public/modules/auth.js`) checks `/api/auth/status` at startup and
after login/logout; the auth panel shows only when no session is active, and the app
shell renders on success. After login, all browser API calls ride the HttpOnly cookie —
no token is kept in localStorage (legacy token keys are read once for migration and
scrubbed; `scrubTokenFromLocation` removes tokens from pasted URLs).

## Audit log

`writeAuditLog(action, { ip, detail })` records to the `audit_log` table:
`login.success` / `login.failure`, `credentials.updated`, `sessions.revoked`,
`webhook-secret.rotated`, `media.deleted`, `settings.saved`, `backup.restored`. Not
exposed via the API — query SQLite directly (see
[sqlite-schema.md](sqlite-schema.md)).

## Hardening

Production checklist (HTTPS, `COOKIE_SECURE`, pinned secrets, Docker overlay):
[hardening.md](hardening.md). Completed remediation history:
[security-checklist.md](security-checklist.md).
