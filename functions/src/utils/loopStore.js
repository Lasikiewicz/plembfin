import { db, Timestamp } from "../firebase.js";

function encodeKey(key) {
  return Buffer.from(String(key)).toString("base64url");
}

export function createLoopStore() {
  return {
    async get(key) {
      const doc = await db.collection("loopKeys").doc(encodeKey(key)).get();
      if (!doc.exists) return null;
      const data = doc.data() || {};
      const expires = data.expireAt?.toMillis?.() || 0;
      if (expires && expires < Date.now()) {
        await doc.ref.delete().catch(() => null);
        return null;
      }
      return data.value || null;
    },
    async put(key, value, options = {}) {
      const ttl = Math.max(1, Number(options.expirationTtl || 60));
      await db.collection("loopKeys").doc(encodeKey(key)).set({
        key,
        value: String(value),
        createdAt: Timestamp.fromMillis(Date.now()),
        expireAt: Timestamp.fromMillis(Date.now() + ttl * 1000),
      });
    },
  };
}
