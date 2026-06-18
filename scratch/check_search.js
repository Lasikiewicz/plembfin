import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve('data/plembfin.db');
console.log('Opening DB at:', dbPath);
const db = new Database(dbPath);

const rows = db.prepare('SELECT id, query, media_type, page, missing, updated_at_ms, response FROM tmdb_search_cache').all();
console.log('Total cached queries:', rows.length);
for (const r of rows) {
  if (r.query.toLowerCase().includes('hanks')) {
    console.log(`Query: "${r.query}", ID: ${r.id}, Media Type: ${r.media_type}, Missing: ${r.missing}`);
    try {
      const resp = JSON.parse(r.response);
      console.log(`Results count: ${resp.results?.length}`);
      if (resp.results) {
        resp.results.forEach((item, index) => {
          console.log(`  [${index}] name/title: "${item.name || item.title}", type: "${item.media_type}", id: ${item.id}`);
        });
      }
    } catch (e) {
      console.log('Failed to parse response:', e);
    }
  }
}
