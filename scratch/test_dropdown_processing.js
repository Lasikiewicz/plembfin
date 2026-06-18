import fetch from 'node-fetch';

function slug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  const token = 'e34f8be453ac9f1cdf0d2af6a174a93b8a6a17a5c7ed3690';
  const url = 'http://127.0.0.1:5055/api/tmdb-search?query=tom%20hanks&mediaType=multi';
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const body = await res.json();
  const discoveryResults = body.results || [];

  const query = "tom hanks";
  const q = query.toLowerCase();
  const results = [];

  // Simulate local data (empty for this test)
  const showsRaw = [];
  const history = [];

  const discoveryState = { loading: false, results: discoveryResults };
  for (const item of (discoveryState?.results || [])) {
    if (results.length >= 14) break;
    const mediaType = item.media_type || (item.title ? "movie" : "tv");
    if (!["movie", "tv", "person"].includes(mediaType)) {
      console.log('Skipping due to mediaType:', mediaType, item.name || item.title);
      continue;
    }

    const title = item.title || item.name || "Unknown title";
    const overview = item.overview || (item.known_for ? `Known for: ${item.known_for.map(x => x.title || x.name).filter(Boolean).join(", ")}` : "");

    const existing = results.find((result) => result._type !== "episode" && result.title.toLowerCase() === title.toLowerCase());
    if (existing) {
      console.log('Skipping existing duplicate:', title);
      if (!existing.overview && overview) {
        existing.overview = overview;
      }
      continue;
    }

    const year = (item.release_date || item.first_air_date || "").slice(0, 4);
    results.push({
      _type: mediaType === "person" ? "person" : (mediaType === "movie" ? "movie" : "show"),
      title,
      sub: mediaType === "person" ? "Cast Member" : `${mediaType === "movie" ? "Movie" : "TV Show"}${year ? ` · ${year}` : ""} · TMDB`,
      overview,
    });
  }

  console.log('Before sorting:', results.map(r => `${r._type}: ${r.title} (${r.sub})`));

  // Prioritize actor matching query at the top of dropdown
  results.sort((a, b) => {
    const aIsPersonMatch = a._type === "person" && a.title.toLowerCase() === q;
    const bIsPersonMatch = b._type === "person" && b.title.toLowerCase() === q;
    if (aIsPersonMatch && !bIsPersonMatch) return -1;
    if (!aIsPersonMatch && bIsPersonMatch) return 1;

    const aIsPersonPartial = a._type === "person" && a.title.toLowerCase().includes(q);
    const bIsPersonPartial = b._type === "person" && b.title.toLowerCase().includes(q);
    if (aIsPersonPartial && !bIsPersonPartial) return -1;
    if (!aIsPersonPartial && bIsPersonPartial) return 1;

    return 0; // Maintain original order
  });

  console.log('After sorting:', results.map(r => `${r._type}: ${r.title} (${r.sub})`));
}

main();
