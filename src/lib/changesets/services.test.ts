import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { DomainError } from "./contracts";
import type { StoredChangeRecord, StoredChangeSetRecord, StoredChannelRecord, StoredVideoRecord } from "./contracts";
import { createChangeSetServices } from "./services";

function makeChannel(overrides: Partial<StoredChannelRecord> = {}): StoredChannelRecord {
  return {
    channelId: "UC_TEST",
    title: "Tropico Jazz",
    thumbnailUrl: null,
    uploadsPlaylistId: "UU_TEST",
    connectedUserId: "user-1",
    connectedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function makeVideo(overrides: Partial<StoredVideoRecord> = {}): StoredVideoRecord {
  return {
    videoId: "v1",
    channelId: "UC_TEST",
    title: "Video 1",
    description: "Description 1",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: {},
    existingLocalizations: {},
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

async function buildWorkbookBuffer(rows: Array<Record<string, string>>, channelId = "UC_TEST"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Localizations");
  sheet.columns = [
    { header: "video_id", key: "video_id" },
    { header: "language", key: "language" },
    { header: "title", key: "title" },
    { header: "description", key: "description" },
    { header: "remote_title", key: "remote_title" },
    { header: "remote_description", key: "remote_description" },
  ];
  for (const row of rows) sheet.addRow(row);

  const meta = workbook.addWorksheet("Meta");
  meta.columns = [{ header: "key", key: "key" }, { header: "value", key: "value" }];
  meta.addRow({ key: "schema_version", value: "2" });
  meta.addRow({ key: "exported_at", value: "2026-01-01T00:00:00.000Z" });
  meta.addRow({ key: "channel_id", value: channelId });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function createFixture(options: { channelBaseline?: string | null; decisionLogFails?: boolean } = {}) {
  const decisions: Array<{ channelId: string; changeId: string; action: string }> = [];
  let channel = makeChannel();
  let videos: StoredVideoRecord[] = [makeVideo()];
  const changeSets = new Map<string, StoredChangeSetRecord>();
  const changesByChangeSet = new Map<string, StoredChangeRecord[]>();
  let idCounter = 0;
  const crdtConflictedChangeIds = new Set<string>();
  // Simulates a read side (SQL projection) that is missing some stored changes.
  const hiddenOnRead = new Set<string>();

  const channelStore = {
    async getChannel(channelId: string) {
      return channelId === channel.channelId ? channel : null;
    },
    async listVideosByChannel(channelId: string) {
      return channelId === channel.channelId ? videos : [];
    },
  };

  const changeSetStore = {
    async createChangeSetWithChanges(input: Parameters<
      Parameters<typeof createChangeSetServices>[0]["changeSetStore"]["createChangeSetWithChanges"]
    >[0]) {
      const now = new Date();
      changeSets.set(input.id, {
        id: input.id,
        channelId: input.channelId,
        source: input.source,
        status: input.status,
        importedFilename: input.importedFilename,
        schemaVersion: input.schemaVersion,
        exportedAt: input.exportedAt,
        createdAt: now,
        updatedAt: now,
      });
      changesByChangeSet.set(
        input.id,
        input.changes.map((c) => ({
          ...c,
          changeSetId: input.id,
          approvalStatus: "pending" as const,
          approvedValue: null,
          createdAt: now,
          updatedAt: now,
        }))
      );
    },
    async listChangeSetsByChannel(channelId: string) {
      return [...changeSets.values()].filter((cs) => cs.channelId === channelId);
    },
    async getChangeSet(changeSetId: string) {
      return changeSets.get(changeSetId) ?? null;
    },
    async listChangesByChangeSet(changeSetId: string) {
      return (changesByChangeSet.get(changeSetId) ?? []).filter((c) => !hiddenOnRead.has(c.id));
    },
    async updateChangeSetStatus(changeSetId: string, status: StoredChangeSetRecord["status"]) {
      const cs = changeSets.get(changeSetId);
      if (cs) changeSets.set(changeSetId, { ...cs, status, updatedAt: new Date() });
    },
    async updateChange(changeId: string, patch: Partial<StoredChangeRecord>) {
      for (const [changeSetId, list] of changesByChangeSet.entries()) {
        const idx = list.findIndex((c) => c.id === changeId);
        if (idx >= 0) {
          list[idx] = { ...list[idx]!, ...patch, updatedAt: new Date() };
          changesByChangeSet.set(changeSetId, list);
          return;
        }
      }
    },
    async bulkUpdateChanges(updates: Array<{ id: string; patch: Partial<StoredChangeRecord> }>) {
      for (const update of updates) {
        await this.updateChange(update.id, update.patch);
      }
    },
  };

  const crdtConflicts = {
    async listConflictedChangeIds() {
      return new Set(crdtConflictedChangeIds);
    },
  };

  const services = createChangeSetServices({
    channelStore,
    changeSetStore,
    crdtConflicts,
    ...(options.channelBaseline !== undefined ? { channelLanguageBaseline: { getExpectedDefaultLanguage: async () => options.channelBaseline ?? null } } : {}),
    idGenerator: () => `id-${++idCounter}`,
    logger: { info() {}, error() {} },
    decisionLog: {
      async record(channelId: string, list: Array<{ changeId: string; action: "approve" | "reject" }>) {
        if (options.decisionLogFails) throw new Error("document unavailable");
        for (const entry of list) decisions.push({ channelId, ...entry });
      },
    },
  });

  return {
    services,
    decisions,
    setVideos: (next: StoredVideoRecord[]) => {
      videos = next;
    },
    setChannel: (next: StoredChannelRecord) => {
      channel = next;
    },
    hideChangesOnRead: (ids: string[]) => {
      for (const id of ids) hiddenOnRead.add(id);
    },
    setCrdtConflictedChangeIds: (ids: string[]) => {
      crdtConflictedChangeIds.clear();
      for (const id of ids) crdtConflictedChangeIds.add(id);
    },
  };
}

test("createChangeSetFromImport: persists only real changes (skips unchanged rows) and reports an accurate summary", async () => {
  const { services } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Nuevo Titulo", description: "", remote_title: "", remote_description: "" },
  ]);

  const result = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });

  assert.equal(result.summary.validChanges, 1);
  assert.equal(result.changeSet.totalChanges, 1);
  assert.equal(result.changeSet.status, "in_review");
});

test("createChangeSetFromImport: rejects a video_id belonging to another channel's synchronized data", async () => {
  const { services } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "video-from-other-channel", language: "es", title: "X", description: "", remote_title: "", remote_description: "" },
  ]);

  const result = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  assert.equal(result.summary.invalidRows, 1);
  assert.equal(result.changeSet.totalChanges, 0);
});

