export function connectionPayloadFromElements(type, elements) {
  if (type === "plex") {
    return {
      type,
      url: elements.plexServerUrl.value.trim(),
      token: elements.plexToken.value.trim(),
    };
  }

  if (type === "emby") {
    return {
      type,
      url: elements.embyServerUrl.value.trim(),
      token: elements.embyApiKey.value.trim(),
    };
  }

  return {
    type,
    url: elements.jellyfinServerUrl.value.trim(),
    token: elements.jellyfinApiKey.value.trim(),
  };
}

export function connectionLabel(type) {
  const text = String(type || "unknown").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
