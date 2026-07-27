// Read-only audit for watch rows that look like media-server echoes.
// It deliberately reports candidates instead of deleting anything.

const PLATFORM_SOURCES = new Set(["plex", "emby", "jellyfin"]);
const SAME_EVENT_WINDOW_MS = 10 * 60 * 1000;
const MAX_GROUPS = 500;

function text(value) { return String(value || "").trim(); }
function lower(value) { return text(value).toLowerCase(); }
function titleKey(value) {
  return lower(value).replace(/\s+/g, " ").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}
function timeMs(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
function sourceIsPlatform(row) { return PLATFORM_SOURCES.has(lower(row.source)); }
function providerIds(row) {
  return [row.imdb_id && `imdb:${text(row.imdb_id)}`, row.tmdb_id && `tmdb:${text(row.tmdb_id)}`, row.tvdb_id && `tvdb:${text(row.tvdb_id)}`].filter(Boolean);
}
function episodeKey(row) {
  if (row.media_type !== "episode" || row.season == null || row.episode == null) return "";
  return `episode|${titleKey(row.show_title || row.title)}|${row.season}|${row.episode}`;
}

function unionFind(size) {
  const parent = Array.from({ length: size }, (_, index) => index);
  const find = (value) => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const union = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[b] = a;
  };
  return { find, union };
}

function compact(row) {
  return {
    id: row.id, title: row.title, media_type: row.media_type,
    show_title: row.show_title || null, season: row.season ?? null, episode: row.episode ?? null,
    watched_at: row.watched_at, source: row.source, media_key: row.media_key || null,
    sync_action: row.sync_action || null,
  };
}

export function auditPhantomWatchHistory(database, { sameEventWindowMs = SAME_EVENT_WINDOW_MS } = {}) {
  const rows = database.prepare(`
    SELECT id, title, media_type, watched_at, source, imdb_id, tmdb_id, tvdb_id,
           season, episode, media_key, show_title, sync_action
    FROM watch_history
    WHERE watched_at IS NOT NULL
      AND (sync_action IS NULL OR LOWER(sync_action) NOT IN ('unwatched', 'unplayed'))
    ORDER BY watched_at ASC
  `).all();

  const { find, union } = unionFind(rows.length);
  const byIdentity = new Map();
  const connect = (key, index) => {
    if (!key) return;
    const prior = byIdentity.get(key);
    if (prior == null) byIdentity.set(key, index); else union(prior, index);
  };
  rows.forEach((row, index) => {
    connect(text(row.media_key) && `key|${row.media_key}`, index);
    providerIds(row).forEach((id) => {
      // Episode rows often carry a series-level TMDB/TVDB ID. Include season
      // and episode so different episodes of one show are never grouped as
      // duplicate watches merely because they share that series ID.
      const scope = row.media_type === "episode" ? `${row.season}|${row.episode}` : "";
      connect(`${row.media_type}|${id}|${scope}`, index);
    });
    connect(episodeKey(row), index);
    // Title matching is audit-only so title-only and cross-key records are
    // surfaced for review without changing normal deduplication semantics.
    const titleIdentity = row.media_type === "episode"
      ? `episode-title|${titleKey(row.show_title || row.title)}|${row.season}|${row.episode}`
      : `movie-title|${titleKey(row.title)}`;
    connect(titleIdentity, index);
  });

  const groups = new Map();
  rows.forEach((row, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  });

  const candidates = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => timeMs(a.watched_at) - timeMs(b.watched_at));
    for (let index = 1; index < members.length; index += 1) {
      const previous = members[index - 1];
      const current = members[index];
      const gap = timeMs(current.watched_at) - timeMs(previous.watched_at);
      if (gap < 0 || gap > sameEventWindowMs) continue;
      if (!sourceIsPlatform(previous) && !sourceIsPlatform(current)) continue;
      const sameKey = text(previous.media_key) && text(previous.media_key) === text(current.media_key);
      const sharedProvider = providerIds(previous).some((id) => providerIds(current).includes(id));
      const sameEpisode = episodeKey(previous) && episodeKey(previous) === episodeKey(current);
      candidates.push({
        confidence: sameKey || sharedProvider || sameEpisode ? "high" : "review",
        reason: sameKey ? "same-media-key" : sharedProvider ? "shared-provider-id" : sameEpisode ? "same-episode-identity" : "title-or-coordinate-match",
        gap_seconds: Math.round(gap / 1000),
        records: [compact(previous), compact(current)],
      });
      if (candidates.length >= MAX_GROUPS) break;
    }
    if (candidates.length >= MAX_GROUPS) break;
  }
  candidates.sort((a, b) => String(b.records.at(-1)?.watched_at || "").localeCompare(String(a.records.at(-1)?.watched_at || "")));
  return {
    scanned: rows.length,
    candidate_groups: candidates.length,
    high_confidence_groups: candidates.filter((item) => item.confidence === "high").length,
    review_groups: candidates.filter((item) => item.confidence === "review").length,
    same_event_window_seconds: Math.round(sameEventWindowMs / 1000),
    candidates,
  };
}
