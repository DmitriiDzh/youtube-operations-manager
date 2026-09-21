import assert from "node:assert/strict";
import test from "node:test";
import { createChangeSetWithChanges, upsertChannel } from "@/lib/db";
import { createSqlSourceAdapter } from "./sql-source";

// Real db.ts calls, not a fake -- src/lib/db.ts redirects to an isolated, per-test-file temp
// SQLite database under the node:test runner (src/lib/platform-paths/runtime.ts), so this needs
// no mocking to stay safe. This is the one place worth testing against real SQLite rather than a
// fake: the Date -> ISO string conversion is exactly the kind of thing that looks right against a
// hand-built fixture but silently breaks against what Drizzle actually returns.

test("listChangeSetsForChannel/listChangesForChangeSet map real DB rows into DraftChangeSet/DraftChange, converting Date to ISO string", async () => {
  const channelId = "UC_sql_source_test";
  await upsertChannel({
    channelId,
    title: "Test Channel",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_test",
    connectedUserId: null,
  });

  await createChangeSetWithChanges({
    id: "cs-sql-1",
    channelId,
    source: "xlsx_import",
    status: "in_review",
    importedFilename: "batch.xlsx",
    schemaVersion: "1",
    exportedAt: "2026-09-01T00:00:00.000Z",
    changes: [
      {
        id: "c-sql-1",
        videoId: "v1",
        language: "es",
        field: "title",
        baselineValue: "Original",
        proposedValue: "Nuevo",
        changeType: "modify",
        validationStatus: "valid",
        validationError: null,
        conflictStatus: "none",
      },
    ],
  });

  const adapter = createSqlSourceAdapter();

  const changeSets = await adapter.listChangeSetsForChannel(channelId);
  assert.equal(changeSets.length, 1);
  const changeSet = changeSets[0];
  assert.equal(changeSet.id, "cs-sql-1");
  assert.equal(changeSet.channelId, channelId);
  assert.equal(changeSet.source, "xlsx_import");
  assert.equal(changeSet.status, "in_review");
  assert.equal(changeSet.importedFilename, "batch.xlsx");
  assert.equal(changeSet.schemaVersion, "1");
  assert.equal(changeSet.exportedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(typeof changeSet.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(changeSet.createdAt)), "createdAt must be a valid ISO string, not a Date object");
  assert.ok(!Number.isNaN(Date.parse(changeSet.updatedAt)), "updatedAt must be a valid ISO string, not a Date object");

  const changesForSet = await adapter.listChangesForChangeSet("cs-sql-1");
  assert.equal(changesForSet.length, 1);
  const change = changesForSet[0];
  assert.equal(change.id, "c-sql-1");
  assert.equal(change.changeSetId, "cs-sql-1");
  assert.equal(change.videoId, "v1");
  assert.equal(change.language, "es");
  assert.equal(change.field, "title");
  assert.equal(change.baselineValue, "Original");
  assert.equal(change.proposedValue, "Nuevo");
  assert.equal(change.changeType, "modify");
  assert.equal(change.validationStatus, "valid");
  assert.equal(change.validationError, null);
  assert.equal(change.conflictStatus, "none");
  assert.equal(change.approvalStatus, "pending");
  assert.equal(change.approvedValue, null);
  assert.ok(!Number.isNaN(Date.parse(change.createdAt)));
  assert.ok(!Number.isNaN(Date.parse(change.updatedAt)));
});

test("listChangeSetsForChannel returns an empty array for a channel with no change sets", async () => {
  const adapter = createSqlSourceAdapter();
  const result = await adapter.listChangeSetsForChannel("UC_never_had_any_change_sets");
  assert.deepEqual(result, []);
});
