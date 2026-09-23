import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/video-metadata/contracts";
import { createSyncRunner, type DocumentFamilyForSync, type SyncRunnerDeps } from "./sync-runner";
import type { PerChannelTransportAdapter } from "./transport";

function fakeLogger() {
  return { info() {}, error() {} };
}

function fakeTransport(overrides: Partial<PerChannelTransportAdapter> = {}): PerChannelTransportAdapter {
  return {
    async checkRootAvailable() {},
    async writeDeviceFile() {},
    async listPeerFiles() {
      return [];
    },
    ...overrides,
  };
}

function fakeFamily(overrides: Partial<DocumentFamilyForSync> = {}): DocumentFamilyForSync {
  return {
    async exportBytes() {
      return new Uint8Array([1]);
    },
    async mergeIncoming() {
      return { newConflictsCount: 0 };
    },
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SyncRunnerDeps> = {}): SyncRunnerDeps {
  return {
    syncthingSubfolderName: "test-family",
    bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: null }; } },
    localFallbackDir: "/fake/local-fallback",
    listChannelIds: async () => ["UC_1"],
    family: fakeFamily(),
    transport: fakeTransport(),
    logger: fakeLogger(),
    isNotFoundError: (error) => isDomainError(error) && error.code === "not_found",
    describeError: (error) => (error instanceof Error ? error.message : "unknown error"),
    ...overrides,
  };
}

test("runSyncCycle pushes the local document and reports the channel as pushed", async () => {
  const written: Array<{ root: string; channelId: string; deviceId: string }> = [];
  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async writeDeviceFile(root, channelId, deviceId) {
          written.push({ root, channelId, deviceId });
        },
      }),
    })
  );

  const result = await runner.runSyncCycle();
  assert.equal(result.deviceId, "device-a");
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].pushed, true);
  assert.equal(written.length, 1);
  assert.equal(written[0].channelId, "UC_1");
});

test("a channel with nothing to push yet (not_found) is skipped, not treated as an error", async () => {
  const runner = createSyncRunner(
    makeDeps({
      family: fakeFamily({
        async exportBytes() {
          throw new DomainError({ code: "not_found", message: "no document" });
        },
      }),
    })
  );

  const result = await runner.runSyncCycle();
  assert.equal(result.channels[0].pushed, false);
  assert.equal(result.channels[0].pushError, null);
});

test("a real push failure is isolated to its channel via pushError, never thrown", async () => {
  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async writeDeviceFile() {
          throw new Error("disk full");
        },
      }),
    })
  );

  const result = await runner.runSyncCycle();
  assert.equal(result.channels[0].pushed, false);
  assert.equal(result.channels[0].pushError, "disk full");
});

test("every peer file found is merged in, and their new-conflict counts are aggregated", async () => {
  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [
            { deviceId: "device-b", bytes: new Uint8Array([2]) },
            { deviceId: "device-c", bytes: new Uint8Array([3]) },
          ];
        },
      }),
      family: fakeFamily({
        async mergeIncoming() {
          return { newConflictsCount: 1 };
        },
      }),
    })
  );

  const result = await runner.runSyncCycle();
  assert.deepEqual(result.channels[0].peersMerged.sort(), ["device-b", "device-c"]);
  assert.equal(result.totalNewConflicts, 2);
});

test("one peer's merge failure is isolated -- reported in peersSkipped, other peers still merge", async () => {
  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [
            { deviceId: "device-bad", bytes: new Uint8Array([9]) },
            { deviceId: "device-good", bytes: new Uint8Array([1]) },
          ];
        },
      }),
      family: fakeFamily({
        async mergeIncoming(_channelId, bytes) {
          if (bytes[0] === 9) throw new DomainError({ code: "divergent_document_lineage", message: "diverged" });
          return { newConflictsCount: 0 };
        },
      }),
    })
  );

  const result = await runner.runSyncCycle();
  assert.deepEqual(result.channels[0].peersMerged, ["device-good"]);
  assert.equal(result.channels[0].peersSkipped.length, 1);
  assert.equal(result.channels[0].peersSkipped[0].deviceId, "device-bad");
});

test("when the configured Syncthing root is unavailable, every channel reports pushError and no push/pull is attempted", async () => {
  const written: unknown[] = [];
  const runner = createSyncRunner(
    makeDeps({
      bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: "/missing" }; } },
      transport: fakeTransport({
        async checkRootAvailable() {
          throw new Error("not mounted");
        },
        async writeDeviceFile() {
          written.push(1);
        },
      }),
    })
  );

  const result = await runner.runSyncCycle();
  assert.equal(result.channels[0].pushError, "not mounted");
  assert.equal(written.length, 0);
});

test("uses a family-specific subfolder under the configured Syncthing root", async () => {
  let sawRoot: string | undefined;
  const runner = createSyncRunner(
    makeDeps({
      syncthingSubfolderName: "editorial-profile",
      bootstrapConfig: { async ensureExists() { return { deviceId: "device-a", syncthingRootPath: "/synced" }; } },
      transport: fakeTransport({
        async writeDeviceFile(root) {
          sawRoot = root;
        },
      }),
    })
  );

  await runner.runSyncCycle();
  assert.match(sawRoot ?? "", /editorial-profile$/);
});

test("runSyncCycle is single-flight: an overlapping call gets the SAME in-flight result", async () => {
  let calls = 0;
  const runner = createSyncRunner(
    makeDeps({
      listChannelIds: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return ["UC_1"];
      },
    })
  );

  const [a, b] = await Promise.all([runner.runSyncCycle(), runner.runSyncCycle()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});
