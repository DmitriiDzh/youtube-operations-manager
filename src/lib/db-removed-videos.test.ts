import assert from "node:assert/strict";
import test from "node:test";
import { getStoredVideo, listStoredVideosByChannel, markVideosRemovedOnYoutube, upsertChannel, upsertVideos } from "@/lib/db";

// Real SQLite (isolated per test file). Owner instruction 2026-10-14 (Telegram msgs 2770/2775, option "б"): a video a
// complete owner sync no longer finds in the channel's uploads is hidden from every list with a mark; the row is never
// deleted, and the mark goes away when YouTube returns the video again.

function video(videoId: string, channelId: string) {
  return {
    videoId,
    channelId,
    title: `T ${videoId}`,
    description: "D",
    publishedAt: "2026-09-01T00:00:00Z",
    privacyStatus: "public",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    thumbnails: {},
    existingLocalizations: {},
    etag: null,
  };
}

test("marking hides only the channel's videos missing from the uploads; the rows stay; the other channel is untouched", async () => {
  await upsertChannel({ channelId: "UC_a", title: "A", thumbnailUrl: null, uploadsPlaylistId: "UU_a", connectedUserId: null });
  await upsertChannel({ channelId: "UC_b", title: "B", thumbnailUrl: null, uploadsPlaylistId: "UU_b", connectedUserId: null });
  await upsertVideos([video("a1", "UC_a"), video("a2", "UC_a"), video("a3", "UC_a"), video("b1", "UC_b")], new Date("2026-10-01T00:00:00Z"));

  const at = new Date("2026-10-14T09:00:00Z");
  assert.deepEqual(await markVideosRemovedOnYoutube("UC_a", ["a1", "a3"], at), ["a2"]);

  assert.deepEqual((await listStoredVideosByChannel("UC_a")).map((v) => v.videoId).sort(), ["a1", "a3"]);
  assert.deepEqual((await listStoredVideosByChannel("UC_b")).map((v) => v.videoId), ["b1"]);
  assert.equal((await getStoredVideo("UC_a", "a2"))?.title, "T a2", "the hidden row itself is kept");

  assert.deepEqual(await markVideosRemovedOnYoutube("UC_a", ["a1", "a3"], at), [], "an already hidden video is not marked again");
});

test("a sync that returns the hidden video again shows it again", async () => {
  await upsertChannel({ channelId: "UC_c", title: "C", thumbnailUrl: null, uploadsPlaylistId: "UU_c", connectedUserId: null });
  await upsertVideos([video("c1", "UC_c"), video("c2", "UC_c")], new Date("2026-10-01T00:00:00Z"));
  await markVideosRemovedOnYoutube("UC_c", ["c1"], new Date("2026-10-14T09:00:00Z"));
  await upsertVideos([video("c2", "UC_c")], new Date("2026-10-14T10:00:00Z"));
  assert.deepEqual((await listStoredVideosByChannel("UC_c")).map((v) => v.videoId).sort(), ["c1", "c2"]);
});

test("more hidden videos than one update batch are all marked", async () => {
  await upsertChannel({ channelId: "UC_d", title: "D", thumbnailUrl: null, uploadsPlaylistId: "UU_d", connectedUserId: null });
  const many = Array.from({ length: 1205 }, (_, i) => video(`d${i}`, "UC_d"));
  await upsertVideos(many, new Date("2026-10-01T00:00:00Z"));
  const marked = await markVideosRemovedOnYoutube("UC_d", ["d0"], new Date("2026-10-14T09:00:00Z"));
  assert.equal(marked.length, 1204);
  assert.deepEqual((await listStoredVideosByChannel("UC_d")).map((v) => v.videoId), ["d0"]);
});
