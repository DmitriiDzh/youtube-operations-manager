import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import type { JobServiceDependencies } from "../jobs";

/** Local file access for the job services: create the per-job folder, hash a file, remove a file it wrote. */
export function createExchangeLocalFs(): JobServiceDependencies["fs"] {
  return {
    mkdirp: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    remove: async (filePath) => {
      await rm(filePath, { force: true });
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
