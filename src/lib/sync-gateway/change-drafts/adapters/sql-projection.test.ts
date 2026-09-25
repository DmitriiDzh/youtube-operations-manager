import assert from "node:assert/strict";
import test from "node:test";
import { getGenerationProvenanceByChangeSetId, getStoredChangeById, getStoredChangeSet, upsertChannel } from "@/lib/db";
import { createSqlProjectionAdapter } from "./sql-projection";
import type { DraftChange, DraftChangeSet, DraftProvenance } from "../contracts";

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

// Phase 7 slice F regression (docs/AGENT_OPERATIONS_INTERFACE.md §4e, owner spec §12/§13/§22):
// `setStoredGenerationProvenanceRow` uses `onConflictDoUpdate`, not `onConflictDoNothing` --
// re-projecting an id that already exists in SQL must actually overwrite its columns with
// whatever the CRDT document currently says, never silently leave a pre-existing row frozen at
// whatever it happened to hold before. (Provenance is write-once in the CRDT itself -- the
// realistic case this protects is a SQL row inserted on an older schema/app version, or from an
// older CRDT-entry shape, later getting a fresh, complete write once a full re-projection runs
// with the current, correct values -- not the CRDT's own content changing.) Proves this against
// real SQLite, since a fake `onConflictDoNothing` vs. `onConflictDoUpdate` distinction could
// easily be "right by accident" in a mock.
test("upsertProvenance overwrites an existing row's columns on a second call, instead of leaving it untouched", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  const adapter = createSqlProjectionAdapter();
  await adapter.upsertChangeSet({
    id: "cs-proj-prov-1",
    channelId: CHANNEL,
    source: "ai_localization",
    status: "in_review",
    importedFilename: null,
    schemaVersion: null,
    exportedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  const staleProvenance: DraftProvenance = {
    id: "prov-proj-1",
    changeSetId: "cs-proj-prov-1",
    channelId: CHANNEL,
    profileVersion: 2,
    effectiveContextJson: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    evidenceJson: null,
    rationale: null,
    createdVia: null,
    agentApiVersion: null,
  };
  await adapter.upsertProvenance(staleProvenance);

  const stale = await getGenerationProvenanceByChangeSetId("cs-proj-prov-1");
  assert.equal(stale?.evidenceJson, null);
  assert.equal(stale?.createdVia, null);

  // Re-projecting the same id with different values -- a mechanical property of the SQL
  // adapter's own upsert, regardless of how a real caller might arrive at it.
  const backfilledProvenance: DraftProvenance = {
    ...staleProvenance,
    evidenceJson: JSON.stringify([
      { url: "https://example.com/report", retrievedAt: "2026-09-24T00:00:00.000Z", description: "Comparable video performance", claimSupported: "Shorter titles outperform", sourceType: "external_research" },
    ]),
    rationale: "Shorter titles tested better on 3 comparable videos.",
    createdVia: "mcp",
    agentApiVersion: "0.6.0",
  };
  await adapter.upsertProvenance(backfilledProvenance);

  const backfilled = await getGenerationProvenanceByChangeSetId("cs-proj-prov-1");
  assert.equal(backfilled?.id, "prov-proj-1", "same row, not a duplicate");
  assert.ok(backfilled?.evidenceJson, "evidence must be backfilled, not left null forever");
  assert.equal(backfilled?.rationale, "Shorter titles tested better on 3 comparable videos.");
  assert.equal(backfilled?.createdVia, "mcp");
  assert.equal(backfilled?.agentApiVersion, "0.6.0");
});

// Phase 7 slice F backward-compatibility regression: Automerge has no schema migration
// (`ChannelDraftDocument.provenance?`'s own doc comment), so a provenance entry created before
// this slice existed literally lacks the `evidenceJson`/`rationale`/`createdVia`/`agentApiVersion`
// keys -- reading them is `undefined`, not `null`. `upsertProvenance` must normalize this to
// `null` before writing, never pass `undefined` through to the SQL layer.
test("upsertProvenance projects a pre-slice-F entry (missing the new keys entirely) without throwing, reading back null", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  const adapter = createSqlProjectionAdapter();
  await adapter.upsertChangeSet({
    id: "cs-proj-prov-2",
    channelId: CHANNEL,
    source: "ai_localization",
    status: "in_review",
    importedFilename: null,
    schemaVersion: null,
    exportedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });

  // Deliberately omits evidenceJson/rationale/createdVia/agentApiVersion -- simulates a real
  // Automerge document entry saved before this slice's fields existed, cast through `Omit` since
  // the real `DraftProvenance` type now marks them optional, but a genuinely pre-existing entry
  // has no such keys at all, not even as `undefined` own-properties.
  const preSliceFProvenance = {
    id: "prov-proj-2",
    changeSetId: "cs-proj-prov-2",
    channelId: CHANNEL,
    profileVersion: 1,
    effectiveContextJson: null,
    createdAt: "2026-08-01T00:00:00.000Z",
  } as DraftProvenance;

  await assert.doesNotReject(() => adapter.upsertProvenance(preSliceFProvenance));

  const projected = await getGenerationProvenanceByChangeSetId("cs-proj-prov-2");
  assert.equal(projected?.evidenceJson, null);
  assert.equal(projected?.rationale, null);
  assert.equal(projected?.createdVia, null);
  assert.equal(projected?.agentApiVersion, null);
});
