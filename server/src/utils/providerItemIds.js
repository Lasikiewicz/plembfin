// A media object carries one bare `provider_item_id`: the native id of the
// provider that produced it. The same object is then handed to every outbound
// target (see clientFor/clientProgressFor in syncOrchestrator.js), so reading
// that field without checking whose id it is addresses the wrong library.
//
// This is how a Plex ratingKey reached Jellyfin's progress endpoint and failed
// with a 400. The 400 was luck: Emby and Jellyfin ids are usually 32-character
// GUIDs that cannot collide with a numeric Plex key, but Emby installations
// also issue short numeric ids, and there the same mistake is a silent,
// successful write to an unrelated title.
//
// Per-provider `provider_items` entries are always safe - they are already
// keyed by provider - and so are explicitly named aliases like `emby_id`.
// Only the unqualified field needs the source check.
const PROVIDERS = ["plex", "emby", "jellyfin"];

export function nativeProviderItemIds(media = {}, provider) {
  const target = String(provider || "").trim().toLowerCase();
  if (!target) return [];
  const configured = media?.provider_items || media?.providerItems || {};
  const raw = configured[target];
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const ids = values
    .map((value) => String(value?.id || value?.Id || value || "").trim())
    .filter(Boolean);

  for (const key of [`${target}_id`, `${target}Id`]) {
    const alias = String(media?.[key] || "").trim();
    if (alias) ids.push(alias);
  }

  // The bare id is accepted unless it can be attributed to someone else.
  // Rejecting it outright would break every caller that legitimately passes a
  // native id without naming a source, so the test is "do we have evidence
  // this id belongs to a different provider", not "did anyone vouch for it".
  const own = String(media?.provider_item_id || media?.providerItemId || "").trim();
  if (own && !ids.includes(own)) {
    const source = String(media?.provider || media?.source || "").trim().toLowerCase();
    const claimedByAnotherSource = PROVIDERS.includes(source) && source !== target;
    const listedUnderAnotherProvider = PROVIDERS.some((provider) => {
      if (provider === target) return false;
      const other = configured[provider];
      const values = Array.isArray(other) ? other : other ? [other] : [];
      return values.some((value) => String(value?.id || value?.Id || value || "").trim() === own);
    });
    if (!claimedByAnotherSource && !listedUnderAnotherProvider) ids.push(own);
  }

  return [...new Set(ids)];
}
