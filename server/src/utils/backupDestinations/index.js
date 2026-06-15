// Pluggable remote backup destinations. Each adapter exposes the same contract so
// the backup lifecycle in watchHistoryBackups.js can treat every target uniformly:
//
//   testConnection()              -> { ok, detail }
//   upload(localPath, remoteName) -> { bytes, durationMs }
//   list()                        -> [{ name, sizeBytes, createdAt }]
//   download(remoteName)          -> Buffer        (used to restore from a remote)
//   delete(remoteName)            -> void
//
// Adapters receive the full destination record ({ id, type, label, settings, secrets })
// plus a `persistSecrets(partial)` callback used to write back rotated OAuth refresh
// tokens. Everything goes over the global fetch (undici) — no extra dependencies.
import { createFolderAdapter } from "./folder.js";
import { createWebdavAdapter } from "./webdav.js";
import { createS3Adapter } from "./s3.js";
import { createOneDriveAdapter } from "./onedrive.js";
import { createDropboxAdapter } from "./dropbox.js";

export const DESTINATION_TYPES = ["folder", "backblaze", "webdav", "s3", "onedrive", "dropbox"];

export function createAdapter(destination, hooks = {}) {
  const persistSecrets = typeof hooks.persistSecrets === "function" ? hooks.persistSecrets : () => {};
  switch (destination?.type) {
    case "folder":
      return createFolderAdapter(destination, { persistSecrets });
    case "backblaze": // Backblaze B2 speaks the S3 API; the adapter derives its endpoint.
    case "s3":
      return createS3Adapter(destination, { persistSecrets });
    case "webdav":
      return createWebdavAdapter(destination, { persistSecrets });
    case "onedrive":
      return createOneDriveAdapter(destination, { persistSecrets });
    case "dropbox":
      return createDropboxAdapter(destination, { persistSecrets });
    default:
      throw new Error(`Unknown backup destination type: ${destination?.type || "(none)"}`);
  }
}
