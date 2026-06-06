import crypto from "node:crypto";
import { db, FieldValue, storageBucket } from "../firebase.js";

const POSTER_CACHE_COLLECTION = db.collection("posterCache");
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_POSTER_BYTES = 5 * 1024 * 1024;

function cacheIdFor(mediaKey = "") {
  return crypto.createHash("sha1").update(String(mediaKey || "unknown")).digest("hex");
}

function extensionForContentType(contentType = "") {
  const clean = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (clean === "image/png") return "png";
  if (clean === "image/webp") return "webp";
  if (clean === "image/gif") return "gif";
  return "jpg";
}

function publicStorageUrl(path, token) {
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const encodedPath = encodeURIComponent(path);
  if (host) {
    const protocol = host.startsWith("http") ? "" : "http://";
    return `${protocol}${host}/v0/b/${storageBucket.name}/o/${encodedPath}?alt=media&token=${encodeURIComponent(token)}`;
  }
  return `https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodedPath}?alt=media&token=${encodeURIComponent(token)}`;
}

function sanitizedRemoteUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    for (const key of [...url.searchParams.keys()]) {
      if (/token|api[_-]?key|key/i.test(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch (error) {
    return String(value || "");
  }
}

function freshNegativeCache(data = {}) {
  const updatedAt = Number(data.updatedAtMs || 0);
  if (!updatedAt) return false;
  const ttl = data.status === "missing" ? MISSING_RETRY_MS : FAILED_RETRY_MS;
  return Date.now() - updatedAt < ttl;
}

export async function getPosterCache(mediaKey = "") {
  if (!mediaKey) return null;
  const doc = await POSTER_CACHE_COLLECTION.doc(cacheIdFor(mediaKey)).get().catch(() => null);
  if (!doc?.exists) return null;
  return { id: doc.id, ...doc.data() };
}

export function usableCachedPoster(cache = {}) {
  if (cache?.status === "cached" && cache.url) {
    return { url: cache.url, cached: true, source: cache.source || "cache" };
  }
  if ((cache?.status === "missing" || cache?.status === "failed") && freshNegativeCache(cache)) {
    return { url: null, cached: true, source: cache.source || cache.status || "cache" };
  }
  return null;
}

export async function markPosterMissing(mediaKey = "", source = "unknown", detail = "") {
  if (!mediaKey) return;
  await POSTER_CACHE_COLLECTION.doc(cacheIdFor(mediaKey)).set(
    {
      mediaKey,
      status: "missing",
      source,
      detail: String(detail || ""),
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

export async function cachePosterFromUrl(mediaKey = "", remoteUrl = "", source = "unknown") {
  if (!mediaKey || !remoteUrl) return null;

  try {
    const response = await fetch(remoteUrl, { headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" } });
    if (!response.ok) {
      await markPosterFailure(mediaKey, source, `HTTP ${response.status}`, remoteUrl);
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!String(contentType).toLowerCase().startsWith("image/")) {
      await markPosterFailure(mediaKey, source, `Unexpected content type ${contentType}`, remoteUrl);
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_POSTER_BYTES) {
      await markPosterFailure(mediaKey, source, `Poster exceeds ${MAX_POSTER_BYTES} bytes`, remoteUrl);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_POSTER_BYTES) {
      await markPosterFailure(mediaKey, source, "Poster body is empty or too large", remoteUrl);
      return null;
    }

    const token = crypto.randomUUID();
    const extension = extensionForContentType(contentType);
    const cacheId = cacheIdFor(mediaKey);
    const storagePath = `posters/${cacheId}.${extension}`;

    await storageBucket.file(storagePath).save(buffer, {
      metadata: {
        contentType,
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {
          firebaseStorageDownloadTokens: token,
          mediaKey,
          source,
        },
      },
      resumable: false,
    });

    const url = publicStorageUrl(storagePath, token);
    const record = {
      mediaKey,
      status: "cached",
      source,
      originalUrl: sanitizedRemoteUrl(remoteUrl),
      storagePath,
      contentType,
      sizeBytes: buffer.length,
      url,
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await POSTER_CACHE_COLLECTION.doc(cacheId).set(record, { merge: true });
    return { url, cached: false, source };
  } catch (error) {
    await markPosterFailure(mediaKey, source, error?.message || String(error), remoteUrl).catch(() => null);
    return null;
  }
}

async function markPosterFailure(mediaKey = "", source = "unknown", detail = "", remoteUrl = "") {
  if (!mediaKey) return;
  await POSTER_CACHE_COLLECTION.doc(cacheIdFor(mediaKey)).set(
    {
      mediaKey,
      status: "failed",
      source,
      detail: String(detail || ""),
      originalUrl: sanitizedRemoteUrl(remoteUrl),
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
