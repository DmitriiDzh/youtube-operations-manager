import assert from "node:assert/strict";
import test from "node:test";
import { COARSE_MTIME_SLACK_MS, cachedForFile, fileStampKey, isSettledAt, type FileStamp } from "./index";

// BL-277 (owner TG 4922): a file system that keeps modification times to whole seconds (HFS+ on the T9 disk, where channel workspaces
// and media live) gives a file replaced within the same second the same size and mtime as the one before. A value cached per path,
// size and mtime must therefore be trusted only for a file last changed at least 2 s before the value was computed, and a file
// replaced by a rename (another inode) must never hit. Expected values by hand from that rule, through fake ports (no real disk,
// so the rule itself is tested -- on APFS a real rewrite would also move the nanosecond ctime).

const NOW = 1_800_000_000_000; // a whole second
const stamp = (over: Partial<FileStamp> = {}): FileStamp => ({ size: 1000, mtimeMs: NOW - 60_000, ctimeMs: NOW - 60_000, ino: 7, dev: 1, ...over });

function harness() {
  const store = new Map<string, string>();
  let reads = 0;
  let content = "A";
  let now = NOW;
  const get = (s: FileStamp, scope = "file") =>
    cachedForFile({
      store,
      scope,
      stamp: s,
      now: () => now,
      compute: async () => {
        reads++;
        return `sha(${content})`;
      },
    });
  return {
    get,
    store,
    get reads() {
      return reads;
    },
    set content(value: string) {
      content = value;
    },
    set now(value: number) {
      now = value;
    },
  };
}

test("BL-277: the coarse-clock slack is 2 s", () => {
  assert.equal(COARSE_MTIME_SLACK_MS, 2_000);
});

test("BL-277: a file last changed at least 2 s ago is settled; a newer one, or one dated in the future, is not", () => {
  assert.equal(isSettledAt(stamp({ mtimeMs: NOW - 2_000, ctimeMs: NOW - 2_000 }), NOW), true);
  assert.equal(isSettledAt(stamp({ mtimeMs: NOW - 1_999, ctimeMs: NOW - 5_000 }), NOW), false);
  // ctime counts too: a same-size copy that kept an old mtime (cp -p) changed its ctime now.
  assert.equal(isSettledAt(stamp({ mtimeMs: NOW - 60_000, ctimeMs: NOW - 1_000 }), NOW), false);
  assert.equal(isSettledAt(stamp({ mtimeMs: NOW + 5_000, ctimeMs: NOW + 5_000 }), NOW), false);
  // A port that knows no ctime: the mtime alone decides.
  assert.equal(isSettledAt({ size: 1, mtimeMs: NOW - 3_000 }, NOW), true);
  assert.equal(isSettledAt({ size: 1, mtimeMs: NOW - 1_000 }, NOW), false);
});

test("BL-277: the key differs for another size, mtime, ctime, inode or device", () => {
  const base = fileStampKey(stamp());
  for (const over of [{ size: 1001 }, { mtimeMs: NOW - 59_000 }, { ctimeMs: NOW - 59_000 }, { ino: 8 }, { dev: 2 }]) {
    assert.notEqual(fileStampKey(stamp(over)), base, JSON.stringify(over));
  }
  assert.equal(fileStampKey(stamp()), base);
});

test("BL-277: an unchanged old file is read once -- later reads are cache hits", async () => {
  const h = harness();
  assert.equal(await h.get(stamp()), "sha(A)");
  assert.equal(await h.get(stamp()), "sha(A)");
  assert.equal(await h.get(stamp()), "sha(A)");
  assert.equal(h.reads, 1);
});

test("BL-277: a same-size replacement within the same whole second (same inode, same ctime) is detected", async () => {
  // Hashed 1 s after it was written; on a whole-second file system the replacement carries exactly the same stamp.
  const h = harness();
  const written = stamp({ mtimeMs: NOW - 1_000, ctimeMs: NOW - 1_000 });
  assert.equal(await h.get(written), "sha(A)");
  h.content = "B";
  h.now = NOW + 500;
  assert.equal(await h.get(written), "sha(B)", "a value computed for a fresh file is never reused");
  assert.equal(h.reads, 2);
});

test("BL-277: a fresh file is not cached, so it is re-read until it is 2 s old, then cached", async () => {
  const h = harness();
  const written = stamp({ mtimeMs: NOW, ctimeMs: NOW });
  await h.get(written);
  h.now = NOW + 1_999;
  await h.get(written);
  assert.equal(h.reads, 2);
  assert.equal(h.store.size, 0);
  h.now = NOW + 2_000;
  h.content = "B";
  assert.equal(await h.get(written), "sha(B)");
  h.now = NOW + 10_000;
  assert.equal(await h.get(written), "sha(B)");
  assert.equal(h.reads, 3);
});

test("BL-277: a rename-replacement (another inode, otherwise the same stamp) is detected", async () => {
  const h = harness();
  assert.equal(await h.get(stamp()), "sha(A)");
  h.content = "B";
  assert.equal(await h.get(stamp({ ino: 99 })), "sha(B)");
  assert.equal(h.reads, 2);
});

test("BL-277: the scope separates entries (the same file under another manifest is read again)", async () => {
  const h = harness();
  await h.get(stamp(), "manifest-1");
  await h.get(stamp(), "manifest-2");
  await h.get(stamp(), "manifest-1");
  assert.equal(h.reads, 2);
});

test("BL-277: a failed read is not cached", async () => {
  const store = new Map<string, string>();
  await assert.rejects(cachedForFile({ store, scope: "f", stamp: stamp(), now: () => NOW, compute: async () => Promise.reject(new Error("EIO")) }), /EIO/);
  assert.equal(store.size, 0);
});
