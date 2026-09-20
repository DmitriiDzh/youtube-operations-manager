// ---------------------------------------------------------------------------
// Acceptance matrix (AGENTS.md §L), derived from the owner's own requirement (Telegram,
// 2026-09-20: a reusable write module where changing one field never overwrites the rest, and
// AGENTS.md §G's minimum safety-critical write model: identity check, validation, backup, diff,
// approval, dry-run, audit, verification):
//
// AC-SVC-01: previewFieldsUpdate never calls backup/audit-of-a-write/writeContext -- it is
//   read-only, and records only a DRY_RUN audit event.
// AC-SVC-02: previewFieldsUpdate rejects a publishAt patch when the video already has one,
//   before computing any diff.
// AC-SVC-03: applyFieldsUpdate calls, in order: writeContext.assertWriteChannel (identity) ->
//   backup infra health -> getSnapshot (before) -> captureBackup -> applyPatch (the write) ->
//   localCache.refreshVideoFields -- a wrong-channel guardrail failure means NONE of the later
//   steps (backup, write, cache refresh) ever run.
// AC-SVC-04: a backup-infrastructure failure aborts before any write -- no applyPatch call.
// AC-SVC-05: post-write verification failure (the adapter's `after` doesn't match the patch)
//   throws update_failed and still records a VERIFICATION audit event with verified: false.
// AC-SVC-06: on full success, localCache.refreshVideoFields is called exactly once, with the
//   `after` snapshot -- never called at all if the write itself failed.
// AC-SVC-07: shouldPersistSelection triggers channelSelectionStore.setSelectedChannelId; when
//   false, it is never called.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createVideoDetailsServices, type ServiceDependencies } from "./services";
import type { ResolvedCredentials } from "@/lib/video-metadata/contracts";
import type { VideoDetailsSnapshot } from "./contracts";

function makeCredentials(): ResolvedCredentials {
  return {
    credentialRef: { userId: "user-1" },
    accessToken: "access-token",
    refreshToken: "refresh-token",
    scopeSet: new Set(["read", "write"]),
  };
}

function makeSnapshot(overrides?: Partial<VideoDetailsSnapshot>): VideoDetailsSnapshot {
  return {
    videoId: "v1",
    etag: "etag-1",
    title: "Original Title",
    description: "Original description",
    tags: ["a", "b"],
    categoryId: "22",
    defaultLanguage: "en",
    privacyStatus: "public",
    publishAt: null,
    license: "youtube",
    embeddable: true,
    publicStatsViewable: true,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: false,
    recordingDate: null,
    ...overrides,
  };
}

type Overrides = {
  authResolver?: Partial<ServiceDependencies["authResolver"]>;
  writeContext?: Partial<ServiceDependencies["writeContext"]>;
  channelSelectionStore?: Partial<ServiceDependencies["channelSelectionStore"]>;
  youtubeApi?: Partial<ServiceDependencies["youtubeApi"]>;
  backup?: Partial<ServiceDependencies["backup"]>;
  auditStore?: Partial<ServiceDependencies["auditStore"]>;
  localCache?: Partial<ServiceDependencies["localCache"]>;
  idGenerator?: ServiceDependencies["idGenerator"];
};

