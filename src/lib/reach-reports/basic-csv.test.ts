import assert from "node:assert/strict";
import test from "node:test";
import { parseReportingCsv } from "@/lib/youtube-read-gateway";
import { DomainError } from "./contracts";
import { mapBasicRows, mapTrafficSourceRows } from "./basic-csv";

// BL-181 (FO-REQ-0020). Column names are Google's published definitions (developers.google.com/youtube/reporting/v1/reports/
// channel_reports, read 2026-10-13): `channel_basic_a3` has the dimensions date, channel_id, video_id, live_or_on_demand,
// subscribed_status, country_code; `channel_traffic_source_a3` adds traffic_source_type and traffic_source_detail. Google's
// "Report characteristics": video_id / channel_id can be empty strings for a deleted resource and for channel-level metrics
// (subscribers gained on the channel page); country_code ZZ and a NULL traffic_source_detail are anonymised rows. Expected sums
// below are worked out by hand.

const isMalformed = (error: unknown) => error instanceof DomainError && error.code === "reporting_report_malformed";

const NULL_BASIC = {
  views: null,
  engagedViews: null,
  redViews: null,
  watchTimeMinutes: null,
  redWatchTimeMinutes: null,
  likes: null,
  dislikes: null,
  comments: null,
  shares: null,
  subscribersGained: null,
  subscribersLost: null,
  videosAddedToPlaylists: null,
  videosRemovedFromPlaylists: null,
};

const BASIC_HEADER =
  "date,channel_id,video_id,live_or_on_demand,subscribed_status,country_code,views,engaged_views,red_views,watch_time_minutes," +
  "red_watch_time_minutes,likes,dislikes,comments,shares,subscribers_gained,subscribers_lost,videos_added_to_playlists," +
  "videos_removed_from_playlists,card_impressions";

test("mapBasicRows sums a video's day over country, subscribed status and live/on-demand rows, anonymised ZZ rows included", () => {
  const csv =
    `${BASIC_HEADER}\n` +
    // vidA: 10 + 3 + 2 = 15 views; 12.5 + 1.25 + 0.25 = 14 minutes; likes 1 + 0 + 2 = 3; card_impressions is ignored.
    "20261010,UC_X,vidA,onDemand,subscribed,US,10,9,1,12.5,1.5,1,0,0,1,0,0,0,0,40\n" +
    "20261010,UC_X,vidA,onDemand,unsubscribed,ZZ,3,3,0,1.25,0,0,0,1,0,0,0,1,0,5\n" +
    "20261010,UC_X,vidA,live,unsubscribed,BR,2,2,0,0.25,0,2,1,0,0,1,0,0,1,0\n" +
    "20261010,UC_X,vidB,onDemand,unsubscribed,JP,4,4,0,3,0,0,0,0,0,0,1,0,0,0\n";

  assert.deepEqual(mapBasicRows(parseReportingCsv(csv), "UC_X"), [
    {
      date: "2026-10-10",
      videoId: "vidA",
      views: 15,
      engagedViews: 14,
      redViews: 1,
      watchTimeMinutes: 14,
      redWatchTimeMinutes: 1.5,
      likes: 3,
      dislikes: 1,
      comments: 1,
      shares: 1,
      subscribersGained: 1,
      subscribersLost: 0,
      videosAddedToPlaylists: 1,
      videosRemovedFromPlaylists: 1,
    },
    {
      date: "2026-10-10",
      videoId: "vidB",
      views: 4,
      engagedViews: 4,
      redViews: 0,
      watchTimeMinutes: 3,
      redWatchTimeMinutes: 0,
      likes: 0,
      dislikes: 0,
      comments: 0,
      shares: 0,
      subscribersGained: 0,
      subscribersLost: 1,
      videosAddedToPlaylists: 0,
      videosRemovedFromPlaylists: 0,
    },
  ]);
});

test("mapBasicRows keeps the channel-level row (empty video_id) with only its subscriber counts; empty metrics stay null, not 0", () => {
  // Google: a row without video_id carries subscribers_gained and subscribers_lost "but it does not specify values for other metrics".
  const csv = `${BASIC_HEADER}\n20261010,UC_X,,onDemand,unsubscribed,ZZ,,,,,,,,,,4,1,,,\n20261010,UC_X,,onDemand,unsubscribed,DE,,,,,,,,,,2,0,,,\n`;
  assert.deepEqual(mapBasicRows(parseReportingCsv(csv), "UC_X"), [
    { date: "2026-10-10", videoId: "", ...NULL_BASIC, subscribersGained: 6, subscribersLost: 1 },
  ]);
});

test("mapBasicRows: a deleted video's row (empty channel_id and video_id) is kept in the remainder", () => {
  const csv = `${BASIC_HEADER}\n20261010,,,onDemand,unsubscribed,US,7,7,0,2.5,0,0,0,0,0,0,0,0,0,0\n`;
  const [row] = mapBasicRows(parseReportingCsv(csv), "UC_X");
  assert.equal(row.videoId, "");
  assert.equal(row.views, 7);
  assert.equal(row.watchTimeMinutes, 2.5);
});

test("mapBasicRows: columns in another order are read by name; an optional column Google leaves out is null for every row", () => {
  const csv = "views,video_id,watch_time_minutes,date,channel_id,country_code\n5,vidA,2.75,2026-10-10,UC_X,US\n1,vidA,0.25,2026-10-10,UC_X,ZZ\n";
  assert.deepEqual(mapBasicRows(parseReportingCsv(csv), "UC_X"), [
    { date: "2026-10-10", videoId: "vidA", ...NULL_BASIC, views: 6, watchTimeMinutes: 3 },
  ]);
});

