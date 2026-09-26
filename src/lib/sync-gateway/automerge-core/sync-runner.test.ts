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
    async discardLocalAndAdoptPeer() {
      return { backupPath: null };
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

// Generalized 2026-09-23 from change-drafts-sync/services.ts's own bespoke adoptDivergentPeer --
// editorial-profile and ai-connections-catalog gained the same capability via this shared runner
// instead of a third copy-paste (AGENTS.md §M).
test("adoptDivergentPeer re-reads the peer's CURRENT file and delegates to the family's discardLocalAndAdoptPeer", async () => {
  const peerBytes = new Uint8Array([9, 9, 9]);
  let received: { channelId: string; incomingBytes: Uint8Array } | null = null;
  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: peerBytes }];
        },
      }),
      family: fakeFamily({
        async discardLocalAndAdoptPeer(channelId, incomingBytes) {
          received = { channelId, incomingBytes };
          return { backupPath: "/fake/backup.automerge" };
        },
      }),
    })
  );

  const result = await runner.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  assert.equal(result.backupPath, "/fake/backup.automerge");
  assert.deepEqual(received, { channelId: "UC_1", incomingBytes: peerBytes });
});

test("adoptDivergentPeer throws when the named peer has no file in the sync folder", async () => {
  const runner = createSyncRunner(makeDeps({ transport: fakeTransport({ async listPeerFiles() { return []; } }) }));

  await assert.rejects(
    () => runner.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" }),
    /no file for "UC_1"/
  );
});

// Independent test-suite audit (2026-09-26): this test previously only asserted
// `adoptCalls === 1` and `backupPath === null` -- deleting the actual mutual-exclusion guard
// from `sync-runner.ts` would still make this test pass (adopt still runs exactly once and
// still returns `null` regardless of whether it waited for the in-flight cycle). Ported the
// ordered-events assertion pattern already proven in this codebase's own sibling test
// (`change-drafts-sync/services.test.ts`'s "runSyncCycle and adoptDivergentPeer are mutually
// exclusive..."), which WOULD fail if exclusion broke, and added the reverse direction (adopt
// in flight, then a sync cycle) the original test's own title claimed to cover but never tested.
test("runSyncCycle and adoptDivergentPeer are mutually exclusive: adopt waits for an in-flight sync cycle to finish first", async () => {
  const events: string[] = [];
  let resolveSync: (() => void) | undefined;
  const syncGate = new Promise<void>((resolve) => {
    resolveSync = resolve;
  });

  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([1]) }];
        },
      }),
      family: fakeFamily({
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

  const syncPromise = runner.runSyncCycle();
  const adoptPromise = runner.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  resolveSync?.();
  const [, adoptResult] = await Promise.all([syncPromise, adoptPromise]);

  assert.deepEqual(events, ["sync:start", "sync:end", "adopt:run"], "adopt must wait for the in-flight sync cycle to finish first");
  assert.equal(adoptResult.backupPath, null);
});

test("runSyncCycle and adoptDivergentPeer are mutually exclusive: a sync cycle waits for an in-flight adopt to finish first (the reverse direction)", async () => {
  const events: string[] = [];
  let resolveAdopt: (() => void) | undefined;
  const adoptGate = new Promise<void>((resolve) => {
    resolveAdopt = resolve;
  });

  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([1]) }];
        },
      }),
      family: fakeFamily({
        async exportBytes() {
          events.push("sync:run");
          return new Uint8Array([1]);
        },
        async discardLocalAndAdoptPeer() {
          events.push("adopt:start");
          await adoptGate;
          events.push("adopt:end");
          return { backupPath: null };
        },
      }),
    })
  );

  const adoptPromise = runner.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  const syncPromise = runner.runSyncCycle();
  resolveAdopt?.();
  await Promise.all([adoptPromise, syncPromise]);

  assert.deepEqual(events, ["adopt:start", "adopt:end", "sync:run"], "a sync cycle must wait for the in-flight adopt to finish first");
});

test("adoptDivergentPeer rejects a second overlapping call outright rather than coalescing (a different peer/channel must never receive the wrong result)", async () => {
  let resolveFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const runner = createSyncRunner(
    makeDeps({
      transport: fakeTransport({
        async listPeerFiles() {
          return [{ deviceId: "device-b", bytes: new Uint8Array([1]) }];
        },
      }),
      family: fakeFamily({
        async discardLocalAndAdoptPeer() {
          await firstGate;
          return { backupPath: null };
        },
      }),
    })
  );

  const first = runner.adoptDivergentPeer({ channelId: "UC_1", peerDeviceId: "device-b" });
  await assert.rejects(
    () => runner.adoptDivergentPeer({ channelId: "UC_2", peerDeviceId: "device-c" }),
    /already in progress/
  );
  resolveFirst!();
  await first;
});
