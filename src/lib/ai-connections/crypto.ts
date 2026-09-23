import {
  decryptSecret as sharedDecryptSecret,
  encryptSecret as sharedEncryptSecret,
  resolveEncryptionKeyFromEnv as sharedResolveEncryptionKeyFromEnv,
  type EncryptedPayload,
} from "../shared-crypto";
import { DomainError } from "./contracts";

// AES-256-GCM implementation lives in `src/lib/shared-crypto/` (AGENTS.md §M -- extracted after
// this file and `cloud-connection/crypto.ts` were found to be byte-for-byte identical). Key
// resolution is injectable (never a module-level singleton reading process.env directly) so tests
// can exercise "no key configured" (AC-CONN-03) without mutating global environment state.

export type ResolveEncryptionKey = () => Buffer | null;
export type { EncryptedPayload };

/**
 * Default key resolver: reads `AI_CONNECTIONS_ENCRYPTION_KEY` from the environment
 * (base64-encoded 32 bytes), exactly like this repository's other secrets
 * (`GOOGLE_CLIENT_SECRET`, etc.) -- never committed to the repository, never a
 * hardcoded fallback. Returns `null` if unset or malformed, which callers must treat
 * as "encryption unavailable," never silently falling back to plaintext.
 */
export function resolveEncryptionKeyFromEnv(): Buffer | null {
  return sharedResolveEncryptionKeyFromEnv("AI_CONNECTIONS_ENCRYPTION_KEY");
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedPayload {
  return sharedEncryptSecret(plaintext, key);
}

export function decryptSecret(payload: EncryptedPayload, key: Buffer): string {
  return sharedDecryptSecret(payload, key);
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
