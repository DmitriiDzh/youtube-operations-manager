import type { EncryptedPayload } from "@/lib/shared-crypto";

/**
 * BL-199 (ADR 0042, docs/roadmap/plans/DEVICE_SECRETS_PLAN.md): this computer's typed secrets, one store.
 * Feature modules use a named slot; only this module touches the key file and the ciphertext.
 */

export const DEVICE_SECRETS_KEY_FILE_NAME = "device-secrets.key";

/** `runpod`: the RunPod key + S3 pair (a JSON set, media-generation). `gemini`: the Gemini key. `huggingface`: the HF read token. */
export const DEVICE_SECRET_NAMES = ["runpod", "gemini", "huggingface"] as const;
export type DeviceSecretName = (typeof DEVICE_SECRET_NAMES)[number];

/** `set`: a row and a readable key file. `none`: nothing stored. The key file is missing / unusable while a row exists. */
export type DeviceSecretState = "set" | "none" | "key_file_missing" | "key_file_invalid";

/** Plaintext, non-secret display fields (a key prefix, an access key id, the last 4 characters, a user name). */
export type DeviceSecretHints = Record<string, string | null>;

export type DeviceSecretInfo = {
  hints: DeviceSecretHints;
  status: string | null;
  verifiedAt: number | null;
  updatedAt: number;
  revision: number;
};

export type StoredDeviceSecretRow = DeviceSecretInfo & { name: string } & EncryptedPayload;

export type DeviceSecretStorePort = {
  get(name: string): Promise<StoredDeviceSecretRow | null>;
  upsert(row: { name: string; hints: DeviceSecretHints; status: string | null; verifiedAt: number | null; updatedAt: number } & EncryptedPayload): Promise<void>;
  setStatus(name: string, expectedRevision: number, patch: { status?: string | null; verifiedAt?: number | null }): Promise<boolean>;
  delete(name: string): Promise<void>;
  isMigrated(name: string): Promise<boolean>;
  markMigrated(name: string, at: number): Promise<void>;
};

/** A secret as a legacy table held it, decrypted with its legacy key file (ADR 0042 §3). */
export type LegacySecret = { plaintext: string; hints: DeviceSecretHints; status: string | null; verifiedAt: number | null };

/**
 * A legacy source of one slot: `null` when it holds nothing, `"unreadable"` when it holds a row its key file cannot open (missing
 * or unusable file) -- that one secret must then be entered again.
 */
export type LegacySecretSource = { read(): Promise<LegacySecret | null | "unreadable"> };
