import { z } from "zod";

// BL-193 (owner, Telegram 2026-10-16, msgs 2864/2867, "variant 1"; ADR 0039 §6, extending ADR 0027): one password-encrypted file
// carries every cloud key of this computer -- RunPod with its S3 pair, and the Gemini key -- to another computer. The file holds
// only ciphertext and public hints in clear; the password is never stored or logged.

export const CLOUD_CREDENTIALS_FILE_FORMAT = "ytm-cloud-credentials";
/** BL-137's file (RunPod/S3 only): still imported, never written any more. */
export const LEGACY_RUNPOD_CREDENTIALS_FILE_FORMAT = "ytm-runpod-credentials";
export const CREDENTIALS_EXPORT_MIN_PASSWORD = 12;

/** BL-134 (ADR 0042): the Hugging Face read token joins the file as its own section. */
export const CLOUD_CREDENTIAL_SECTIONS = ["runpod", "gemini", "huggingface"] as const;
export type CloudCredentialSection = (typeof CLOUD_CREDENTIAL_SECTIONS)[number];

export const exportCloudCredentialsInputSchema = z
  .object({ password: z.string().min(CREDENTIALS_EXPORT_MIN_PASSWORD, `use at least ${CREDENTIALS_EXPORT_MIN_PASSWORD} characters`).max(256) })
  .strict();

const base64 = z.string().min(1).max(8192).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const encryptedSchema = z
  .object({ kdf: z.literal("scrypt"), salt: base64, N: z.number().int(), r: z.number().int(), p: z.number().int(), ciphertext: base64, iv: base64, authTag: base64 })
  .strict();

export const cloudCredentialsFileSchema = z
  .object({
    format: z.literal(CLOUD_CREDENTIALS_FILE_FORMAT),
    version: z.literal(1),
    createdAt: z.string().max(64),
    /** Which sections the ciphertext holds, and their public hints (never a secret: a key prefix, the S3 key id, a key's last 4). */
    sections: z.array(z.enum(CLOUD_CREDENTIAL_SECTIONS)).min(1).max(CLOUD_CREDENTIAL_SECTIONS.length),
    hints: z
      .object({
        runpodKeyPrefix: z.string().max(64).nullable(),
        s3AccessKeyId: z.string().max(256).nullable(),
        geminiKeyHint: z.string().max(8).nullable(),
        // BL-134: absent in files written before it.
        hfUser: z.string().max(200).nullable().optional(),
      })
      .strict(),
    encrypted: encryptedSchema,
  })
  .strict();

export const legacyRunpodCredentialsFileSchema = z
  .object({
    format: z.literal(LEGACY_RUNPOD_CREDENTIALS_FILE_FORMAT),
    version: z.literal(1),
    createdAt: z.string().max(64),
    hints: z.object({ runpodKeyPrefix: z.string().max(64).nullable(), s3AccessKeyId: z.string().max(256).nullable() }).strict(),
    encrypted: encryptedSchema,
  })
  .strict();

export const importCloudCredentialsInputSchema = z
  .object({ file: z.union([cloudCredentialsFileSchema, legacyRunpodCredentialsFileSchema]), password: z.string().min(1).max(256) })
  .strict();

/** What the ciphertext of a `ytm-cloud-credentials` file decrypts to: each section's secret as its own module handed it over. */
export const cloudCredentialsPayloadSchema = z
  .object({
    runpod: z.unknown().optional(),
    gemini: z.object({ apiKey: z.string().min(1).max(512) }).strict().optional(),
    huggingface: z.object({ token: z.string().min(1).max(512) }).strict().optional(),
  })
  .strict();

export type CloudCredentialsFile = z.infer<typeof cloudCredentialsFileSchema>;
export type LegacyRunpodCredentialsFile = z.infer<typeof legacyRunpodCredentialsFileSchema>;
