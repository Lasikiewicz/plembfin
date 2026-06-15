import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { db, bumpDataVersion } from '../server/src/db.js';
import { POSTERS_DIR } from '../server/src/paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

const movies = [
  { slug: 'signal-drift', title: 'Signal Drift', daysAgo: 1, color: '#1c6675', accent: '#75d6de' },
  { slug: 'glass-horizon', title: 'Glass Horizon', daysAgo: 3, color: '#744c32', accent: '#f0b66d' },
  { slug: 'after-last-train', title: 'After the Last Train', daysAgo: 5, color: '#4a3d70', accent: '#bd9ef2' },
  { slug: 'static-bloom', title: 'Static Bloom', daysAgo: 7, color: '#755050', accent: '#f4a3a3' },
  { slug: 'quiet-engine', title: 'The Quiet Engine', daysAgo: 10, color: '#3f6347', accent: '#9dd4a4' },
  { slug: 'northern-relay', title: 'Northern Relay', daysAgo: 13, color: '#385a76', accent: '#9bc8ed' },
];

const shows = [
  {
    slug: 'harbor-nine',
    title: 'Harbor Nine',
    color: '#155d68',
    accent: '#79d5d9',
    episodes: ['The Fog Bell', 'Low Tide', 'False Beacon', 'Open Water'],
  },
  {
    slug: 'midnight-archive',
    title: 'Midnight Archive',
    color: '#533b69',
    accent: '#c6a1e4',
    episodes: ['The Missing Reel', 'Room 17', 'Dead Air', 'Final Cut'],
  },
];

