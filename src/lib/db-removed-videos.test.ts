import assert from "node:assert/strict";
import test from "node:test";
import { getStoredChannel, getStoredVideo, listRemovedVideosByChannel, listStoredVideosByIds, listVideoPresence, markChannelSynced, listStoredVideosByChannel, markVideosRemovedOnYoutube, upsertChannel, upsertVideos } from "@/lib/db";

const LISTED = new Date("2026-10-14T08:59:00Z"); // this read of the uploads began after the rows were last synced (2026-10-01)

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
  assert.deepEqual(await markVideosRemovedOnYoutube("UC_a", ["a1", "a3"], at, LISTED), ["a2"]);

  assert.deepEqual((await listStoredVideosByChannel("UC_a")).map((v) => v.videoId).sort(), ["a1", "a3"]);
  assert.deepEqual((await listStoredVideosByChannel("UC_b")).map((v) => v.videoId), ["b1"]);
  assert.equal((await getStoredVideo("UC_a", "a2"))?.title, "T a2", "the hidden row itself is kept");

  assert.deepEqual(await markVideosRemovedOnYoutube("UC_a", ["a1", "a3"], at, LISTED), [], "an already hidden video is not marked again");
});

test("a sync that returns the hidden video again shows it again", async () => {
  await upsertChannel({ channelId: "UC_c", title: "C", thumbnailUrl: null, uploadsPlaylistId: "UU_c", connectedUserId: null });
  await upsertVideos([video("c1", "UC_c"), video("c2", "UC_c")], new Date("2026-10-01T00:00:00Z"));
  await markVideosRemovedOnYoutube("UC_c", ["c1"], new Date("2026-10-14T09:00:00Z"), LISTED);
  await upsertVideos([video("c2", "UC_c")], new Date("2026-10-14T10:00:00Z"));
  assert.deepEqual((await listStoredVideosByChannel("UC_c")).map((v) => v.videoId).sort(), ["c1", "c2"]);
});

test("more hidden videos than one update batch are all marked", async () => {
  await upsertChannel({ channelId: "UC_d", title: "D", thumbnailUrl: null, uploadsPlaylistId: "UU_d", connectedUserId: null });
  const many = Array.from({ length: 1205 }, (_, i) => video(`d${i}`, "UC_d"));
  await upsertVideos(many, new Date("2026-10-01T00:00:00Z"));
  const marked = await markVideosRemovedOnYoutube("UC_d", ["d0"], new Date("2026-10-14T09:00:00Z"), LISTED);
  assert.equal(marked.length, 1204);
  assert.deepEqual((await listStoredVideosByChannel("UC_d")).map((v) => v.videoId), ["d0"]);
});

test("a row saved after this read of the uploads began is never marked; a listed id loses its mark", async () => {
  await upsertChannel({ channelId: "UC_e", title: "E", thumbnailUrl: null, uploadsPlaylistId: "UU_e", connectedUserId: null });
  await upsertVideos([video("e1", "UC_e"), video("e2", "UC_e")], new Date("2026-10-01T00:00:00Z"));
  await upsertVideos([video("e3", "UC_e")], new Date("2026-10-14T09:00:30Z")); // saved by an overlapping sync
  assert.deepEqual(await markVideosRemovedOnYoutube("UC_e", ["e1"], new Date("2026-10-14T09:01:00Z"), new Date("2026-10-14T09:00:00Z")), ["e2"]);
  assert.deepEqual((await listStoredVideosByChannel("UC_e")).map((v) => v.videoId).sort(), ["e1", "e3"]);

  // e2 listed again (videos.list may still leave it out, so no upsert): the mark goes.
  await markVideosRemovedOnYoutube("UC_e", ["e1", "e2", "e3"], new Date("2026-10-14T10:01:00Z"), new Date("2026-10-14T10:00:00Z"));
  assert.deepEqual((await listStoredVideosByChannel("UC_e")).map((v) => v.videoId).sort(), ["e1", "e2", "e3"]);
});

test("BL-243: the removed videos are listed with their mark, only the channel's own; none once the video reappears", async () => {
  await upsertChannel({ channelId: "UC_r", title: "R", thumbnailUrl: null, uploadsPlaylistId: "UU_r", connectedUserId: null });
  await upsertChannel({ channelId: "UC_s", title: "S", thumbnailUrl: null, uploadsPlaylistId: "UU_s", connectedUserId: null });
  await upsertVideos([video("r1", "UC_r"), video("r2", "UC_r"), video("s1", "UC_s")], new Date("2026-10-01T00:00:00Z"));
  const at = new Date("2026-11-03T19:54:00.000Z");
  await markVideosRemovedOnYoutube("UC_r", ["r1"], at, LISTED);
  await markVideosRemovedOnYoutube("UC_s", [], at, LISTED);
  assert.deepEqual(await listRemovedVideosByChannel("UC_r"), [{ videoId: "r2", removedAt: at }]);
  assert.deepEqual(await listRemovedVideosByChannel("UC_s"), [{ videoId: "s1", removedAt: at }]);
  await upsertVideos([video("r2", "UC_r")], new Date("2026-11-04T08:00:00.000Z"));
  assert.deepEqual(await listRemovedVideosByChannel("UC_r"), []);
});

test("BL-243 AC-WP-78 (schema v118): channels.removed_check_at is set only with a completed check; lastSyncedAt moves on every sync", async () => {
  await upsertChannel({ channelId: "UC_k", title: "K", thumbnailUrl: null, uploadsPlaylistId: "UU_k", connectedUserId: null });
  assert.equal((await getStoredChannel("UC_k"))?.removedCheckAt, null);
  const checked = new Date("2026-11-04T08:00:00.000Z");
  await markChannelSynced("UC_k", checked, checked);
  const skipped = new Date("2026-11-05T08:00:00.000Z");
  await markChannelSynced("UC_k", skipped);
  const channel = await getStoredChannel("UC_k");
  assert.equal(channel?.removedCheckAt?.toISOString(), "2026-11-04T08:00:00.000Z");
  assert.equal(channel?.lastSyncedAt?.toISOString(), "2026-11-05T08:00:00.000Z");
});

test("BL-243 round 5: presence and by-id reads are the channel's own, narrow, and tell removed from visible", async () => {
  await upsertChannel({ channelId: "UC_p", title: "P", thumbnailUrl: null, uploadsPlaylistId: "UU_p", connectedUserId: null });
  await upsertChannel({ channelId: "UC_q", title: "Q", thumbnailUrl: null, uploadsPlaylistId: "UU_q", connectedUserId: null });
  await upsertVideos([video("p1", "UC_p"), video("p2", "UC_p"), video("q1", "UC_q")], new Date("2026-10-01T00:00:00Z"));
  const at = new Date("2026-11-03T19:54:00.000Z");
  await markVideosRemovedOnYoutube("UC_p", ["p1"], at, LISTED);
  const presence = (await listVideoPresence("UC_p")).sort((a, b) => a.videoId.localeCompare(b.videoId));
  assert.deepEqual(presence, [
    { videoId: "p1", publishedAt: "2026-09-01T00:00:00Z", removedAt: null },
    { videoId: "p2", publishedAt: "2026-09-01T00:00:00Z", removedAt: at },
  ]);
  // (round 6: one select, removed rows included with their mark)
  assert.deepEqual((await listStoredVideosByIds("UC_p", ["p1", "p2", "q1"])).map((v) => [v.videoId, v.removedAt]).sort(), [["p1", null], ["p2", at]], "this channel only, each with its mark");
});
