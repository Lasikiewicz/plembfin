import crypto from "node:crypto";
import sharp from "sharp";
import { db, FieldValue, storageBucket } from "../firebase.js";

const POSTER_CACHE_COLLECTION = db.collection("posterCache");
const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
const MISSING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ARTWORK_BYTES = 10 * 1024 * 1024;

function cacheIdFor(mediaKey = "", variant = "poster") {
  const key = variant === "poster" ? mediaKey : `${mediaKey}:${variant}`;
  return crypto.createHash("sha1").update(String(key || "unknown")).digest("hex");
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

export async function getPosterCache(mediaKey = "", variant = "poster") {
  if (!mediaKey) return null;
  const doc = await POSTER_CACHE_COLLECTION.doc(cacheIdFor(mediaKey, variant)).get().catch(() => null);
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

export async function markPosterMissing(mediaKey = "", source = "unknown", detail = "", variant = "poster") {
  if (!mediaKey) return;
  await POSTER_CACHE_COLLECTION.doc(cacheIdFor(mediaKey, variant)).set(
    {
      mediaKey,
      variant,
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
  return cacheArtworkFromUrl(mediaKey, remoteUrl, source, { variant: "poster", width: 340, quality: 80 });
}

export async function cacheBackdropFromUrl(mediaKey = "", remoteUrl = "", source = "unknown") {
  return cacheArtworkFromUrl(mediaKey, remoteUrl, source, { variant: "backdrop", width: 1600, quality: 82 });
}

export async function cacheArtworkFromUrl(mediaKey = "", remoteUrl = "", source = "unknown", { variant = "poster", width = 340, quality = 80 } = {}) {
  if (!mediaKey || !remoteUrl) return null;

  try {
    const response = await fetch(remoteUrl, { headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" } });
    if (!response.ok) {
      await markPosterFailure(mediaKey, source, `HTTP ${response.status}`, remoteUrl, variant);
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!String(contentType).toLowerCase().startsWith("image/")) {
      await markPosterFailure(mediaKey, source, `Unexpected content type ${contentType}`, remoteUrl, variant);
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_ARTWORK_BYTES) {
      await markPosterFailure(mediaKey, source, `Artwork exceeds ${MAX_ARTWORK_BYTES} bytes`, remoteUrl, variant);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_ARTWORK_BYTES) {
      await markPosterFailure(mediaKey, source, "Artwork body is empty or too large", remoteUrl, variant);
      return null;
    }

    let finalBuffer = buffer;
    let finalContentType = contentType;
    let extension = extensionForContentType(contentType);

    try {
      finalBuffer = await sharp(buffer)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();
      finalContentType = "image/webp";
      extension = "webp";
    } catch (resizeError) {
      console.warn("Artwork optimization via sharp failed, falling back to original buffer", resizeError);
    }

    const token = crypto.randomUUID();
    const cacheId = cacheIdFor(mediaKey, variant);
    const storagePath = `${variant === "backdrop" ? "backdrops" : "posters"}/${cacheId}.${extension}`;

    await storageBucket.file(storagePath).save(finalBuffer, {
      metadata: {
        contentType: finalContentType,
        cacheControl: "public, max-age=31536000, immutable",
        metadata: {
          firebaseStorageDownloadTokens: token,
          mediaKey,
          variant,
          source,
        },
      },
      resumable: false,
    });

    const url = publicStorageUrl(storagePath, token);
    const record = {
      mediaKey,
      variant,
      status: "cached",
      source,
      originalUrl: sanitizedRemoteUrl(remoteUrl),
      storagePath,
      contentType: finalContentType,
      sizeBytes: finalBuffer.length,
      url,
      updatedAtMs: Date.now(),
      updatedAt: FieldValue.serverTimestamp(),
    };

    await POSTER_CACHE_COLLECTION.doc(cacheId).set(record, { merge: true });
    return { url, cached: false, source };
  } catch (error) {
    await markPosterFailure(mediaKey, source, error?.message || String(error), remoteUrl, variant).catch(() => null);
    return null;
  }
}

async function markPosterFailure(mediaKey = "", source = "unknown", detail = "", remoteUrl = "", variant = "poster") {
  if (!mediaKey) return;
  await POSTER_CACHE_COLLECTION.doc(cacheIdFor(mediaKey, variant)).set(
    {
      mediaKey,
      variant,
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
