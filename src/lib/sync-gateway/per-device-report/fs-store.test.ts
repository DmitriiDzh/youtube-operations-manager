import assert from "node:assert/strict";
import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createFsPerDeviceReportStore } from "./fs-store";

// BL-162 (review): the peers' reports are read from disk again only when a file changed -- and a change is always seen, whether
// it came through this store (writePeer) or from outside (the file replaced on disk).

test("BL-162: readPeers returns each peer's latest text -- written here, or changed on disk since the last read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "per-device-store-"));
  const store = createFsPerDeviceReportStore(dir);
  assert.deepEqual(await store.readPeers(), {}, "no peers folder yet");
  await store.writePeer("win", '{"v":1}');
  assert.deepEqual(await store.readPeers(), { win: '{"v":1}' });
  await store.writePeer("win", '{"v":2}');
  assert.deepEqual(await store.readPeers(), { win: '{"v":2}' }, "a write here is seen at once");
  // Replaced on disk with the same size; its modification time moves.
  const file = path.join(dir, "peers", "win.json");
  await writeFile(file, '{"v":3}');
  const later = new Date(Date.now() + 5_000);
  await utimes(file, later, later);
  assert.deepEqual(await store.readPeers(), { win: '{"v":3}' }, "a change on disk is seen");
  assert.deepEqual(await store.readPeers(), { win: '{"v":3}' }, "and read again from the cache");
});

// BL-270 (owner TG 4662/4665): the sync cycle hands over the same peer report every minute; it is not rewritten then.
test("BL-270: an unchanged peer report or local report is not rewritten; a changed one is, and is read back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "per-device-store-"));
  const store = createFsPerDeviceReportStore(dir);
  await store.writePeer("win", '{"v":1}');
  await store.writeLocal('{"own":1}');
  const peerFile = path.join(dir, "peers", "win.json");
  const localFile = path.join(dir, "local.json");
  const old = new Date(Math.floor(Date.now() / 1000) * 1000 - 60 * 60_000); // whole seconds: HFS+ (the T9 disk) keeps 1 s mtimes
  await utimes(peerFile, old, old);
  await utimes(localFile, old, old);
  await store.writePeer("win", '{"v":1}');
  await store.writeLocal('{"own":1}');
  assert.equal((await stat(peerFile)).mtimeMs, old.getTime());
  assert.equal((await stat(localFile)).mtimeMs, old.getTime());
  assert.deepEqual(await store.readPeers(), { win: '{"v":1}' });
  await store.writePeer("win", '{"v":2}');
  await store.writeLocal('{"own":2}');
  assert.deepEqual(await store.readPeers(), { win: '{"v":2}' }, "a real change is written and seen at once");
  assert.equal(await store.readLocal(), '{"own":2}');
});

// BL-277 (owner TG 4922): HFS+ keeps whole-second mtimes. A peer report replaced by another store (another module's instance, or the
// sync tool) with the same size, in the same second the reader cached it, must still be seen.
test("BL-277: a same-size peer report replaced in the same whole second by another writer is seen by the reader", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "per-device-store-"));
  const reader = createFsPerDeviceReportStore(dir);
  const writer = createFsPerDeviceReportStore(dir);
  const file = path.join(dir, "peers", "win.json");
  const second = new Date(Math.floor(Date.now() / 1000) * 1000);
  await writer.writePeer("win", '{"v":1}');
  await utimes(file, second, second);
  assert.deepEqual(await reader.readPeers(), { win: '{"v":1}' });
  await writer.writePeer("win", '{"v":2}');
  await utimes(file, second, second);
  assert.deepEqual(await reader.readPeers(), { win: '{"v":2}' });
});
