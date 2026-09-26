import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createFilesystemChangeDraftsStore } from "./automerge-store";
import { withTempDir } from "@/test-support/temp-dir";

test("loadDocumentBytes returns null for a channel that has never been saved", async () => {
  await withTempDir("change-drafts-store-test-", async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    const bytes = await store.loadDocumentBytes("UC_never_saved");
    assert.equal(bytes, null);
  });
});

test("saveDocumentBytes then loadDocumentBytes round-trips the exact bytes, creating the directory if needed", async () => {
  await withTempDir("change-drafts-store-test-", async (dir) => {
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
  await withTempDir("change-drafts-store-test-", async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    await store.saveDocumentBytes("UC_channel_a", new Uint8Array([1]));
    await store.saveDocumentBytes("UC_channel_b", new Uint8Array([2]));

    const a = await store.loadDocumentBytes("UC_channel_a");
    const b = await store.loadDocumentBytes("UC_channel_b");
    assert.deepEqual(Array.from(a!), [1]);
    assert.deepEqual(Array.from(b!), [2]);
  });
});

test("saveDocumentBytes writes atomically: no leftover .tmp file after a save, and a second save leaves only the final file behind", async () => {
  await withTempDir("change-drafts-store-test-", async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    await store.saveDocumentBytes("UC_atomic", new Uint8Array([1, 2, 3]));
    await store.saveDocumentBytes("UC_atomic", new Uint8Array([4, 5, 6]));

    const entries = await readdir(dir);
    assert.deepEqual(entries, ["UC_atomic.automerge"], "no .tmp file should survive a successful save");

    const loaded = await store.loadDocumentBytes("UC_atomic");
    assert.deepEqual(Array.from(loaded!), [4, 5, 6], "the final file must hold the latest bytes, not a stale or partial write");
  });
});

test("a channelId containing filesystem-unsafe characters is sanitized rather than escaping baseDir", async () => {
  await withTempDir("change-drafts-store-test-", async (dir) => {
    const store = createFilesystemChangeDraftsStore(dir);
    await store.saveDocumentBytes("../../etc/passwd", new Uint8Array([9]));

    const entries = await readFile(path.join(dir, "______etc_passwd.automerge"));
    assert.deepEqual(Array.from(new Uint8Array(entries)), [9]);
  });
});
