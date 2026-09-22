import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "./contracts";

// AES-256-GCM, same approach as `src/lib/ai-connections/crypto.ts` -- but under its OWN env var
// (`CLOUD_CONNECTION_ENCRYPTION_KEY`), deliberately never `AI_CONNECTIONS_ENCRYPTION_KEY`
// (AGENTS.md §M, feature-module independence): this module must not fail closed just because the
// unrelated AI-localization module's key is absent, or vice versa.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type ResolveEncryptionKey = () => Buffer | null;

/**
 * Default key resolver: reads `CLOUD_CONNECTION_ENCRYPTION_KEY` from the environment
 * (base64-encoded 32 bytes), never committed to the repository, never a hardcoded fallback.
 * Returns `null` if unset or malformed, which callers must treat as "encryption unavailable,"
 * never silently falling back to plaintext. Narrowed from the full `cloud-platform` scope to
 * `monitoring.read` (2026-09-22, once the Cloud Quotas API that justified the broader scope
 * turned out to be unnecessary), but this is still a real Google Cloud grant, not a YouTube-scoped
 * one -- encryption stays the default here rather than falling back to `users`' plaintext
 * tradeoff (`docs/TECHNICAL_DEBT.md` RISK-07).
 */
export function resolveEncryptionKeyFromEnv(): Buffer | null {
  const raw = process.env.CLOUD_CONNECTION_ENCRYPTION_KEY;
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

export type EncryptedPayload = {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
};

export function encryptSecret(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecret(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Throws `encryption_key_not_configured` -- fail-closed, never a plaintext fallback. */
export function requireEncryptionKey(resolveKey: ResolveEncryptionKey): Buffer {
  const key = resolveKey();
  if (!key) {
    throw new DomainError({
      code: "encryption_key_not_configured",
      message:
        "CLOUD_CONNECTION_ENCRYPTION_KEY is not configured (must be a base64-encoded 32-byte key). Refusing to store the Cloud connection's OAuth tokens in plaintext.",
    });
  }
  return key;
}
