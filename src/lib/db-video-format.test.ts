import assert from "node:assert/strict";
import test from "node:test";
import { getStoredVideo, insertMarketVideoSnapshot, insertResearchChannel, listMarketVideoSnapshotsByChannel, upsertChannel, upsertVideos } from "@/lib/db";
import { createVideoDetailsLocalCacheAdapter } from "@/lib/video-details/adapters/store";

// Real SQLite (isolated per test file). Operator request 2026-10-04: duration + live state next to the other video facts.

test("a market video snapshot stores the raw duration and live state; one inserted without them reads back NULL (not 0)", async () => {
  const researchChannelId = "UC_research_fmt";
  await insertResearchChannel({ id: researchChannelId, reason: "test", createdVia: "web_ui" });
  await insertMarketVideoSnapshot({ id: "s1", researchChannelId, videoId: "v1", durationSeconds: 125, liveBroadcastContent: "none", source: "youtube.videos.list", createdVia: "web_ui" });
  await insertMarketVideoSnapshot({ id: "s2", researchChannelId, videoId: "v2", source: "youtube.videos.batchGetStats", createdVia: "web_ui" });
  const rows = await listMarketVideoSnapshotsByChannel(researchChannelId);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId.s1.durationSeconds, 125);
  assert.equal(byId.s1.liveBroadcastContent, "none");
  assert.equal(byId.s2.durationSeconds, null);
  assert.equal(byId.s2.liveBroadcastContent, null);
});

test("own video: liveBroadcastContent round-trips through the sync upsert and survives a video-details targeted patch", async () => {
  await upsertChannel({ channelId: "UC_vf", title: "T", thumbnailUrl: null, uploadsPlaylistId: "UU_vf", connectedUserId: null });
  await upsertVideos(
    [
      {
        videoId: "v1",
        channelId: "UC_vf",
        title: "Old",
        description: "D",
        publishedAt: "2026-09-01T00:00:00Z",
        privacyStatus: "public",
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
        thumbnails: {},
        existingLocalizations: {},
        etag: "e1",
        durationSeconds: 7200,
        liveBroadcastContent: "upcoming",
      },
    ],
    new Date("2026-10-01T00:00:00Z")
  );
  assert.equal((await getStoredVideo("UC_vf", "v1"))?.liveBroadcastContent, "upcoming");

  await createVideoDetailsLocalCacheAdapter().refreshVideoFields({
    channelId: "UC_vf",
    videoId: "v1",
    after: {
      videoId: "v1",
      etag: "e2",
      title: "New",
      description: "D",
      tags: [],
      categoryId: null,
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
      privacyStatus: "public",
      publishAt: null,
      license: null,
      embeddable: null,
      publicStatsViewable: null,
      selfDeclaredMadeForKids: null,
      containsSyntheticMedia: null,
      recordingDate: null,
    },
  });
  const after = await getStoredVideo("UC_vf", "v1");
  assert.equal(after?.liveBroadcastContent, "upcoming", "a targeted patch must not erase the stored live state");
  assert.equal(after?.durationSeconds, 7200);
});
