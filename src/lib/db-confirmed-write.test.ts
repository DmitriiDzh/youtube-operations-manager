import assert from "node:assert/strict";
import test from "node:test";
import { applyConfirmedWriteToStoredVideo, getStoredVideo, upsertChannel, upsertVideos } from "@/lib/db";

// Real SQLite (isolated per test file).

test("applyConfirmedWriteToStoredVideo changes only the batch-writable fields of this channel's video and leaves counts and sync time alone", async () => {
  await upsertChannel({ channelId: "UC_cw", title: "T", thumbnailUrl: null, uploadsPlaylistId: "UU_cw", connectedUserId: null });
  const syncedAt = new Date("2026-10-01T00:00:00Z");
  await upsertVideos(
    [
      {
        videoId: "v1",
        channelId: "UC_cw",
        title: "Old",
        description: "Old D",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en-US",
        thumbnails: {},
        existingLocalizations: {},
        etag: "e1",
        viewCount: 42,
      },
    ],
    syncedAt
  );

  const ok = await applyConfirmedWriteToStoredVideo({
    channelId: "UC_cw",
    videoId: "v1",
    title: "New",
    description: "New D",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    localizations: { es: { title: "Hola", description: "Desc" } },
  });

  assert.equal(ok, true);
  const video = await getStoredVideo("UC_cw", "v1");
  assert.equal(video?.title, "New");
  assert.equal(video?.defaultAudioLanguage, "en");
  assert.deepEqual(video?.existingLocalizations, { es: { title: "Hola", description: "Desc" } });
  assert.equal(video?.viewCount, 42);
  assert.equal(video?.etag, "e1");
  assert.equal(video?.lastSyncedAt.getTime(), syncedAt.getTime());
});

test("applyConfirmedWriteToStoredVideo creates nothing and touches nothing for a video of another channel or an unknown video", async () => {
  assert.equal(
    await applyConfirmedWriteToStoredVideo({ channelId: "UC_other", videoId: "v1", title: "X", description: "X", defaultLanguage: "en", defaultAudioLanguage: "en", localizations: {} }),
    false
  );
  assert.equal(
    await applyConfirmedWriteToStoredVideo({ channelId: "UC_cw", videoId: "nope", title: "X", description: "X", defaultLanguage: "en", defaultAudioLanguage: "en", localizations: {} }),
    false
  );
  assert.equal((await getStoredVideo("UC_cw", "v1"))?.title, "New");
});
