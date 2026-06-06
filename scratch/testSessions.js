import { loadMediaConfig } from "../functions/src/utils/configStore.js";
import { fetchLiveSessions } from "../functions/src/utils/liveSessions.js";

async function main() {
  await import("../functions/src/firebase.js"); // trigger connection
  const config = await loadMediaConfig();
  console.log("Media Config Loaded:", {
    plex: { baseUrl: config.plex.baseUrl, username: config.plex.username, disabled: config.plex.disabled },
    emby: { baseUrl: config.emby.baseUrl, userId: config.emby.userId, disabled: config.emby.disabled },
    jellyfin: { baseUrl: config.jellyfin.baseUrl, userId: config.jellyfin.userId, disabled: config.jellyfin.disabled }
  });

  console.log("\nFetching live sessions...");
  const sessions = await fetchLiveSessions(config);
  console.log(`\nNormalized live sessions count: ${sessions.length}`);
  console.log(JSON.stringify(sessions, null, 2));

  // Also query the raw endpoints directly to see unfiltered data
  if (config.emby.baseUrl && config.emby.apiKey) {
    try {
      const url = `${config.emby.baseUrl}/Sessions?api_key=${config.emby.apiKey}`;
      const res = await fetch(url);
      const json = await res.json();
      console.log(`\nRaw Emby Sessions Count: ${json.length}`);
      console.log(JSON.stringify(json.map(s => ({
        Id: s.Id,
        UserName: s.UserName,
        UserId: s.UserId,
        DeviceName: s.DeviceName,
        AppName: s.Client,
        NowPlayingItem: s.NowPlayingItem ? { Name: s.NowPlayingItem.Name, Type: s.NowPlayingItem.Type } : null,
        PlayState: s.PlayState
      })), null, 2));
    } catch (e) {
      console.error("Failed fetching raw Emby sessions", e);
    }
  }

  if (config.jellyfin.baseUrl && config.jellyfin.apiKey) {
    try {
      const url = `${config.jellyfin.baseUrl}/Sessions`;
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `MediaBrowser Token="${config.jellyfin.apiKey}"`,
        }
      });
      const json = await res.json();
      console.log(`\nRaw Jellyfin Sessions Count: ${json.length}`);
      console.log(JSON.stringify(json.map(s => ({
        Id: s.Id,
        UserName: s.UserName,
        UserId: s.UserId,
        DeviceName: s.DeviceName,
        AppName: s.Client,
        NowPlayingItem: s.NowPlayingItem ? { Name: s.NowPlayingItem.Name, Type: s.NowPlayingItem.Type } : null,
        PlayState: s.PlayState
      })), null, 2));
    } catch (e) {
      console.error("Failed fetching raw Jellyfin sessions", e);
    }
  }
}

main().catch(console.error).then(() => process.exit(0));
