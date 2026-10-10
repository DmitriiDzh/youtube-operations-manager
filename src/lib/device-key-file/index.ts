import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";

// ---------------------------------------------------------------------------
// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §2.1, AGENTS.md §M): the per-device encryption key file, shared by every
// module that keeps a secret entered in Settings (RunPod/S3 since Phase 14, the Gemini API key since BL-174). Moved here
// unchanged from `media-generation/key-file.ts` + `adapters/key-file-fs.ts`; each module keeps its OWN file (clearing one
// module's credentials deletes only its file) and its own error for an unusable file.
// ---------------------------------------------------------------------------

const KEY_BYTES = 32;

export type KeyFileContent = { version: 1; key: string };

export type KeyFileAccess = {
  /** `null` when the file does not exist. Throws on any other I/O failure. */
  read(): Promise<string | null>;
  /** Writes the JSON content privately (0600) and atomically. */
  write(content: KeyFileContent): Promise<void>;
  /** Deletes the file; a missing file is fine. */
  remove(): Promise<void>;
  randomBytes(size: number): Buffer;
};

function parseKeyFile(text: string, invalid: (detail: string) => Error): Buffer {
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

/** `invalid` builds the owning module's error for a file that exists but is unusable (it fails closed). */
export function createKeyFile(access: KeyFileAccess, invalid: (detail: string) => Error) {
  /** Reads the key; `null` if no file exists yet (reads never create one). */
  async function readKey(): Promise<Buffer | null> {
    const text = await access.read();
    return text === null ? null : parseKeyFile(text, invalid);
  }
  // Plain closures, no `this`: the methods keep working when passed detached (review round 11).
  return {
    readKey,

    /** Deletes the key file (with the credentials row it protected): the only remedy for a corrupt file (review round 16). */
    async removeKey(): Promise<void> {
      await access.remove();
    },

    /** Reads the key, creating it on first use -- for the operator's "save credentials" only. */
    async readOrCreateKey(): Promise<Buffer> {
      const existing = await readKey();
      if (existing) return existing;
      const key = access.randomBytes(KEY_BYTES);
      await access.write({ version: 1, key: key.toString("base64") });
      return key;
    },
  };
}

export type KeyFile = ReturnType<typeof createKeyFile>;

/** Real file access: `writeJsonFileAtomic` gives the tmp-write -> chmod 0600 -> rename sequence (AC-P14-21). */
export function createKeyFileFsAccess(filePath: string): KeyFileAccess {
  return {
    async read() {
      try {
        return await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(content) {
      await writeJsonFileAtomic(filePath, content);
    },
    async remove() {
      await rm(filePath, { force: true });
    },
    randomBytes: (size) => randomBytes(size),
  };
}
