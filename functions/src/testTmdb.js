import { fetchPosterFromTmdb } from './utils/tmdbClient.js';
import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS = '../service-account-key.json';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const configDoc = await db.collection('settings').doc('mediaConfig').get();
const config = configDoc.data();
const tmdbApiKey = config?.tmdb?.apiKey;

console.log('TMDB API Key:', tmdbApiKey);

const testRows = [
  {
    title: "Trying - S04E08",
    media_type: "episode",
    imdb_id: "tt30290761",
    tvdb_id: "10385528",
    tmdb_id: null
  },
  {
    title: "School Spirits - S02E08",
    media_type: "episode",
    imdb_id: "tt32567382",
    tvdb_id: "10931640",
    tmdb_id: null
  },
  {
    title: "Dimension 20 - S27E03",
    media_type: "episode",
    imdb_id: null,
    tvdb_id: "11546765",
    tmdb_id: null
  }
];

for (const row of testRows) {
  console.log(`\nTesting: "${row.title}"`);
  try {
    const posterUrl = await fetchPosterFromTmdb(row, tmdbApiKey);
    console.log(`Result posterUrl:`, posterUrl);
  } catch (error) {
    console.error(`Error:`, error);
  }
}
process.exit(0);
