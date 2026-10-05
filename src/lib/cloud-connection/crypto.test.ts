import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, requireEncryptionKey, resolveEncryptionKeyFromEnv } from "./crypto";
import { DomainError } from "./contracts";

test("encrypting the Cloud connection's token set never leaves the plaintext inside the ciphertext, and round-trips exactly", () => {
  const key = randomBytes(32);
  const plaintext = JSON.stringify({ accessToken: "ya29.fake-access-token", refreshToken: "1//fake-refresh", tokenExpiry: 1234567890 });

  const encrypted = encryptSecret(plaintext, key);

  assert.ok(!encrypted.ciphertext.includes(plaintext));
  assert.ok(!Buffer.from(encrypted.ciphertext, "base64").toString("utf8").includes("fake-access-token"));

  const decrypted = decryptSecret(encrypted, key);
  assert.equal(decrypted, plaintext);
});

test("decrypting with the wrong key fails rather than returning corrupted plaintext", () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const encrypted = encryptSecret("secret", key);

  assert.throws(() => decryptSecret(encrypted, wrongKey));
});

test("requireEncryptionKey throws encryption_key_not_configured when no key is configured, never falls back to plaintext", () => {
  assert.throws(
    () => requireEncryptionKey(() => null),
    (err: unknown) => err instanceof DomainError && err.code === "encryption_key_not_configured"
  );
});

test("requireEncryptionKey returns the resolved key when configured", () => {
  const key = randomBytes(32);
  const resolved = requireEncryptionKey(() => key);
  assert.deepEqual(resolved, key);
});

// This key is deliberately SEPARATE from AI_CONNECTIONS_ENCRYPTION_KEY (AGENTS.md §M) --
// verify the env var name itself, not just that some key resolves.
test("resolveEncryptionKeyFromEnv reads CLOUD_CONNECTION_ENCRYPTION_KEY specifically, not AI_CONNECTIONS_ENCRYPTION_KEY", () => {
  const original = { cloud: process.env.CLOUD_CONNECTION_ENCRYPTION_KEY, ai: process.env.AI_CONNECTIONS_ENCRYPTION_KEY };
  try {
    delete process.env.CLOUD_CONNECTION_ENCRYPTION_KEY;
    process.env.AI_CONNECTIONS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.equal(resolveEncryptionKeyFromEnv(), null, "must not fall back to the AI connections key");

    const key = randomBytes(32);
    process.env.CLOUD_CONNECTION_ENCRYPTION_KEY = key.toString("base64");
    assert.deepEqual(resolveEncryptionKeyFromEnv(), key);
  } finally {
    if (original.cloud === undefined) delete process.env.CLOUD_CONNECTION_ENCRYPTION_KEY;
    else process.env.CLOUD_CONNECTION_ENCRYPTION_KEY = original.cloud;
    if (original.ai === undefined) delete process.env.AI_CONNECTIONS_ENCRYPTION_KEY;
    else process.env.AI_CONNECTIONS_ENCRYPTION_KEY = original.ai;
  }
});

test("resolveEncryptionKeyFromEnv returns null for a malformed (wrong-length) key rather than throwing", () => {
  const original = process.env.CLOUD_CONNECTION_ENCRYPTION_KEY;
  try {
    process.env.CLOUD_CONNECTION_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    assert.equal(resolveEncryptionKeyFromEnv(), null);
  } finally {
    if (original === undefined) delete process.env.CLOUD_CONNECTION_ENCRYPTION_KEY;
    else process.env.CLOUD_CONNECTION_ENCRYPTION_KEY = original;
  }
});
