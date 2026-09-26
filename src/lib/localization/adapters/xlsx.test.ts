import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildHeaderIndex } from "@/lib/shared-xlsx";
import { createXlsxBuilder } from "./xlsx";
import type { StoredChannelRecord, StoredVideoRecord } from "../contracts";

const channel: StoredChannelRecord = {
  channelId: "UC_TEST",
  title: "Tropico Jazz",
  thumbnailUrl: null,
  uploadsPlaylistId: "UU_TEST",
  connectedUserId: "user-1",
  connectedAt: new Date("2026-01-01T00:00:00.000Z"),
  lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
};

const videos: StoredVideoRecord[] = [
  {
    videoId: "v1",
    channelId: "UC_TEST",
    title: "Video One",
    description: "First video description",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: { default: { url: "https://example.com/v1.jpg", width: 120, height: 90 } },
    existingLocalizations: { es: { title: "ES Title", description: "ES description" } },
    etag: "etag-v1",
    lastSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
  },
  {
    videoId: "v2",
    channelId: "UC_TEST",
    title: "Video Two",
    description: "Second video description",
    publishedAt: "2026-01-03T00:00:00.000Z",
    privacyStatus: "unlisted",
    defaultLanguage: "en",
    defaultAudioLanguage: null,
    thumbnails: {},
    existingLocalizations: {},
    etag: "etag-v2",
    lastSyncedAt: new Date("2026-01-04T00:00:00.000Z"),
  },
];

test("buildWorkbook produces a Videos sheet with one row per video and canonical video_id values", async () => {
  const builder = createXlsxBuilder();
  const { buffer } = await builder.buildWorkbook({ channel, videos });

  const workbook = new ExcelJS.Workbook();
  // Pre-existing @types/node vs. exceljs Buffer-generic mismatch (same as
  // changesets/import.ts) -- cast is data-safe, load() only reads bytes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  const videosSheet = workbook.getWorksheet("Videos");
  assert.ok(videosSheet);

  const header = videosSheet!.getRow(1).values as unknown[];
  assert.ok(header.includes("video_id"));
  assert.ok(header.includes("original_title"));

  assert.equal(videosSheet!.rowCount, 3); // header + 2 videos

  const row2 = videosSheet!.getRow(2).values as unknown[];
  assert.ok(row2.includes("v1"));
  assert.ok(row2.includes("https://www.youtube.com/watch?v=v1"));
});

test("buildWorkbook produces a Localizations sheet with a row per video x channel-wide language", async () => {
  const builder = createXlsxBuilder();
  const { buffer, rowCount } = await builder.buildWorkbook({ channel, videos });

  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  const localizationsSheet = workbook.getWorksheet("Localizations");
  assert.ok(localizationsSheet);

  // Only one language ("es") exists anywhere in this video set, so each of the 2
  // videos gets exactly one Localizations row: v1 "Existing", v2 "Missing".
  assert.equal(rowCount, 2);
  assert.equal(localizationsSheet!.rowCount, 3); // header + 2 rows

  const rows = [2, 3].map((i) => localizationsSheet!.getRow(i).values as unknown[]);
  const statuses = rows.map((r) => r[r.length - 1]);
  assert.deepEqual(statuses.sort(), ["Existing", "Missing"]);
});

test("buildWorkbook scopes to the exact videos passed in, regardless of full channel history", async () => {
  const builder = createXlsxBuilder();
  const { buffer } = await builder.buildWorkbook({ channel, videos: [videos[0]!] });

  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  const videosSheet = workbook.getWorksheet("Videos");
  assert.equal(videosSheet!.rowCount, 2); // header + 1 video
});

// Independent review finding (2026-09-26, shared-xlsx extraction): the pre-existing 3 tests
// above never asserted anything about frozen panes/autofilter/wrapped text, so the extraction's
// "zero behavior change" claim for these formatting properties rested on manual code review
// alone, not a regression test. These 3 tests close that gap against the REAL Videos/
// Localizations/Meta specs this app actually ships (not a synthetic sheet, which
// shared-xlsx/index.test.ts already covers for the generic mechanism itself).
test("buildWorkbook freezes the header row and sets an A1:H1 autofilter on Videos and Localizations, but not on Meta", async () => {
  const builder = createXlsxBuilder();
  const { buffer } = await builder.buildWorkbook({ channel, videos });

  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  const videosSheet = workbook.getWorksheet("Videos")!;
  const localizationsSheet = workbook.getWorksheet("Localizations")!;
  const metaSheet = workbook.getWorksheet("Meta")!;

  assert.equal(videosSheet.views[0]?.state, "frozen");
  assert.equal(videosSheet.views[0]?.ySplit, 1);
  assert.equal(videosSheet.autoFilter, "A1:H1"); // round-tripped through bytes -> range string, not {from,to}
  assert.equal(localizationsSheet.views[0]?.state, "frozen");
  assert.equal(localizationsSheet.views[0]?.ySplit, 1);
  assert.equal(localizationsSheet.autoFilter, "A1:H1");
  assert.equal(metaSheet.views, null); // round-tripped through bytes -> no views entry at all
  assert.ok(!metaSheet.autoFilter); // undefined after a round-trip, null on a fresh in-memory sheet -- either way, "not set"
});

test("buildWorkbook wraps text on the long-text columns only (original_description; description + remote_description)", async () => {
  const builder = createXlsxBuilder();
  const { buffer } = await builder.buildWorkbook({ channel, videos });

  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  // A workbook round-tripped through bytes loses the authoring-time column `key`
  // mapping (not part of the XLSX format itself) -- look columns up by header text,
  // the same way changesets/import.ts's own parser does.
  const videosSheet = workbook.getWorksheet("Videos")!;
  const videosHeader = buildHeaderIndex(videosSheet.getRow(1));
  assert.equal(
    videosSheet.getRow(2).getCell(videosHeader.get("original_description")!).alignment?.wrapText,
    true
  );
  assert.notEqual(
    videosSheet.getRow(2).getCell(videosHeader.get("original_title")!).alignment?.wrapText,
    true
  );

  const localizationsSheet = workbook.getWorksheet("Localizations")!;
  const localizationsHeader = buildHeaderIndex(localizationsSheet.getRow(1));
  assert.equal(
    localizationsSheet.getRow(2).getCell(localizationsHeader.get("description")!).alignment?.wrapText,
    true
  );
  assert.equal(
    localizationsSheet.getRow(2).getCell(localizationsHeader.get("remote_description")!).alignment?.wrapText,
    true
  );
  assert.notEqual(
    localizationsSheet.getRow(2).getCell(localizationsHeader.get("language_name")!).alignment?.wrapText,
    true
  );
});

test("buildWorkbook bolds the header row of every sheet, including Meta", async () => {
  const builder = createXlsxBuilder();
  const { buffer } = await builder.buildWorkbook({ channel, videos });

  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);

  for (const sheetName of ["Videos", "Localizations", "Meta"]) {
    const header = workbook.getWorksheet(sheetName)!.getRow(1);
    assert.equal(header.font?.bold, true);
  }
});
