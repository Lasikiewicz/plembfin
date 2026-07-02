import { db, parseJson, toJson } from "../db.js";
import { fetchWithTimeout } from "./outbound.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const getStmt = db.prepare("SELECT data, updated_at_ms FROM omdb_cache WHERE id = ?");
const setStmt = db.prepare(
  `INSERT INTO omdb_cache (id, data, updated_at_ms) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at_ms = excluded.updated_at_ms`,
);

export async function getOmdbRating(imdbId, apiKey) {
  if (!imdbId || !apiKey) return null;

  const cached = getStmt.get(imdbId);
  if (cached && Date.now() - cached.updated_at_ms < TTL_MS) {
    return parseJson(cached.data);
  }

  const url = `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`OMDb API error: ${res.status}`);
  const data = await res.json();

  if (data.Response === "False") {
    setStmt.run(imdbId, toJson({ error: data.Error }), Date.now());
    return null;
  }

  const result = {
    imdbRating: data.imdbRating !== "N/A" ? data.imdbRating : null,
    imdbVotes: data.imdbVotes !== "N/A" ? data.imdbVotes : null,
  };
  setStmt.run(imdbId, toJson(result), Date.now());
  return result;
}
