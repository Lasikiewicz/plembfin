// S3-compatible adapter (AWS S3, Backblaze B2, MinIO, Wasabi, ...). Implements just
// enough SigV4 (PUT / GET / DELETE / ListObjectsV2) to avoid pulling in the large
// @aws-sdk/client-s3 dependency. Settings: { endpoint?, region, bucket, prefix?,
// accessKeyId, forcePathStyle? }  Secrets: { secretAccessKey }
import crypto from "node:crypto";
import fs from "node:fs";

const FILE_PATTERN = /^plembfin-watch-history-\d{8}T\d{6}Z\.json\.gz$/;
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// RFC 3986 encoding; S3 keeps "/" as a path separator in the canonical URI.
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeKeyPath(key) {
  return key.split("/").map(encodeRfc3986).join("/");
}

function s3Config(destination) {
  const region = String(destination.settings?.region || "us-east-1").trim();
  const bucket = String(destination.settings?.bucket || "").trim();
  if (!bucket) throw new Error("S3 bucket is required");
  const accessKeyId = String(destination.settings?.accessKeyId || "").trim();
  const secretAccessKey = String(destination.secrets?.secretAccessKey || "").trim();
  if (!accessKeyId || !secretAccessKey) throw new Error("S3 access key and secret are required");
  const endpoint = String(destination.settings?.endpoint || `https://s3.${region}.amazonaws.com`)
    .trim()
    .replace(/\/+$/, "");
  // Default to path-style: required by MinIO and most non-AWS providers.
  const forcePathStyle = destination.settings?.forcePathStyle !== false;
  let prefix = String(destination.settings?.prefix || "").trim().replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { region, bucket, accessKeyId, secretAccessKey, endpoint, forcePathStyle, prefix };
}

function buildUrl(cfg, key, query) {
  const base = new URL(cfg.endpoint);
  let host = base.host;
  let pathname;
  if (cfg.forcePathStyle) {
    pathname = `/${cfg.bucket}/${encodeKeyPath(key)}`;
  } else {
    host = `${cfg.bucket}.${base.host}`;
    pathname = `/${encodeKeyPath(key)}`;
  }
  const search = query
    ? `?${Object.keys(query).sort().map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(query[k])}`).join("&")}`
    : "";
  return { protocol: base.protocol, host, pathname, search, href: `${base.protocol}//${host}${pathname}${search}` };
}

async function signedFetch(cfg, { method, key, query, body }) {
  const url = buildUrl(cfg, key, query);
  const payload = body || "";
  const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = `${signedHeaderNames.map((h) => `${h}:${headers[h]}`).join("\n")}\n`;
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalQuery = url.search
    ? url.search.slice(1)
    : "";

  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url.href, {
    method,
    headers: {
      Authorization: authorization,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(body ? { "Content-Type": "application/gzip" } : {}),
    },
    body: body || undefined,
  });
}

export function createS3Adapter(destination) {
  const cfg = s3Config(destination);

  async function listRaw() {
    const response = await signedFetch(cfg, {
      method: "GET",
      key: "",
      query: { "list-type": "2", prefix: cfg.prefix },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`S3 list failed (${response.status}): ${text.slice(0, 200)}`);
    }
    return response.text();
  }

  return {
    async testConnection() {
      const response = await signedFetch(cfg, {
        method: "GET",
        key: "",
        query: { "list-type": "2", "max-keys": "1", prefix: cfg.prefix },
      });
      if (response.status === 403) throw new Error("S3 access denied (403) — check keys and bucket policy");
      if (response.status === 404) throw new Error("S3 bucket not found (404)");
      if (!response.ok) throw new Error(`S3 connection failed (${response.status})`);
      return { ok: true, detail: `Bucket ${cfg.bucket} reachable` };
    },

    async upload(localPath, remoteName) {
      const started = Date.now();
      const body = fs.readFileSync(localPath);
      const response = await signedFetch(cfg, { method: "PUT", key: `${cfg.prefix}${remoteName}`, body });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`S3 upload failed (${response.status}): ${text.slice(0, 200)}`);
      }
      return { bytes: body.length, durationMs: Date.now() - started };
    },

    async list() {
      const xml = await listRaw();
      const out = [];
      const blocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
      for (const block of blocks) {
        const key = (block.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || "";
        const name = key.split("/").pop();
        if (!FILE_PATTERN.test(name)) continue;
        const size = (block.match(/<Size>(\d+)<\/Size>/) || [])[1];
        const modified = (block.match(/<LastModified>([\s\S]*?)<\/LastModified>/) || [])[1];
        out.push({
          name,
          sizeBytes: Number(size) || 0,
          createdAt: modified ? new Date(modified).toISOString() : new Date().toISOString(),
        });
      }
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async delete(remoteName) {
      const response = await signedFetch(cfg, { method: "DELETE", key: `${cfg.prefix}${remoteName}` });
      if (!(response.ok || response.status === 204 || response.status === 404)) {
        throw new Error(`S3 delete failed (${response.status})`);
      }
    },
  };
}
