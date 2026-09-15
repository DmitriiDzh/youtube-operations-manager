import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
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
  await workbook.xlsx.load(buffer);

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
  await workbook.xlsx.load(buffer);

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
  await workbook.xlsx.load(buffer);

  const videosSheet = workbook.getWorksheet("Videos");
  assert.equal(videosSheet!.rowCount, 2); // header + 1 video
});
