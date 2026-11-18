import assert from "node:assert/strict";
import test from "node:test";
import { getStoredVideo, upsertChannel, upsertVideos } from "@/lib/db";
import type { VideoDetailsSnapshot } from "../contracts";
import { createVideoDetailsLocalCacheAdapter } from "./store";

// Real SQLite (isolated per test file). FO-REQ-0056: after a verified video-details write (video_details_update, the owner's
// «Применить упаковку», producer_video_metadata_update) the local copy takes the read-back's tags at once -- the tags YouTube now
// has, `[]` when it has none -- while the columns this module does not write keep what the last sync stored.

function after(overrides: Partial<VideoDetailsSnapshot>): VideoDetailsSnapshot {
  return {
    videoId: "vt1",
    etag: "etag-after",
    title: "Title after",
    description: "Description after",
    tags: [],
    categoryId: "10",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    privacyStatus: "private",
    publishAt: null,
    license: null,
    embeddable: null,
    publicStatsViewable: null,
    selfDeclaredMadeForKids: null,
    containsSyntheticMedia: null,
    ...overrides,
  } as VideoDetailsSnapshot;
}

test("FO-REQ-0056: a verified tags write updates the stored tags at once; other synced columns are kept", async () => {
  await upsertChannel({ channelId: "UC_vd", title: "C", thumbnailUrl: null, uploadsPlaylistId: "UU_vd", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "vt1",
        channelId: "UC_vd",
        title: "Title before",
        description: "D",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "private",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        thumbnails: {},
        existingLocalizations: { es: { title: "ES", description: "ES d" } },
        etag: "etag-before",
        viewCount: 42,
        durationSeconds: 630,
        tags: ["old tag"],
      },
    ],
    new Date("2026-11-18T00:00:00Z")
  );
  const cache = createVideoDetailsLocalCacheAdapter();

  await cache.refreshVideoFields({ channelId: "UC_vd", videoId: "vt1", after: after({ tags: ["tropico jazz", "Smooth Jazz"] }) });
  const updated = await getStoredVideo("UC_vd", "vt1");
  assert.deepEqual(updated?.tags, ["tropico jazz", "Smooth Jazz"]);
  assert.equal(updated?.title, "Title after");
  assert.equal(updated?.viewCount, 42);
  assert.equal(updated?.durationSeconds, 630);
  assert.deepEqual(updated?.existingLocalizations, { es: { title: "ES", description: "ES d" } });

  // Tags removed on YouTube by the write: the read-back says [] and so does the local copy.
  await cache.refreshVideoFields({ channelId: "UC_vd", videoId: "vt1", after: after({ tags: [] }) });
  assert.deepEqual((await getStoredVideo("UC_vd", "vt1"))?.tags, []);
});
