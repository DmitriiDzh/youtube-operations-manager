import { test } from "node:test";
import assert from "node:assert/strict";
import { pageMarketVideos, parseVideosQuery as parseOrNull, type PageableVideo, type VideosQuery } from "./paging";

/** The tests below always pass `page`, so a query is always returned. */
function parseVideosQuery(params: URLSearchParams): VideosQuery {
  const query = parseOrNull(params);
  assert.ok(query, "a paged query");
  return query;
}

// BL-140 R2 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4.4/§6, AC-R2-1..4). Expected rows are written by hand.

const v = (id: string, channelId: string, publishedAt: string | null, viewCount: number | null, title: string | null, topics: string[] = []): PageableVideo => ({
  videoId: id,
  channelId,
  channelHandleOrUrl: `@${channelId}`,
  title,
  publishedAt,
  viewCount,
  observedAt: "2026-10-06T12:00:00.000Z",
  topics: topics.map((t) => ({ topicId: t, name: `Topic ${t}` })),
});

// Already in the service's order: newest published first, nulls last.
const all: PageableVideo[] = [
  v("v1", "c1", "2026-10-06T10:00:00.000Z", 100, "Rainy Night Bossa", ["t1"]),
  v("v2", "c2", "2026-10-05T10:00:00.000Z", 5000, "Autumn Harbor Jazz"),
  v("v3", "c1", "2026-10-04T10:00:00.000Z", null, "Velvet Lounge 8 Hours", ["t1", "t2"]),
  v("v4", "c2", "2026-09-01T10:00:00.000Z", 250, null),
  v("v5", "c1", null, 9000, "Undated upload"),
];

test("AC-R2-1: rows come in pages of `limit`; page 2 is the next slice in the chosen order", () => {
  const p1 = pageMarketVideos(all, parseVideosQuery(new URLSearchParams("page=1&limit=2")));
  assert.deepEqual(p1.rows.map((r) => r.videoId), ["v1", "v2"]);
  assert.equal(p1.total, 5);
  const p2 = pageMarketVideos(all, parseVideosQuery(new URLSearchParams("page=2&limit=2")));
  assert.deepEqual(p2.rows.map((r) => r.videoId), ["v3", "v4"]);
  const p3 = pageMarketVideos(all, parseVideosQuery(new URLSearchParams("page=3&limit=2")));
  assert.deepEqual(p3.rows.map((r) => r.videoId), ["v5"]);
});

test("AC-R2-1: the page size defaults to 50 and is capped at 100", () => {
  assert.equal(parseVideosQuery(new URLSearchParams("page=1")).limit, 50);
  assert.equal(parseVideosQuery(new URLSearchParams("page=1&limit=1000")).limit, 100);
  assert.equal(parseVideosQuery(new URLSearchParams("page=0&limit=0")).page, 1);
});

test("AC-R2-2: sort by latest observed views puts the most viewed first and unknown views last", () => {
  const r = pageMarketVideos(all, parseVideosQuery(new URLSearchParams("page=1&sort=views")));
  assert.deepEqual(r.rows.map((x) => x.videoId), ["v5", "v2", "v4", "v1", "v3"]);
});

test("AC-R2-2: filters by channel, topic, publish dates and title narrow the total", () => {
  const q = (s: string) => pageMarketVideos(all, parseVideosQuery(new URLSearchParams(`page=1&${s}`)));
  assert.deepEqual(q("channelId=c1").rows.map((r) => r.videoId), ["v1", "v3", "v5"]);
  assert.deepEqual(q("topicId=t2").rows.map((r) => r.videoId), ["v3"]);
  // Dates are whole days (yyyy-mm-dd), inclusive; an undated video never matches a date filter.
  assert.deepEqual(q("publishedAfter=2026-10-04&publishedBefore=2026-10-05").rows.map((r) => r.videoId), ["v2", "v3"]);
  assert.deepEqual(q("q=JAZZ").rows.map((r) => r.videoId), ["v2"]);
  assert.equal(q("channelId=c2&q=harbor").total, 1);
});

test("AC-R2-2: the response lists every channel and topic present, for the filter menus", () => {
  const r = pageMarketVideos(all, parseVideosQuery(new URLSearchParams("page=1&channelId=c2")));
  assert.deepEqual(r.channels, [
    { channelId: "c1", label: "@c1" },
    { channelId: "c2", label: "@c2" },
  ]);
  assert.deepEqual(r.topics, [
    { topicId: "t1", name: "Topic t1" },
    { topicId: "t2", name: "Topic t2" },
  ]);
});

test("AC-R2-3: a paged row carries only observed values with their time, never a derived metric", () => {
  const r = pageMarketVideos(all, parseVideosQuery(new URLSearchParams("page=1&limit=1")));
  assert.deepEqual(Object.keys(r.rows[0]).sort(), ["channelHandleOrUrl", "channelId", "observedAt", "publishedAt", "title", "topics", "videoId", "viewCount"]);
});

test("AC-R2-4: without paging parameters the request is not a paged one (the route keeps the old response)", () => {
  assert.equal(parseOrNull(new URLSearchParams("")), null);
});
