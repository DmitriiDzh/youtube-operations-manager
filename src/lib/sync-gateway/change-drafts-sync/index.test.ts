import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createChangeDraftsCore } from "../change-drafts";
import { createFilesystemChangeDraftsStore } from "../change-drafts/adapters/automerge-store";
import { createFilesystemTransportAdapter } from "./adapters/filesystem-transport";
import { createChangeDraftsSyncCoreForProduction } from "./index";
import { createChangeDraftsSyncCore } from "./services";

test("createChangeDraftsSyncCoreForProduction returns the SAME instance across calls -- required for the single-flight guard to actually guard anything across separate request handlers", () => {
  const first = createChangeDraftsSyncCoreForProduction();
  const second = createChangeDraftsSyncCoreForProduction();
  assert.equal(first, second, "every API route calling this factory fresh must still share one runSyncCycle guard");
});

// Real end-to-end test of CD5's sync engine: two independent "devices," each with its own real
// filesystem-backed Automerge store (no fakes), syncing through the real filesystem transport
// adapter against one shared directory (standing in for a Syncthing-synced folder). Proves the
// whole loop actually works together, not just each piece in isolation.

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "change-drafts-sync-e2e-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeLogger() {
  return { info() {}, error() {} };
}

const CHANNEL = "UC_sync_e2e";

test("two devices, each with a real filesystem store, sync through the real shared-folder transport and end up with each other's edits", async () => {
  await withTempDir(async (sharedRoot) => {
    await withTempDir(async (deviceAStoreDir) => {
      await withTempDir(async (deviceBStoreDir) => {
        const changeDraftsA = createChangeDraftsCore({
          store: createFilesystemChangeDraftsStore(deviceAStoreDir),
          sqlSource: { async listChangeSetsForChannel() { return []; }, async listChangesForChangeSet() { return []; } },
          projection: { async upsertChangeSet() {}, async upsertChange() {}, async deleteChangeSet() {}, async deleteChange() {}, async upsertProvenance() {} },
          discardedBackupStore: { async backup(channelId: string) { return { path: `/fake/${channelId}.automerge`, capturedAt: new Date().toISOString() }; } },
        });
        const changeDraftsB = createChangeDraftsCore({
          store: createFilesystemChangeDraftsStore(deviceBStoreDir),
          sqlSource: { async listChangeSetsForChannel() { return []; }, async listChangesForChangeSet() { return []; } },
          projection: { async upsertChangeSet() {}, async upsertChange() {}, async deleteChangeSet() {}, async deleteChange() {}, async upsertProvenance() {} },
          discardedBackupStore: { async backup(channelId: string) { return { path: `/fake/${channelId}.automerge`, capturedAt: new Date().toISOString() }; } },
        });

        const transport = createFilesystemTransportAdapter();

        const syncA = createChangeDraftsSyncCore({
          bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: sharedRoot }; } },
          localFallbackDir: "/unused",
          listChannelIds: async () => [CHANNEL],
          changeDrafts: changeDraftsA,
          transport,
          logger: fakeLogger(),
        });
        const syncB = createChangeDraftsSyncCore({
          bootstrapConfig: { async ensureExists() { return { deviceId: "device-b", syncthingRootPath: sharedRoot }; } },
          localFallbackDir: "/unused",
          listChannelIds: async () => [CHANNEL],
          changeDrafts: changeDraftsB,
          transport,
          logger: fakeLogger(),
        });

        // Device A creates a real change set and syncs -- pushes it into the shared folder.
        await changeDraftsA.createChangeSet({ channelId: CHANNEL, changeSetId: "cs-1", source: "ai_localization" });
        await changeDraftsA.addChange({
          channelId: CHANNEL,
          changeId: "c-1",
          changeSetId: "cs-1",
          videoId: "v1",
          language: "es",
          field: "title",
          baselineValue: "Original",
          proposedValue: "From A",
          changeType: "modify",
        });
        const cycleA1 = await syncA.runSyncCycle();
        assert.equal(cycleA1.channels[0].pushed, true);

        // Device B, with NO local document at all, syncs -- adopts A's document from the shared
        // folder (the exact CD2-fix scenario, now exercised through the real sync loop).
        const cycleB1 = await syncB.runSyncCycle();
        assert.deepEqual(cycleB1.channels[0].peersMerged, ["device-a"]);
        const bDoc = await changeDraftsB.getDocument({ channelId: CHANNEL });
        assert.equal(bDoc.changes["c-1"].proposedValue, "From A", "B must have adopted A's real content, not lost it");

        // Device B now makes its OWN edit to a DIFFERENT field and syncs -- pushes its state.
        await changeDraftsB.updateProposedValue({ channelId: CHANNEL, changeId: "c-1", proposedValue: "Edited by B" });
        await changeDraftsB.addChange({
          channelId: CHANNEL,
          changeId: "c-2",
          changeSetId: "cs-1",
          videoId: "v1",
          language: "es",
          field: "description",
          baselineValue: "",
          proposedValue: "New from B",
          changeType: "add",
        });
        const cycleB2 = await syncB.runSyncCycle();
        assert.equal(cycleB2.channels[0].pushed, true);

        // Device A syncs again -- pulls B's edits back in. Real shared-history merge, no data
        // loss, no divergent-lineage rejection (A and B share the same original document).
        const cycleA2 = await syncA.runSyncCycle();
        assert.deepEqual(cycleA2.channels[0].peersMerged, ["device-b"]);
        assert.deepEqual(cycleA2.channels[0].peersSkipped, []);

        const aDocFinal = await changeDraftsA.getDocument({ channelId: CHANNEL });
        assert.equal(aDocFinal.changes["c-1"].proposedValue, "Edited by B", "A must see B's edit");
        assert.ok(aDocFinal.changes["c-2"], "A must see B's newly-added change");
        assert.equal(aDocFinal.changes["c-2"].proposedValue, "New from B");
      });
    });
  });
});
