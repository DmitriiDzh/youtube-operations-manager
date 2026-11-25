import assert from "node:assert/strict";
import { mkdir, readFile, stat, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { withTempDir } from "@/test-support/temp-dir";
import { createAutomergeCore } from "./engine";
import { createDiscardedDocumentBackupStore, createFilesystemDocumentStore } from "./store";
import { createSyncRunner } from "./sync-runner";
import { createPerChannelFilesystemTransport } from "./transport";

// BL-270 (owner TG 4662/4665): every family's sync cycle (every 60 s) saved each document and pushed it to the sync folder even when
// nothing had changed -- a fresh mtime and an fsync per file per minute, and a Syncthing rescan. Requirement: a cycle that brings
// nothing new writes nothing; a cycle that brings a change still saves and pushes it.

type Doc = { key: string; notes: Record<string, string> };
const emptyDocument = (key: string): Doc => ({ key, notes: {} });

const OLD = new Date(Math.floor(Date.now() / 1000) * 1000 - 60 * 60_000); // whole seconds: HFS+ (the T9 disk) keeps 1 s mtimes

async function backdate(file: string) {
  await utimes(file, OLD, OLD);
}

async function setup(root: string, deviceId: string) {
  await mkdir(path.join(root, "sync"), { recursive: true }); // the configured Syncthing folder exists
  const store = createFilesystemDocumentStore(path.join(root, `${deviceId}-docs`));
  const core = createAutomergeCore<Doc>({ store, discardedBackupStore: createDiscardedDocumentBackupStore(path.join(root, `${deviceId}-backups`)), emptyDocument });
  const family = {
    exportBytes: (channelId: string) => core.exportBytes(channelId),
    async mergeIncoming(channelId: string, bytes: Uint8Array) {
      const { merged } = await core.mergeIncoming(channelId, bytes, () => []);
      await core.save(channelId, merged);
      return { newConflictsCount: 0 };
    },
    async discardLocalAndAdoptPeer() {
      return { backupPath: null };
    },
  };
  const runner = createSyncRunner({
    syncthingSubfolderName: "family",
    bootstrapConfig: { ensureExists: async () => ({ deviceId, syncthingRootPath: path.join(root, "sync") }) },
    localFallbackDir: path.join(root, `${deviceId}-fallback`),
    listChannelIds: async () => ["UC1"],
    family,
    transport: createPerChannelFilesystemTransport(),
    logger: { info: () => undefined, error: () => undefined },
    isNotFoundError: (error) => error instanceof Error && "code" in error && (error as { code?: string }).code === "not_found",
    describeError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return { core, runner, docFile: path.join(root, `${deviceId}-docs`, "UC1.automerge"), pushedFile: path.join(root, "sync", "family", "UC1", `${deviceId}.automerge`) };
}

async function writeNote(core: Awaited<ReturnType<typeof setup>>["core"], note: string) {
  const doc = await core.loadOrCreate("UC1");
  await core.save("UC1", Automerge.change(doc, (d) => {
    d.notes[note] = note;
  }));
}

test("BL-270: a merge that brings nothing new saves the same bytes (Automerge.save is deterministic), so the file is not rewritten", () =>
  withTempDir("am-no-rewrite-", async (root) => {
    const a = await setup(root, "dev-a");
    await writeNote(a.core, "one");
    const peer = Automerge.load<Doc>(await a.core.exportBytes("UC1")); // a peer that has exactly what A has
    const before = await readFile(a.docFile);
    const { merged } = await a.core.mergeIncoming("UC1", Automerge.save(peer), () => []);
    assert.equal(Buffer.compare(Buffer.from(Automerge.save(merged)), before), 0, "byte-identical");
    await backdate(a.docFile);
    await a.core.save("UC1", merged);
    assert.equal((await stat(a.docFile)).mtimeMs, OLD.getTime());
  }));

test("BL-270: a cycle with nothing new on either side rewrites neither the local document nor the pushed file", () =>
  withTempDir("am-no-rewrite-", async (root) => {
    const a = await setup(root, "dev-a");
    const b = await setup(root, "dev-b");
    await writeNote(a.core, "one");
    await a.runner.runSyncCycle(); // A pushes
    await b.runner.runSyncCycle(); // B adopts A's document
    await b.runner.runSyncCycle(); // B pushes it back
    await a.runner.runSyncCycle(); // A merges B's copy (nothing new)
    for (const file of [a.docFile, a.pushedFile, b.docFile, b.pushedFile]) await backdate(file);
    await a.runner.runSyncCycle();
    await b.runner.runSyncCycle();
    for (const file of [a.docFile, a.pushedFile, b.docFile, b.pushedFile]) {
      assert.equal((await stat(file)).mtimeMs, OLD.getTime(), `${path.basename(path.dirname(file))}/${path.basename(file)} rewritten`);
    }
  }));

test("BL-270 (negative): a real change is still saved, pushed and merged on the other device", () =>
  withTempDir("am-no-rewrite-", async (root) => {
    const a = await setup(root, "dev-a");
    const b = await setup(root, "dev-b");
    await writeNote(a.core, "one");
    await a.runner.runSyncCycle();
    await b.runner.runSyncCycle();
    await b.runner.runSyncCycle();
    await a.runner.runSyncCycle();
    for (const file of [a.docFile, a.pushedFile, b.docFile, b.pushedFile]) await backdate(file);
    await writeNote(b.core, "two"); // B changes
    await b.runner.runSyncCycle(); // B pushes
    await a.runner.runSyncCycle(); // A merges and saves, then pushes the merged document
    assert.notEqual((await stat(b.pushedFile)).mtimeMs, OLD.getTime(), "B pushed its change");
    assert.notEqual((await stat(a.docFile)).mtimeMs, OLD.getTime(), "A saved the merge");
    const merged = Automerge.load<Doc>(new Uint8Array(await readFile(a.docFile)));
    assert.deepEqual({ ...merged.notes }, { one: "one", two: "two" });
  }));
