import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { type ChangeDraftsForSync, createChangeDraftsSyncCore, type ServiceDependencies } from "./services";
import type { ChangeDraftsSyncTransportAdapter } from "./adapters/filesystem-transport";

function fakeLogger() {
  return { info() {}, error() {} };
}

function fakeTransport(overrides: Partial<ChangeDraftsSyncTransportAdapter> = {}): ChangeDraftsSyncTransportAdapter {
  return {
    async checkRootAvailable() {},
    async writeDeviceFile() {},
    async listPeerFiles() {
      return [];
    },
    ...overrides,
  };
}

function fakeChangeDrafts(overrides: Partial<ChangeDraftsForSync> = {}): ChangeDraftsForSync {
  return {
    async exportBytes() {
      return new Uint8Array([1]);
    },
    async mergeIncoming() {
      return { newConflicts: [] };
    },
    async discardLocalAndAdoptPeer() {
      return { backupPath: "/fake/backup.automerge" };
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ServiceDependencies> = {}): ServiceDependencies {
  return {
    bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: null }; } },
    localFallbackDir: "/fake/local-fallback",
    listChannelIds: async () => ["UC_1"],
    changeDrafts: fakeChangeDrafts(),
    transport: fakeTransport(),
    logger: fakeLogger(),
    ...overrides,
  };
}

test("runSyncCycle pushes the local document and reports the channel as pushed", async () => {
  const written: Array<{ root: string; channelId: string; deviceId: string }> = [];
  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async writeDeviceFile(root, channelId, deviceId) {
          written.push({ root, channelId, deviceId });
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  assert.equal(result.deviceId, "device-a");
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].pushed, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].deviceId, "device-a");
  assert.equal(written[0].channelId, "UC_1");
});

