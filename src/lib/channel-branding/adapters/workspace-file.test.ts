import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileCapped } from "./workspace-file";

// BL-223 review #3: the agent's banner is read from one handle, its identity checked, never more than the cap + 1 bytes.

test("readFileCapped: reads a file within the cap; refuses one over it and one whose identity changed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "banner-capped-"));
  try {
    const small = path.join(dir, "small.png");
    await writeFile(small, Buffer.alloc(10, 1));
    const info = await stat(small);
    assert.equal((await readFileCapped(small, { dev: info.dev, ino: info.ino }, 10)).length, 10, "exactly the cap passes");
    const big = path.join(dir, "big.png");
    await writeFile(big, Buffer.alloc(11, 1));
    await assert.rejects(readFileCapped(big, undefined, 10), { code: "banner_too_large" });
    await assert.rejects(readFileCapped(small, { dev: info.dev, ino: info.ino + 1 }, 10), /changed after it was checked/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
