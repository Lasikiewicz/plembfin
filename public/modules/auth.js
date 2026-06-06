import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.0/firebase-app.js";
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.9.0/firebase-auth.js";
import { firebaseConfig } from "../firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const LOCAL_ADMIN_TOKEN = "plembfin-local-admin";

function isLocalHost() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

if (isLocalHost()) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}

let cachedToken = localStorage.getItem("adminToken") || "";
let refreshTimer;

async function refreshIdToken(force = false) {
  if (!auth.currentUser) return "";
  cachedToken = await auth.currentUser.getIdToken(force);
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => refreshIdToken(true).catch(() => {}), 45 * 60 * 1000);
  return cachedToken;
}

export function readStoredAdminToken(_keys, fallback = "") {
  return cachedToken || fallback || "";
}

export function currentFirebaseUser() {
  return auth.currentUser || (cachedToken === LOCAL_ADMIN_TOKEN ? { email: "admin", uid: "local-admin" } : null);
}

export function onFirebaseAuthChange(callback) {
  if (isLocalHost() && cachedToken === LOCAL_ADMIN_TOKEN) {
    setTimeout(() => {
      callback({ email: "admin", uid: "local-admin" }, cachedToken);
    }, 0);
  }

  return onAuthStateChanged(auth, async (user) => {
    if (user) {
      cachedToken = await refreshIdToken();
      callback(user, cachedToken);
    } else {
      if (isLocalHost() && cachedToken === LOCAL_ADMIN_TOKEN) {
        return;
      }
      cachedToken = "";
      localStorage.removeItem("adminToken");
      callback(null, "");
    }
  });
}

export async function signInAdmin(email, password) {
  if (isLocalHost() && String(email || "").trim() === "admin" && String(password || "") === "admin") {
    cachedToken = LOCAL_ADMIN_TOKEN;
    localStorage.setItem("adminToken", cachedToken);
    return { user: { email: "admin", uid: "local-admin" }, token: cachedToken };
  }
  const credential = await signInWithEmailAndPassword(auth, email, password);
  const token = await refreshIdToken(true);
  return { user: credential.user, token };
}

export async function signOutAdmin() {
  window.clearTimeout(refreshTimer);
  cachedToken = "";
  localStorage.removeItem("adminToken");
  await signOut(auth);
}

export function buildAuthHeaders(token) {
  return {
    Authorization: `Bearer ${token || cachedToken}`,
    "Content-Type": "application/json",
  };
}

export function buildNowPlayingUrl(origin, _token) {
  const url = new URL("/api/now-playing", origin);
  return url;
}

export function scrubTokenFromLocation() {
  const search = String(window.location.search || "");
  const hash = String(window.location.hash || "");
  const hasAuthParams = /(?:[?&#](?:adminToken|username|token)=)|(?:^#(?:adminToken|username|token)=)/i.test(`${search}${hash}`);

  if (hasAuthParams) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}
