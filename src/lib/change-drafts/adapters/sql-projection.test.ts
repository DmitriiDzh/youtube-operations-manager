import assert from "node:assert/strict";
import test from "node:test";
import { getStoredChangeById, getStoredChangeSet, upsertChannel } from "@/lib/db";
import { createSqlProjectionAdapter } from "./sql-projection";
import type { DraftChange, DraftChangeSet } from "../contracts";

// Real db.ts calls against the isolated per-test-file SQLite database (same reasoning as
// sql-source.test.ts): `upsertStoredChangeSet`/`upsertStoredChange`'s `onConflictDoUpdate`
// semantics (insert-then-update-on-conflict) are exactly the kind of thing worth proving against
// real SQLite rather than a fake, since a fake could trivially get this "right" by accident.

const CHANNEL = "UC_sql_projection_test";

test("upsertChangeSet inserts a new row, then updates it in place on a second call with the same id", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  const adapter = createSqlProjectionAdapter();

  const changeSet: DraftChangeSet = {
    id: "cs-proj-1",
    channelId: CHANNEL,
    source: "ai_localization",
    status: "in_review",
    importedFilename: null,
    schemaVersion: null,
    exportedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  await adapter.upsertChangeSet(changeSet);

  const inserted = await getStoredChangeSet("cs-proj-1");
  assert.equal(inserted?.status, "in_review");

  await adapter.upsertChangeSet({ ...changeSet, status: "approved", updatedAt: "2026-09-02T00:00:00.000Z" });
  const updated = await getStoredChangeSet("cs-proj-1");
  assert.equal(updated?.status, "approved");
  assert.equal(updated?.id, "cs-proj-1", "same row, not a duplicate");
});

test("upsertChange inserts a new row, then updates it in place on a second call with the same id", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  const adapter = createSqlProjectionAdapter();
  await adapter.upsertChangeSet({
    id: "cs-proj-2",
    channelId: CHANNEL,
    source: "ai_localization",
    status: "in_review",
    importedFilename: null,
    schemaVersion: null,
    exportedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  const change: DraftChange = {
    id: "c-proj-1",
    changeSetId: "cs-proj-2",
    videoId: "v1",
    language: "es",
    field: "title",
    baselineValue: "Original",
    proposedValue: "Nuevo",
    changeType: "modify",
    validationStatus: "valid",
    validationError: null,
    conflictStatus: "none",
    approvalStatus: "pending",
    approvedValue: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  await adapter.upsertChange(change);
  const inserted = await getStoredChangeById("c-proj-1");
  assert.equal(inserted?.approvalStatus, "pending");

  await adapter.upsertChange({ ...change, approvalStatus: "approved", approvedValue: "Nuevo", updatedAt: "2026-09-02T00:00:00.000Z" });
  const updated = await getStoredChangeById("c-proj-1");
  assert.equal(updated?.approvalStatus, "approved");
  assert.equal(updated?.approvedValue, "Nuevo");
  assert.equal(updated?.id, "c-proj-1", "same row, not a duplicate");
});
