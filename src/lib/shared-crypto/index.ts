import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM secret encryption, shared by every feature module that needs to store an
// encrypted-at-rest secret (currently `ai-connections`, `cloud-connection`) -- extracted here
// (`AGENTS.md` §M) after both modules were found to carry a byte-for-byte identical
// implementation of this same logic, differing only in which env var they read and which
// `DomainError` they threw. Deliberately does NOT own key resolution's fail-closed error
// behavior or any particular env var name -- each feature module keeps its own
// `requireEncryptionKey` wrapper (own env var, own error type), preserving the independent
// failure mode `AGENTS.md` §M protects (one feature's missing key must never fail closed for an
// unrelated feature). This module owns only the actual duplicated cryptography.
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type EncryptedPayload = {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
};

/**
 * Reads a base64-encoded 32-byte key from the given environment variable. Returns `null` if
 * unset or malformed -- callers must treat that as "encryption unavailable" and fail closed,
 * never fall back to plaintext.
 */
export function resolveEncryptionKeyFromEnv(envVarName: string): Buffer | null {
  const raw = process.env[envVarName];
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, "base64");
    return key.length === KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

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
