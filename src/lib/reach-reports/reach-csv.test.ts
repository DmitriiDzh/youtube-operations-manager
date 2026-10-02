import assert from "node:assert/strict";
import test from "node:test";
import { parseReportingCsv } from "@/lib/youtube-read-gateway";
import { DomainError } from "./contracts";
import { mapReachBasicRows, normalizeReportDate } from "./reach-csv";

// Column names are Google's published `channel_reach_basic_a1` definition
// (developers.google.com/youtube/reporting/v1/reports/channel_reports): date, channel_id, video_id,
// video_thumbnail_impressions, video_thumbnail_impressions_ctr. Expected values are written by hand.

const HEADER = "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr";
const isMalformed = (error: unknown) => error instanceof DomainError && error.code === "reporting_report_malformed";

test("normalizeReportDate: YYYYMMDD and YYYY-MM-DD map to YYYY-MM-DD; impossible or odd dates are rejected", () => {
  assert.equal(normalizeReportDate("20260930"), "2026-09-30");
  assert.equal(normalizeReportDate("2026-09-30"), "2026-09-30");
  assert.equal(normalizeReportDate("20240229"), "2024-02-29", "leap day");
  for (const bad of ["20260230", "20261340", "2026093", "2026/09/30", "", "abcdefgh", "20260931"]) {
    assert.equal(normalizeReportDate(bad), null, bad);
  }
});

test("mapReachBasicRows maps every documented column, including reordered columns", () => {
  const csv =
    "video_id,video_thumbnail_impressions_ctr,date,video_thumbnail_impressions,channel_id\n" +
    "vidA,0.052,20260930,1200,UC_X\n" +
    "vidB,0.04,20260930,300,UC_X\n";

  assert.deepEqual(mapReachBasicRows(parseReportingCsv(csv), "UC_X"), [
    { date: "2026-09-30", videoId: "vidA", impressions: 1200, ctr: 0.052 },
    { date: "2026-09-30", videoId: "vidB", impressions: 300, ctr: 0.04 },
  ]);
});

test("mapReachBasicRows: an empty CTR cell is null (unknown), never 0; zero impressions is a valid 0", () => {
  const csv = `${HEADER}\n20260930,UC_X,vidA,0,\n20260930,UC_X,vidB,10,0\n`;
  assert.deepEqual(mapReachBasicRows(parseReportingCsv(csv), "UC_X"), [
    { date: "2026-09-30", videoId: "vidA", impressions: 0, ctr: null },
    { date: "2026-09-30", videoId: "vidB", impressions: 10, ctr: 0 },
  ]);
});

test("mapReachBasicRows: a header-only (empty) report yields no rows", () => {
  assert.deepEqual(mapReachBasicRows(parseReportingCsv(`${HEADER}\n`), "UC_X"), []);
});

test("mapReachBasicRows fails the WHOLE file on a missing documented column, naming it", () => {
  const csv = "date,channel_id,video_id,video_thumbnail_impressions\n20260930,UC_X,vidA,5\n";
  assert.throws(
    () => mapReachBasicRows(parseReportingCsv(csv), "UC_X"),
    (error: unknown) => isMalformed(error) && (error as DomainError).message.includes("video_thumbnail_impressions_ctr")
  );
});

// Channel identity: a file must never import under a channel it does not belong to.
test("mapReachBasicRows rejects a row naming a different channel than expected, even if only one row differs", () => {
  const csv = `${HEADER}\n20260930,UC_X,vidA,5,0.1\n20260930,UC_OTHER,vidB,7,0.2\n`;
  assert.throws(() => mapReachBasicRows(parseReportingCsv(csv), "UC_X"), isMalformed);
});

test("mapReachBasicRows rejects unreadable dates, empty video ids, bad impressions and bad CTR values", () => {
  const cases: string[] = [
    "20261340,UC_X,vidA,5,0.1",
    ",UC_X,vidA,5,0.1",
    "20260930,UC_X,,5,0.1",
    "20260930,UC_X,vidA,-1,0.1",
    "20260930,UC_X,vidA,1.5,0.1",
    "20260930,UC_X,vidA,,0.1",
    "20260930,UC_X,vidA,abc,0.1",
    "20260930,UC_X,vidA,5,-0.1",
    "20260930,UC_X,vidA,5,NaN",
    "20260930,UC_X,vidA,5,abc",
  ];
  for (const row of cases) {
    assert.throws(() => mapReachBasicRows(parseReportingCsv(`${HEADER}\n${row}\n`), "UC_X"), isMalformed, row);
  }
});

test("mapReachBasicRows rejects two rows for the same video and day (would silently overwrite)", () => {
  const csv = `${HEADER}\n20260930,UC_X,vidA,5,0.1\n20260930,UC_X,vidA,6,0.2\n`;
  assert.throws(() => mapReachBasicRows(parseReportingCsv(csv), "UC_X"), isMalformed);
  // The same video on a DIFFERENT day is fine.
  const ok = `${HEADER}\n20260930,UC_X,vidA,5,0.1\n20261001,UC_X,vidA,6,0.2\n`;
  assert.equal(mapReachBasicRows(parseReportingCsv(ok), "UC_X").length, 2);
});
