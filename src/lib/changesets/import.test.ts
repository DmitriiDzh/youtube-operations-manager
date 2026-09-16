import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { DomainError } from "./contracts";
import type { StoredVideoRecord } from "./contracts";
import { MAX_WORKBOOK_BYTES, parseAndValidateWorkbook, summarizeParsedWorkbook } from "./import";

const LOCALIZATION_COLUMNS = [
  "video_id",
  "language",
  "language_name",
  "title",
  "description",
  "remote_title",
  "remote_description",
  "status",
] as const;

type Row = Partial<Record<(typeof LOCALIZATION_COLUMNS)[number], string>>;

async function buildWorkbookBuffer(args: {
  rows: Row[];
  includeMeta?: boolean;
  metaChannelId?: string;
  columns?: readonly string[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Localizations");
  const columns = args.columns ?? LOCALIZATION_COLUMNS;
  sheet.columns = columns.map((key) => ({ header: key, key }));
  for (const row of args.rows) {
    sheet.addRow(row);
  }

  if (args.includeMeta !== false) {
    const meta = workbook.addWorksheet("Meta");
    meta.columns = [{ header: "key", key: "key" }, { header: "value", key: "value" }];
    meta.addRow({ key: "schema_version", value: "2" });
    meta.addRow({ key: "exported_at", value: "2026-01-01T00:00:00.000Z" });
    meta.addRow({ key: "channel_id", value: args.metaChannelId ?? "UC_TEST" });
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
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

test("parseAndValidateWorkbook: rejects a workbook missing the Localizations sheet", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("SomethingElse");
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  await assert.rejects(
    () => parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [] }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("parseAndValidateWorkbook: rejects a workbook missing required columns", async () => {
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "es" }],
    columns: ["video_id", "language"],
    includeMeta: false,
  });

  await assert.rejects(
    () => parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [] }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("parseAndValidateWorkbook: rejects a workbook exported for a different channel", async () => {
  const buffer = await buildWorkbookBuffer({ rows: [], metaChannelId: "UC_OTHER" });

  await assert.rejects(
    () => parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [] }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("parseAndValidateWorkbook: blank title/description cells produce no proposed change (blank = no change)", async () => {
  const video = makeVideo({ existingLocalizations: { es: { title: "ES Title", description: "ES desc" } } });
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "es", title: "", description: "", remote_title: "ES Title", remote_description: "ES desc" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]!.fields.length, 0);
});

test("parseAndValidateWorkbook: a real title edit is classified MODIFY when a current remote value exists", async () => {
  const video = makeVideo({ existingLocalizations: { es: { title: "Viejo Titulo", description: "" } } });
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "es", title: "Nuevo Titulo", description: "", remote_title: "Viejo Titulo", remote_description: "" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.rows[0]!.fields.length, 1);
  assert.equal(parsed.rows[0]!.fields[0]!.changeType, "modify");
  assert.equal(parsed.rows[0]!.fields[0]!.conflictStatus, "none");
});

test("parseAndValidateWorkbook: a title edit is classified ADD when there is no current remote value", async () => {
  const video = makeVideo({ existingLocalizations: {} });
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "es", title: "Nuevo Titulo", description: "", remote_title: "", remote_description: "" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.rows[0]!.fields[0]!.changeType, "add");
});

test("parseAndValidateWorkbook: flags CONFLICT when the current remote value has drifted from the exported baseline", async () => {
  // Exported (baseline) remote_title was "Cuban Jazz"; the channel has since been
  // re-synced and now shows "Changed In Studio" -- YouTube Studio moved since export.
  const video = makeVideo({ existingLocalizations: { es: { title: "Changed In Studio", description: "" } } });
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "es", title: "My Proposed Title", description: "", remote_title: "Cuban Jazz", remote_description: "" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.rows[0]!.fields[0]!.conflictStatus, "conflict");
});

test("parseAndValidateWorkbook: rejects a video_id that does not belong to the synchronized channel", async () => {
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "not-synced", language: "es", title: "Titulo", description: "", remote_title: "", remote_description: "" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [] });
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0]!.message, /does not belong/);
});

test("parseAndValidateWorkbook: rejects malformed language codes", async () => {
  const video = makeVideo();
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "!!", title: "Titulo", description: "", remote_title: "", remote_description: "" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0]!.message, /Invalid language code/);
});

test("parseAndValidateWorkbook: rejects duplicate video_id+language rows", async () => {
  const video = makeVideo({ videoId: "v1" });
  const buffer = await buildWorkbookBuffer({
    rows: [
      { video_id: "v1", language: "es", title: "First", description: "", remote_title: "", remote_description: "" },
      { video_id: "v1", language: "es", title: "Second", description: "", remote_title: "", remote_description: "" },
    ],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0]!.message, /Duplicate/);
});

test("parseAndValidateWorkbook: flags an oversized title as an invalid field", async () => {
  const video = makeVideo();
  const longTitle = "x".repeat(101);
  const buffer = await buildWorkbookBuffer({
    rows: [{ video_id: "v1", language: "es", title: longTitle, description: "", remote_title: "", remote_description: "" }],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: [video] });
  assert.equal(parsed.rows[0]!.fields[0]!.validationStatus, "invalid");
});

test("parseAndValidateWorkbook: rejects a workbook larger than the configured size limit", async () => {
  const oversized = Buffer.alloc(MAX_WORKBOOK_BYTES + 1);
  await assert.rejects(
    () => parseAndValidateWorkbook({ buffer: oversized, channelId: "UC_TEST", syncedVideos: [] }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("summarizeParsedWorkbook: matches the mutually-exclusive row categories (valid/unchanged/invalid/conflict)", async () => {
  const videos = [
    makeVideo({ videoId: "v1", existingLocalizations: { es: { title: "Same Title", description: "" } } }),
    makeVideo({ videoId: "v2", existingLocalizations: { es: { title: "Old Title", description: "" } } }),
    makeVideo({ videoId: "v3", existingLocalizations: {} }),
  ];
  const buffer = await buildWorkbookBuffer({
    rows: [
      // unchanged: proposed === current remote
      { video_id: "v1", language: "es", title: "Same Title", description: "", remote_title: "Same Title", remote_description: "" },
      // valid change: real edit, no conflict
      { video_id: "v2", language: "es", title: "New Title", description: "", remote_title: "Old Title", remote_description: "" },
      // invalid: title too long
      { video_id: "v3", language: "es", title: "x".repeat(200), description: "", remote_title: "", remote_description: "" },
      // row-level error: unknown video
      { video_id: "unknown", language: "es", title: "X", description: "", remote_title: "", remote_description: "" },
    ],
  });

  const parsed = await parseAndValidateWorkbook({ buffer, channelId: "UC_TEST", syncedVideos: videos });
  const summary = summarizeParsedWorkbook(parsed);

  assert.equal(summary.validChanges, 1);
  assert.equal(summary.unchangedValues, 1);
  assert.equal(summary.invalidRows, 2);
  assert.equal(summary.conflicts, 0);
  assert.equal(summary.localizationRows, 4);
});
