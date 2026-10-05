import { DomainError } from "./contracts";

// ---------------------------------------------------------------------------
// Per-device encryption key for `media_credentials` (PHASE_14_PLAN.md §2.9, owner instruction
// 2026-10-05: keys entered in Settings, "сохранять закодировано локально на каждой машине").
// Unlike `ai-connections`/`cloud-connection` (env var), the key is a file the app creates itself,
// so the operator never edits `.env`. Pure logic with injected file access; the real adapter is
// `adapters/key-file-fs.ts` (0600 via `writeJsonFileAtomic`).
// ---------------------------------------------------------------------------

const KEY_BYTES = 32;

export type KeyFileContent = { version: 1; key: string };

export type KeyFileAccess = {
  /** `null` when the file does not exist. Throws on any other I/O failure. */
  read(): Promise<string | null>;
  /** Writes the JSON content privately (0600) and atomically. */
  write(content: KeyFileContent): Promise<void>;
  randomBytes(size: number): Buffer;
};

function parseKeyFile(text: string): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid("the key file is not valid JSON");
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  if (record.version !== 1 || typeof record.key !== "string") throw invalid("the key file has an unexpected shape");
  const key = Buffer.from(record.key, "base64");
  if (key.length !== KEY_BYTES) throw invalid("the key file does not hold a 32-byte key");
  return key;
}

function invalid(detail: string): DomainError {
  return new DomainError({
    code: "encryption_key_not_configured",
    message: `The media-generation key file exists but is unusable (${detail}). Clear the stored credentials and enter them again.`,
  });
}

export function createKeyFile(access: KeyFileAccess) {
  return {
    /** Reads the key; `null` if no file exists yet (reads never create one). */
    async readKey(): Promise<Buffer | null> {
      const text = await access.read();
      return text === null ? null : parseKeyFile(text);
    },

    /** Reads the key, creating it on first use -- for the operator's "save credentials" only. */
    async readOrCreateKey(): Promise<Buffer> {
      const existing = await this.readKey();
      if (existing) return existing;
      const key = access.randomBytes(KEY_BYTES);
      await access.write({ version: 1, key: key.toString("base64") });
      return key;
    },
  };
}

export type KeyFile = ReturnType<typeof createKeyFile>;
