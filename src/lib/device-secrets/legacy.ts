import path from "node:path";
import { createKeyFile, createKeyFileFsAccess } from "@/lib/device-key-file";
import { decryptSecret } from "@/lib/shared-crypto";
import { getStoredGeminiCredentials, getStoredMediaCredentials } from "@/lib/db";
import type { LegacySecretSource } from "./contracts";

/**
 * ADR 0042 §3: the two tables and key files that held typed secrets before `device_secrets` (BL-199). Read once per slot, on its
 * first use, by `createDeviceSecrets`; never written, never dropped (`resolveMergedNumberingCollision` relies on
 * `media_credentials` existing). A legacy file that is missing or unusable makes that row unreadable: the secret is entered again.
 */

export const LEGACY_MEDIA_KEY_FILE_NAME = "media-generation.key";
export const LEGACY_GEMINI_KEY_FILE_NAME = "gemini-media.key";

function legacyKeyFile(appDataDir: string, fileName: string) {
  return createKeyFile(createKeyFileFsAccess(path.join(appDataDir, fileName)), (detail) => new Error(detail));
}

async function readLegacyKey(appDataDir: string, fileName: string): Promise<Buffer | null> {
  try {
    return await legacyKeyFile(appDataDir, fileName).readKey();
  } catch {
    return null;
  }
}

/** RunPod key + S3 pair: the plaintext is the same JSON set media-generation stored (`{runpodApiKey, s3AccessKeyId, s3SecretAccessKey}`). */
export function legacyRunpodSource(appDataDir: string): LegacySecretSource {
  return {
    async read() {
      const row = await getStoredMediaCredentials();
      if (!row) return null;
      const key = await readLegacyKey(appDataDir, LEGACY_MEDIA_KEY_FILE_NAME);
      if (!key) return "unreadable";
      try {
        return {
          plaintext: decryptSecret(row, key),
          hints: { runpodKeyPrefix: row.runpodKeyPrefix, s3AccessKeyId: row.s3AccessKeyId },
          status: null,
          verifiedAt: row.verifiedAt ? row.verifiedAt.getTime() : null,
        };
      } catch {
        return "unreadable";
      }
    },
  };
}

/** The Gemini key: plaintext is the key itself. */
export function legacyGeminiSource(appDataDir: string): LegacySecretSource {
  return {
    async read() {
      const row = await getStoredGeminiCredentials();
      if (!row) return null;
      const key = await readLegacyKey(appDataDir, LEGACY_GEMINI_KEY_FILE_NAME);
      if (!key) return "unreadable";
      try {
        return {
          plaintext: decryptSecret(row, key),
          hints: { keyHint: row.keyHint },
          status: row.status,
          verifiedAt: row.verifiedAt ? row.verifiedAt.getTime() : null,
        };
      } catch {
        return "unreadable";
      }
    },
  };
}

/** ADR 0042 §5: session tokens sealed before BL-199 open with the legacy media key while that file exists. */
export function legacyMediaSealKey(appDataDir: string): () => Promise<Buffer | null> {
  return () => readLegacyKey(appDataDir, LEGACY_MEDIA_KEY_FILE_NAME);
}
