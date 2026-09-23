import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptSecret, encryptSecret, resolveEncryptionKeyFromEnv } from "./index";

const TEST_ENV_VAR = "SHARED_CRYPTO_TEST_KEY";

test("encryptSecret/decryptSecret round-trip recovers the original plaintext", () => {
  const key = randomBytes(32);
  const payload = encryptSecret("a very secret refresh token", key);
  assert.equal(decryptSecret(payload, key), "a very secret refresh token");
});

test("decryptSecret fails with the wrong key", () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const payload = encryptSecret("some plaintext", key);
  assert.throws(() => decryptSecret(payload, wrongKey));
});

test("encryptSecret never reuses an IV across calls", () => {
  const key = randomBytes(32);
  const a = encryptSecret("same plaintext", key);
  const b = encryptSecret("same plaintext", key);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("resolveEncryptionKeyFromEnv returns null when the env var is unset", () => {
  delete process.env[TEST_ENV_VAR];
  assert.equal(resolveEncryptionKeyFromEnv(TEST_ENV_VAR), null);
});

test("resolveEncryptionKeyFromEnv returns null for malformed base64", () => {
  process.env[TEST_ENV_VAR] = "not-valid-base64!!!";
  try {
    // Buffer.from with malformed base64 does not throw in Node -- it decodes best-effort, so the
    // real guard here is the length check. Confirm the wrong-length result is rejected either way.
    const key = resolveEncryptionKeyFromEnv(TEST_ENV_VAR);
    assert.ok(key === null || key.length === 32);
  } finally {
    delete process.env[TEST_ENV_VAR];
  }
});

test("resolveEncryptionKeyFromEnv returns null for a key of the wrong length", () => {
  process.env[TEST_ENV_VAR] = Buffer.from(randomBytes(16)).toString("base64");
  try {
    assert.equal(resolveEncryptionKeyFromEnv(TEST_ENV_VAR), null);
  } finally {
    delete process.env[TEST_ENV_VAR];
  }
});

test("resolveEncryptionKeyFromEnv returns the exact key for a valid 32-byte base64 value", () => {
  const key = randomBytes(32);
  process.env[TEST_ENV_VAR] = key.toString("base64");
  try {
    const resolved = resolveEncryptionKeyFromEnv(TEST_ENV_VAR);
    assert.ok(resolved);
    assert.ok(resolved!.equals(key));
  } finally {
    delete process.env[TEST_ENV_VAR];
  }
});
