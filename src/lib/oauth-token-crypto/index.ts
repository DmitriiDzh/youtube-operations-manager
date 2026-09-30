import { decryptSecret, encryptSecret, resolveEncryptionKeyFromEnv } from "@/lib/shared-crypto";

/**
 * Phase 12 slice 12.8 (`docs/roadmap/plans/PHASE_12_PLAN.md` §7 D5.4; owner chose the "env" key
 * variant, Telegram msg 1060). Google OAuth access/refresh tokens in `users` are stored encrypted
 * at rest (AES-256-GCM via `src/lib/shared-crypto`) when `OAUTH_TOKENS_ENCRYPTION_KEY` is
 * configured -- so an agent (or anyone) accidentally opening the database file alone finds no
 * usable Google credential. Closes the plaintext-at-rest part of RISK-07 for configured installs.
 *
 * Deliberately a zero-db leaf used only by `db.ts`'s OAuth-token functions (the single choke point
 * for every read/write of these columns).
 *
 * Stored format: `enc:v1:<iv>:<authTag>:<ciphertext>` (each base64) in the same TEXT column, so no
 * schema change. A value without the prefix is a legacy plaintext row.
 *
 * Policy (safety-first, never locks the operator out of sign-in):
 * - key configured: every write is encrypted; legacy plaintext rows are still readable and are
 *   re-encrypted on first read (`needsReencrypt`);
 * - key NOT configured: values are stored as plaintext exactly as before this slice (with a
 *   one-time warning) -- refusing to store would make Google sign-in impossible;
 * - an encrypted value that cannot be decrypted (key missing or changed) reads as `null`, i.e.
 *   "not signed in -- sign in again", never a crash and never ciphertext passed on as a token.
 */

const PREFIX = "enc:v1:";
export const OAUTH_TOKENS_ENCRYPTION_KEY_ENV = "OAUTH_TOKENS_ENCRYPTION_KEY";

export type ResolveOAuthTokenKey = () => Buffer | null;

export const resolveOAuthTokenKeyFromEnv: ResolveOAuthTokenKey = () =>
  resolveEncryptionKeyFromEnv(OAUTH_TOKENS_ENCRYPTION_KEY_ENV);

let warnedAboutMissingKey = false;

/** Value to store in the TEXT column for a token (or null). */
export function encodeStoredOAuthToken(value: string | null | undefined, resolveKey: ResolveOAuthTokenKey = resolveOAuthTokenKeyFromEnv): string | null | undefined {
  if (value === null || value === undefined) return value;
  const key = resolveKey();
  if (!key) {
    if (!warnedAboutMissingKey) {
      warnedAboutMissingKey = true;
      process.stderr.write(
        `[oauth-token-crypto] ${OAUTH_TOKENS_ENCRYPTION_KEY_ENV} is not configured -- Google OAuth tokens are stored unencrypted (RISK-07).\n`
      );
    }
    return value;
  }
  const payload = encryptSecret(value, key);
  return `${PREFIX}${payload.iv}:${payload.authTag}:${payload.ciphertext}`;
}

export function isEncryptedOAuthToken(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}

/** Decodes a stored value. `needsReencrypt` is true for a legacy plaintext value while a key is
 * configured -- the caller persists `encodeStoredOAuthToken(value)` back. */
export function decodeStoredOAuthToken(
  stored: string | null | undefined,
  resolveKey: ResolveOAuthTokenKey = resolveOAuthTokenKeyFromEnv
): { value: string | null; needsReencrypt: boolean } {
  if (stored === null || stored === undefined) return { value: null, needsReencrypt: false };
  if (!isEncryptedOAuthToken(stored)) {
    return { value: stored, needsReencrypt: resolveKey() !== null };
  }
  const key = resolveKey();
  if (!key) return { value: null, needsReencrypt: false };
  const [iv, authTag, ciphertext] = stored.slice(PREFIX.length).split(":");
  try {
    return { value: decryptSecret({ iv, authTag, ciphertext }, key), needsReencrypt: false };
  } catch {
    return { value: null, needsReencrypt: false };
  }
}
