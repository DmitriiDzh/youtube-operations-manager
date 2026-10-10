import { createKeyFile as createDeviceKeyFile, type KeyFileAccess, type KeyFileContent } from "@/lib/device-key-file";
import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// Per-device encryption key for `media_credentials` (PHASE_14_PLAN.md §2.9, owner instruction
// 2026-10-05: keys entered in Settings, "сохранять закодировано локально на каждой машине").
// Unlike `ai-connections`/`cloud-connection` (env var), the key is a file the app creates itself,
// so the operator never edits `.env`. BL-174: the logic moved to the shared `device-key-file`
// module (the Gemini key uses it too); this module keeps its own file and its own error text.
// ---------------------------------------------------------------------------

export type { KeyFileAccess, KeyFileContent };

function invalid(detail: string): DomainError {
  return new DomainError({
    code: "encryption_key_not_configured",
    message: `The media-generation key file exists but is unusable (${detail}). Clear the stored credentials and enter them again.`,
  });
}

export function createKeyFile(access: KeyFileAccess) {
  return createDeviceKeyFile(access, invalid);
}

export type KeyFile = ReturnType<typeof createKeyFile>;
