// ---------------------------------------------------------------------------
// Acceptance matrix, fixed from docs/acceptance/PHASE_5_ACCEPTANCE.md before writing the
// implementation:
//
// AC-BACKUP-01: backup content exactly matches the pre-write snapshot passed in.
// AC-BACKUP-02: a per-item backup failure (store healthy) throws backup_item_failed,
//   scoped to that video only.
// AC-BACKUP-03: a second capture for the same video under a DIFFERENT operationId does not
//   touch the first backup's file; capturing the exact same (channelId, operationId,
//   videoId) twice fails rather than silently overwriting.
// AC-BACKUP-04: infrastructure-wide unavailability is checked once, up front, via
//   checkInfrastructureHealth -- distinct from an item-level failure.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "./contracts";
import { createFilesystemBackupStore } from "./adapters/filesystem-store";
import { createBackupServices } from "./services";

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "backup-store-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("AC-BACKUP-01: captured backup content exactly matches the pre-write snapshot", async () => {
  await withTempRoot(async (root) => {
    const services = createBackupServices({
      store: createFilesystemBackupStore(root),
      clock: () => new Date("2026-09-17T12:00:00.000Z"),
    });

    const snapshot = {
      kind: "localization" as const,
      defaultLanguage: "en",
      existingLocalizations: { es: { title: "Titulo Original", description: "Desc" } },
    };

    const record = await services.captureBackup({
      channelId: "UC_TEST",
      operationId: "batch-1",
      videoId: "v1",
      snapshot,
    });

    const content = JSON.parse(await readFile(record.path, "utf8"));
    assert.equal(content.snapshot.defaultLanguage, "en");
    assert.deepEqual(content.snapshot.existingLocalizations, snapshot.existingLocalizations);
    assert.equal(content.videoId, "v1");
  });
});

test("AC-BACKUP-02: a per-item write failure is reported as backup_item_failed, scoped to that video", async () => {
  const services = createBackupServices({
    store: {
      async healthCheck() {
        return { healthy: true };
      },
      async write(args) {
        if (args.videoId === "v1") throw new Error("simulated disk write error");
        return { path: `/fake/${args.videoId}.json` };
      },
    },
    clock: () => new Date(),
  });

  await assert.rejects(
    () =>
      services.captureBackup({
        channelId: "UC_TEST",
        operationId: "batch-1",
        videoId: "v1",
        snapshot: { kind: "localization", defaultLanguage: "en", existingLocalizations: {} },
      }),
    (error: unknown) => error instanceof DomainError && error.code === "backup_item_failed"
  );

  // v2's backup succeeds via the same (healthy) store -- proves the failure was scoped
  // to v1, not the whole store.
  const record = await services.captureBackup({
    channelId: "UC_TEST",
    operationId: "batch-1",
    videoId: "v2",
    snapshot: { kind: "localization", defaultLanguage: "en", existingLocalizations: {} },
  });
  assert.equal(record.path, "/fake/v2.json");
});

test("AC-BACKUP-03: backups are never overwritten -- a prior backup's content is unchanged after a later capture", async () => {
  await withTempRoot(async (root) => {
    const services = createBackupServices({
      store: createFilesystemBackupStore(root),
      clock: () => new Date(),
    });

    await services.captureBackup({
      channelId: "UC_TEST",
      operationId: "batch-1",
      videoId: "v1",
      snapshot: {
        kind: "localization",
        defaultLanguage: "en",
        existingLocalizations: { es: { title: "First", description: "" } },
      },
    });

    // A second batch targeting the same video gets its own, distinct path.
    const second = await services.captureBackup({
      channelId: "UC_TEST",
      operationId: "batch-2",
      videoId: "v1",
      snapshot: {
        kind: "localization",
        defaultLanguage: "en",
        existingLocalizations: { es: { title: "Second", description: "" } },
      },
    });

    const firstPath = path.join(root, "UC_TEST", "batch-1", "v1.metadata_before.json");
    const firstContent = JSON.parse(await readFile(firstPath, "utf8"));
    assert.equal(firstContent.snapshot.existingLocalizations.es.title, "First");
    assert.notEqual(second.path, firstPath);

    // Attempting to capture the exact same (channelId, operationId, videoId) again must fail
    // rather than silently overwrite.
    await assert.rejects(
      () =>
        services.captureBackup({
          channelId: "UC_TEST",
          operationId: "batch-1",
          videoId: "v1",
          snapshot: {
            kind: "localization",
            defaultLanguage: "en",
            existingLocalizations: { es: { title: "Overwrite attempt", description: "" } },
          },
        }),
      (error: unknown) => error instanceof DomainError && error.code === "backup_item_failed"
    );

    const stillFirstContent = JSON.parse(await readFile(firstPath, "utf8"));
    assert.equal(stillFirstContent.snapshot.existingLocalizations.es.title, "First");
  });
});

test("AC-BACKUP-04: infrastructure-wide unavailability is reported distinctly from an item-level failure", async () => {
  const services = createBackupServices({
    store: {
      async healthCheck() {
        return { healthy: false, error: "connection refused" };
      },
      async write() {
        throw new Error("should never be called once health check has failed");
      },
    },
    clock: () => new Date(),
  });

  const health = await services.checkInfrastructureHealth();
  assert.equal(health.healthy, false);
});
