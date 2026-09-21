import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFilesystemChangeDraftsStore } from "./automerge-store";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "change-drafts-store-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadDocumentBytes returns null for a channel that has never been saved", async () => {
  await withTempDir(async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    const bytes = await store.loadDocumentBytes("UC_never_saved");
    assert.equal(bytes, null);
  });
});

test("saveDocumentBytes then loadDocumentBytes round-trips the exact bytes, creating the directory if needed", async () => {
  await withTempDir(async (dir) => {
    const nestedDir = path.join(dir, "does", "not", "exist", "yet");
    const store = createFilesystemChangeDraftsStore(nestedDir);
    const original = new Uint8Array([1, 2, 3, 4, 250, 0, 128]);

    await store.saveDocumentBytes("UC_channel_a", original);
    const loaded = await store.loadDocumentBytes("UC_channel_a");

    assert.ok(loaded);
    assert.deepEqual(Array.from(loaded!), Array.from(original));
  });
});

test("two different channelIds are stored as two distinct files, never overwriting each other", async () => {
  await withTempDir(async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    await store.saveDocumentBytes("UC_channel_a", new Uint8Array([1]));
    await store.saveDocumentBytes("UC_channel_b", new Uint8Array([2]));

    const a = await store.loadDocumentBytes("UC_channel_a");
    const b = await store.loadDocumentBytes("UC_channel_b");
    assert.deepEqual(Array.from(a!), [1]);
    assert.deepEqual(Array.from(b!), [2]);
  });
});

test("a channelId containing filesystem-unsafe characters is sanitized rather than escaping baseDir", async () => {
  await withTempDir(async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    await store.saveDocumentBytes("../../etc/passwd", new Uint8Array([9]));

    const entries = await readFile(path.join(dir, "______etc_passwd.automerge"));
    assert.deepEqual(Array.from(new Uint8Array(entries)), [9]);
  });
});
