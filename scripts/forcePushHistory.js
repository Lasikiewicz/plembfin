import { markPlexPlayed } from "../functions/src/utils/plexClient.js";
import { markEmbyPlayed } from "../functions/src/utils/embyClient.js";
import { markJellyfinPlayed } from "../functions/src/utils/jellyfinClient.js";


const HISTORY_ENDPOINT = "http://localhost:5000/api/history?limit=25000";
const ADMIN_TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijg1NGFhNGMyM2VkZTdiOGNhODc1OWZiMDZlNmExZDU4OTI0MjVkMDYiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vcGxlbWJmaW4iLCJhdWQiOiJwbGVtYmZpbiIsImF1dGhfdGltZSI6MTc4MDMwOTkzMiwidXNlcl9pZCI6InBOZ2hKQlByVm1aV0Fna0JHOW93V093T094MTMiLCJzdWIiOiJwTmdoSkJQclZtWldBZ2tCRzlvd1dPd09PeDEzIiwiaWF0IjoxNzgwMzA5OTMzLCJleHAiOjE3ODAzMTM1MzMsImVtYWlsIjoibGFzaWtpZUBob3RtYWlsLmNvLnVrIiwiZW1haWxfdmVyaWZpZWQiOmZhbHNlLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7ImVtYWlsIjpbImxhc2lraWVAaG90bWFpbC5jby51ayJdfSwic2lnbl9pbl9wcm92aWRlciI6InBhc3N3b3JkIn19.JpumEH0CkfXJxK30I_dsVtCLGbQqEFSU9rdXp4bwbUTnos_MMVbOTVdWJaYUMjBID9tKRqpUkfhmoiwhixBgzqBlIPPicCkRBPMIhHC6RQ4cTDkmGF_Qiig0B34OOvltTXmX4CmuW6cRsJfTeXXkT1lThjVm5zpfmPZCjQHUz0OoIeQJbv3ByoQY59YNasE_kvd1ifuEg8vM8uqn89o2Z6zDPuN1smZ67zcXPIHftNomRe3kEkbg7ffhx7saHlriWFqvQ2UXhPeG7jxDP2PjDd8eJDhk7415C0TtsR02spYeo3unPJLQMaBpCshIK_2KbkzvJ3Fs71JoqHbk8J-1QA";

const TARGET_CONFIG = {
  plex: {
    baseUrl: "https://plex.lasikie.co.uk",
    token: "eL3Yeq_SXJWj-r15zzzc",
  },
  emby: {
    baseUrl: "https://emby.example.com",
    apiKey: "6b2e97f331174373ab74eee4d8925166",
    userId: "dcacc7a88e134bb0a9183a11416ebd3c",
  },
  jellyfin: {
    baseUrl: "https://jellyfin.example.com",
    apiKey: "1d5c6eeb685c4980933c7cd16d7e6bb4",
    userId: "1ef4842933a44161a3641abfb9e78b3c",
  },
};

const ROW_DELAY_MS = 150;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMasterHistory() {
  const response = await fetch(HISTORY_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      Accept: "application/json",
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`History download failed: ${body.error || response.status}`);
  }

  if (!Array.isArray(body.history)) {
    throw new Error("History API did not return a history array");
  }

  return body.history;
}

function cleanShowTitleForDeduplication(title) {
  const str = String(title || "");
  const regex = /(?:\s*-\s*|\s+)S(\d+)E(\d+)/i;
  const match = str.match(regex);
  if (match) {
    return str.slice(0, match.index).replace(/\s*-\s*$/, "").trim();
  }
  return str.replace(/\s*-\s*$/, "").trim();
}

function getCompositeKey(row) {
  const type = String(row.media_type || "").toLowerCase();
  const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  if (type === "movie") {
    if (row.imdb_id) return `movie:imdb:${row.imdb_id}`;
    if (row.tmdb_id) return `movie:tmdb:${row.tmdb_id}`;
    if (row.tvdb_id) return `movie:tvdb:${row.tvdb_id}`;
    return `movie:title:${normalize(row.title)}`;
  } else {
    const s = row.season == null ? "?" : Number(row.season);
    const e = row.episode == null ? "?" : Number(row.episode);

    if (row.imdb_id) return `episode:imdb:${row.imdb_id}:s${s}e${e}`;
    if (row.tmdb_id) return `episode:tmdb:${row.tmdb_id}:s${s}e${e}`;
    if (row.tvdb_id) return `episode:tvdb:${row.tvdb_id}:s${s}e${e}`;

    const baseTitle = cleanShowTitleForDeduplication(row.title);
    return `episode:title:${normalize(baseTitle)}:s${s}e${e}`;
  }
}

function deduplicateHistory(history) {
  const seen = new Set();
  const unique = [];

  for (const row of history) {
    const key = getCompositeKey(row);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }

  return unique;
}

function mediaFromHistoryRow(row) {
  return {
    title: row.title,
    type: row.media_type,
    source: row.source,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
    season: row.season == null ? undefined : Number(row.season),
    episode: row.episode == null ? undefined : Number(row.episode),
    isValid: Boolean(row.title && row.media_type),
  };
}

async function pushToTarget(target, media) {
  if (target === "plex") return markPlexPlayed(TARGET_CONFIG.plex, media);
  if (target === "emby") return markEmbyPlayed(TARGET_CONFIG.emby, media);
  if (target === "jellyfin") return markJellyfinPlayed(TARGET_CONFIG.jellyfin, media);
  throw new Error(`Unknown target: ${target}`);
}

async function pushRow(row, index, total) {
  let jellyfinItemId = null;
  let embyItemId = null;
  let plexRatingKey = null;
  let seriesId = null;

  // Example Explicit Loop Sanitization
  jellyfinItemId = null;
  embyItemId = null;
  plexRatingKey = null;
  seriesId = null;

  const media = mediaFromHistoryRow(row);
  const targets = ["plex", "emby", "jellyfin"];
  const results = [];

  for (const target of targets) {
    try {
      const result = await pushToTarget(target, media);
      if (result && result.status === "fulfilled" && result.itemId) {
        if (target === "plex") plexRatingKey = result.itemId;
        if (target === "emby") embyItemId = result.itemId;
        if (target === "jellyfin") jellyfinItemId = result.itemId;
      }
      results.push(`${target}: ${result.status === "not_found" ? "not found" : "success"}`);
    } catch (error) {
      results.push(`${target}: error (${error.message})`);
    }
  }

  console.log(`[SYNCING] ${index} / ${total} - '${media.title}' pushed to ${results.join(", ")}.`);
}

async function main() {
  console.log("Downloading master D1 history...");
  const rawHistory = await fetchMasterHistory();

  const formattedRaw = rawHistory.length.toLocaleString("en-US");
  console.log(`  Downloaded ${formattedRaw} history logs.`);

  const cleanHistory = deduplicateHistory(rawHistory);
  const formattedClean = cleanHistory.length.toLocaleString("en-US");
  console.log(`  ✔ Cleaned database array: Isolate ${formattedClean} unique media assets to sync.`);
  console.log("  Starting force-push sync...");

  for (let index = 0; index < cleanHistory.length; index += 1) {
    await pushRow(cleanHistory[index], index + 1, cleanHistory.length);
    await delay(ROW_DELAY_MS);
  }

  console.log("Force-push history sync complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
