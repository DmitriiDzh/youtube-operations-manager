import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLibsqlClient } from "@/lib/libsql-client";
import { getStoredVideo, initializeDatabaseSchema, listStoredVideosByChannel, listStoredVideosByIds, SCHEMA_MIGRATIONS, upsertChannel, upsertVideos } from "@/lib/db";
import { SNAPSHOT_TRANSFERRED_TABLES } from "@/lib/snapshot/contracts";

// FO-REQ-0056 part 2: schema v125 adds `videos.tags_json` -- YouTube's `snippet.tags` of each synced video, stored by the sync so
// channel_video_list / agent_get_video_context can show them without a YouTube call. NULL = not read yet (unknown), "[]" = none.

function video(videoId: string, channelId: string, extra: { tags?: string[] } = {}) {
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
    ...extra,
  };
}

test("schema v125 adds videos.tags_json (nullable, no default) on a fresh database, and re-applying it is harmless", async () => {
  const migration = SCHEMA_MIGRATIONS.find((m) => m.version === 125);
  assert.ok(migration);
  // videos is a device-local cache of YouTube (a new computer syncs it itself), so the column never travels in a snapshot.
  assert.equal((SNAPSHOT_TRANSFERRED_TABLES as readonly string[]).includes("videos"), false);
  const dir = await mkdtemp(path.join(tmpdir(), "db-video-tags-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const columns = await client.execute("PRAGMA table_info(videos)");
    const tags = columns.rows.find((row) => row.name === "tags_json");
    assert.ok(tags, "videos.tags_json exists");
    assert.equal(tags.type, "TEXT");
    assert.equal(Number(tags.notnull), 0);
    assert.equal(tags.dflt_value, null);
    // The playbook's re-apply path (an unstamped database that already has the column) must not fail the boot.
    await migration.apply(client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a synced video's tags come back exactly as stored -- order, case and duplicates kept; [] stays []", async () => {
  await upsertChannel({ channelId: "UC_t1", title: "T", thumbnailUrl: null, uploadsPlaylistId: "UU_t1", connectedUserId: null });
  await upsertVideos(
    [video("t1", "UC_t1", { tags: ["tropico jazz", "Smooth Jazz", "tropico jazz", "Bossa Nova ☕"] }), video("t2", "UC_t1", { tags: [] })],
    new Date("2026-11-18T00:00:00Z")
  );
  assert.deepEqual((await getStoredVideo("UC_t1", "t1"))?.tags, ["tropico jazz", "Smooth Jazz", "tropico jazz", "Bossa Nova ☕"]);
  assert.deepEqual((await getStoredVideo("UC_t1", "t2"))?.tags, []);
  const listed = new Map((await listStoredVideosByChannel("UC_t1")).map((v) => [v.videoId, v.tags]));
  assert.deepEqual(listed.get("t2"), []);
  const byIds = await listStoredVideosByIds("UC_t1", ["t1"]);
  assert.deepEqual(byIds[0]?.tags, ["tropico jazz", "Smooth Jazz", "tropico jazz", "Bossa Nova ☕"]);
});

test("a row never given tags reads as null (unknown), never as []", async () => {
  await upsertChannel({ channelId: "UC_t2", title: "T", thumbnailUrl: null, uploadsPlaylistId: "UU_t2", connectedUserId: null });
  await upsertVideos([video("u1", "UC_t2")], new Date("2026-11-18T00:00:00Z"));
  assert.equal((await getStoredVideo("UC_t2", "u1"))?.tags, null);
});

test("a later upsert without tags (a targeted cache refresh) keeps the stored tags; a sync with tags replaces them", async () => {
  await upsertChannel({ channelId: "UC_t3", title: "T", thumbnailUrl: null, uploadsPlaylistId: "UU_t3", connectedUserId: null });
  await upsertVideos([video("w1", "UC_t3", { tags: ["a", "b"] })], new Date("2026-11-18T00:00:00Z"));
  await upsertVideos([{ ...video("w1", "UC_t3"), title: "Edited" }], new Date("2026-11-18T00:00:00Z"));
  const kept = await getStoredVideo("UC_t3", "w1");
  assert.equal(kept?.title, "Edited");
  assert.deepEqual(kept?.tags, ["a", "b"]);

  await upsertVideos([video("w1", "UC_t3", { tags: [] })], new Date("2026-11-18T01:00:00Z"));
  assert.deepEqual((await getStoredVideo("UC_t3", "w1"))?.tags, [], "tags removed on YouTube are removed here at the next sync");
});
