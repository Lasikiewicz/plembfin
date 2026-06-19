import fs from "node:fs";
import Database from "better-sqlite3";

const dbPath = "c:\\Github\\plembfin\\data\\plembfin.db";
const db = new Database(dbPath);

const settingsRow = db.prepare("SELECT data FROM settings LIMIT 1").get();
const settings = JSON.parse(settingsRow.data);
const seerr = settings.seerr || {};

const headers = { "X-Api-Key": seerr.apiKey, Accept: "application/json" };

async function checkSeerrStatus(tmdbId, title) {
  const paths = [
    `/api/v1/media/movie/${tmdbId}`,
    `/api/v1/movie/${tmdbId}`,
  ];
  console.log(`\n=== Checking Seerr status for: ${title} (TMDB ID: ${tmdbId}) ===`);
  for (const path of paths) {
    const url = `${seerr.baseUrl.replace(/\/+$/, "")}${path}`;
    try {
      const res = await fetch(url, { headers });
      const body = await res.json().catch(() => ({}));
      console.log(`Path: ${path} | HTTP Status: ${res.status}`);
      if (res.ok) {
        if (body.mediaInfo) {
          console.log("mediaInfo status:", {
            status: body.mediaInfo.status,
            status4k: body.mediaInfo.status4k,
            available: body.mediaInfo.available,
            available4k: body.mediaInfo.available4k,
            requestsCount: body.mediaInfo.requests?.length,
          });
        } else {
          console.log("body properties:", {
            status: body.status,
            status4k: body.status4k,
            mediaStatus: body.mediaStatus,
            mediaStatus4k: body.mediaStatus4k,
            available: body.available,
            available4k: body.available4k,
          });
        }
      } else {
        console.log("Error response body:", body);
      }
    } catch (e) {
      console.error("Fetch error:", e.message);
    }
  }
}

async function run() {
  await checkSeerrStatus(4978, "An American Tail");
  // Spider-Man: Across the Spider-Verse TMDB ID is 569094
  await checkSeerrStatus(569094, "Spider-Man: Across the Spider-Verse");
}

run();
