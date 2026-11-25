import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hashReviewFile } from "./files";

// BL-277 (owner TG 4922): the review files' SHA-256 pins what the owner approves (clip and image reviews). On a file system with
// whole-second modification times (HFS+, the T9 disk) a same-size file replaced within the same second keeps size and mtime, so the
// cache must never hand back the earlier file's hash. Simulated on any disk by setting whole-second times with `utimes`, so these
// fail on APFS too without the rule. Expected hashes computed by hand from the bytes written.

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (fill: number) => Buffer.alloc(4096, fill);

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "bl277-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("BL-277: a same-size file rewritten in place within the same whole second is hashed again", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "master.png");
    const second = new Date(Math.floor(Date.now() / 1000) * 1000); // the whole second a coarse file system would store
    await writeFile(file, bytesOf(1));
    await utimes(file, second, second);
    assert.equal(await hashReviewFile(file), sha(bytesOf(1)));
    await writeFile(file, bytesOf(2));
    await utimes(file, second, second);
    assert.equal(await hashReviewFile(file), sha(bytesOf(2)));
  });
});

test("BL-277: a same-size file replaced by a rename, carrying the same old mtime, is hashed again", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "clip.mp4");
    const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 3_600_000);
    await writeFile(file, bytesOf(3));
    await utimes(file, old, old);
    assert.equal(await hashReviewFile(file), sha(bytesOf(3)));
    const next = path.join(dir, ".clip.mp4.tmp");
    await writeFile(next, bytesOf(4));
    await utimes(next, old, old);
    await rename(next, file);
    assert.equal(await hashReviewFile(file), sha(bytesOf(4)));
  });
});