test("mapBasicRows: a header-only file (a day without activity) maps to no rows", () => {
  assert.deepEqual(mapBasicRows(parseReportingCsv(`${BASIC_HEADER}\n`), "UC_X"), []);
});

test("mapBasicRows refuses the whole file: a missing required column, another channel's row, an unreadable date, a bad number", () => {
  const withoutWatchTime = "date,channel_id,video_id,views\n20261010,UC_X,vidA,1\n";
  assert.throws(() => mapBasicRows(parseReportingCsv(withoutWatchTime), "UC_X"), isMalformed);

  const otherChannel = `${BASIC_HEADER}\n20261010,UC_X,vidA,onDemand,subscribed,US,1,1,0,1,0,0,0,0,0,0,0,0,0,0\n20261010,UC_OTHER,vidB,onDemand,subscribed,US,1,1,0,1,0,0,0,0,0,0,0,0,0,0\n`;
  assert.throws(() => mapBasicRows(parseReportingCsv(otherChannel), "UC_X"), isMalformed);

  const badDate = `${BASIC_HEADER}\n20261340,UC_X,vidA,onDemand,subscribed,US,1,1,0,1,0,0,0,0,0,0,0,0,0,0\n`;
  assert.throws(() => mapBasicRows(parseReportingCsv(badDate), "UC_X"), isMalformed);

  for (const bad of ["-1", "abc", "NaN", "Infinity"]) {
    const csv = `${BASIC_HEADER}\n20261010,UC_X,vidA,onDemand,subscribed,US,${bad},1,0,1,0,0,0,0,0,0,0,0,0,0\n`;
    assert.throws(() => mapBasicRows(parseReportingCsv(csv), "UC_X"), isMalformed, bad);
  }
});

const TRAFFIC_HEADER =
  "date,channel_id,video_id,live_or_on_demand,subscribed_status,country_code,traffic_source_type,traffic_source_detail,engaged_views," +
  "views,watch_time_minutes,average_view_duration_seconds,average_view_duration_percentage,red_views,red_watch_time_minutes";

test("mapTrafficSourceRows sums each video's day per traffic source code over every detail, the anonymised NULL detail included", () => {
  const csv =
    `${TRAFFIC_HEADER}\n` +
    // vidA, code 5 (YouTube search): two terms + the below-threshold remainder = 6 + 4 + 2 = 12 views, 3 + 2 + 0.5 = 5.5 minutes.
    "20261010,UC_X,vidA,onDemand,unsubscribed,US,5,cuban jazz,6,6,3,30,40,0,0\n" +
    "20261010,UC_X,vidA,onDemand,unsubscribed,US,5,latin cafe,4,4,2,30,40,0,0\n" +
    "20261010,UC_X,vidA,onDemand,unsubscribed,ZZ,5,NULL,2,2,0.5,15,20,0,0\n" +
    // vidA, code 7 (suggested videos), and code 3 (browse) with an empty detail.
    "20261010,UC_X,vidA,onDemand,subscribed,US,7,vidZ,3,3,1.5,30,40,0,0\n" +
    "20261010,UC_X,vidA,onDemand,subscribed,US,3,,1,1,0.25,15,20,0,0\n" +
    // A code this app does not know yet is kept as it is.
    "20261010,UC_X,vidB,onDemand,subscribed,US,99,,2,2,1,30,40,0,0\n";

  assert.deepEqual(mapTrafficSourceRows(parseReportingCsv(csv), "UC_X"), [
    { date: "2026-10-10", videoId: "vidA", trafficSourceType: 3, views: 1, engagedViews: 1, watchTimeMinutes: 0.25 },
    { date: "2026-10-10", videoId: "vidA", trafficSourceType: 5, views: 12, engagedViews: 12, watchTimeMinutes: 5.5 },
    { date: "2026-10-10", videoId: "vidA", trafficSourceType: 7, views: 3, engagedViews: 3, watchTimeMinutes: 1.5 },
    { date: "2026-10-10", videoId: "vidB", trafficSourceType: 99, views: 2, engagedViews: 2, watchTimeMinutes: 1 },
  ]);
});

test("mapTrafficSourceRows: without engaged_views the column is null; a missing traffic_source_type column or a non-code value fails the file", () => {
  const noEngaged = "date,channel_id,video_id,traffic_source_type,views,watch_time_minutes\n20261010,UC_X,vidA,9,2,1\n";
  assert.deepEqual(mapTrafficSourceRows(parseReportingCsv(noEngaged), "UC_X"), [
    { date: "2026-10-10", videoId: "vidA", trafficSourceType: 9, views: 2, engagedViews: null, watchTimeMinutes: 1 },
  ]);

  const noType = "date,channel_id,video_id,views,watch_time_minutes\n20261010,UC_X,vidA,2,1\n";
  assert.throws(() => mapTrafficSourceRows(parseReportingCsv(noType), "UC_X"), isMalformed);

  for (const bad of ["", "abc", "-3", "2.5"]) {
    const csv = `date,channel_id,video_id,traffic_source_type,views,watch_time_minutes\n20261010,UC_X,vidA,${bad},2,1\n`;
    assert.throws(() => mapTrafficSourceRows(parseReportingCsv(csv), "UC_X"), isMalformed, bad);
  }

  const otherChannel = "date,channel_id,video_id,traffic_source_type,views,watch_time_minutes\n20261010,UC_OTHER,vidA,5,2,1\n";
  assert.throws(() => mapTrafficSourceRows(parseReportingCsv(otherChannel), "UC_X"), isMalformed);
});
