import { open } from "node:fs/promises";

// BL-223 review #3: an agent's banner is read from ONE opened handle -- its fstat must still be the file the shared resolver proved
// inside `Sent to YTM` (same dev/ino), and at most `cap + 1` bytes are ever read (a file grown past the cap is seen as too large,
// never buffered whole).

export async function readFileCapped(filePath: string, identity: { dev: number; ino: number } | undefined, cap: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (identity && (info.dev !== identity.dev || info.ino !== identity.ino)) throw new Error("the file changed after it was checked");
    const buffer = Buffer.alloc(Math.min(info.size, cap) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > cap) throw Object.assign(new Error(`larger than ${cap} bytes`), { code: "banner_too_large" });
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}
