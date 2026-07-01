// Pure utility functions — no state, no DOM, no side effects.

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

export function sanitizeTitle(value) {
  const raw = String(value || "").trim();
  if (!raw || /^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) return "";
  return raw;
}

export function safeImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, window.location.origin);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (window.location.protocol === "https:" && url.protocol === "http:") return "";
    return /^https?:\/\//i.test(raw) ? url.toString() : "";
  } catch {
    return "";
  }
}

export function slug(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function movieSlug(movie = {}) {
  return slug(movie.title || movie.name || movie.id);
}

export function movieHref(movie = {}) {
  return `/movie/${movieSlug(movie)}`;
}

export function showName(title) {
  const text = String(title || "Unknown Show").trim();
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

export function showTitleFrom(title = "") {
  const text = String(title || "").trim() || "Unknown Show";
  const seasonMatch = text.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  if (seasonMatch?.[1]) return seasonMatch[1].trim() || "Unknown Show";
  const alternateMatch = text.match(/^(.*?)(?:\s+-\s+Season\s+\d+.*)$/i);
  if (alternateMatch?.[1]) return alternateMatch[1].trim() || "Unknown Show";
  return text.split(" - ")[0].trim() || "Unknown Show";
}

export function episodeTitle(title, episodeNumber) {
  const text = String(title || "Episode").trim();
  const suffixMatch = text.match(/S\d{1,2}E\d{1,2}\s+-\s+(.+)$/i);
  if (suffixMatch?.[1]) return suffixMatch[1].trim();
  const parts = text.split(" - ");
  if (parts.length > 1) {
    const candidate = parts.slice(1).join(" - ").trim();
    if (candidate && !/^S\d{1,2}E\d{1,2}$/i.test(candidate)) return candidate;
  }
  return episodeNumber ? `Episode ${String(episodeNumber).padStart(2, "0")}` : text;
}

// Resolves a watch-history entry's episode title from its stored fields,
// falling back to parsing it out of the combined "Show - S01E02 - Title"
// history title. `needsResolve` signals the caller should kick off an async
// TMDB lookup (title wasn't stored and couldn't be parsed from the row).
export function resolveEpisodeTitle(entry) {
  let epTitle = entry.episode_title;
  let needsResolve = false;
  if (!epTitle || /^Episode \d+$/i.test(String(epTitle).trim())) {
    const text = String(entry.title || "").trim();
    const suffixMatch = text.match(/S\d{1,2}E\d{1,2}\s+-\s+(.+)$/i);
    if (suffixMatch?.[1]) {
      epTitle = suffixMatch[1].trim();
    } else {
      if (!epTitle) {
        epTitle = `Episode ${entry.episode}`;
      }
      needsResolve = true;
    }
  }
  return { epTitle, needsResolve };
}

export function startOfWeek(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return startOfWeek(new Date());
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + mondayOffset);
  return date;
}

export function addDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

export function toDateInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Local "YYYY-MM-DDTHH:MM" string for <input type="datetime-local"> values.
export function toDateTimeInputValue(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${toDateInputValue(date)}T${hours}:${minutes}`;
}

export function formatDayName(value) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(value);
}

export function formatDayDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(value);
}

export function formatWeekRange(start, endExclusive) {
  const end = addDays(endExclusive, -1);
  const formatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

export function formatShortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

export function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatDateShort(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" }).format(date);
}

export function shortMonthLabel(isoMonth = "") {
  if (!isoMonth) return "";
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [year, month] = isoMonth.split("-");
  const idx = parseInt(month, 10) - 1;
  return `${monthNames[idx] || month} '${(year || "").slice(2)}`;
}

export function normalizePlatformSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (source.startsWith("emby")) return "emby";
  if (source.startsWith("jellyfin")) return "jellyfin";
  return "plex";
}

export function platformName(value) {
  const normalized = normalizePlatformSource(value);
  const text = normalized.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function platformBadge(value) {
  return platformName(value);
}

export function sourceClass(value) {
  return `source-${normalizePlatformSource(value)}`;
}

export function computeProgress(offsetMs = 0, durationMs = 0) {
  if (!durationMs) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(offsetMs || 0) / Number(durationMs || 1)) * 100)));
}

export function formatDuration(value) {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatPlaybackClock(offsetMs = 0, durationMs = 0) {
  return `${formatDuration(offsetMs)} / ${formatDuration(durationMs)}`;
}

export function formatNowPlayingMeta(session = {}) {
  const parts = [session.mediaType || "unknown"];
  if (session.season != null) parts.push(`Season ${String(session.season).padStart(2, "0")}`);
  if (session.episode != null) parts.push(`Episode ${String(session.episode).padStart(2, "0")}`);
  if (session.client?.deviceName) parts.push(session.client.deviceName);
  if (session.client?.userName) parts.push(session.client.userName);
  return parts.join(" / ");
}

export function idLine(entry) {
  const ids = [
    entry.imdb_id ? `IMDb ${entry.imdb_id}` : "",
    entry.tmdb_id ? `TMDB ${entry.tmdb_id}` : "",
    entry.tvdb_id ? `TVDB ${entry.tvdb_id}` : "",
    entry.season ? `S${String(entry.season).padStart(2, "0")}` : "",
    entry.episode ? `E${String(entry.episode).padStart(2, "0")}` : "",
  ].filter(Boolean);
  return ids.join(" / ");
}

export function csvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// ── TMDB / episode formatting helpers ────────────────────────────────────────

export function formatTmdbDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(date.getTime())) return dateStr;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function ordinalDay(day) {
  const value = Number(day) || 0;
  const suffix = (value % 100 >= 11 && value % 100 <= 13)
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[value % 10] || "th");
  return `${value}${suffix}`;
}

export function formatLongAiringDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length !== 3) return dateStr;
  const date = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(date.getTime())) return dateStr;
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  return `${ordinalDay(date.getDate())} ${month} ${date.getFullYear()}`;
}

export function knownShowAirtime(showTitle = "") {
  return String(showTitle || "").trim().toLowerCase() === "from" ? "9:00 p.m. ET" : "";
}

export function formatEpisodeAirtime(episode = {}, showTitle = "") {
  const raw = episode.airTime || episode.air_time || episode.airtime || "";
  if (!raw) return knownShowAirtime(showTitle) || "Airtime TBA";
  const text = String(raw).trim();
  if (/^\d{1,2}:\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (!Number.isNaN(date.getTime())) return formatShortTime(date);
  return text;
}

export function showEpisodeKey(seasonNumber, episodeNumber) {
  return `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;
}

export function episodeCode(seasonNumber, episodeNumber) {
  return `S${String(seasonNumber || 0).padStart(2, "0")}E${String(episodeNumber || 0).padStart(2, "0")}`;
}

export function seasonLabel(seasonNumber) {
  return `Season ${seasonNumber}`;
}