test("approveChange: approves a valid non-conflicting change and updates the change set status", async () => {
  const { services } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Nuevo Titulo", description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  const changeId = detail.changes[0]!.id;

  const result = await services.approveChange({ channelId: "UC_TEST", changeSetId, changeId });
  assert.equal(result.change.approvalStatus, "approved");
  assert.equal(result.change.approvedValue, "Nuevo Titulo");
  assert.equal(result.changeSet.status, "approved");
});

test("approveChange: refuses to approve a conflicting change", async () => {
  const { services, setVideos } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Proposed", description: "", remote_title: "Baseline", remote_description: "" },
  ]);
  // Remote already drifted from the exported baseline before the change set is even created.
  setVideos([makeVideo({ existingLocalizations: { es: { title: "Drifted", description: "" } } })]);

  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  const changeId = detail.changes[0]!.id;

  await assert.rejects(
    () => services.approveChange({ channelId: "UC_TEST", changeSetId, changeId }),
    (error: unknown) => error instanceof DomainError && error.code === "change_not_approvable"
  );
});

// RISK-47 (docs/TECHNICAL_DEBT.md): a change with an open CRDT-level FieldConflict (a different
// concept from this module's own conflictStatus, see that risk entry) must also be refused.
test("approveChange: refuses to approve a change with an open CRDT-level field conflict", async () => {
  const { services, setCrdtConflictedChangeIds } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Nuevo Titulo", description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  const changeId = detail.changes[0]!.id;

  setCrdtConflictedChangeIds([changeId]);

  await assert.rejects(
    () => services.approveChange({ channelId: "UC_TEST", changeSetId, changeId }),
    (error: unknown) => error instanceof DomainError && error.code === "crdt_conflict_open"
  );

  // Must not have been partially approved.
  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  assert.equal(after.changes[0]!.approvalStatus, "pending");
});

