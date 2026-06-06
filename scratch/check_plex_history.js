import { loadMediaConfig } from "../functions/src/utils/configStore.js";
import { db } from "../functions/src/firebase.js";
import process from "node:process";

// Configure Firebase Credentials
import fs from "node:fs/promises";
import path from "node:path";
const candidate = path.resolve("service-account-key.json");
try {
  await fs.access(candidate);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = candidate;
} catch {}

async function checkPlex() {
  const config = await loadMediaConfig();
  const plex = config.plex;
  if (!plex?.baseUrl || !plex?.token) {
    console.log("No Plex config found");
    return;
  }
  
  const baseUrl = plex.baseUrl.replace(/\/+$/, "");
  const token = plex.token;
  
  const url = new URL(`${baseUrl}/status/sessions/history/all`);
  url.searchParams.set("X-Plex-Token", token);
  url.searchParams.set("X-Plex-Container-Start", "0");
  url.searchParams.set("X-Plex-Container-Size", "100");
  url.searchParams.set("sort", "viewedAt:desc");
  
  console.log("Fetching Plex history...");
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error(`Plex API failed: ${res.status}`);
    return;
  }
  
  const data = await res.json();
  const items = data?.MediaContainer?.Metadata || [];
  console.log(`Found ${items.length} items in recent Plex history:`);
  const staleShows = ["The Testaments", "A Thousand Blows", "The Good Doctor"];
  let count = 0;
  for (const item of items) {
    const title = item.title || item.grandparentTitle || "";
    if (staleShows.some(s => title.toLowerCase().includes(s.toLowerCase()))) {
      count++;
      const viewedAtDate = item.viewedAt ? new Date(item.viewedAt * 1000).toISOString() : "unknown";
      console.log(`- MATCHED Title: ${title} | Season: ${item.parentIndex} | Episode: ${item.index} | ViewedAt: ${viewedAtDate} | AccountID: ${item.accountID}`);
    }
  }
  console.log(`Total matched items printed: ${count}`);
}

checkPlex().catch(console.error);
