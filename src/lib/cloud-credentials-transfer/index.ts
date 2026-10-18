import { createGeminiMediaCore } from "@/lib/gemini-media";
import { createMediaGenerationCore } from "@/lib/media-generation";
import type { CloudCredentialSection } from "./contracts";
import { createCloudCredentialsTransfer, type CloudCredentialsTransfer, type CredentialSectionPort } from "./services";

// BL-193 (ADR 0039 §6): the cloud-keys file wired to the real feature modules, each through its own barrel and its own public
// functions. Each core is built inside the call, so a module that cannot load fails only its own section (AGENTS.md §M).

export * from "./contracts";
export { createCloudCredentialsTransfer } from "./services";
export type { CloudCredentialsExport, CloudCredentialsImport, CloudCredentialsTransfer, CredentialSectionPort } from "./services";

type MediaCore = Pick<
  ReturnType<typeof createMediaGenerationCore>,
  "exportCredentialsForTransfer" | "getCredentialsStatus" | "checkCredentialsForImport" | "storeImportedCredentials" | "exportHfTokenForTransfer" | "getHfToken" | "checkHfTokenForImport" | "storeCheckedHfToken"
>;
type GeminiCore = Pick<ReturnType<typeof createGeminiMediaCore>, "exportKeyForTransfer" | "getKey" | "checkKeyForImport" | "storeImportedKey">;

/** Each module's section, through its own public functions; `media()` / `gemini()` are called inside each call (lazy, §M). */
export function cloudCredentialSections(media: () => MediaCore, gemini: () => GeminiCore): Record<CloudCredentialSection, CredentialSectionPort> {
  return {
    runpod: {
      async exportSecret() {
        const core = media();
        const secret = await core.exportCredentialsForTransfer();
        if (!secret) return null;
        const status = await core.getCredentialsStatus();
        return { secret, hints: { runpodKeyPrefix: status.configured ? status.runpodKeyPrefix : null, s3AccessKeyId: secret.s3AccessKeyId } };
      },
      check: (secret) => media().checkCredentialsForImport(secret),
      store: (checked) => media().storeImportedCredentials(checked as Parameters<MediaCore["storeImportedCredentials"]>[0]),
    },
    gemini: {
      async exportSecret() {
        const core = gemini();
        const apiKey = await core.exportKeyForTransfer();
        if (!apiKey) return null;
        return { secret: { apiKey }, hints: { geminiKeyHint: (await core.getKey()).keyHint } };
      },
      check: (secret) => gemini().checkKeyForImport(secret),
      store: (checked) => gemini().storeImportedKey(checked as Parameters<GeminiCore["storeImportedKey"]>[0]),
    },
    // BL-134: the Hugging Face read token (media-generation owns it). Checked with Hugging Face before ANY section is stored.
    huggingface: {
      async exportSecret() {
        const core = media();
        const token = await core.exportHfTokenForTransfer();
        if (!token) return null;
        return { secret: { token }, hints: { hfUser: (await core.getHfToken()).user } };
      },
      check: (secret) => media().checkHfTokenForImport(secret),
      store: (checked) => media().storeCheckedHfToken(checked as Parameters<MediaCore["storeCheckedHfToken"]>[0]),
    },
  };
}

export function createCloudCredentialsTransferForProduction(): CloudCredentialsTransfer {
  return createCloudCredentialsTransfer({ sections: cloudCredentialSections(createMediaGenerationCore, createGeminiMediaCore), clock: { now: () => new Date() } });
}
