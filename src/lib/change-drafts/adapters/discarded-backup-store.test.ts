import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiscardedDocumentBackupStore } from "./discarded-backup-store";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "discarded-backup-store-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("backup writes the exact bytes to a new file, creating the directory if needed", async () => {
  await withTempDir(async (parent) => {
    const baseDir = path.join(parent, "does", "not", "exist", "yet");
    const store = createDiscardedDocumentBackupStore(baseDir);
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128]);

    const result = await store.backup("UC_test", bytes);

    const onDisk = await readFile(result.path);
    assert.deepEqual(Array.from(new Uint8Array(onDisk)), Array.from(bytes));
  });
});

test("backup never overwrites -- two calls for the same channel produce two distinct files", async () => {
  await withTempDir(async (baseDir) => {
    const store = createDiscardedDocumentBackupStore(baseDir);
    const first = await store.backup("UC_test", new Uint8Array([1]));
    const second = await store.backup("UC_test", new Uint8Array([2]));

    assert.notEqual(first.path, second.path);
    const entries = await readdir(baseDir);
    assert.equal(entries.length, 2);

    const firstOnDisk = await readFile(first.path);
    const secondOnDisk = await readFile(second.path);
    assert.deepEqual(Array.from(new Uint8Array(firstOnDisk)), [1]);
    assert.deepEqual(Array.from(new Uint8Array(secondOnDisk)), [2]);
  });
});

test("a channelId containing filesystem-unsafe characters is sanitized rather than escaping baseDir", async () => {
  await withTempDir(async (baseDir) => {
    const store = createDiscardedDocumentBackupStore(baseDir);
    const result = await store.backup("../../etc/passwd", new Uint8Array([9]));
    assert.ok(path.resolve(result.path).startsWith(path.resolve(baseDir)));
  });
});
