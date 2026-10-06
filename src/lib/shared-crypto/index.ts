import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";

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

// ---------------------------------------------------------------------------------------------
// Password-based encryption (BL-137: carrying the RunPod credentials to another device as a file).
// The key is derived with scrypt from an operator-chosen password and a random salt; the
// password itself is never stored. Kept here, next to the AES-GCM primitives it reuses, so any
// future "export a secret under a password" uses the same parameters and the same bounds.
// ---------------------------------------------------------------------------------------------

export type ScryptParams = { N: number; r: number; p: number };
/** ~128 MiB of memory per derivation (128 * N * r bytes): slow to brute-force, ~0.3 s for one honest attempt. */
export const PASSWORD_SCRYPT_PARAMS: ScryptParams = Object.freeze({ N: 2 ** 17, r: 8, p: 1 });
/** Bounds for a file's own parameters: a crafted file must not make a decrypt allocate gigabytes or spin for minutes. */
const SCRYPT_LIMITS = { maxN: 2 ** 20, maxR: 16, maxP: 4 };
const SALT_BYTES = 16;

export type PasswordEncryptedPayload = EncryptedPayload & { kdf: "scrypt"; salt: string } & ScryptParams;

function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const maxmem = 128 * params.N * params.r * 2 + 1024 * 1024;
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFC"), salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem }, (error, key) => (error ? reject(error) : resolve(key)))
  );
}

export function scryptParamsWithinLimits(params: ScryptParams): boolean {
  const isPowerOfTwo = Number.isInteger(params.N) && params.N > 1 && (params.N & (params.N - 1)) === 0;
  return (
    isPowerOfTwo &&
    params.N <= SCRYPT_LIMITS.maxN &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= SCRYPT_LIMITS.maxR &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= SCRYPT_LIMITS.maxP
  );
}

export async function encryptWithPassword(plaintext: string, password: string, params: ScryptParams = PASSWORD_SCRYPT_PARAMS): Promise<PasswordEncryptedPayload> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, params);
  return { kdf: "scrypt", salt: salt.toString("base64"), N: params.N, r: params.r, p: params.p, ...encryptSecret(plaintext, key) };
}

/** Throws on a wrong password or any tampering (the GCM tag fails), and on parameters outside the limits. */
export async function decryptWithPassword(payload: PasswordEncryptedPayload, password: string): Promise<string> {
  if (payload.kdf !== "scrypt" || !scryptParamsWithinLimits(payload)) throw new Error("unsupported key-derivation parameters");
  const key = await deriveKey(password, Buffer.from(payload.salt, "base64"), payload);
  return decryptSecret(payload, key);
}
