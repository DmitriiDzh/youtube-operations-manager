import path from "node:path";
import { createKeyFileFsAccess } from "@/lib/device-key-file";
import { MEDIA_KEY_FILE_NAME } from "../contracts";
import { createKeyFile, type KeyFile } from "../key-file";

// BL-174: the file access itself lives in the shared `device-key-file` module (0600 via `writeJsonFileAtomic`).
export { createKeyFileFsAccess };

export function mediaKeyFilePath(appDataDir: string): string {
  return path.join(appDataDir, MEDIA_KEY_FILE_NAME);
}

export function createFsKeyFile(appDataDir: string): KeyFile {
  return createKeyFile(createKeyFileFsAccess(mediaKeyFilePath(appDataDir)));
}
