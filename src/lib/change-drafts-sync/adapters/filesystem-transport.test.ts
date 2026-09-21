import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFilesystemTransportAdapter } from "./filesystem-transport";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "change-drafts-sync-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("listPeerFiles returns an empty array for a channel with no exchange directory yet", async () => {
  await withTempDir(async (root) => {
    const transport = createFilesystemTransportAdapter();
    const peers = await transport.listPeerFiles(root, "UC_test", "device-a");
    assert.deepEqual(peers, []);
  });
});

test("writeDeviceFile then listPeerFiles from a DIFFERENT device round-trips the exact bytes, creating the directory if needed", async () => {
  await withTempDir(async (root) => {
    const transport = createFilesystemTransportAdapter();
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 128]);
    await transport.writeDeviceFile(root, "UC_test", "device-a", bytes);

    const peers = await transport.listPeerFiles(root, "UC_test", "device-b");
    assert.equal(peers.length, 1);
    assert.equal(peers[0].deviceId, "device-a");
    assert.deepEqual(Array.from(peers[0].bytes), Array.from(bytes));
  });
});

test("listPeerFiles NEVER returns the caller's own file, even though it wrote one this cycle", async () => {
  await withTempDir(async (root) => {
    const transport = createFilesystemTransportAdapter();
    await transport.writeDeviceFile(root, "UC_test", "device-a", new Uint8Array([1]));
    await transport.writeDeviceFile(root, "UC_test", "device-b", new Uint8Array([2]));

    const peers = await transport.listPeerFiles(root, "UC_test", "device-a");
    assert.equal(peers.length, 1);
    assert.equal(peers[0].deviceId, "device-b");
  });
});

test("listPeerFiles ignores Syncthing's own conflict-copy and temp-file artifacts, never feeding them back as a real peer", async () => {
  await withTempDir(async (root) => {
    const transport = createFilesystemTransportAdapter();
    const channelDir = path.join(root, "UC_test");
    await mkdir(channelDir, { recursive: true });
    await writeFile(path.join(channelDir, "device-b.automerge"), new Uint8Array([9]));
    // A Syncthing same-filename-conflict copy (should never occur for this transport's own
    // per-device filenames, but defended against anyway) and a mid-replication temp file.
    await writeFile(path.join(channelDir, "device-b.sync-conflict-20260101-120000-ABCDEF.automerge"), new Uint8Array([1]));
    await writeFile(path.join(channelDir, ".syncthing.device-c.automerge.tmp"), new Uint8Array([2]));

    const peers = await transport.listPeerFiles(root, "UC_test", "device-a");
    assert.equal(peers.length, 1, "only the one genuine <deviceId>.automerge file must be returned");
    assert.equal(peers[0].deviceId, "device-b");
    assert.deepEqual(Array.from(peers[0].bytes), [9]);
  });
});

test("two different channels are stored in separate subdirectories, never mixing peer files", async () => {
  await withTempDir(async (root) => {
    const transport = createFilesystemTransportAdapter();
    await transport.writeDeviceFile(root, "UC_channel_a", "device-x", new Uint8Array([1]));
    await transport.writeDeviceFile(root, "UC_channel_b", "device-x", new Uint8Array([2]));

    const peersA = await transport.listPeerFiles(root, "UC_channel_a", "someone-else");
    const peersB = await transport.listPeerFiles(root, "UC_channel_b", "someone-else");
    assert.deepEqual(Array.from(peersA[0].bytes), [1]);
    assert.deepEqual(Array.from(peersB[0].bytes), [2]);
  });
});

test("a channelId/deviceId containing filesystem-unsafe characters is sanitized rather than escaping root", async () => {
  await withTempDir(async (root) => {
    const transport = createFilesystemTransportAdapter();
    await transport.writeDeviceFile(root, "../../etc/passwd", "../../also-bad", new Uint8Array([7]));

    const peers = await transport.listPeerFiles(root, "../../etc/passwd", "unrelated-device");
    assert.equal(peers.length, 1);
    assert.deepEqual(Array.from(peers[0].bytes), [7]);
  });
});