test("approveChange: a change is approvable once its CRDT-level conflict is no longer reported as open", async () => {
  const { services, setCrdtConflictedChangeIds } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Nuevo Titulo", description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  const changeId = detail.changes[0]!.id;

  setCrdtConflictedChangeIds(["some-other-change-id"]);

  const result = await services.approveChange({ channelId: "UC_TEST", changeSetId, changeId });
  assert.equal(result.change.approvalStatus, "approved");
});

test("approveAllValid: silently excludes a change with an open CRDT-level conflict from the bulk approval, without failing the whole batch", async () => {
  const { services, setCrdtConflictedChangeIds } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Titulo ES", description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  const changeId = detail.changes[0]!.id;

  setCrdtConflictedChangeIds([changeId]);

  const result = await services.approveAllValid({ channelId: "UC_TEST", changeSetId });
  assert.equal(result.approvedCount, 0);

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  assert.equal(after.changes[0]!.approvalStatus, "pending");
});

test("re-sync draft preservation: approving a change, then a later re-sync changing the remote value invalidates the approval", async () => {
  const { services, setVideos } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Proposed", description: "", remote_title: "Baseline", remote_description: "" },
  ]);
  setVideos([makeVideo({ existingLocalizations: { es: { title: "Baseline", description: "" } } })]);

  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const before = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  const changeId = before.changes[0]!.id;

  const approved = await services.approveChange({ channelId: "UC_TEST", changeSetId, changeId });
  assert.equal(approved.change.approvalStatus, "approved");

  // Simulate a channel re-sync that picked up a change made directly in YouTube Studio.
  setVideos([makeVideo({ existingLocalizations: { es: { title: "Changed In Studio", description: "" } } })]);

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  assert.equal(after.changes.length, 1, "the draft/change must survive the re-sync, not be deleted");
  assert.equal(after.changes[0]!.conflictStatus, "conflict");
  assert.equal(after.changes[0]!.approvalStatus, "pending", "a stale approval must be invalidated, not silently kept");
  assert.equal(after.changeSet.status, "in_review");
});

test("approveAllValid: bulk-approves only valid, non-conflicting, pending changes", async () => {
  const { services, setVideos } = createFixture();
  setVideos([
    makeVideo({ videoId: "v1", existingLocalizations: {} }),
    makeVideo({ videoId: "v2", existingLocalizations: { es: { title: "Drifted", description: "" } } }),
  ]);
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Valid Edit", description: "", remote_title: "", remote_description: "" },
    { video_id: "v2", language: "es", title: "Conflicting Edit", description: "", remote_title: "Baseline", remote_description: "" },
    { video_id: "v1", language: "es", title: "x".repeat(200), description: "", remote_title: "", remote_description: "" },
  ]);

  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const result = await services.approveAllValid({ channelId: "UC_TEST", changeSetId: created.changeSet.id });

  assert.equal(result.approvedCount, 1);
  assert.equal(result.changeSet.status, "in_review", "conflicting/invalid rows keep the set in_review");
});