test("a channel with no local document yet (exportBytes throws not_found) is skipped for push, not treated as an error", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      changeDrafts: fakeChangeDrafts({
        async exportBytes() {
          throw new DomainError({ code: "not_found", message: "no document" });
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  assert.equal(result.channels[0].pushed, false);
  // Independent test-suite audit (2026-09-26): this test's own title promises "not treated as
  // an error" but never checked pushError -- a regression that treated not_found as a real
  // error (setting pushError) would have passed undetected.
  assert.equal(result.channels[0].pushError, null);
});

test("a non-not_found error from exportBytes is isolated to its channel via pushError, never thrown (advisor review: a real push failure must not abort the whole cycle)", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      changeDrafts: fakeChangeDrafts({
        async exportBytes() {
          throw new Error("disk full");
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  assert.equal(result.channels[0].pushed, false);
  assert.match(result.channels[0].pushError ?? "", /disk full/);
});

test("every peer file found is merged in, and their new conflicts are aggregated", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [
            { deviceId: "device-b", bytes: new Uint8Array([1]) },
            { deviceId: "device-c", bytes: new Uint8Array([2]) },
          ];
        },
      }),
      changeDrafts: fakeChangeDrafts({
        async mergeIncoming(input) {
          return { newConflicts: [{ changeId: `from-${input.incomingBytes[0]}`, field: "proposedValue", valuesByActor: {} }] };
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  assert.deepEqual(result.channels[0].peersMerged, ["device-b", "device-c"]);
  assert.equal(result.channels[0].newConflicts.length, 2);
  assert.equal(result.totalNewConflicts, 2);
});

test("one peer's merge failure is isolated -- it is reported in peersSkipped, but every OTHER peer still merges", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [
            { deviceId: "device-bad", bytes: new Uint8Array([1]) },
            { deviceId: "device-good", bytes: new Uint8Array([2]) },
          ];
        },
      }),
      changeDrafts: fakeChangeDrafts({
        async mergeIncoming(input) {
          if (input.incomingBytes[0] === 1) {
            throw new DomainError({ code: "divergent_document_lineage", message: "no shared history" });
          }
          return { newConflicts: [] };
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  assert.deepEqual(result.channels[0].peersMerged, ["device-good"]);
  assert.equal(result.channels[0].peersSkipped.length, 1);
  assert.equal(result.channels[0].peersSkipped[0].deviceId, "device-bad");
  assert.equal(result.channels[0].peersSkipped[0].reason, "divergent_document_lineage");
});

test("a push failure (e.g. sync folder unavailable) is isolated to its channel -- reported via pushError, never thrown, and pull/merge still proceeds", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      listChannelIds: async () => ["UC_1", "UC_2"],
      transport: fakeTransport({
        async writeDeviceFile(root, channelId) {
          if (channelId === "UC_1") throw new Error("ENOENT: sync folder is not available");
        },
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([1]) }];
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  const channel1 = result.channels.find((c) => c.channelId === "UC_1")!;
  const channel2 = result.channels.find((c) => c.channelId === "UC_2")!;

  assert.equal(channel1.pushed, false);
  assert.match(channel1.pushError ?? "", /sync folder is not available/);
  // The pull/merge side is unaffected by the push failure on the SAME channel.
  assert.deepEqual(channel1.peersMerged, ["device-b"]);

  // A push failure on one channel must never abort syncing a DIFFERENT channel.
  assert.equal(channel2.pushed, true);
  assert.equal(channel2.pushError, null);
});

test("a successful push (or a legitimate 'nothing to push yet') reports pushError as null", async () => {
  const core = createChangeDraftsSyncCore(makeDeps());
  const result = await core.runSyncCycle();
  assert.equal(result.channels[0].pushError, null);
});

test("when the configured Syncthing root is unavailable, every channel this cycle reports pushError and no push/pull is attempted at all -- checked once, not per channel", async () => {
  let exportCalls = 0;
  let listPeerFilesCalls = 0;
  const core = createChangeDraftsSyncCore(
    makeDeps({
      bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: "/not/mounted" }; } },
      listChannelIds: async () => ["UC_1", "UC_2"],
      transport: fakeTransport({
        async checkRootAvailable() {
          throw new Error("Configured sync folder is not available (does not exist): /not/mounted");
        },
        async listPeerFiles() {
          listPeerFilesCalls++;
          return [];
        },
      }),
      changeDrafts: fakeChangeDrafts({
        async exportBytes() {
          exportCalls++;
          return new Uint8Array([1]);
        },
      }),
    })
  );

  const result = await core.runSyncCycle();
  assert.equal(exportCalls, 0, "no push should even be attempted when the root itself is unavailable");
  assert.equal(listPeerFilesCalls, 0, "no pull should even be attempted when the root itself is unavailable");
  for (const channel of result.channels) {
    assert.equal(channel.pushed, false);
    assert.match(channel.pushError ?? "", /not available/);
    assert.deepEqual(channel.peersMerged, []);
  }
});

test("uses the local fallback directory when no Syncthing root is configured", async () => {
  const roots: string[] = [];
  const core = createChangeDraftsSyncCore(
    makeDeps({
      localFallbackDir: "/fake/local-fallback",
      transport: fakeTransport({
        async writeDeviceFile(root) {
          roots.push(root);
        },
      }),
    })
  );

  await core.runSyncCycle();
  assert.equal(roots[0], "/fake/local-fallback");
});

test("uses a change-drafts subfolder under the configured Syncthing root when one is set", async () => {
  const roots: string[] = [];
  const core = createChangeDraftsSyncCore(
    makeDeps({
      bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: "/fake/syncthing-root" }; } },
      transport: fakeTransport({
        async writeDeviceFile(root) {
          roots.push(root);
        },
      }),
    })
  );

  await core.runSyncCycle();
  assert.ok(roots[0].includes("syncthing-root"));
  assert.ok(roots[0].includes("change-drafts"));
});

