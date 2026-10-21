import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  deleteLiveStreamVideo,
  getLiveStream,
  initializeDatabaseSchema,
  insertLiveStreamEvent,
  listLiveStreamEvents,
  listLiveStreamSources,
  listLiveStreamVideos,
  listLiveStreams,
  SCHEMA_CURRENT_VERSION,
  SCHEMA_MIGRATIONS,
  setLiveStreamRotationOrder,
  updateLiveStream,
  updateLiveStreamVideo,
  upsertLiveStream,
  upsertLiveStreamSource,
  upsertLiveStreamVideo,
  type AppDb,
} from "@/lib/db";

// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.3) on a real migrated database: schema v86 creates the four tables,
// converges when run again, and the rotation order can only be set to exactly the rotation's videos.

async function withDb(run: (database: AppDb, client: ReturnType<typeof createLibsqlClient>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "db-live-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    await run(drizzle(client) as unknown as AppDb, client);
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const T = new Date("2026-10-12T12:00:00.000Z");

const stream = (overrides: Record<string, unknown> = {}) => ({
  channelId: "UC1",
  intent: "off" as const,
  title: "Tropico Jazz Radio",
  description: "24/7",
  privacyStatus: "unlisted" as const,
  madeForKids: false,
  orderMode: "sequence" as const,
  passNumber: 0,
  positionIndex: 0,
  positionOffsetSeconds: 0,
  createdAt: T,
  updatedAt: T,
  ...overrides,
});

const video = (videoId: string, rotationIndex: number) => ({
  channelId: "UC1",
  videoId,
  rotationIndex,
  originalPath: `04 Videos/${videoId}.mp4`,
  checkStatus: "unchecked" as const,
  addedAt: T,
});

test("schema v86: the current version is at least 86; a second run converges; the four tables exist", () =>
  withDb(async (_database, client) => {
    assert.ok(SCHEMA_CURRENT_VERSION >= 86);
    const v86 = SCHEMA_MIGRATIONS.find((m) => m.version === 86);
    assert.ok(v86);
    await v86.apply(client);
    const names = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
    for (const table of ["live_streams", "live_stream_videos", "live_stream_events", "live_stream_sources"]) assert.ok(names.includes(table), table);
  }));

test("live_streams: one row per channel, replaced in place, partly updated; an update of a missing channel writes nothing", () =>
  withDb(async (database) => {
    assert.equal(await getLiveStream("UC1", database), null);
    await upsertLiveStream(stream(), database);
    await upsertLiveStream(stream({ title: "New", intent: "on", onSince: T }), database);
    assert.equal((await listLiveStreams(database)).length, 1);
    assert.equal(await updateLiveStream("UC1", { broadcastId: "BC1", positionIndex: 2, positionOffsetSeconds: 12.5 }, database), true);
    const row = await getLiveStream("UC1", database);
    assert.deepEqual([row?.title, row?.intent, row?.broadcastId, row?.positionIndex, row?.positionOffsetSeconds, row?.madeForKids], ["New", "on", "BC1", 2, 12.5, false]);
    assert.equal(await updateLiveStream("UC-missing", { title: "x" }, database), false);
  }));

test("live_stream_videos: listed in rotation order; the order is set only to exactly the rotation's videos", () =>
  withDb(async (database) => {
    await upsertLiveStreamVideo(video("A", 0), database);
    await upsertLiveStreamVideo(video("B", 1), database);
    await upsertLiveStreamVideo(video("C", 2), database);
    await upsertLiveStreamVideo({ ...video("Z", 0), channelId: "UC2" }, database);
    assert.deepEqual((await listLiveStreamVideos("UC1", database)).map((v) => v.videoId), ["A", "B", "C"]);

    assert.equal(await setLiveStreamRotationOrder("UC1", ["C", "A", "B"], database), true);
    assert.deepEqual((await listLiveStreamVideos("UC1", database)).map((v) => v.videoId), ["C", "A", "B"]);

    for (const bad of [["C", "A"], ["C", "A", "B", "Z"], ["C", "A", "A"], ["C", "A", "X"]]) {
      assert.equal(await setLiveStreamRotationOrder("UC1", bad, database), false, bad.join(","));
    }
    assert.deepEqual((await listLiveStreamVideos("UC1", database)).map((v) => v.videoId), ["C", "A", "B"]);
    assert.deepEqual((await listLiveStreamVideos("UC2", database)).map((v) => v.videoId), ["Z"]);

    assert.equal(await updateLiveStreamVideo("UC1", "A", { checkStatus: "refused", checkReason: "private", checkedAt: T }, database), true);
    assert.equal((await listLiveStreamVideos("UC1", database)).find((v) => v.videoId === "A")?.checkReason, "private");
    assert.equal(await deleteLiveStreamVideo("UC1", "A", database), true);
    assert.equal(await deleteLiveStreamVideo("UC1", "A", database), false);
    assert.deepEqual((await listLiveStreamVideos("UC1", database)).map((v) => v.videoId), ["C", "B"]);
  }));

test("live_stream_events newest first per channel; live_stream_sources replaced per video", () =>
  withDb(async (database) => {
    await insertLiveStreamEvent({ id: "e1", channelId: "UC1", at: new Date("2026-10-12T12:00:00Z"), kind: "encoder_start", detailJson: "{}" }, database);
    await insertLiveStreamEvent({ id: "e2", channelId: "UC1", at: new Date("2026-10-12T12:05:00Z"), kind: "encoder_exit", detailJson: "{}" }, database);
    await insertLiveStreamEvent({ id: "e3", channelId: "UC2", at: new Date("2026-10-12T12:06:00Z"), kind: "encoder_exit", detailJson: "{}" }, database);
    assert.deepEqual((await listLiveStreamEvents("UC1", 10, database)).map((e) => e.id), ["e2", "e1"]);
    assert.deepEqual((await listLiveStreamEvents("UC1", 1, database)).map((e) => e.id), ["e2"]);

    await upsertLiveStreamSource({ channelId: "UC1", videoId: "A", originalPath: "04 Videos/a.mp4", setBy: "operator", setAt: T }, database);
    await upsertLiveStreamSource({ channelId: "UC1", videoId: "A", originalPath: "04 Videos/a2.mp4", setBy: "operator", setAt: T }, database);
    assert.deepEqual((await listLiveStreamSources("UC1", database)).map((s) => s.originalPath), ["04 Videos/a2.mp4"]);
  }));

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §3.2): schema v92 adds the stream's video settings -- null until saved, and a later write of
// other columns (or the whole row without it) never clears it.
test("v92: video_settings_json is null on a new row, set by an update, kept by other writes", async () => {
  await withDb(async (database, client) => {
    const columns = await client.execute("PRAGMA table_info(live_streams)");
    assert.ok(columns.rows.some((row) => row.name === "video_settings_json"));
    await upsertLiveStream(stream(), database);
    assert.equal((await getLiveStream("UC1", database))?.videoSettingsJson, null);
    assert.equal(await updateLiveStream("UC1", { videoSettingsJson: '{"v":1}' }, database), true);
    await updateLiveStream("UC1", { title: "Other", updatedAt: T }, database);
    await upsertLiveStream(stream({ title: "Again" }), database);
    const row = await getLiveStream("UC1", database);
    assert.equal(row?.title, "Again");
    assert.equal(row?.videoSettingsJson, '{"v":1}');
  });
});

// BL-207 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 2): schema v101 adds the stream's translations -- null until saved, set by an update,
// never cleared by a write of other columns or of the whole row without it; running the migration again converges.
test("v101: localizations_json is null on a new row, set by an update, kept by other writes", async () => {
  await withDb(async (database, client) => {
    const columns = await client.execute("PRAGMA table_info(live_streams)");
    assert.ok(columns.rows.some((row) => row.name === "localizations_json"));
    const v101 = SCHEMA_MIGRATIONS.find((m) => m.version === 101);
    assert.ok(v101, "schema v101 exists");
    await v101.apply(client);
    await upsertLiveStream(stream(), database);
    assert.equal((await getLiveStream("UC1", database))?.localizationsJson, null);
    const set = '{"de":{"title":"Jazz Radio","description":"Rund um die Uhr"}}';
    assert.equal(await updateLiveStream("UC1", { localizationsJson: set }, database), true);
    await updateLiveStream("UC1", { title: "Other", videoSettingsJson: '{"v":1}', updatedAt: T }, database);
    await upsertLiveStream(stream({ title: "Again" }), database);
    assert.equal((await getLiveStream("UC1", database))?.localizationsJson, set);
    assert.equal(await updateLiveStream("UC1", { localizationsJson: null }, database), true);
    assert.equal((await getLiveStream("UC1", database))?.localizationsJson, null);
  });
});
