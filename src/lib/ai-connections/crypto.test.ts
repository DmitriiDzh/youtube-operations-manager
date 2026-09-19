import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, requireEncryptionKey } from "./crypto";
import { DomainError } from "./contracts";

// AC-CONN-02
test("AC-CONN-02: encrypting a secret never leaves the plaintext inside the ciphertext, and round-trips exactly", () => {
  const key = randomBytes(32);
  const plaintext = "sk-super-secret-value-12345";

  const encrypted = encryptSecret(plaintext, key);

  assert.ok(!encrypted.ciphertext.includes(plaintext));
  assert.ok(!Buffer.from(encrypted.ciphertext, "base64").toString("utf8").includes(plaintext));

  const decrypted = decryptSecret(encrypted, key);
  assert.equal(decrypted, plaintext);
});

test("decrypting with the wrong key fails rather than returning corrupted plaintext", () => {
  const key = randomBytes(32);
  const wrongKey = randomBytes(32);
  const encrypted = encryptSecret("sk-secret", key);

  assert.throws(() => decryptSecret(encrypted, wrongKey));
});

// AC-CONN-03
test("AC-CONN-03: requireEncryptionKey throws a structured error when no key is configured, never falls back", () => {
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
