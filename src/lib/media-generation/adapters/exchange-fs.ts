import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import type { JobServiceDependencies } from "../jobs";

/** Local file access for the job services: create the per-job folder, hash a file, remove a file it wrote, write the manifest. */
export function createExchangeLocalFs(): JobServiceDependencies["fs"] {
  return {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    remove: async (filePath) => {
      await rm(filePath, { force: true });
    },
    writeFileAtomic: async (filePath, text) => {
      // Same convention as the media files (`runpod-s3.ts`): readers ignore `*.part`, the final name appears complete.
      const tmpPath = `${filePath}.part`;
      await rm(tmpPath, { force: true });
      await writeFile(tmpPath, text, { encoding: "utf8", flag: "wx" });
      await rename(tmpPath, filePath);
    },
    sha256File: (filePath) =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(filePath)
          .on("data", (chunk) => hash.update(chunk))
          .on("error", reject)
          .on("end", () => resolve(hash.digest("hex")));
      }),
  };
}
