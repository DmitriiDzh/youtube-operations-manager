import assert from "node:assert/strict";
import test from "node:test";
import { formatPublishColumn, type SyncedVideo } from "./content-manager";

// Independent review, round 3, 2026-09-26: `formatPublishColumn` had zero test coverage --
// including for round 1's own null-guard fix (`publishedAt === ""` -> "—", not "Invalid date").
// These exercise the real exported function, not a reimplementation of its branches.

function baseVideo(overrides: Partial<SyncedVideo> = {}): SyncedVideo {
  return {
    videoId: "v1",
    channelId: "UC_test",
    title: "Title",
    description: "",
    publishedAt: "2026-01-05T14:30:00.000Z",
    privacyStatus: "public",
    defaultLanguage: null,
    defaultAudioLanguage: null,
    thumbnails: {},
    existingLocalizationLanguages: [],
    lastSyncedAt: "2026-01-05T14:30:00.000Z",
    etag: null,
    viewCount: null,
    commentCount: null,
    likeCount: null,
    publishAt: null,
    ...overrides,
  };
}

test("formatPublishColumn shows the real publish date once the video is public", () => {
  const video = baseVideo({ privacyStatus: "public", publishedAt: "2026-01-05T14:30:00.000Z" });
  assert.equal(formatPublishColumn(video), formatDisplayDateOf("2026-01-05T14:30:00.000Z"));
});

test("formatPublishColumn shows a dash for a public video with a malformed/empty publishedAt, never 'Invalid date'", () => {
  const video = baseVideo({ privacyStatus: "public", publishedAt: "" });
  assert.equal(formatPublishColumn(video), "—");
});

test("formatPublishColumn shows the scheduled publishAt for a still-private video", () => {
  const video = baseVideo({ privacyStatus: "private", publishAt: "2026-10-15T09:00:00.000Z" });
  assert.equal(formatPublishColumn(video), formatDisplayDateOf("2026-10-15T09:00:00.000Z"));
});

test("formatPublishColumn shows a dash for a private video with no scheduled publishAt", () => {
  const video = baseVideo({ privacyStatus: "private", publishAt: null });
  assert.equal(formatPublishColumn(video), "—");
});

test("formatPublishColumn treats an unlisted video with a scheduled publishAt the same as private", () => {
  const video = baseVideo({ privacyStatus: "unlisted", publishAt: "2026-10-15T09:00:00.000Z" });
  assert.equal(formatPublishColumn(video), formatDisplayDateOf("2026-10-15T09:00:00.000Z"));
});

test("formatPublishColumn shows a dash for an unlisted video with no scheduled publishAt", () => {
  const video = baseVideo({ privacyStatus: "unlisted", publishAt: null });
  assert.equal(formatPublishColumn(video), "—");
});

// Local helper mirroring the exact DD.MM.YYYY local-time format `@/lib/shared-formatting`'s
// `formatDisplayDate` produces -- used only to derive an expected value independently of the
// implementation under test (AGENTS.md §L), never imported from the module itself.
function formatDisplayDateOf(iso: string): string {
  const date = new Date(iso);
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}
