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
  const old = new Date(Date.now() - 60 * 60_000);
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
