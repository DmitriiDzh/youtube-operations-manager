import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { MEMBERSHIP_CACHE_TTL_MS, createVideoPlaylistMembership, type VideoPlaylistMembershipDeps } from "./services";

// Package playlists (owner, Telegram 4858/4859): the Producer's read of a video's playlists. Requirements, written before the code:
// - scoping fails closed, in order, before any credential or YouTube call: a channel not connected here -> CHANNEL_NOT_ACTIVE; a
//   video that is not the channel's by local data (its synced list or this computer's uploads) -> video_not_in_channel;
// - then the channel identity check on the grant (a grant of another channel fails, nothing is read);
// - the live answer lists the channel's playlists that hold the video; cost: 1 (identity) + 1 per 50 playlists listed + 1 per
//   playlist checked; kept for 10 minutes per channel and video (0 units then), `refresh` reads live;
// - next to it, this computer's upload rows of the video with their recorded playlist step (local, always fresh).
// Expected values worked out by hand.

const NOW = new Date("2026-11-24T12:00:00Z");

function harness(over: Partial<VideoPlaylistMembershipDeps> = {}) {
  const calls: string[] = [];
  const clock = { at: NOW };
  const holding = new Map<string, Set<string>>([
    ["PL_a", new Set(["vid1"])],
    ["PL_b", new Set()],
    ["PL_c", new Set(["vid1", "vid2"])],
  ]);
  const deps: VideoPlaylistMembershipDeps = {
    channelUser: async (channelId) => (channelId === "UC_wwe" ? "u-owner" : null),
    videoOfChannel: async (channelId, videoId) => channelId === "UC_wwe" && (videoId === "vid1" || videoId === "vid2"),
    uploadRecords: async (_c, videoId) =>
      videoId === "vid1"
        ? [{ uploadId: "u1", video: "V70", status: "done", finishedAt: NOW.toISOString(), settingsPlaylist: "added", playlists: [{ playlistId: "PL_x", source: "package", result: "failed", reason: "other_channel" }] }]
        : [],
    credentials: async (userId) => {
      calls.push(`credentials ${userId}`);
      return { token: "t" };
    },
    assertChannel: async ({ channelId }) => {
      calls.push(`identity ${channelId}`);
    },
    listPlaylists: async () => {
      calls.push("list");
      return [
        { id: "PL_a", title: "A", privacyStatus: "public" },
        { id: "PL_b", title: "B", privacyStatus: "private" },
        { id: "PL_c", title: "C", privacyStatus: "unlisted" },
      ];
    },
    playlistHasVideo: async (_c, playlistId, videoId) => {
      calls.push(`has ${playlistId}`);
      return holding.get(playlistId)?.has(videoId) ?? false;
    },
    clock: { now: () => new Date(clock.at) },
    ...over,
  };
  return { reader: createVideoPlaylistMembership(deps), calls, clock };
}

test("AC-PP-30: the channel's playlists that hold the video, with the units spent, and this computer's upload records", async () => {
  const h = harness();
  const result = await h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid1" });
  assert.deepEqual(result.playlists.map((p) => p.id), ["PL_a", "PL_c"]);
  assert.equal(result.checkedPlaylists, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.cached, false);
  // identity 1 + one page of the list 1 + three membership reads 3.
  assert.equal(result.quotaUnits, 5);
  assert.equal(result.readAt, NOW.toISOString());
  assert.deepEqual(result.uploads.map((u) => [u.uploadId, u.settingsPlaylist, u.playlists[0]?.reason]), [["u1", "added", "other_channel"]]);
  assert.ok(h.calls.indexOf("identity UC_wwe") < h.calls.indexOf("list"), "the identity check before any read");
});

test("AC-PP-31: a channel not connected here fails closed before any credential or YouTube call", async () => {
  const h = harness();
  await assert.rejects(h.reader.videoPlaylists({ channelId: "UC_other", videoId: "vid1" }), (e: unknown) => e instanceof DomainError && e.code === "CHANNEL_NOT_ACTIVE");
  assert.deepEqual(h.calls, []);
});

test("AC-PP-32: a video of another channel (or unknown here) fails closed before any credential or YouTube call", async () => {
  const h = harness();
  await assert.rejects(h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid_foreign" }), (e: unknown) => e instanceof DomainError && e.code === "video_not_in_channel");
  assert.deepEqual(h.calls, []);
});

test("AC-PP-33: a grant of another channel fails the identity check -- nothing is listed or read", async () => {
  const h = harness({
    assertChannel: async () => {
      throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "other channel" });
    },
  });
  await assert.rejects(h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid1" }), (e: unknown) => e instanceof DomainError && e.code === "WRITE_CHANNEL_MISMATCH");
  assert.equal(h.calls.some((c) => c === "list" || c.startsWith("has ")), false);
});

test("AC-PP-34: the answer is kept 10 minutes (0 units, the upload records still fresh); refresh or an older answer reads live", async () => {
  const h = harness();
  await h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid1" });
  h.calls.length = 0;
  const kept = await h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid1" });
  assert.equal(kept.cached, true);
  assert.equal(kept.quotaUnits, 0);
  assert.deepEqual(h.calls, []);
  assert.equal(kept.uploads.length, 1);
  // Another video of the same channel: the playlist list is kept, only identity + the membership reads (1 + 3).
  const other = await h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid2" });
  assert.equal(other.quotaUnits, 4);
  assert.deepEqual(other.playlists.map((p) => p.id), ["PL_c"]);
  h.calls.length = 0;
  const refreshed = await h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid1", refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.quotaUnits, 5);
  h.clock.at = new Date(NOW.getTime() + MEMBERSHIP_CACHE_TTL_MS);
  const expired = await h.reader.videoPlaylists({ channelId: "UC_wwe", videoId: "vid1" });
  assert.equal(expired.cached, false);
});
