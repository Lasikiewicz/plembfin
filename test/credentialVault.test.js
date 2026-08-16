import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { decryptCredential, encryptCredential, loadCredentialKey, redactSecrets } from "../server/src/utils/credentialVault.js";

test("credential vault encrypts with unique IVs and detects tampering", () => {
  const key = Buffer.alloc(32, 7);
  const first = encryptCredential("secret-token", { key });
  const second = encryptCredential("secret-token", { key });
  assert.notEqual(first.iv, second.iv);
  assert.equal(decryptCredential(first, { key }), "secret-token");
  assert.throws(() => decryptCredential({ ...first, ciphertext: `${first.ciphertext.slice(0, -1)}A` }, { key }), /could not be decrypted/);
  assert.throws(() => decryptCredential(first, { key: Buffer.alloc(32, 8) }), /could not be decrypted/);
});

test("credential key is created once and missing-key recovery fails safely", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-vault-"));
  const keyPath = path.join(directory, "credential.key");
  const database = new Database(":memory:");
  database.exec("CREATE TABLE media_connections (credential_ciphertext TEXT)");
  try {
    const key = loadCredentialKey({ keyPath, database, env: {} });
    assert.equal(key.length, 32);
    assert.deepEqual(loadCredentialKey({ keyPath, database, env: {} }), key);
    fs.rmSync(keyPath);
    database.prepare("INSERT INTO media_connections VALUES (?)").run("encrypted");
    assert.throws(() => loadCredentialKey({ keyPath, database, env: {} }), /key is missing/);
    assert.equal(fs.existsSync(keyPath), false);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("secret-bearing diagnostic fields are recursively redacted", () => {
  assert.deepEqual(redactSecrets({ user: "a", accessToken: "x", nested: { privateKey: "y", ok: true } }), { user: "a", accessToken: "[redacted]", nested: { privateKey: "[redacted]", ok: true } });
});
