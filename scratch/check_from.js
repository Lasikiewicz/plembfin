import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve('data/plembfin.db');
const db = new Database(dbPath);

const rows = db.prepare('SELECT id, title, show_title, media_type, tmdb_id, poster_url FROM watch_history WHERE show_title = ? OR title = ?').all('From', 'From');
console.log('From rows in watch_history:', rows.length);
if (rows.length > 0) {
  rows.forEach((r, idx) => {
    console.log(`[${idx}] id: ${r.id}, title: ${r.title}, show_title: ${r.show_title}, tmdb_id: ${r.tmdb_id}, poster_url: ${r.poster_url}`);
  });
}
