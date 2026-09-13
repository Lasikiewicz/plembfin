import { db } from "../db.js";

// Providers round and re-report positions slightly differently from what was
// written (ticks vs milliseconds, their own clamping), so an exact match is
// too strict. Two seconds is far tighter than any real viewing session that
// could plausibly stop on the seeded frame and then be reported unchanged.
const MATCH_TOLERANCE_MS = 2000;
// A seed the user never acts on should not suppress a real resume forever. A
// push refreshes its own seeds, so anything this old belongs to a queue that
// has long since moved on.
const SEED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const upsertStmt = db.prepare(`
  INSERT INTO up_next_rail_seeds (provider, provider_item_id, position_ms, duration_ms, media_key, title, seeded_at)
  VALUES (@provider, @provider_item_id, @position_ms, @duration_ms, @media_key, @title, @seeded_at)
  ON CONFLICT(provider, provider_item_id) DO UPDATE SET
    position_ms = excluded.position_ms,
    duration_ms = excluded.duration_ms,
    media_key = excluded.media_key,
    title = excluded.title,
    seeded_at = excluded.seeded_at
`);
const selectStmt = db.prepare(
  "SELECT * FROM up_next_rail_seeds WHERE provider = ? AND provider_item_id = ?",
);
const deleteStmt = db.prepare(
  "DELETE FROM up_next_rail_seeds WHERE provider = ? AND provider_item_id = ?",
);
const expireStmt = db.prepare("DELETE FROM up_next_rail_seeds WHERE seeded_at < ?");
const countStmt = db.prepare("SELECT COUNT(*) AS total FROM up_next_rail_seeds");
const selectByProviderStmt = db.prepare(
  "SELECT * FROM up_next_rail_seeds WHERE provider = ? ORDER BY seeded_at ASC",
);

function text(value = "") {
  return String(value ?? "").trim();
}

function providerOf(media = {}) {
  return text(media?.provider || media?.source).toLowerCase();
}

export function recordUpNextRailSeeds(entries = []) {
  const rows = (Array.isArray(entries) ? entries : [entries])
    .map((entry) => ({
      provider: text(entry?.provider).toLowerCase(),
      provider_item_id: text(entry?.providerItemId || entry?.provider_item_id),
      position_ms: Math.max(0, Math.round(Number(entry?.positionMs ?? entry?.position_ms) || 0)),
      duration_ms: Math.max(0, Math.round(Number(entry?.durationMs ?? entry?.duration_ms) || 0)),
      media_key: text(entry?.mediaKey || entry?.media_key) || null,
      title: text(entry?.title) || null,
      seeded_at: Date.now(),
    }))
    .filter((row) => row.provider && row.provider_item_id && row.position_ms > 0);
  if (!rows.length) return 0;
  db.transaction(() => {
    for (const row of rows) upsertStmt.run(row);
  }).immediate();
  return rows.length;
}

export function listUpNextRailSeeds(provider) {
  const name = text(provider).toLowerCase();
  if (!name) return [];
  return selectByProviderStmt.all(name).map((row) => ({
    provider: row.provider,
    providerItemId: row.provider_item_id,
    positionMs: Number(row.position_ms || 0),
    durationMs: Number(row.duration_ms || 0),
    mediaKey: row.media_key || "",
    title: row.title || "",
    seededAt: Number(row.seeded_at || 0),
  }));
}

export function forgetUpNextRailSeed(provider, providerItemId) {
  const key = text(providerItemId);
  const name = text(provider).toLowerCase();
  if (!name || !key) return false;
  return deleteStmt.run(name, key).changes > 0;
}

export function expireUpNextRailSeeds({ now = Date.now() } = {}) {
  return expireStmt.run(now - SEED_TTL_MS).changes;
}

export function countUpNextRailSeeds() {
  return Number(countStmt.get()?.total || 0);
}

// True when this provider position is the one Plembfin wrote to make the item
// visible on a calculated rail, rather than something the user actually
// watched. Used by ingestion and provider-cleanup paths that would otherwise
// treat it as real progress.
//
// A position that has moved away from the seed is a genuine play: the seed is
// forgotten so the item behaves normally from then on. This is what keeps the
// suppression from swallowing the first real resume after a seed.
export function isUpNextRailSeedPosition(provider, providerItemId, positionMs) {
  const name = text(provider).toLowerCase();
  const key = text(providerItemId);
  const position = Math.round(Number(positionMs) || 0);
  if (!name || !key || position <= 0) return false;
  let row;
  try {
    row = selectStmt.get(name, key);
  } catch {
    return false;
  }
  if (!row) return false;
  if (Date.now() - Number(row.seeded_at || 0) > SEED_TTL_MS) {
    forgetUpNextRailSeed(name, key);
    return false;
  }
  if (Math.abs(position - Number(row.position_ms || 0)) <= MATCH_TOLERANCE_MS) return true;
  forgetUpNextRailSeed(name, key);
  return false;
}

// Convenience wrapper for the ingestion paths, which hold a normalized media
// object rather than a provider/id pair.
export function mediaIsUpNextRailSeed(media = {}) {
  const provider = providerOf(media);
  if (!provider) return false;
  const providerItemId = text(media?.provider_item_id || media?.providerItemId || media?.itemId);
  const positionMs = Number(media?.positionMs ?? media?.position_ms ?? media?.offsetMs ?? media?.offset_ms ?? 0);
  return isUpNextRailSeedPosition(provider, providerItemId, positionMs);
}

export const UP_NEXT_SEED_MATCH_TOLERANCE_MS = MATCH_TOLERANCE_MS;
export const UP_NEXT_SEED_TTL_MS = SEED_TTL_MS;
