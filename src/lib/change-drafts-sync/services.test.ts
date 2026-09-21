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
});

test("a non-not_found error from exportBytes propagates -- only the specific 'no document yet' case is swallowed", async () => {
  const core = createChangeDraftsSyncCore(
    makeDeps({
      changeDrafts: fakeChangeDrafts({
        async exportBytes() {
          throw new Error("disk full");
        },
      }),
    })
  );

  await assert.rejects(() => core.runSyncCycle(), /disk full/);
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
