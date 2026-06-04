import admin from 'firebase-admin';

process.env.GOOGLE_APPLICATION_CREDENTIALS = '../service-account-key.json';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const snapshot = await db.collection('watchHistory')
  .where('source', '==', 'plex')
  .get();

console.log('PLEX_DOCS_START');
const docs = snapshot.docs.map(doc => {
  const data = doc.data();
  return {
    id: doc.id,
    title: data.title,
    mediaType: data.mediaType,
    source: data.source,
    watchedAt: data.watchedAt,
    posterUrl: data.posterUrl,
    ids: data.ids,
    syncDispatchTelemetry: data.syncDispatchTelemetry
  };
});

// Sort in-memory
docs.sort((a, b) => b.watchedAt.localeCompare(a.watchedAt));

docs.slice(0, 5).forEach(d => console.log(JSON.stringify(d, null, 2)));
console.log('PLEX_DOCS_END');
process.exit(0);
