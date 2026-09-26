import assert from "node:assert/strict";
import test from "node:test";
import { getStoredVideo, upsertChannel, upsertVideos } from "@/lib/db";
import { createVideoDetailsLocalCacheAdapter } from "./store";
import type { VideoDetailsSnapshot } from "../contracts";

// Independent review, 2026-09-26: `refreshVideoFields` merges a single-video edit onto the
// existing cached row, copying forward every untouched field from the current row. `publishAt`
// must NOT be one of those copied-forward fields -- `args.after` is always a fresh, authoritative
// read straight from YouTube, so `after.publishAt === null` is a real fact ("no longer
// scheduled"), never "unknown, keep the old value". Real db.ts calls against the isolated
// per-test-file SQLite database (same reasoning as sql-projection.test.ts).

const CHANNEL = "UC_video_details_store_test";

function baseSnapshot(overrides: Partial<VideoDetailsSnapshot> = {}): VideoDetailsSnapshot {
  return {
    videoId: "v1",
    etag: "etag-1",
    title: "Title",
    description: "Description",
    tags: [],
    categoryId: null,
    defaultLanguage: null,
    privacyStatus: "public",
    publishAt: null,
    license: null,
    embeddable: null,
    publicStatsViewable: null,
    selfDeclaredMadeForKids: null,
    containsSyntheticMedia: null,
    recordingDate: null,
    ...overrides,
  };
}

test("refreshVideoFields clears a stale scheduled publishAt once YouTube itself confirms it's no longer scheduled", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "v1",
        channelId: CHANNEL,
        title: "Old title",
        description: "Old description",
        publishedAt: "2026-01-01T00:00:00.000Z",
        privacyStatus: "private",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        etag: "etag-old",
        viewCount: 42,
        commentCount: 3,
        likeCount: 7,
        durationSeconds: 600,
        publishAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    new Date("2026-09-01T00:00:00.000Z")
  );

  const adapter = createVideoDetailsLocalCacheAdapter();
  await adapter.refreshVideoFields({
    channelId: CHANNEL,
    videoId: "v1",
    after: baseSnapshot({ title: "New title", privacyStatus: "public", publishAt: null }),
  });

  const stored = await getStoredVideo(CHANNEL, "v1");
  assert.equal(stored?.title, "New title", "the edited field must be applied");
  assert.equal(
    stored?.publishAt,
    null,
    "publishAt must be cleared to the fresh, authoritative null, not left at the stale scheduled date"
  );
  assert.equal(stored?.viewCount, 42, "an untouched field must still be copied forward from the current row");
});

test("refreshVideoFields applies a fresh scheduled publishAt when YouTube reports one", async () => {
  await upsertChannel({ channelId: CHANNEL, title: "Test", thumbnailUrl: null, uploadsPlaylistId: "UU_test", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "v2",
        channelId: CHANNEL,
        title: "Title",
        description: "Description",
        publishedAt: "2026-01-01T00:00:00.000Z",
        privacyStatus: "private",
        defaultLanguage: null,
        defaultAudioLanguage: null,
        thumbnails: {},
        existingLocalizations: {},
        etag: "etag-old",
        viewCount: null,
        commentCount: null,
        likeCount: null,
        durationSeconds: null,
        publishAt: null,
      },
    ],
    new Date("2026-09-01T00:00:00.000Z")
  );

  const adapter = createVideoDetailsLocalCacheAdapter();
  await adapter.refreshVideoFields({
    channelId: CHANNEL,
    videoId: "v2",
    after: baseSnapshot({ videoId: "v2", privacyStatus: "private", publishAt: "2026-11-20T10:00:00.000Z" }),
  });

  const stored = await getStoredVideo(CHANNEL, "v2");
  assert.equal(stored?.publishAt, "2026-11-20T10:00:00.000Z");
});