function makeDeps(overrides?: Overrides) {
  const credentials = makeCredentials();
  const before = makeSnapshot();

  const calls = {
    assertWriteChannel: 0,
    backupHealth: 0,
    getSnapshot: 0,
    captureBackup: 0,
    applyPatch: 0,
    refreshVideoFields: [] as VideoDetailsSnapshot[],
    setSelectedChannelId: 0,
    auditEvents: [] as string[],
  };

  const deps: ServiceDependencies = {
    authResolver: {
      resolve: async () => credentials,
      ...overrides?.authResolver,
    },
    writeContext: {
      assertWriteChannel: async () => {
        calls.assertWriteChannel += 1;
        return { expectedChannelId: "UC_ACTIVE", shouldPersistSelection: false, userId: "user-1" };
      },
      ...overrides?.writeContext,
    },
    channelSelectionStore: {
      setSelectedChannelId: async () => {
        calls.setSelectedChannelId += 1;
      },
      ...overrides?.channelSelectionStore,
    },
    youtubeApi: {
      getSnapshot: async () => {
        calls.getSnapshot += 1;
        return before;
      },
      applyPatch: async ({ patch }) => {
        calls.applyPatch += 1;
        return { before, after: { ...before, ...patch } };
      },
      ...overrides?.youtubeApi,
    },
    backup: {
      checkInfrastructureHealth: async () => {
        calls.backupHealth += 1;
        return { healthy: true };
      },
      captureBackup: async () => {
        calls.captureBackup += 1;
        return { path: "/fake/backup.json", capturedAt: new Date().toISOString() };
      },
      ...overrides?.backup,
    },
    auditStore: {
      record: async (args) => {
        calls.auditEvents.push(args.eventType);
      },
      ...overrides?.auditStore,
    },
    localCache: {
      refreshVideoFields: async ({ after }) => {
        calls.refreshVideoFields.push(after);
      },
      ...overrides?.localCache,
    },
    idGenerator: overrides?.idGenerator ?? (() => "operation-1"),
  };

  return { deps, calls, before };
}

function baseInput(patch: Record<string, unknown>) {
  return {
    credentialRef: { userId: "user-1" },
    expectedChannelId: "UC_ACTIVE",
    videoId: "v1",
    patch,
  };
}

test("AC-SVC-01: previewFieldsUpdate is read-only -- no backup/write-identity calls, just a DRY_RUN audit", async () => {
  const { deps, calls } = makeDeps();
  const services = createVideoDetailsServices(deps);

  const result = await services.previewFieldsUpdate(baseInput({ title: "New Title" }));

  assert.equal(result.dryRun, true);
  assert.equal(result.diff.length, 1);
  assert.deepEqual(result.diff[0], { field: "title", before: "Original Title", proposed: "New Title" });
  assert.equal(calls.assertWriteChannel, 0);
  assert.equal(calls.captureBackup, 0);
  assert.equal(calls.applyPatch, 0);
  assert.deepEqual(calls.auditEvents, ["DRY_RUN"]);
});

test("AC-SVC-02: previewFieldsUpdate rejects publishAt when the video already has one", async () => {
  const { deps } = makeDeps({
    youtubeApi: { getSnapshot: async () => makeSnapshot({ publishAt: "2026-01-01T00:00:00Z" }) },
  });
  const services = createVideoDetailsServices(deps);

  await assert.rejects(
    () => services.previewFieldsUpdate(baseInput({ publishAt: "2026-06-01T00:00:00Z", privacyStatus: "private" })),
    (error: unknown) => error instanceof DomainError && error.code === "publish_at_already_published"
  );
});

test("AC-SVC-03: a wrong-channel guardrail failure runs no backup, no write, no cache refresh", async () => {
  const { deps, calls } = makeDeps({
    writeContext: {
      assertWriteChannel: async () => {
        throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "wrong channel" });
      },
    },
  });
  const services = createVideoDetailsServices(deps);

  await assert.rejects(
    () => services.applyFieldsUpdate(baseInput({ title: "New Title" })),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_MISMATCH"
  );

  assert.equal(calls.backupHealth, 0);
  assert.equal(calls.captureBackup, 0);
  assert.equal(calls.applyPatch, 0);
  assert.equal(calls.refreshVideoFields.length, 0);
});

test("AC-SVC-04: a backup-infrastructure failure aborts before any write", async () => {
  const { deps, calls } = makeDeps({
    backup: {
      checkInfrastructureHealth: async () => ({ healthy: false, error: "disk full" }),
    },
  });
  const services = createVideoDetailsServices(deps);

  await assert.rejects(
    () => services.applyFieldsUpdate(baseInput({ title: "New Title" })),
    (error: unknown) => error instanceof DomainError && error.code === "backup_infrastructure_unavailable"
  );

  assert.equal(calls.captureBackup, 0);
  assert.equal(calls.applyPatch, 0);
});

