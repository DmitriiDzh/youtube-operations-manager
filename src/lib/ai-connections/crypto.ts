import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DomainError } from "./contracts";

// AES-256-GCM. Key resolution is injectable (never a module-level singleton reading
// process.env directly) so tests can exercise "no key configured" (AC-CONN-03)
// without mutating global environment state.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type ResolveEncryptionKey = () => Buffer | null;

/**
 * Default key resolver: reads `AI_CONNECTIONS_ENCRYPTION_KEY` from the environment
 * (base64-encoded 32 bytes), exactly like this repository's other secrets
 * (`GOOGLE_CLIENT_SECRET`, etc.) -- never committed to the repository, never a
 * hardcoded fallback. Returns `null` if unset or malformed, which callers must treat
 * as "encryption unavailable," never silently falling back to plaintext.
 */
export function resolveEncryptionKeyFromEnv(): Buffer | null {
  const raw = process.env.AI_CONNECTIONS_ENCRYPTION_KEY;
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

/** Throws `encryption_key_not_configured` -- the fail-closed behavior AC-CONN-03
 * requires -- rather than ever returning/using a fallback key. */
export function requireEncryptionKey(resolveKey: ResolveEncryptionKey): Buffer {
  const key = resolveKey();
  if (!key) {
    throw new DomainError({
      code: "encryption_key_not_configured",
      message:
        "AI_CONNECTIONS_ENCRYPTION_KEY is not configured (must be a base64-encoded 32-byte key). Refusing to store a credential in plaintext.",
    });
  }
  return key;
}
