import { decryptWithPassword, encryptWithPassword, type ScryptParams } from "@/lib/shared-crypto";
import { DomainError, isDomainError, parseWithSchema } from "@/lib/shared-domain";
import {
  CLOUD_CREDENTIALS_FILE_FORMAT,
  CLOUD_CREDENTIAL_SECTIONS,
  cloudCredentialsPayloadSchema,
  exportCloudCredentialsInputSchema,
  importCloudCredentialsInputSchema,
  type CloudCredentialSection,
  type CloudCredentialsFile,
} from "./contracts";

// BL-193 (ADR 0039 §6): the shared module that builds and reads the one cloud-keys file. It knows no provider: each feature module
// hands over its own secret and takes it back through a port (`./index.ts` wires media-generation's and gemini-media's public
// functions), so neither feature module reaches into the other (AGENTS.md §M). Secrets live here only for one call, go straight
// into the password-encrypted payload, and are never logged or returned.

/** One feature module's part of the file. */
export type CredentialSectionPort = {
  /** This computer's secret with its public hints, or null when none is stored. Throws when a stored secret cannot be read. */
  exportSecret(): Promise<{ secret: unknown; hints: Record<string, string | null> } | null>;
  /** Validates the imported secret and checks it with its provider, storing nothing; throws when it is refused. */
  check(secret: unknown): Promise<unknown>;
  /** Stores what `check` accepted, exactly like a typed key; returns the module's public view (never the secret). */
  store(checked: unknown): Promise<unknown>;
};

export type CloudCredentialsTransferDeps = {
  sections: Record<CloudCredentialSection, CredentialSectionPort>;
  clock: { now(): Date };
  /** scrypt cost; omitted = `PASSWORD_SCRYPT_PARAMS` (tests pass a cheap one). */
  passwordScrypt?: ScryptParams;
};

export type CloudCredentialsExport = {
  file: CloudCredentialsFile;
  /** A section whose stored secret could not be read is left out (with why), so one broken module never blocks the others' keys. */
  skipped: Array<{ section: CloudCredentialSection; code: string; message: string }>;
};

export type CloudCredentialsImport = {
  /** Each section the file carried, with its module's public view after the import; sections absent from the file are untouched. */
  imported: Partial<Record<CloudCredentialSection, unknown>>;
};

const nothingChanged = (message: string) => new DomainError({ code: "validation_failed", message: `${message} Nothing was changed.` });

export function createCloudCredentialsTransfer(deps: CloudCredentialsTransferDeps) {
  return {
    async exportFile(input: unknown): Promise<CloudCredentialsExport> {
      const { password } = parseWithSchema(exportCloudCredentialsInputSchema, input, "export credentials");
      const payload: Partial<Record<CloudCredentialSection, unknown>> = {};
      const hints: Record<string, string | null> = {};
      const skipped: CloudCredentialsExport["skipped"] = [];
      for (const section of CLOUD_CREDENTIAL_SECTIONS) {
        try {
          const exported = await deps.sections[section].exportSecret();
          if (!exported) continue;
          payload[section] = exported.secret;
          Object.assign(hints, exported.hints);
        } catch (error) {
          skipped.push({ section, code: isDomainError(error) ? error.code : "internal_error", message: error instanceof Error ? error.message : String(error) });
        }
      }
      const sections = CLOUD_CREDENTIAL_SECTIONS.filter((section) => payload[section] !== undefined);
      if (sections.length === 0) {
        throw new DomainError({
          code: "cloud_credentials_not_configured",
          message: skipped.length > 0 ? `No cloud key on this computer can be read: ${skipped.map((s) => s.message).join(" ")}` : "No RunPod or Gemini key is stored on this computer: there is nothing to export.",
          details: { skipped: skipped.map((s) => ({ section: s.section, code: s.code })) },
        });
      }
      const encrypted = await encryptWithPassword(JSON.stringify(payload), password, deps.passwordScrypt);
      return {
        file: {
          format: CLOUD_CREDENTIALS_FILE_FORMAT,
          version: 1,
          createdAt: deps.clock.now().toISOString(),
          sections,
          hints: { runpodKeyPrefix: hints.runpodKeyPrefix ?? null, s3AccessKeyId: hints.s3AccessKeyId ?? null, geminiKeyHint: hints.geminiKeyHint ?? null },
          encrypted,
        },
        skipped,
      };
    },

    /**
     * Imports a `ytm-cloud-credentials` file, or BL-137's `ytm-runpod-credentials` (RunPod/S3 only). Only the sections the file
     * carries are touched. All or nothing as far as the providers can tell: a wrong password, a damaged file, or ANY key its
     * provider refuses (or RunPod's "volume busy") stores nothing; only then is each section stored, RunPod first.
     */
    async importFile(input: unknown): Promise<CloudCredentialsImport> {
      const { file, password } = parseWithSchema(importCloudCredentialsInputSchema, input, "import credentials");
      let plaintext: string;
      try {
        plaintext = await decryptWithPassword(file.encrypted, password);
      } catch {
        throw nothingChanged("Wrong password, or the credentials file is damaged.");
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(plaintext);
      } catch {
        throw nothingChanged("The credentials file is damaged.");
      }
      let secrets: Partial<Record<CloudCredentialSection, unknown>>;
      if (file.format === CLOUD_CREDENTIALS_FILE_FORMAT) {
        const parsed = cloudCredentialsPayloadSchema.safeParse(decoded);
        if (!parsed.success) throw nothingChanged("The credentials file is damaged.");
        secrets = parsed.data;
      } else {
        // BL-137's file: the ciphertext is the RunPod set itself.
        secrets = { runpod: decoded };
      }
      const present = CLOUD_CREDENTIAL_SECTIONS.filter((section) => secrets[section] !== undefined);
      if (present.length === 0) throw nothingChanged("The credentials file holds no key.");

      const checked: Array<[CloudCredentialSection, unknown]> = [];
      for (const section of present) {
        try {
          checked.push([section, await deps.sections[section].check(secrets[section])]);
        } catch (error) {
          if (isDomainError(error)) {
            const tail = /Nothing was changed\.$|not saved\.$/.test(error.message) ? "" : " Nothing was changed.";
            throw new DomainError({ code: error.code, message: `${section === "runpod" ? "RunPod" : "Gemini"}: ${error.message}${tail}`, details: { ...(error.details as Record<string, unknown> | undefined), section } });
          }
          throw error;
        }
      }
      const imported: CloudCredentialsImport["imported"] = {};
      for (const [section, value] of checked) {
        try {
          imported[section] = await deps.sections[section].store(value);
        } catch (error) {
          const done = Object.keys(imported);
          const message = `${section === "runpod" ? "RunPod" : "Gemini"} could not be stored: ${error instanceof Error ? error.message : String(error)}${done.length > 0 ? ` (already stored: ${done.join(", ")})` : " Nothing was changed."}`;
          if (isDomainError(error)) throw new DomainError({ code: error.code, message, details: { section, stored: done } });
          throw new Error(message);
        }
      }
      return { imported };
    },
  };
}

export type CloudCredentialsTransfer = ReturnType<typeof createCloudCredentialsTransfer>;
