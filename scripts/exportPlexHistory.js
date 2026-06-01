const PLEX_URL = "https://plex.lasikie.co.uk";
const PLEX_TOKEN = "eL3Yeq_SXJWj-r15zzzc";
const ADMIN_TOKEN = "eyJhbGciOiJSUzI1NiIsImtpZCI6Ijg1NGFhNGMyM2VkZTdiOGNhODc1OWZiMDZlNmExZDU4OTI0MjVkMDYiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vcGxlbWJmaW4iLCJhdWQiOiJwbGVtYmZpbiIsImF1dGhfdGltZSI6MTc4MDMwOTkzMiwidXNlcl9pZCI6InBOZ2hKQlByVm1aV0Fna0JHOW93V093T094MTMiLCJzdWIiOiJwTmdoSkJQclZtWldBZ2tCRzlvd1dPd09PeDEzIiwiaWF0IjoxNzgwMzA5OTMzLCJleHAiOjE3ODAzMTM1MzMsImVtYWlsIjoibGFzaWtpZUBob3RtYWlsLmNvLnVrIiwiZW1haWxfdmVyaWZpZWQiOmZhbHNlLCJmaXJlYmFzZSI6eyJpZGVudGl0aWVzIjp7ImVtYWlsIjpbImxhc2lraWVAaG90bWFpbC5jby51ayJdfSwic2lnbl9pbl9wcm92aWRlciI6InBhc3N3b3JkIn19.JpumEH0CkfXJxK30I_dsVtCLGbQqEFSU9rdXp4bwbUTnos_MMVbOTVdWJaYUMjBID9tKRqpUkfhmoiwhixBgzqBlIPPicCkRBPMIhHC6RQ4cTDkmGF_Qiig0B34OOvltTXmX4CmuW6cRsJfTeXXkT1lThjVm5zpfmPZCjQHUz0OoIeQJbv3ByoQY59YNasE_kvd1ifuEg8vM8uqn89o2Z6zDPuN1smZ67zcXPIHftNomRe3kEkbg7ffhx7saHlriWFqvQ2UXhPeG7jxDP2PjDd8eJDhk7415C0TtsR02spYeo3unPJLQMaBpCshIK_2KbkzvJ3Fs71JoqHbk8J-1QA";
const IMPORT_ENDPOINT = "http://localhost:5000/api/import";
const CHUNK_SIZE = 100;

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function plexUrl(path) {
  const url = new URL(`${trimTrailingSlash(PLEX_URL)}${path}`);
  url.searchParams.set("X-Plex-Token", PLEX_TOKEN);
  return url;
}

function posterUrl(item = {}, type = "movie") {
  // Return empty string to force the importer to fetch high-quality canonical TMDB posters
  return "";
}

async function plexJson(path) {
  const response = await fetch(plexUrl(path), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Plex request failed ${response.status} for ${path}`);
  }

  return response.json();
}

function providerIds(item = {}) {
  const ids = { imdb_id: "", tmdb_id: "", tvdb_id: "" };
  const rawGuids = [
    item.guid,
    ...(Array.isArray(item.Guid) ? item.Guid.map((guid) => guid.id || guid) : []),
  ].filter(Boolean);

  for (const rawGuid of rawGuids) {
    const guid = String(rawGuid);
    const value = guid.split(/:\/\/|\//).pop();
    if (guid.includes("imdb")) ids.imdb_id = value;
    if (guid.includes("tmdb") || guid.includes("themoviedb")) ids.tmdb_id = value;
    if (guid.includes("tvdb") || guid.includes("thetvdb")) ids.tvdb_id = value;
  }

  return ids;
}

function watchedAt(item = {}) {
  if (item.lastViewedAt) return new Date(Number(item.lastViewedAt) * 1000).toISOString();
  if (item.viewedAt) return new Date(Number(item.viewedAt) * 1000).toISOString();
  return "";
}

function movieRecord(item) {
  const watched = watchedAt(item);
  if (!watched) return undefined;

  return {
    title: item.title || "Unknown Movie",
    media_type: "movie",
    watched_at: watched,
    source: "plex_initial_sync",
    poster_url: posterUrl(item, "movie"),
    ...providerIds(item),
  };
}

function episodeRecord(item) {
  const show = item.grandparentTitle || "Unknown Show";
  const season = Number(item.parentIndex) || "";
  const episode = Number(item.index) || "";
  const title = `${show} - S${String(season || "?").padStart(2, "0")}E${String(episode || "?").padStart(2, "0")}`;
  const watched = watchedAt(item);
  if (!watched) return undefined;

  return {
    title,
    media_type: "episode",
    watched_at: watched,
    source: "plex_initial_sync",
    season,
    episode,
    poster_url: posterUrl(item, "episode"),
    ...providerIds(item),
  };
}

async function uploadChunk(records, chunkNumber, totalChunks) {
  const response = await fetch(IMPORT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chunk ${chunkNumber}/${totalChunks} failed: ${body.error || response.status}`);
  }

  console.log(`Uploaded chunk ${chunkNumber}/${totalChunks}: ${body.inserted || 0} inserted`);
}

async function main() {
  console.log("Fetching play history from Plex status sessions history endpoint...");
  const records = [];
  const pageSize = 500;
  let start = 0;
  let hasMore = true;
  let lastFirstItemKey = null;

  while (hasMore) {
    const url = `/status/sessions/history/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`;
    const body = await plexJson(url);
    const items = body.MediaContainer?.Metadata || [];
    if (!items.length) {
      hasMore = false;
      break;
    }

    const firstItemKey = items[0]?.historyKey || items[0]?.viewedAt;
    if (firstItemKey && firstItemKey === lastFirstItemKey) {
      console.log("Pagination ignored by Plex server (received duplicate data). Stopping query loop.");
      break;
    }
    lastFirstItemKey = firstItemKey;

    for (const item of items) {
      if (item.type === "movie") {
        const record = movieRecord(item);
        if (record) records.push(record);
      } else if (item.type === "episode") {
        const record = episodeRecord(item);
        if (record) records.push(record);
      }
    }

    console.log(`Retrieved ${records.length} total watch history events so far...`);
    start += pageSize;
  }

  console.log(`Found ${records.length} watched Plex records in history`);
  const totalChunks = Math.ceil(records.length / CHUNK_SIZE);

  for (let index = 0; index < records.length; index += CHUNK_SIZE) {
    const chunk = records.slice(index, index + CHUNK_SIZE);
    await uploadChunk(chunk, Math.floor(index / CHUNK_SIZE) + 1, totalChunks);
  }

  console.log("Plex history export complete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