test("AC-SVC-05: post-write verification failure throws update_failed and records verified: false", async () => {
  const auditDetails: Array<{ eventType: string; detail: unknown }> = [];
  const { deps } = makeDeps({
    youtubeApi: {
      getSnapshot: async () => makeSnapshot(),
      // The adapter returns an `after` that does NOT reflect the patch -- simulates YouTube
      // silently not applying (or a race with another writer).
      applyPatch: async () => ({ before: makeSnapshot(), after: makeSnapshot({ title: "Untouched" }) }),
    },
    auditStore: {
      record: async (args) => {
        auditDetails.push({ eventType: args.eventType, detail: args.detail });
      },
    },
  });
  const services = createVideoDetailsServices(deps);

  await assert.rejects(
    () => services.applyFieldsUpdate(baseInput({ title: "New Title" })),
    (error: unknown) => error instanceof DomainError && error.code === "update_failed"
  );

  const verificationEvent = auditDetails.find((e) => e.eventType === "VERIFICATION");
  assert.ok(verificationEvent);
  assert.deepEqual(verificationEvent!.detail, { verified: false });
});

test("AC-SVC-06: localCache.refreshVideoFields is called exactly once on success, with the after snapshot", async () => {
  const { deps, calls } = makeDeps();
  const services = createVideoDetailsServices(deps);

  const result = await services.applyFieldsUpdate(baseInput({ title: "New Title" }));

  assert.equal(result.dryRun, false);
  assert.equal(result.verified, true);
  assert.equal(calls.refreshVideoFields.length, 1);
  assert.equal(calls.refreshVideoFields[0].title, "New Title");
});

test("AC-SVC-06: localCache.refreshVideoFields is never called when the write itself throws", async () => {
  const { deps, calls } = makeDeps({
    youtubeApi: {
      getSnapshot: async () => makeSnapshot(),
      applyPatch: async () => {
        throw new Error("simulated network failure");
      },
    },
  });
  const services = createVideoDetailsServices(deps);

  await assert.rejects(() => services.applyFieldsUpdate(baseInput({ title: "New Title" })));
  assert.equal(calls.refreshVideoFields.length, 0);
});

test("AC-SVC-07: shouldPersistSelection true calls setSelectedChannelId; false never does", async () => {
  const { deps: depsPersist, calls: callsPersist } = makeDeps({
    writeContext: {
      assertWriteChannel: async () => ({
        expectedChannelId: "UC_ACTIVE",
        shouldPersistSelection: true,
        userId: "user-1",
      }),
    },
  });
  await createVideoDetailsServices(depsPersist).applyFieldsUpdate(baseInput({ title: "New Title" }));
  assert.equal(callsPersist.setSelectedChannelId, 1);

  const { deps: depsNoPersist, calls: callsNoPersist } = makeDeps();
  await createVideoDetailsServices(depsNoPersist).applyFieldsUpdate(baseInput({ title: "New Title" }));
  assert.equal(callsNoPersist.setSelectedChannelId, 0);
});

test("captureBackup snapshot is kind: video_fields and mirrors the before snapshot's writable fields", async () => {
  let capturedSnapshot: unknown = null;
  const { deps } = makeDeps({
    backup: {
      checkInfrastructureHealth: async () => ({ healthy: true }),
      captureBackup: async (args) => {
        capturedSnapshot = args.snapshot;
        return { path: "/fake/backup.json", capturedAt: new Date().toISOString() };
      },
    },
  });
  await createVideoDetailsServices(deps).applyFieldsUpdate(baseInput({ title: "New Title" }));

  assert.deepEqual(capturedSnapshot, {
    kind: "video_fields",
    snippet: {
      title: "Original Title",
      description: "Original description",
      tags: ["a", "b"],
      categoryId: "22",
      defaultLanguage: "en",
    },
    status: {
      privacyStatus: "public",
      publishAt: null,
      license: "youtube",
      embeddable: true,
      publicStatsViewable: true,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: false,
    },
    recordingDate: null,
  });
});
