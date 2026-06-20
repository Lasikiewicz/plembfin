// Local authentication client. Replaces the Firebase Auth web SDK with calls to
// the self-hosted /api/login, /api/logout, and /api/auth/status endpoints. The
// browser holds an HttpOnly session cookie (sent automatically on same-origin
// requests); the API key is fetched from /api/auth/apikey after login and kept
// in memory + localStorage for use in X-Api-Key request headers.

const API_KEY_STORAGE = "plembfinApiKey";

let cachedToken = localStorage.getItem(API_KEY_STORAGE) || "";
let cachedWebhookToken = "";
let cachedUser = null;

function userFrom(username) {
  const name = username || "admin";
  return { email: name, uid: name, username: name };
}

function setSession(username) {
  cachedUser = userFrom(username);
}

function clearSession() {
  cachedUser = null;
  cachedToken = "";
  cachedWebhookToken = "";
  localStorage.removeItem(API_KEY_STORAGE);
}

// Fetches the admin API key from the server and caches it. Called after any
// successful authentication so buildAuthHeaders() always has a key to use.
async function fetchAndCacheApiKey() {
  try {
    const res = await fetch("/api/auth/apikey", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.apiKey) {
      cachedToken = data.apiKey;
      localStorage.setItem(API_KEY_STORAGE, cachedToken);
    }
  } catch { /* network error — session cookie covers same-origin requests */ }
}

async function fetchAndCacheWebhookToken() {
  try {
    const res = await fetch("/api/auth/webhook-secret", { credentials: "same-origin" });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (data.webhookToken) cachedWebhookToken = data.webhookToken;
  } catch { /* best-effort */ }
}

export function readStoredAdminToken(_keys, fallback = "") {
  return cachedToken || fallback || "";
}

export function currentFirebaseUser() {
  return cachedUser;
}

export function getWebhookToken() {
  return cachedWebhookToken;
}

// Called once at startup. Resolves the current auth state from the session
// cookie and invokes the callback with (user, token) or (null, "").
export function onFirebaseAuthChange(callback) {
  (async () => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (data.authenticated) {
        setSession(data.username);
        await Promise.all([fetchAndCacheApiKey(), fetchAndCacheWebhookToken()]);
        callback(cachedUser, cachedToken || "session");
      } else {
        clearSession();
        callback(null, "");
      }
    } catch {
      clearSession();
      callback(null, "");
    }
  })();
  return () => {};
}

export async function signInAdmin(username, password) {
  const res = await fetch("/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: String(username || "").trim(), password: String(password || "") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Invalid username or password");
  }
  setSession(data.username);
  await Promise.all([fetchAndCacheApiKey(), fetchAndCacheWebhookToken()]);
  return { user: cachedUser, token: cachedToken || "session" };
}

export async function signOutAdmin() {
  try {
    await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  } catch {
    /* best-effort */
  }
  clearSession();
}

export async function updateAdminCredentials({ username, currentPassword, newPassword }) {
  const res = await fetch("/api/auth/credentials", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, currentPassword, newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Login update failed");
  setSession(data.username);
  await fetchAndCacheApiKey();
  return { user: cachedUser, token: cachedToken || "session" };
}

export async function rotateWebhookSecret() {
  const res = await fetch("/api/auth/webhook-secret", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to rotate webhook secret");
  if (data.webhookToken) cachedWebhookToken = data.webhookToken;
  return data.webhookToken || "";
}

export function buildAuthHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  const key = token && token !== "session" ? token : cachedToken;
  if (key) headers["X-Api-Key"] = key;
  return headers;
}

export function buildNowPlayingUrl(origin) {
  return new URL("/api/now-playing", origin);
}

export function scrubTokenFromLocation() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token|api_key)=)|(?:^#(?:adminToken|username|token|api_key)=)/i.test(`${search}${hash}`);

  if (hasAuthParams) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}
