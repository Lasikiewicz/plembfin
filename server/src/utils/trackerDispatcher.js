import { getTrackerConnection, recordTrackerOutbound, updateTrackerConnectionStatus, updateTrackerTokens } from "./trackerConnectionRepo.js";
import { refreshTraktToken, setTraktWatchState, trackerMediaKey } from "./traktClient.js";
import { hydrateTraktAppCredentials } from "./traktAppConfig.js";

let traktRefreshInFlight = null;

function tokenExpiry(tokens) {
  const created = Number(tokens.created_at || Math.floor(Date.now() / 1000));
  return (created + Number(tokens.expires_in || 604800)) * 1000;
}

export async function withFreshTraktConnection(force = false) {
  let connection = getTrackerConnection("trakt", { includeCredentials: true });
  if (!connection || connection.status !== "connected") return null;
  connection = hydrateTraktAppCredentials(connection);
  if (!force && Number(connection.accessTokenExpiresAt || 0) > Date.now() + 5 * 60_000) return connection;
  if (!traktRefreshInFlight) {
    traktRefreshInFlight = refreshTraktToken(connection)
      .then((tokens) => {
        updateTrackerTokens("trakt", { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessTokenExpiresAt: tokenExpiry(tokens) });
      })
      .catch((error) => {
        updateTrackerConnectionStatus("trakt", { status: error.status === 400 || error.status === 401 ? "reauth_required" : "connected", lastError: error.message });
        throw error;
      })
      .finally(() => { traktRefreshInFlight = null; });
  }
  await traktRefreshInFlight;
  connection = getTrackerConnection("trakt", { includeCredentials: true });
  return hydrateTraktAppCredentials(connection);
}

async function dispatchTrakt(media, state) {
  let connection = await withFreshTraktConnection();
  if (!connection) return { target: "trakt", status: "skipped", detail: "Trakt is not connected" };
  if (String(media.source || "").toLowerCase() === "trakt") return { target: "trakt", status: "skipped", detail: "Source tracker echo suppressed" };
  try {
    await setTraktWatchState(connection, media, state);
  } catch (error) {
    if (error.status !== 401) throw error;
    connection = await withFreshTraktConnection(true);
    await setTraktWatchState(connection, media, state);
  }
  const mediaKey = trackerMediaKey(media);
  recordTrackerOutbound("trakt", mediaKey, media, state);
  return { target: "trakt", status: "success", detail: `Marked ${state} on Trakt` };
}

export async function dispatchTrackerWatchState(media, state) {
  const connection = getTrackerConnection("trakt");
  if (!connection || connection.status === "disabled") return [];
  try {
    return [await dispatchTrakt(media, state)];
  } catch (error) {
    updateTrackerConnectionStatus("trakt", { lastError: error.message });
    const status = error.code === "not_found" ? "not_found" : "failed";
    return [{ target: "trakt", status, detail: error.message || String(error) }];
  }
}

export function traktTokenExpiry(tokens) {
  return tokenExpiry(tokens);
}
