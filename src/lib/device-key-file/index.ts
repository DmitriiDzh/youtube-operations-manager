import { randomBytes } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";

// ---------------------------------------------------------------------------
// BL-174 (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §2.1, AGENTS.md §M): the per-device encryption key file. Since BL-199
// (ADR 0042) its one user is `src/lib/device-secrets` (`device-secrets.key`, every typed secret of this computer); the
// pre-BL-199 files (`media-generation.key`, `gemini-media.key`) are only read, by its legacy migration.
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
  /**
   * FO-MSG-0018: writes the content only if NO file exists yet, all or nothing; `false` when one already exists (another caller
   * created it first). Absent = this access cannot do it atomically (in-memory fakes): `write` is used, guarded in-process only.
   */
  createExclusive?(content: KeyFileContent): Promise<boolean>;
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
  let creating: Promise<Buffer> | null = null;
  // Plain closures, no `this`: the methods keep working when passed detached (review round 11).
  return {
    readKey,

    /** Deletes the key file (with the credentials row it protected): the only remedy for a corrupt file (review round 16). */
    async removeKey(): Promise<void> {
      await access.remove();
    },

    /**
     * Reads the key, creating it on first use. FO-MSG-0018 (2026-10-18): two first uses at once (the RunPod and the Gemini secret
     * moving at the same start) each created a key and the last write won, leaving one secret sealed with a key nobody has. Now
     * one creation runs at a time in this process, the file is created only if absent, and the key returned is always the one in
     * the file.
     */
    readOrCreateKey(): Promise<Buffer> {
      creating ??= (async () => {
        const existing = await readKey();
        if (existing) return existing;
        const content: KeyFileContent = { version: 1, key: access.randomBytes(KEY_BYTES).toString("base64") };
        if (access.createExclusive) await access.createExclusive(content);
        else await access.write(content);
        const stored = await readKey();
        if (!stored) throw invalid("the key file could not be created");
        return stored;
      })().finally(() => {
        creating = null;
      });
      return creating;
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
    async createExclusive(content) {
      // A private temp file, then a hard link to the final name: link() fails with EEXIST if the name exists, and the final file
      // is never half-written -- also across processes (the CLI next to the server).
      const temp = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify(content), { mode: 0o600, flag: "wx" });
      try {
        await link(temp, filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      } finally {
        await rm(temp, { force: true });
      }
    },
    randomBytes: (size) => randomBytes(size),
  };
}
