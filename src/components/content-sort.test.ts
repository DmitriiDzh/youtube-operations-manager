import assert from "node:assert/strict";
import test from "node:test";
import type { SyncedVideo } from "./content-manager";
import { DEFAULT_SORT, nextSortState, sortVideos } from "./content-sort";

function video(id: string, overrides: Partial<SyncedVideo> = {}): SyncedVideo {
  return {
    videoId: id,
    channelId: "UC_test",
    title: id,
    description: "",
    publishedAt: "2026-01-01T00:00:00.000Z",
    privacyStatus: "public",
    defaultLanguage: null,
    defaultAudioLanguage: null,
    thumbnails: {},
    existingLocalizationLanguages: [],
    lastSyncedAt: "2026-01-01T00:00:00.000Z",
    etag: null,
    viewCount: null,
    commentCount: null,
    likeCount: null,
    publishAt: null,
    ...overrides,
  };
}

const ids = (list: SyncedVideo[]) => list.map((v) => v.videoId);

test("default sort is Publish date, newest first", () => {
  assert.deepEqual(DEFAULT_SORT, { key: "publish", direction: "desc" });
  const list = [
    video("old", { publishedAt: "2025-01-01T00:00:00.000Z" }),
    video("new", { publishedAt: "2026-06-01T00:00:00.000Z" }),
    video("mid", { publishedAt: "2025-09-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(sortVideos(list, DEFAULT_SORT)), ["new", "mid", "old"]);
});

test("publish ascending reverses the order", () => {
  const list = [
    video("a", { publishedAt: "2025-01-01T00:00:00.000Z" }),
    video("b", { publishedAt: "2026-06-01T00:00:00.000Z" }),
  ];
  assert.deepEqual(ids(sortVideos(list, { key: "publish", direction: "asc" })), ["a", "b"]);
});

test("publish uses the scheduled publishAt for a non-public video, and puts undated videos last in both directions", () => {
  const list = [
    video("none", { privacyStatus: "private", publishAt: null }),
    video("sched", { privacyStatus: "private", publishAt: "2027-01-01T00:00:00.000Z" }),
    video("pub", { publishedAt: "2026-01-01T00:00:00.000Z" }),
    video("empty", { publishedAt: "" }),
  ];
  assert.deepEqual(ids(sortVideos(list, { key: "publish", direction: "desc" })), ["sched", "pub", "none", "empty"]);
  assert.deepEqual(ids(sortVideos(list, { key: "publish", direction: "asc" })), ["pub", "sched", "none", "empty"]);
});

test("views sort numerically (not as text) and keep null counts last", () => {
  const list = [
    video("nine", { viewCount: 9 }),
    video("null", { viewCount: null }),
    video("hundred", { viewCount: 100 }),
    video("zero", { viewCount: 0 }),
  ];
  assert.deepEqual(ids(sortVideos(list, { key: "views", direction: "desc" })), ["hundred", "nine", "zero", "null"]);
  assert.deepEqual(ids(sortVideos(list, { key: "views", direction: "asc" })), ["zero", "nine", "hundred", "null"]);
});

test("comments sort by commentCount", () => {
  const list = [video("a", { commentCount: 1 }), video("b", { commentCount: 5 })];
  assert.deepEqual(ids(sortVideos(list, { key: "comments", direction: "desc" })), ["b", "a"]);
});

test("title sorts case-insensitively", () => {
  const list = [video("1", { title: "banana" }), video("2", { title: "Apple" }), video("3", { title: "cherry" })];
  assert.deepEqual(ids(sortVideos(list, { key: "title", direction: "asc" })), ["2", "1", "3"]);
  assert.deepEqual(ids(sortVideos(list, { key: "title", direction: "desc" })), ["3", "1", "2"]);
});

test("access sorts by privacy status", () => {
  const list = [
    video("u", { privacyStatus: "unlisted" }),
    video("p", { privacyStatus: "public" }),
    video("v", { privacyStatus: "private" }),
  ];
  assert.deepEqual(ids(sortVideos(list, { key: "privacy", direction: "asc" })), ["v", "p", "u"]);
});

test("equal values keep their original relative order and the input is not mutated", () => {
  const list = [video("a", { viewCount: 5 }), video("b", { viewCount: 5 }), video("c", { viewCount: 5 })];
  const snapshot = ids(list);
  assert.deepEqual(ids(sortVideos(list, { key: "views", direction: "desc" })), ["a", "b", "c"]);
  assert.deepEqual(ids(sortVideos(list, { key: "views", direction: "asc" })), ["a", "b", "c"]);
  assert.deepEqual(ids(list), snapshot);
});

test("nextSortState flips direction on the active column and uses a natural default on a new one", () => {
  assert.deepEqual(nextSortState({ key: "publish", direction: "desc" }, "publish"), { key: "publish", direction: "asc" });
  assert.deepEqual(nextSortState({ key: "publish", direction: "asc" }, "publish"), { key: "publish", direction: "desc" });
  assert.deepEqual(nextSortState(DEFAULT_SORT, "title"), { key: "title", direction: "asc" });
  assert.deepEqual(nextSortState(DEFAULT_SORT, "views"), { key: "views", direction: "desc" });
});
