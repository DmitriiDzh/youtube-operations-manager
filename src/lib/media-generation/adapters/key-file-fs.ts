import { randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";
import { MEDIA_KEY_FILE_NAME } from "../contracts";
import { createKeyFile, type KeyFile, type KeyFileAccess } from "../key-file";

export function mediaKeyFilePath(appDataDir: string): string {
  return path.join(appDataDir, MEDIA_KEY_FILE_NAME);
}

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

export function createFsKeyFile(appDataDir: string): KeyFile {
  return createKeyFile(createKeyFileFsAccess(mediaKeyFilePath(appDataDir)));
}
