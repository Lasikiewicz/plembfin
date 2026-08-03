import { db, parseJson, toJson } from "../db.js";
import { activeSessionTtlMs } from "./tuning.js";
import { recordWatchAuditEvent } from "./watchAudit.js";

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

function fromRow(row) {
  return {
    key: row.id,
    title: row.title || "Unknown media",
    mediaType: row.media_type || "unknown",
    source: row.source || "unknown",
    progress: Number(row.progress || 0),
    offsetMs: Number(row.offset_ms || 0),
    durationMs: Number(row.duration_ms || 0),
    season: row.season ?? null,
    episode: row.episode ?? null,
    posterUrl: row.poster_url || "",
    ids: parseJson(row.ids, {}) || {},
    event: row.event || "",
    client: parseJson(row.client, { userName: "", deviceName: "" }) || { userName: "", deviceName: "" },
    updatedAt: Number(row.updated_at || 0),
  };
}

const selectAllStmt = db.prepare("SELECT * FROM active_sessions ORDER BY updated_at DESC");
const deleteStaleStmt = db.prepare("DELETE FROM active_sessions WHERE updated_at < ?");
const upsertStmt = db.prepare(
  `INSERT INTO active_sessions
     (id, title, media_type, source, progress, offset_ms, duration_ms, season, episode, poster_url, ids, event, client, updated_at, expire_at)
   VALUES (@id, @title, @media_type, @source, @progress, @offset_ms, @duration_ms, @season, @episode, @poster_url, @ids, @event, @client, @updated_at, @expire_at)
   ON CONFLICT(id) DO UPDATE SET
     title=excluded.title, media_type=excluded.media_type, source=excluded.source, progress=excluded.progress,
     offset_ms=excluded.offset_ms, duration_ms=excluded.duration_ms, season=excluded.season, episode=excluded.episode,
     poster_url=excluded.poster_url, ids=excluded.ids, event=excluded.event, client=excluded.client,
     updated_at=excluded.updated_at, expire_at=excluded.expire_at`,
);
const deleteOneStmt = db.prepare("DELETE FROM active_sessions WHERE id = ?");

export async function listActiveSessions() {
  const cutoff = Date.now() - activeSessionTtlMs();
  deleteStaleStmt.run(cutoff);
  return selectAllStmt.all().map(fromRow);
}

export async function upsertActiveSession(media) {
  if (!media) return [];
  const now = Date.now();
  const id = sessionIdentity(media);
  const wasActive = Boolean(db.prepare("SELECT id FROM active_sessions WHERE id = ? LIMIT 1").get(id));
  upsertStmt.run({
    id,
    title: media.title || "Unknown media",
    media_type: media.type || "unknown",
    source: media.source || "unknown",
    progress: Number.isFinite(Number(media.progress)) ? Math.max(0, Math.min(100, Number(media.progress))) : 0,
    offset_ms: Number(media.offsetMs) || 0,
    duration_ms: Number(media.durationMs) || 0,
    season: media.season ?? null,
    episode: media.episode ?? null,
    poster_url: media.posterUrl || "",
    ids: toJson(media.ids || {}),
    event: media.event || "",
    client: toJson({
      userName: media.user || "",
      deviceName: media.device || media.deviceName || "",
      deviceId: media.deviceId || "",
      client: media.clientName || media.client?.client || media.client?.product || media.client?.platform || "",
      version: media.clientVersion || media.client?.version || "",
    }),
    updated_at: now,
    expire_at: now + activeSessionTtlMs(),
  });
  if (!wasActive || /start|resume|unpause/i.test(String(media.event || ""))) {
    const client = media.client && typeof media.client === "object" ? media.client : {};
    recordWatchAuditEvent({
      eventType: "playback_detected",
      timestamp: now,
      action: "playback",
      mediaType: media.type || media.mediaType,
      title: media.title,
      source: media.source,
      sourceEvent: media.event,
      phase: "active",
      watchProvenance: media.watchProvenance || media.watch_provenance,
      ids: media.ids,
      season: media.season,
      episode: media.episode,
      itemId: media.itemId,
      sessionId: media.sessionId || id,
      user: media.user || client.userName,
      device: media.device || media.deviceName || client.deviceName,
      deviceId: media.deviceId || client.deviceId,
      client: media.clientName || client.client || client.product || client.platform,
      clientVersion: media.clientVersion || client.version,
      details: wasActive ? "Playback resumed on a known active session." : "Playback detected and active session opened.",
      payload: {
        progress: media.progress,
        offsetMs: media.offsetMs,
        durationMs: media.durationMs,
      },
    });
  }
  return listActiveSessions();
}

export async function deleteActiveSession(media) {
  if (!media) return [];
  deleteOneStmt.run(sessionIdentity(media));
  return listActiveSessions();
}
