import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db, getUserOAuthTokens, upsertUserOAuthOnSignIn, users } from "@/lib/db";
import { decodeStoredOAuthToken, encodeStoredOAuthToken, OAUTH_TOKENS_ENCRYPTION_KEY_ENV } from "./index";

// docs/roadmap/plans/PHASE_12_PLAN.md §7 D5.4 / AC-P12-14 (owner: "env" key variant). Expected
// behavior is stated by the plan: ciphertext at rest when a key is configured, legacy plaintext
// still readable and re-encrypted, no lock-out without a key, undecryptable -> "not signed in".

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

test("round trip with a key: stored value is prefixed ciphertext that never contains the token", () => {
  const stored = encodeStoredOAuthToken("ya29.secret-access", () => KEY)!;
  assert.ok(stored.startsWith("enc:v1:"));
  assert.equal(stored.includes("ya29.secret-access"), false);
  assert.deepEqual(decodeStoredOAuthToken(stored, () => KEY), { value: "ya29.secret-access", needsReencrypt: false });
  assert.notEqual(encodeStoredOAuthToken("ya29.secret-access", () => KEY), stored, "fresh IV per write");
});

test("legacy plaintext is readable and flagged for re-encryption only when a key exists", () => {
  assert.deepEqual(decodeStoredOAuthToken("1//legacy-refresh", () => KEY), { value: "1//legacy-refresh", needsReencrypt: true });
  assert.deepEqual(decodeStoredOAuthToken("1//legacy-refresh", () => null), { value: "1//legacy-refresh", needsReencrypt: false });
});

test("no key configured: stored as before (plaintext), so sign-in keeps working", () => {
  assert.equal(encodeStoredOAuthToken("ya29.x", () => null), "ya29.x");
  assert.equal(encodeStoredOAuthToken(null, () => KEY), null);
  assert.equal(encodeStoredOAuthToken(undefined, () => KEY), undefined);
});

test("an encrypted value with no key, a wrong key, or corrupted payload reads as null (sign in again), never ciphertext", () => {
  const stored = encodeStoredOAuthToken("ya29.secret", () => KEY)!;
  assert.equal(decodeStoredOAuthToken(stored, () => null).value, null);
  assert.equal(decodeStoredOAuthToken(stored, () => OTHER_KEY).value, null);
  assert.equal(decodeStoredOAuthToken("enc:v1:garbage", () => KEY).value, null);
});

test("db.ts: with the env key set, tokens are ciphertext in the users row and plaintext through getUserOAuthTokens; legacy rows re-encrypt on read", async () => {
  const previous = process.env[OAUTH_TOKENS_ENCRYPTION_KEY_ENV];
  process.env[OAUTH_TOKENS_ENCRYPTION_KEY_ENV] = KEY.toString("base64");
  try {
    await upsertUserOAuthOnSignIn({
      userId: "u-enc",
      name: null,
      email: "u@example.com",
      image: null,
      accessToken: "ya29.at-rest",
      refreshToken: "1//refresh-at-rest",
      tokenExpiry: null,
      scope: null,
    });
    const [raw] = await db.select().from(users).where(eq(users.id, "u-enc"));
    assert.ok(raw.accessToken?.startsWith("enc:v1:") && raw.refreshToken?.startsWith("enc:v1:"));
    assert.equal(JSON.stringify(raw).includes("at-rest"), false);
    const tokens = await getUserOAuthTokens("u-enc");
    assert.equal(tokens?.accessToken, "ya29.at-rest");
    assert.equal(tokens?.refreshToken, "1//refresh-at-rest");

    await db.insert(users).values({ id: "u-legacy", email: "l@example.com", accessToken: "ya29.legacy", refreshToken: "1//legacy" });
    assert.equal((await getUserOAuthTokens("u-legacy"))?.accessToken, "ya29.legacy");
    const [migrated] = await db.select().from(users).where(eq(users.id, "u-legacy"));
    assert.ok(migrated.accessToken?.startsWith("enc:v1:") && migrated.refreshToken?.startsWith("enc:v1:"));
  } finally {
    if (previous === undefined) delete process.env[OAUTH_TOKENS_ENCRYPTION_KEY_ENV];
    else process.env[OAUTH_TOKENS_ENCRYPTION_KEY_ENV] = previous;
  }
});