function isoAt(daysAgo, hourOffset = 0) {
  return new Date(now - (daysAgo * DAY_MS) - (hourOffset * 60 * 60 * 1000)).toISOString();
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function titleLines(title, maxLength = 15) {
  const lines = [];
  let line = '';
  for (const word of title.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && next.length > maxLength) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

async function createPoster(item) {
  const hash = crypto.createHash('sha1').update(item.mediaKey).digest('hex');
  const filename = `${hash}.webp`;
  const storagePath = path.join('posters', filename).replaceAll('\\', '/');
  const absolutePath = path.join(POSTERS_DIR, filename);
  const lines = titleLines(item.posterTitle || item.title);
  const lineHeight = 88;
  const titleTop = 650 - ((lines.length - 1) * lineHeight / 2);
  const titleMarkup = lines.map((line, index) => (
    `<text x="64" y="${titleTop + (index * lineHeight)}" fill="#f8fafc" font-family="Arial, sans-serif" font-size="72" font-weight="700">${xmlEscape(line)}</text>`
  )).join('');
  const subtitle = item.mediaType === 'episode'
    ? `SEASON ${item.season} / EPISODE ${item.episode}`
    : 'DEMO FEATURE';
  const svg = `
    <svg width="680" height="1020" viewBox="0 0 680 1020" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${item.color}" />
          <stop offset="1" stop-color="#0b1017" />
        </linearGradient>
        <radialGradient id="glow" cx="75%" cy="18%" r="70%">
          <stop offset="0" stop-color="${item.accent}" stop-opacity="0.65" />
          <stop offset="1" stop-color="${item.accent}" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="680" height="1020" fill="url(#background)" />
      <rect width="680" height="1020" fill="url(#glow)" />
      <circle cx="520" cy="210" r="145" fill="none" stroke="${item.accent}" stroke-width="3" opacity="0.55" />
      <circle cx="520" cy="210" r="98" fill="none" stroke="#ffffff" stroke-width="2" opacity="0.25" />
      <path d="M0 430 L680 180 L680 360 L0 610 Z" fill="${item.accent}" opacity="0.12" />
      <text x="64" y="82" fill="${item.accent}" font-family="Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="5">PLEMBFIN TEST LIBRARY</text>
      ${titleMarkup}
      <text x="64" y="940" fill="${item.accent}" font-family="Arial, sans-serif" font-size="24" font-weight="700" letter-spacing="3">${subtitle}</text>
      <rect x="64" y="964" width="112" height="6" rx="3" fill="${item.accent}" />
    </svg>`;

  await sharp(Buffer.from(svg)).webp({ quality: 86 }).toFile(absolutePath);
  return {
    cacheId: hash,
    storagePath,
    url: `/media/posters/${filename}`,
    sizeBytes: fs.statSync(absolutePath).size,
  };
}

function buildItems() {
  const movieItems = movies.map((movie, index) => ({
    ...movie,
    id: `demo:movie:${movie.slug}`,
    mediaKey: `demo:movie:${movie.slug}`,
    mediaType: 'movie',
    watchedAt: isoAt(movie.daysAgo, index),
  }));

  const episodeItems = shows.flatMap((show, showIndex) => show.episodes.map((episodeTitle, index) => ({
    ...show,
    id: `demo:episode:${show.slug}:1:${index + 1}`,
    mediaKey: `demo:episode:${show.slug}:1:${index + 1}`,
    mediaType: 'episode',
    title: `${show.title} - ${episodeTitle}`,
    posterTitle: show.title,
    showTitle: show.title,
    episodeTitle,
    season: 1,
    episode: index + 1,
    watchedAt: isoAt((showIndex * 4) + index + 1, 2 + index),
  })));

  return [...movieItems, ...episodeItems];
}

async function main() {
  fs.mkdirSync(POSTERS_DIR, { recursive: true });
  const items = buildItems();

  for (const item of items) {
    item.poster = await createPoster(item);
  }

  const clearDemoData = db.transaction(() => {
    db.prepare("DELETE FROM watch_history WHERE id LIKE 'demo:%'").run();
    db.prepare("DELETE FROM playstate WHERE media_key LIKE 'demo:%'").run();
    db.prepare("DELETE FROM playback_progress WHERE media_key LIKE 'demo:%'").run();
    db.prepare("DELETE FROM active_sessions WHERE id LIKE 'demo:%'").run();
    db.prepare("DELETE FROM poster_cache WHERE media_key LIKE 'demo:%'").run();
    db.prepare("DELETE FROM sync_history WHERE source = 'demo'").run();
  });
  clearDemoData();

  const insertHistory = db.prepare(`
    INSERT INTO watch_history (
      id, title, title_lower, media_type, watched_at, source, season, episode,
      poster_url, sync_action, sync_dispatch_telemetry, media_key, show_title,
      show_title_lower, episode_title, created_at, updated_at
    ) VALUES (
      @id, @title, @titleLower, @mediaType, @watchedAt, 'demo', @season, @episode,
      @posterUrl, 'watched', @telemetry, @mediaKey, @showTitle,
      @showTitleLower, @episodeTitle, @createdAt, @updatedAt
    )
  `);
  const insertPlaystate = db.prepare(`
    INSERT INTO playstate (
      media_key, title, title_lower, media_type, state, watched_at, last_source,
      sources, season, episode, poster_url, updated_at
    ) VALUES (
      @mediaKey, @title, @titleLower, @mediaType, 'watched', @watchedAt, 'demo',
      @sources, @season, @episode, @posterUrl, @updatedAt
    )
  `);
  const insertPoster = db.prepare(`
    INSERT INTO poster_cache (
      id, media_key, variant, status, source, detail, storage_path, content_type,
      size_bytes, url, updated_at_ms
    ) VALUES (
      @id, @mediaKey, 'poster', 'cached', 'demo', 'Generated local demo artwork',
      @storagePath, 'image/webp', @sizeBytes, @url, @updatedAt
    )
  `);

  const insertItems = db.transaction((seedItems) => {
    for (const item of seedItems) {
      const titleLower = item.title.toLowerCase();
      const showTitle = item.showTitle || null;
      insertHistory.run({
        id: item.id,
        title: item.title,
        titleLower,
        mediaType: item.mediaType,
        watchedAt: item.watchedAt,
        season: item.season || null,
        episode: item.episode || null,
        posterUrl: item.poster.url,
        telemetry: 'Origin: demo seed\nDispatch status: success',
        mediaKey: item.mediaKey,
        showTitle,
        showTitleLower: showTitle ? showTitle.toLowerCase() : null,
        episodeTitle: item.episodeTitle || null,
        createdAt: Date.parse(item.watchedAt),
        updatedAt: now,
      });
      insertPlaystate.run({
        mediaKey: item.mediaKey,
        title: item.title,
        titleLower,
        mediaType: item.mediaType,
        watchedAt: item.watchedAt,
        sources: JSON.stringify({ demo: { state: 'watched', watchedAt: item.watchedAt } }),
        season: item.season || null,
        episode: item.episode || null,
        posterUrl: item.poster.url,
        updatedAt: now,
      });
      insertPoster.run({
        id: item.poster.cacheId,
        mediaKey: item.mediaKey,
        storagePath: item.poster.storagePath,
        sizeBytes: item.poster.sizeBytes,
        url: item.poster.url,
        updatedAt: now,
      });
    }
  });
  insertItems(items);

  const progressItems = [items[0], items.find((item) => item.id === 'demo:episode:harbor-nine:1:4')];
  const progressValues = [46, 71];
  const insertProgress = db.prepare(`
    INSERT INTO playback_progress (
      media_key, title, media_type, source, season, episode, position_ms,
      duration_ms, progress, updated_at, sync_dispatch_telemetry
    ) VALUES (
      @mediaKey, @title, @mediaType, 'demo', @season, @episode, @positionMs,
      3600000, @progress, @updatedAt, 'Origin: demo seed'
    )
  `);
  progressItems.forEach((item, index) => insertProgress.run({
    mediaKey: item.mediaKey,
    title: item.title,
    mediaType: item.mediaType,
    progress: progressValues[index],
    positionMs: Math.round(3600000 * progressValues[index] / 100),
    season: item.season || null,
    episode: item.episode || null,
    updatedAt: now - ((index + 1) * 60 * 60 * 1000),
  }));

  const activeItem = items.find((item) => item.id === 'demo:episode:midnight-archive:1:4');
  db.prepare(`
    INSERT INTO active_sessions (
      id, title, media_type, source, progress, offset_ms, duration_ms, season,
      episode, poster_url, ids, event, client, updated_at, expire_at
    ) VALUES (
      'demo:session:living-room', @title, @mediaType, 'demo', 38, 1368000,
      3600000, @season, @episode, @posterUrl, @ids, 'play', @client,
      @updatedAt, @expireAt
    )
  `).run({
    title: activeItem.title,
    mediaType: activeItem.mediaType,
    posterUrl: activeItem.poster.url,
    season: activeItem.season,
    episode: activeItem.episode,
    ids: JSON.stringify({ mediaKey: activeItem.mediaKey }),
    client: JSON.stringify({ name: 'Living Room', user: 'Demo User' }),
    updatedAt: now,
    expireAt: now + (2 * 60 * 60 * 1000),
  });

  db.prepare(`
    INSERT INTO sync_history (
      timestamp, media_type, title, source, status, details, action, created_at
    ) VALUES (
      @timestamp, 'library', @title, 'demo', 'success', @details, 'seed', @createdAt
    )
  `).run({
    timestamp: now,
    title: 'Demo test library',
    details: `Generated ${items.length} local demo records`,
    createdAt: now,
  });

  bumpDataVersion();
  db.close();
  console.log(`Seeded ${movies.length} movies and ${items.length - movies.length} TV episodes.`);
  console.log(`Generated ${items.length} local posters in ${POSTERS_DIR}.`);
}

main().catch((error) => {
  console.error('Failed to seed demo content:', error);
  try { db.close(); } catch {}
  process.exitCode = 1;
});
