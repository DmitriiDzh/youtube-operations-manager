import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function sha256File(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const stats = await stat(filePath);
  const hash = createHash("sha256");

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });

  return { sha256: hash.digest("hex"), sizeBytes: stats.size };
}
