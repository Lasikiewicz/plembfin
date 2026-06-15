// Local authentication client. Replaces the Firebase Auth web SDK with calls to
// the self-hosted /api/login, /api/logout, and /api/auth/status endpoints. The
// browser holds an HttpOnly session cookie (sent automatically on same-origin
// requests); the returned API key is kept in memory + localStorage so it can be
// attached to header-less requests like the now-playing EventSource.

const API_KEY_STORAGE = "plembfinApiKey";

let cachedToken = localStorage.getItem(API_KEY_STORAGE) || "";
let cachedUser = null;

function userFrom(username) {
  const name = username || "admin";
  return { email: name, uid: name, username: name };
}

function setSession(username, apiKey) {
  cachedUser = userFrom(username);
  cachedToken = apiKey || cachedToken || "";
  if (cachedToken) localStorage.setItem(API_KEY_STORAGE, cachedToken);
}

function clearSession() {
  cachedUser = null;
  cachedToken = "";
  localStorage.removeItem(API_KEY_STORAGE);
}

export function readStoredAdminToken(_keys, fallback = "") {
  return cachedToken || fallback || "";
}

export function currentFirebaseUser() {
  return cachedUser;
}

// Called once at startup. Resolves the current auth state from the session
// cookie and invokes the callback with (user, token) or (null, "").
export function onFirebaseAuthChange(callback) {
  (async () => {
    try {
      const res = await fetch("/api/auth/status", { credentials: "same-origin" });
      const data = await res.json().catch(() => ({}));
      if (data.authenticated) {
        setSession(data.username, data.apiKey);
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
  setSession(data.username, data.apiKey);
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
  setSession(data.username, data.apiKey);
  return { user: cachedUser, token: cachedToken || "session" };
}

export function buildAuthHeaders(token) {
  const headers = { "Content-Type": "application/json" };
  const key = token && token !== "session" ? token : cachedToken;
  if (key) headers["X-Api-Key"] = key;
  return headers;
}

export function buildNowPlayingUrl(origin, token) {
  const url = new URL("/api/now-playing", origin);
  const key = token && token !== "session" ? token : cachedToken;
  if (key) url.searchParams.set("api_key", key);
  return url;
}

export function scrubTokenFromLocation() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token|api_key)=)|(?:^#(?:adminToken|username|token|api_key)=)/i.test(`${search}${hash}`);

  if (hasAuthParams) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}
