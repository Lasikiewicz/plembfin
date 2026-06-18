import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve('data/plembfin.db');
console.log('Opening DB at:', dbPath);
const db = new Database(dbPath);

const history = db.prepare('SELECT title, show_title, media_type FROM watch_history WHERE title LIKE ? OR show_title LIKE ?').all('%hanks%', '%hanks%');
console.log('History matching hanks:', history);
