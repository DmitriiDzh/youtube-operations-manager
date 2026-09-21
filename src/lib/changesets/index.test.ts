import assert from "node:assert/strict";
import test from "node:test";
import { upsertChannel, upsertVideos } from "@/lib/db";
import { createChangeDraftsCoreForProduction } from "@/lib/change-drafts";
import { createChangeSetCore } from "./index";

// Real end-to-end test of the CD2 cutover (docs/decisions/0006-*.md,
// AUTOMERGE_MIGRATION_PLAN.md): createChangeSetCore()'s REAL production wiring, not a fake --
// proves the whole loop actually works: services.ts -> the new Automerge-backed adapter ->
// change-drafts (Automerge document) -> SQL read-projection -> read back through services.ts's
// own read path, exactly the way a real API route/MCP tool/CLI command uses it. Nothing before
// this test exercised the real wiring at all (every existing changesets/MCP/CLI test injects a
// fake store), so this is the one place a regression in the cutover itself would actually be
// caught.

const CHANNEL = "UC_changesets_cutover_test";

test("createChangeSetFromProposals -> listChangeSets/getChangeSet/approveChange round-trip through the real Automerge-backed adapter", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test Channel", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "v1",
        channelId: CHANNEL,
        title: "Original Title",
        description: "Original description",
        publishedAt: "2026-01-01T00:00:00.000Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        thumbnails: {},
        existingLocalizations: {},
        etag: null,
      },
    ],
    new Date()
  );

  const core = createChangeSetCore();

  const created = await core.createChangeSetFromProposals({
    channelId: CHANNEL,
    source: "ai_localization",
    changes: [
      {
        id: "c-cutover-1",
        videoId: "v1",
        language: "en",
        field: "title",
        baselineValue: "Original Title",
        proposedValue: "New Title",
        changeType: "modify",
        validationStatus: "valid",
        validationError: null,
        conflictStatus: "none",
      },
      {
        id: "c-cutover-2",
        videoId: "v1",
        language: "en",
        field: "description",
        baselineValue: "Original description",
        proposedValue: "New description",
        changeType: "modify",
        validationStatus: "valid",
        validationError: null,
        conflictStatus: "none",
      },
    ],
  });

  assert.equal(created.channelId, CHANNEL);
  assert.equal(created.totalChanges, 2);

  // Read back through services.ts's own read path (SQL, unchanged) -- proves the projection
  // actually landed before createChangeSetFromProposals returned, for BOTH changes in the batch
  // (this exercises the batched createChangeSetWithChanges adapter path, not just a single-change
  // write).
  const listed = await core.listChangeSets({ channelId: CHANNEL });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const fetched = await core.getChangeSet({ channelId: CHANNEL, changeSetId: created.id });
  assert.equal(fetched.changes.length, 2);
  assert.equal(fetched.changes.find((c) => c.id === "c-cutover-1")?.proposedValue, "New Title");
  assert.equal(fetched.changes.find((c) => c.id === "c-cutover-2")?.proposedValue, "New description");
  assert.ok(fetched.changes.every((c) => c.approvalStatus === "pending"));

  // Cross-check the OTHER side of the projection: both changes genuinely exist in the Automerge
  // document too, not just in SQL -- proves the write actually went through change-drafts/,
  // not some path that bypassed it and wrote SQL directly.
  const draftsCore = createChangeDraftsCoreForProduction();
  const doc = await draftsCore.getDocument({ channelId: CHANNEL });
  assert.equal(doc.changes["c-cutover-1"].proposedValue, "New Title");
  assert.equal(doc.changes["c-cutover-2"].proposedValue, "New description");
  assert.equal(doc.changeSets[created.id].channelId, CHANNEL);

  // approveChange exercises the adapter's updateChange path (changeSetId/changeId resolution
  // back to channelId via the SQL projection lookup) for one change...
  const approved = await core.approveChange({ channelId: CHANNEL, changeSetId: created.id, changeId: "c-cutover-1" });
  assert.equal(approved.change.approvalStatus, "approved");
  assert.equal(approved.changeSet.status, "in_review", "c-cutover-2 is still pending, so the set as a whole is still in_review");

  // ...and rejectAllPending exercises the adapter's batched bulkUpdateChanges path for the rest.
  const rejected = await core.rejectAllPending({ channelId: CHANNEL, changeSetId: created.id });
  assert.equal(rejected.rejectedCount, 1);
  assert.equal(rejected.changeSet.status, "partially_approved");

  // The Automerge document reflects both the approval and the bulk rejection.
  const docAfter = await draftsCore.getDocument({ channelId: CHANNEL });
  assert.equal(docAfter.changes["c-cutover-1"].approvalStatus, "approved");
  assert.equal(docAfter.changes["c-cutover-2"].approvalStatus, "rejected");
});
