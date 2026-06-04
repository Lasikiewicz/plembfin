import admin from 'firebase-admin';

// Set credentials relative to functions directory
process.env.GOOGLE_APPLICATION_CREDENTIALS = '../service-account-key.json';

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const doc = await db.collection('settings').doc('mediaConfig').get();
if (doc.exists) {
  console.log('CONFIG_JSON_START');
  console.log(JSON.stringify(doc.data(), null, 2));
  console.log('CONFIG_JSON_END');
} else {
  console.log('Document settings/mediaConfig does not exist.');
}
process.exit(0);