test("getChangeSet: refuses access to a change set belonging to a different channel", async () => {
  const { services } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "X", description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });

  await assert.rejects(
    () => services.getChangeSet({ channelId: "UC_OTHER", changeSetId: created.changeSet.id }),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

test("rejectChange then reject-all: rejecting is always allowed, including for invalid/conflicting changes", async () => {
  const { services } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "x".repeat(200), description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.equal(detail.changes[0]!.validationStatus, "invalid");

  const result = await services.rejectChange({
    channelId: "UC_TEST",
    changeSetId: created.changeSet.id,
    changeId: detail.changes[0]!.id,
  });
  assert.equal(result.change.approvalStatus, "rejected");
});

// ---------------------------------------------------------------------------
// proposeLocalizationDeletion (docs/PROJECT_SPEC.md §16/§21). Acceptance fixed before
// implementation (advisor-reviewed scope, E5a/E5b split): a deletion proposal is a
// two-Change-per-video, source:"deletion" Change Set spanning every affected video,
// that goes through the ordinary review/approval/conflict pipeline -- it is NOT an
// immediate delete. `videoIds` omitted means "every video on the channel with a real
// localization in this language" (the whole-column/E5b case); provided explicitly it
// scopes to exactly those videos (BL-036's original single-video behavior). A video
// whose own defaultLanguage equals the requested language is NEVER included --
// that language's title/description live on snippet, not a removable localizations
// entry -- and is reported in skippedDefaultLanguageVideoIds instead, computed
// independently of existingLocalizations (a video can be missing a localizations
// entry for its own defaultLanguage entirely and must still be reported skipped,
// not silently uncounted).
// ---------------------------------------------------------------------------

test("proposeLocalizationDeletion: creates a two-Change, source:\"deletion\" Change Set from the existing localization (single video, explicit videoIds)", async () => {
  const { services, setVideos } = createFixture();
  setVideos([
    makeVideo({
      defaultLanguage: "en",
      existingLocalizations: { es: { title: "Titulo ES", description: "Descripcion ES" } },
    }),
  ]);

  const result = await services.proposeLocalizationDeletion({ channelId: "UC_TEST", videoIds: ["v1"], language: "es" });

  assert.deepEqual(result.affectedVideoIds, ["v1"]);
  assert.deepEqual(result.skippedDefaultLanguageVideoIds, []);
  assert.ok(result.changeSet);
  assert.equal(result.changeSet.source, "deletion");
  assert.equal(result.changeSet.totalChanges, 2);

  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: result.changeSet.id });
  const byField = new Map(detail.changes.map((c) => [c.field, c]));

  assert.equal(byField.get("title")!.changeType, "delete");
  assert.equal(byField.get("title")!.baselineValue, "Titulo ES");
  assert.equal(byField.get("title")!.proposedValue, "");
  assert.equal(byField.get("description")!.changeType, "delete");
  assert.equal(byField.get("description")!.baselineValue, "Descripcion ES");
  assert.equal(byField.get("description")!.proposedValue, "");
});

test("proposeLocalizationDeletion: never includes a video whose own defaultLanguage equals the requested language, and reports it skipped", async () => {
  const { services, setVideos } = createFixture();
  setVideos([makeVideo({ defaultLanguage: "en", existingLocalizations: {} })]);

  const result = await services.proposeLocalizationDeletion({ channelId: "UC_TEST", videoIds: ["v1"], language: "en" });

  assert.deepEqual(result.affectedVideoIds, []);
  assert.deepEqual(result.skippedDefaultLanguageVideoIds, ["v1"]);
  assert.equal(result.changeSet, null);
});

test("proposeLocalizationDeletion: a video whose defaultLanguage matches is skipped even with zero existingLocalizations entries for it (the undercount trap)", async () => {
  const { services, setVideos } = createFixture();
  // "en" is v1's defaultLanguage but was never separately written into existingLocalizations --
  // collectChannelLanguages-style unions would see nothing here; the skip must still be reported.
  setVideos([makeVideo({ videoId: "v1", defaultLanguage: "en", existingLocalizations: {} })]);

  const result = await services.proposeLocalizationDeletion({ channelId: "UC_TEST", language: "en" });

  assert.deepEqual(result.skippedDefaultLanguageVideoIds, ["v1"]);
  assert.deepEqual(result.affectedVideoIds, []);
  assert.equal(result.changeSet, null);
});

test("proposeLocalizationDeletion: whole-column form (videoIds omitted) spans every video on the channel with a real localization, skipping unrelated ones", async () => {
  const { services, setVideos } = createFixture();
  setVideos([
    makeVideo({
      videoId: "v1",
      defaultLanguage: "en",
      existingLocalizations: { es: { title: "Titulo ES 1", description: "Desc ES 1" } },
    }),
    makeVideo({
      videoId: "v2",
      defaultLanguage: "en",
      existingLocalizations: { es: { title: "Titulo ES 2", description: "Desc ES 2" }, de: { title: "DE", description: "DE desc" } },
    }),
    // v3 has no "es" localization at all -- must be silently excluded, not an error.
    makeVideo({ videoId: "v3", defaultLanguage: "en", existingLocalizations: {} }),
    // v4's defaultLanguage IS "es" -- must be skipped and reported, never deleted.
    makeVideo({ videoId: "v4", defaultLanguage: "es", existingLocalizations: {} }),
  ]);

  const result = await services.proposeLocalizationDeletion({ channelId: "UC_TEST", language: "es" });

  assert.deepEqual(result.affectedVideoIds.sort(), ["v1", "v2"]);
  assert.deepEqual(result.skippedDefaultLanguageVideoIds, ["v4"]);
  assert.ok(result.changeSet);
  assert.equal(result.changeSet.totalChanges, 4); // 2 videos x (title + description)

  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: result.changeSet.id });
  assert.deepEqual(
    detail.changes.map((c) => c.videoId).sort(),
    ["v1", "v1", "v2", "v2"]
  );
});

