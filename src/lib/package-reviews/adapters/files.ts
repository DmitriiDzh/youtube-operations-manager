import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** A whole file's SHA-256 (lower-case hex), read as a stream (a multi-GB episode never sits in memory). */
export function hashPackageFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(absolutePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