test("runSyncCycle is single-flight: a call arriving while a cycle is already running gets that SAME cycle's result, never starts a second concurrent one", async () => {
  let concurrentCalls = 0;
  let maxConcurrent = 0;
  let resolveFirstExport: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveFirstExport = resolve;
  });

  const core = createChangeDraftsSyncCore(
    makeDeps({
      changeDrafts: fakeChangeDrafts({
        async exportBytes() {
          concurrentCalls++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
          await gate;
          concurrentCalls--;
          return new Uint8Array([1]);
        },
      }),
    })
  );

  const first = core.runSyncCycle();
  const second = core.runSyncCycle();
  resolveFirstExport?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(maxConcurrent, 1, "a second call must never start its own overlapping cycle");
  assert.equal(firstResult, secondResult, "both callers must receive the exact same result object");

  // After the first cycle fully completes, a NEW call must start a genuinely new cycle.
  const third = await core.runSyncCycle();
  assert.notEqual(third, firstResult);
});

test("adoptDivergentPeer rejects a second call arriving while a DIFFERENT adopt is already in flight, rather than coalescing into the first one's result (advisor review)", async () => {
  let resolveFirst: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });

  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([1]) }];
        },
      }),
      changeDrafts: fakeChangeDrafts({
        async discardLocalAndAdoptPeer(input) {
          if (input.channelId === "UC_1") await gate; // hold the first call open
          return { backupPath: `/fake/${input.channelId}.automerge` };
        },
      }),
    })
  );

  const first = core.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  const second = core.adoptDivergentPeer({ channelId: "UC_2", peerDeviceId: "device-b" });
  await assert.rejects(second, /already in progress/);

  resolveFirst?.();
  const firstResult = await first;
  assert.equal(firstResult.backupPath, "/fake/UC_1.automerge");
});

test("adoptDivergentPeer re-reads the peer's CURRENT file and forwards it to discardLocalAndAdoptPeer", async () => {
  let received: { channelId: string; incomingBytes: Uint8Array } | undefined;
  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([42]) }];
        },
      }),
      changeDrafts: fakeChangeDrafts({
        async discardLocalAndAdoptPeer(input) {
          received = input;
          return { backupPath: "/fake/backup.automerge" };
        },
      }),
    })
  );

  const result = await core.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  assert.equal(result.backupPath, "/fake/backup.automerge");
  assert.equal(received?.channelId, "UC_1");
  assert.deepEqual(Array.from(received!.incomingBytes), [42]);
});

test("adoptDivergentPeer throws a clear error when the named peer has no file in the sync folder (already resynced, or gone)", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [];
        },
      }),
    })
  );

  await assert.rejects(
    () => core.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" }),
    /no file for channel/
  );
});

test("adoptDivergentPeer checks the configured Syncthing root's availability before reading peer files, same as a sync cycle", async () => {
  let checkedRoot: string | undefined;
  const core = createChangeDraftsSyncCore(
    makeDeps({
      bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: "/not/mounted" }; } },
      transport: fakeTransport({
        async checkRootAvailable(root) {
          checkedRoot = root;
          throw new Error("Configured sync folder is not available (does not exist): /not/mounted");
        },
      }),
    })
  );

  await assert.rejects(() => core.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" }), /not available/);
  assert.equal(checkedRoot, "/not/mounted");
});

test("runSyncCycle and adoptDivergentPeer are mutually exclusive: a call to one waits for an in-flight call to the other, never runs concurrently with it", async () => {
  const events: string[] = [];
  let resolveSync: (() => void) | undefined;
  const syncGate = new Promise<void>((resolve) => { resolveSync = resolve; });

  const core = createChangeDraftsSyncCore(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([1]) }];
        },
      }),
      changeDrafts: fakeChangeDrafts({
        async exportBytes() {
          events.push("sync:start");
          await syncGate;
          events.push("sync:end");
          return new Uint8Array([1]);
        },
        async discardLocalAndAdoptPeer() {
          events.push("adopt:run");
          return { backupPath: null };
        },
      }),
    })
  );

  const syncPromise = core.runSyncCycle();
  const adoptPromise = core.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  resolveSync?.();
  await Promise.all([syncPromise, adoptPromise]);

  assert.deepEqual(events, ["sync:start", "sync:end", "adopt:run"], "adopt must wait for the in-flight sync cycle to finish first");
});