test("proposeLocalizationDeletion + re-sync: a third-party edit made after proposing deletion is detected as a conflict, not silently applied", async () => {
  const { services, setVideos } = createFixture();
  setVideos([
    makeVideo({
      defaultLanguage: "en",
      existingLocalizations: { es: { title: "Titulo ES", description: "Descripcion ES" } },
    }),
  ]);

  const result = await services.proposeLocalizationDeletion({ channelId: "UC_TEST", videoIds: ["v1"], language: "es" });
  assert.ok(result.changeSet);

  // Someone edits the Spanish title directly in YouTube Studio, then the channel re-syncs.
  setVideos([
    makeVideo({
      defaultLanguage: "en",
      existingLocalizations: { es: { title: "Changed In Studio", description: "Descripcion ES" } },
    }),
  ]);

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: result.changeSet.id });
  const titleChange = after.changes.find((c) => c.field === "title")!;
  assert.equal(titleChange.conflictStatus, "conflict", "a deletion baseline that no longer matches the live remote value must be flagged, never silently applied");
  assert.equal(after.changeSet.status, "in_review");
});

// --- auto-revoke of superseded proposals (owner instruction 2026-10-02) ---------------------

function proposed(id: string, videoId: string, language: string, field: "title" | "description", value: string) {
  return {
    id,
    videoId,
    language,
    field,
    baselineValue: "",
    proposedValue: value,
    changeType: "add" as const,
    validationStatus: "valid" as const,
    validationError: null,
    conflictStatus: "none" as const,
  };
}

test("a new same-source change set revokes only the older PENDING changes it covers; uncovered ones stay pending", async () => {
  const { services } = createFixture();
  const old = await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "ai_localization",
    changes: [
      proposed("o1", "v1", "ja", "title", "old title"),
      proposed("o2", "v1", "ja", "description", "old description"),
      proposed("o3", "v1", "es", "title", "otro titulo"),
    ],
  });

  await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "ai_localization",
    changes: [proposed("n1", "v1", "ja", "title", "new title"), proposed("n2", "v1", "ja", "description", "new description")],
  });

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: old.id });
  const byId = new Map(after.changes.map((c) => [c.id, c.approvalStatus]));
  assert.equal(byId.get("o1"), "rejected");
  assert.equal(byId.get("o2"), "rejected");
  assert.equal(byId.get("o3"), "pending");
});

test("an already APPROVED older change is never revoked by a newer set", async () => {
  const { services } = createFixture();
  const old = await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "ai_localization",
    changes: [proposed("o1", "v1", "ja", "title", "old title")],
  });
  await services.approveChange({ channelId: "UC_TEST", changeSetId: old.id, changeId: "o1" });

  await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "ai_localization",
    changes: [proposed("n1", "v1", "ja", "title", "new title")],
  });

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: old.id });
  assert.equal(after.changes.find((c) => c.id === "o1")?.approvalStatus, "approved");
});

test("a different source, or a new deletion set, never revokes anything", async () => {
  const { services } = createFixture();
  const old = await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "ai_localization",
    changes: [proposed("o1", "v1", "ja", "title", "old title")],
  });

  await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "xlsx_import",
    changes: [proposed("n1", "v1", "ja", "title", "from xlsx")],
  });
  await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "deletion",
    changes: [{ ...proposed("n2", "v1", "ja", "title", ""), changeType: "delete" as const }],
  });

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: old.id });
  assert.equal(after.changes.find((c) => c.id === "o1")?.approvalStatus, "pending");
});

