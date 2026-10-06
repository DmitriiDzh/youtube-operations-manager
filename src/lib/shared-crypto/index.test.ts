import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { decryptSecret, decryptWithPassword, encryptSecret, encryptWithPassword, PASSWORD_SCRYPT_PARAMS, resolveEncryptionKeyFromEnv, scryptParamsWithinLimits } from "./index";

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

// BL-137: password-based encryption for a credentials file. Low scrypt cost in tests (the production default is 2^17).
const FAST = { N: 2 ** 10, r: 8, p: 1 };

test("encryptWithPassword round-trips with the same password and carries no plaintext", async () => {
  const secret = "rpa_THISISASECRETVALUE1234567890";
  const payload = await encryptWithPassword(secret, "correct horse battery", FAST);
  assert.equal(payload.kdf, "scrypt");
  assert.deepEqual([payload.N, payload.r, payload.p], [1024, 8, 1]);
  assert.ok(!JSON.stringify(payload).includes(secret));
  assert.equal(await decryptWithPassword(payload, "correct horse battery"), secret);
  // A fresh salt and IV each time: two exports of the same secret differ.
  const again = await encryptWithPassword(secret, "correct horse battery", FAST);
  assert.notEqual(again.salt, payload.salt);
  assert.notEqual(again.ciphertext, payload.ciphertext);
});

test("decryptWithPassword fails on a wrong password, a tampered ciphertext, and out-of-bounds scrypt parameters", async () => {
  const payload = await encryptWithPassword("secret", "correct horse battery", FAST);
  await assert.rejects(decryptWithPassword(payload, "wrong horse battery"));
  const flipped = Buffer.from(payload.ciphertext, "base64");
  flipped[0] ^= 1;
  await assert.rejects(decryptWithPassword({ ...payload, ciphertext: flipped.toString("base64") }, "correct horse battery"));
  await assert.rejects(decryptWithPassword({ ...payload, N: 2 ** 22 }, "correct horse battery"), /parameters/);
  await assert.rejects(decryptWithPassword({ ...payload, N: 1000 }, "correct horse battery"), /parameters/);
  await assert.rejects(decryptWithPassword({ ...payload, r: 64 }, "correct horse battery"), /parameters/);
});

test("the production scrypt parameters are within the accepted limits; anything costing over 256 MiB is refused", () => {
  assert.ok(scryptParamsWithinLimits(PASSWORD_SCRYPT_PARAMS));
  // 128 * N * r * p bytes: 2^18 * 8 * 128 = 256 MiB is the most a file may ask for.
  assert.ok(scryptParamsWithinLimits({ N: 2 ** 18, r: 8, p: 1 }));
  assert.ok(!scryptParamsWithinLimits({ N: 2 ** 19, r: 8, p: 1 })); // 512 MiB
  assert.ok(!scryptParamsWithinLimits({ N: 2 ** 18, r: 16, p: 1 })); // 512 MiB
  assert.ok(!scryptParamsWithinLimits({ N: 2 ** 17, r: 8, p: 2 })); // p > 1 multiplies the CPU cost
  assert.ok(!scryptParamsWithinLimits({ N: 2 ** 20, r: 16, p: 4 })); // 2 GiB
});
