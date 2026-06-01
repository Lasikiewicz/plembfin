import { db, Timestamp } from "../firebase.js";

const ACTIVE_SESSION_TTL_MS = 10_000;

function normalizePart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function sessionIdentity(media = {}) {
  const ids = media.ids || {};
  const providerParts = [
    ids.imdb ? `imdb:${ids.imdb}` : "",
    ids.tmdb ? `tmdb:${ids.tmdb}` : "",
    ids.tvdb ? `tvdb:${ids.tvdb}` : "",
  ].filter(Boolean);

  return [
    normalizePart(media.source),
    normalizePart(media.type),
    normalizePart(media.season),
    normalizePart(media.episode),
    providerParts.length ? providerParts.map(normalizePart).join(":") : normalizePart(media.title),
  ].join(":");
}

function fromDoc(doc) {
  const data = doc.data() || {};
  return {
    key: doc.id,
    title: data.title || "Unknown media",
    mediaType: data.mediaType || "unknown",
    source: data.source || "unknown",
    progress: Number(data.progress || 0),
    season: data.season ?? null,
    episode: data.episode ?? null,
    posterUrl: data.posterUrl || "",
    ids: data.ids || {},
    event: data.event || "",
    updatedAt: Number(data.updatedAt || 0),
  };
}

export async function listActiveSessions() {
  const cutoff = Date.now() - ACTIVE_SESSION_TTL_MS;
  const snapshot = await db.collection("activeSessions").orderBy("updatedAt", "desc").get();
  const stale = [];
  const sessions = [];
  snapshot.docs.forEach((doc) => {
    const session = fromDoc(doc);
    if (session.updatedAt < cutoff) stale.push(doc.ref);
    else sessions.push(session);
  });
  if (stale.length) {
    const batch = db.batch();
    stale.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return sessions;
}

export async function upsertActiveSession(_unusedKv, media) {
  if (!media) return [];
  const now = Date.now();
  await db.collection("activeSessions").doc(sessionIdentity(media)).set({
    title: media.title || "Unknown media",
    mediaType: media.type || "unknown",
    source: media.source || "unknown",
    progress: Number.isFinite(Number(media.progress)) ? Math.max(0, Math.min(100, Number(media.progress))) : 0,
    season: media.season ?? null,
    episode: media.episode ?? null,
    posterUrl: media.posterUrl || "",
    ids: media.ids || {},
    event: media.event || "",
    updatedAt: now,
    expireAt: Timestamp.fromMillis(now + 60_000),
  });
  return listActiveSessions();
}

export async function deleteActiveSession(_unusedKv, media) {
  if (!media) return [];
  await db.collection("activeSessions").doc(sessionIdentity(media)).delete();
  return listActiveSessions();
}