test("a Change Set that reads back smaller than what was submitted is never reported as created: change_set_incomplete names what is missing (2026-10-04 incident: 106 sent, 75 visible, no error)", async () => {
  const { services, hideChangesOnRead } = createFixture();
  hideChangesOnRead(["n2", "n4"]);
  await assert.rejects(
    () =>
      services.createChangeSetFromProposals({
        channelId: "UC_TEST",
        source: "ai_localization",
        changes: [
          proposed("n1", "v1", "es", "title", "uno"),
          proposed("n2", "v1", "es", "description", "dos"),
          proposed("n3", "v1", "ja", "title", "tres"),
          proposed("n4", "v1", "ja", "description", "cuatro"),
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "change_set_incomplete");
      const details = error.details as { expectedChanges: number; storedChanges: number; missingTotal: number; missing: unknown };
      assert.equal(details.expectedChanges, 4);
      assert.equal(details.storedChanges, 2);
      assert.equal(details.missingTotal, 2);
      assert.deepEqual(details.missing, [
        { videoId: "v1", language: "es", field: "description" },
        { videoId: "v1", language: "ja", field: "description" },
      ]);
      return true;
    }
  );
});

test("a complete Change Set still reports success with the true counts", async () => {
  const { services } = createFixture();
  const created = await services.createChangeSetFromProposals({
    channelId: "UC_TEST",
    source: "ai_localization",
    changes: [proposed("n1", "v1", "es", "title", "uno"), proposed("n2", "v1", "es", "description", "dos")],
  });
  assert.equal(created.totalChanges, 2);
  assert.equal(created.pendingCount, 2);
});

test("owner report 2026-10-04: an approved change whose value then became live (sent + synced) stays approved and conflict-free; the set stays approved, not back in review", async () => {
  const { services, setVideos } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Proposed", description: "", remote_title: "Baseline", remote_description: "" },
  ]);
  setVideos([makeVideo({ existingLocalizations: { es: { title: "Baseline", description: "" } } })]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changeSetId = created.changeSet.id;
  const changeId = (await services.getChangeSet({ channelId: "UC_TEST", changeSetId })).changes[0]!.id;
  await services.approveChange({ channelId: "UC_TEST", changeSetId, changeId });

  // The write reached YouTube and the local copy now shows the proposed value.
  setVideos([makeVideo({ existingLocalizations: { es: { title: "Proposed", description: "" } } })]);

  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId });
  assert.equal(after.changes[0]!.conflictStatus, "none");
  assert.equal(after.changes[0]!.approvalStatus, "approved");
  assert.equal(after.changeSet.status, "approved");
});

// ---------------------------------------------------------------------------
// BL-178 (PROJECT_SPEC §14, owner exception 2026-10-12, msg 2665; FO-REQ-0022). Expected values by hand from the request's case:
// a video labelled `es` whose text is English, YouTube's mirror `localizations.es` equal to the snippet, channel baseline `en`.
// An `es` row is a translation (add, against nothing), never an edit of the original; a row made earlier against the mirror
// still holds (no conflict) and stays approvable.
// ---------------------------------------------------------------------------
const EN_T = "Cuban Jazz Morning Coffee";
const EN_D = "Two hours of relaxing Cuban jazz";
const MISLABELLED = () => makeVideo({ title: EN_T, description: EN_D, defaultLanguage: "es", existingLocalizations: { es: { title: EN_T, description: EN_D } } });

