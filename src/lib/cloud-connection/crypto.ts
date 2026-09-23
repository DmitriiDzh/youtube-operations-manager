import {
  decryptSecret as sharedDecryptSecret,
  encryptSecret as sharedEncryptSecret,
  resolveEncryptionKeyFromEnv as sharedResolveEncryptionKeyFromEnv,
  type EncryptedPayload,
} from "../shared-crypto";
import { DomainError } from "./contracts";

// AES-256-GCM implementation lives in `src/lib/shared-crypto/` (AGENTS.md §M -- extracted after
// this file and `ai-connections/crypto.ts` were found to be byte-for-byte identical). Key
// resolution stays under its OWN env var (`CLOUD_CONNECTION_ENCRYPTION_KEY`), deliberately never
// `AI_CONNECTIONS_ENCRYPTION_KEY` (AGENTS.md §M, feature-module independence): this module must
// not fail closed just because the unrelated AI-localization module's key is absent, or vice versa.

export type ResolveEncryptionKey = () => Buffer | null;
export type { EncryptedPayload };

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
  return sharedResolveEncryptionKeyFromEnv("CLOUD_CONNECTION_ENCRYPTION_KEY");
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedPayload {
  return sharedEncryptSecret(plaintext, key);
}

export function decryptSecret(payload: EncryptedPayload, key: Buffer): string {
  return sharedDecryptSecret(payload, key);
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
