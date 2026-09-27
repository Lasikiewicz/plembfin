import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";

import { createS3Adapter } from "../server/src/utils/backupDestinations/s3.js";

const FILE_SIZE = 128 * 1024 * 1024;

function writeLargeFile(filePath) {
  const fd = fs.openSync(filePath, "w");
  const chunk = crypto.randomBytes(1024 * 1024);
  const hash = crypto.createHash("sha256");
  for (let written = 0; written < FILE_SIZE; written += chunk.length) {
    chunk[0] = written / chunk.length; // vary each MB so a dropped or repeated chunk changes the hash
    fs.writeSync(fd, chunk);
    hash.update(chunk);
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}

test("S3 upload streams a large backup with its length and payload hash", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-s3-upload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "backup.encrypted.json");
  const expectedHash = writeLargeFile(filePath);

  let received = null;
  const server = http.createServer((req, res) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    req.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
    req.on("end", () => {
      received = { method: req.method, url: req.url, headers: req.headers, bytes, hash: hash.digest("hex") };
      res.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const adapter = createS3Adapter({
    type: "s3",
    settings: { endpoint: `http://127.0.0.1:${server.address().port}`, region: "us-east-1", bucket: "bucket", prefix: "plembfin", accessKeyId: "AKID" },
    secrets: { secretAccessKey: "secret" },
  });

  // The upload must never hold the file: sample live Buffer memory while it runs,
  // collecting garbage first so already-sent chunks are not counted.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  const liveBuffers = () => { gc(); return process.memoryUsage().arrayBuffers; };
  const baseline = liveBuffers();
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, liveBuffers()); }, 10);
  let result;
  try {
    result = await adapter.upload(filePath, "plembfin-backup-20260927T000000Z.encrypted.json");
  } finally {
    clearInterval(sampler);
  }

  assert.equal(result.bytes, FILE_SIZE);
  assert.equal(received.method, "PUT");
  assert.equal(received.url, "/bucket/plembfin/plembfin-backup-20260927T000000Z.encrypted.json");
  assert.equal(received.bytes, FILE_SIZE);
  assert.equal(received.hash, expectedHash);
  assert.equal(received.headers["content-length"], String(FILE_SIZE));
  assert.equal(received.headers["transfer-encoding"], undefined);
  assert.equal(received.headers["x-amz-content-sha256"], expectedHash);
  assert.match(received.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\//);
  assert.ok(peak - baseline < 32 * 1024 * 1024, `Buffer memory grew by ${Math.round((peak - baseline) / 1048576)} MB during a 128 MB upload`);
});

test("S3 upload reports the provider's error", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-s3-upload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "small.json");
  fs.writeFileSync(filePath, "{}");

  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(403).end("<Error>SignatureDoesNotMatch</Error>"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const adapter = createS3Adapter({
    type: "s3",
    settings: { endpoint: `http://127.0.0.1:${server.address().port}`, region: "us-east-1", bucket: "bucket", accessKeyId: "AKID" },
    secrets: { secretAccessKey: "secret" },
  });
  await assert.rejects(adapter.upload(filePath, "plembfin-backup-20260927T000000Z.encrypted.json"), /S3 upload failed \(403\): <Error>SignatureDoesNotMatch/);
});