test("BL-178: with baseline en, an es row for a video labelled es is a translation (add), not an edit of the original", async () => {
  const { services, setVideos } = createFixture({ channelBaseline: "en" });
  setVideos([MISLABELLED()]);
  const buffer = await buildWorkbookBuffer([{ video_id: "v1", language: "es", title: "Jazz cubano", description: "", remote_title: "", remote_description: "" }]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.equal(detail.changes[0]!.changeType, "add");
  assert.equal(detail.changes[0]!.conflictStatus, "none");
  const approved = await services.approveChange({ channelId: "UC_TEST", changeSetId: created.changeSet.id, changeId: detail.changes[0]!.id });
  assert.equal(approved.change.approvalStatus, "approved");
});

test("BL-178: a row made against the mirror (remote = the English title, set 66cbf969's shape) does not become a conflict and stays approvable", async () => {
  const { services, setVideos } = createFixture({ channelBaseline: "en" });
  setVideos([MISLABELLED()]);
  const buffer = await buildWorkbookBuffer([{ video_id: "v1", language: "es", title: "Jazz cubano", description: "", remote_title: EN_T, remote_description: "" }]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.equal(detail.changes[0]!.conflictStatus, "none");
  await services.approveChange({ channelId: "UC_TEST", changeSetId: created.changeSet.id, changeId: detail.changes[0]!.id });
  // The snippet changed afterwards: now it is a real conflict and the approval is withdrawn.
  setVideos([makeVideo({ title: "A new English title", description: EN_D, defaultLanguage: "es", existingLocalizations: { es: { title: "A new English title", description: EN_D } } })]);
  const after = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.equal(after.changes[0]!.conflictStatus, "conflict");
  assert.equal(after.changes[0]!.approvalStatus, "pending");
});

test("BL-178: without a baseline the video is read as it is (the es row compares with the snippet, as before)", async () => {
  const { services, setVideos } = createFixture({ channelBaseline: null });
  setVideos([MISLABELLED()]);
  const buffer = await buildWorkbookBuffer([{ video_id: "v1", language: "es", title: "Jazz cubano", description: "", remote_title: EN_T, remote_description: "" }]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.equal(detail.changes[0]!.changeType, "modify");
});

test("BL-178: the change set lists the videos whose language the send will align (es -> en), so the approval screen can show it", async () => {
  const { services, setVideos } = createFixture({ channelBaseline: "en" });
  setVideos([MISLABELLED(), makeVideo({ videoId: "v2" })]);
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Jazz cubano", description: "", remote_title: "", remote_description: "" },
    { video_id: "v2", language: "es", title: "Nuevo", description: "", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.deepEqual(detail.languageAlignments, [{ videoId: "v1", from: "es", to: "en" }]);
});

test("BL-226: the change set names the translations it would leave without a title, so the review screen shows them before approval", async () => {
  // Expected by hand: v1 has no `it` title on YouTube and the `it` title row is too long (invalid), so its `it` description would
  // go alone -> named. v1's `fr` already has a title on YouTube, so a description alone is fine; `de` comes with its title.
  const { services, setVideos } = createFixture({ channelBaseline: "en" });
  setVideos([makeVideo({ existingLocalizations: { fr: { title: "Titre", description: "" } } })]);
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "it", title: "x".repeat(101), description: "Descrizione", remote_title: "", remote_description: "" },
    { video_id: "v1", language: "fr", title: "", description: "Description fr", remote_title: "Titre", remote_description: "" },
    { video_id: "v1", language: "de", title: "Titel", description: "Beschreibung", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.deepEqual(detail.untitledTranslations, [{ videoId: "v1", language: "it" }]);
});

test("BL-226 (review): a conflicting title does not count as on its way, and a conflicting description is not flagged", async () => {
  // Expected by hand: the `it` title row's baseline ("Old") no longer matches YouTube's (none) -> conflict, never sent, so the `it`
  // description goes alone -> named. The `de` description's baseline ("Alt") mismatches too -> conflict, never sent -> not named.
  const { services, setVideos } = createFixture({ channelBaseline: "en" });
  setVideos([makeVideo()]);
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "it", title: "Titolo", description: "Descrizione", remote_title: "Old", remote_description: "" },
    { video_id: "v1", language: "de", title: "", description: "Beschreibung", remote_title: "", remote_description: "Alt" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.deepEqual(detail.untitledTranslations, [{ videoId: "v1", language: "it" }]);
});


test("BL-227 AC-LR-08: approve, reject and the bulk forms each record a decision; a failing log never fails the decision", async () => {
  const { services, decisions } = createFixture();
  const buffer = await buildWorkbookBuffer([
    { video_id: "v1", language: "es", title: "Hola", description: "Desc", remote_title: "", remote_description: "" },
  ]);
  const created = await services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const detail = await services.getChangeSet({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  const [title, description] = detail.changes;
  await services.approveChange({ channelId: "UC_TEST", changeSetId: created.changeSet.id, changeId: title.id });
  await services.rejectChange({ channelId: "UC_TEST", changeSetId: created.changeSet.id, changeId: title.id });
  await services.approveAllValid({ channelId: "UC_TEST", changeSetId: created.changeSet.id });
  assert.deepEqual(decisions.map((d) => [d.changeId, d.action]), [
    [title.id, "approve"],
    [title.id, "reject"],
    [description.id, "approve"],
  ]);

  const failing = createFixture({ decisionLogFails: true });
  const again = await failing.services.createChangeSetFromImport({ channelId: "UC_TEST", filename: "import.xlsx", buffer });
  const changes = (await failing.services.getChangeSet({ channelId: "UC_TEST", changeSetId: again.changeSet.id })).changes;
  const result = await failing.services.approveChange({ channelId: "UC_TEST", changeSetId: again.changeSet.id, changeId: changes[0].id });
  assert.equal(result.change.approvalStatus, "approved");
});
