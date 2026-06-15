import { db } from "../db.js";

function encodeKey(key) {
  return Buffer.from(String(key)).toString("base64url");
}

const getStmt = db.prepare("SELECT value, expire_at FROM loop_keys WHERE id = ?");
const delStmt = db.prepare("DELETE FROM loop_keys WHERE id = ?");
const putStmt = db.prepare(
  `INSERT INTO loop_keys (id, key, value, created_at, expire_at)
   VALUES (@id, @key, @value, @created_at, @expire_at)
   ON CONFLICT(id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expire_at = excluded.expire_at`,
);

export function createLoopStore() {
  return {
    async get(key) {
      const id = encodeKey(key);
      const row = getStmt.get(id);
      if (!row) return null;
      const expires = Number(row.expire_at || 0);
      if (expires && expires < Date.now()) {
        delStmt.run(id);
        return null;
      }
      return row.value || null;
    },
    async put(key, value, options = {}) {
      const ttl = Math.max(1, Number(options.expirationTtl || 60));
      putStmt.run({
        id: encodeKey(key),
        key: String(key),
        value: String(value),
        created_at: Date.now(),
        expire_at: Date.now() + ttl * 1000,
      });
    },
  };
}
