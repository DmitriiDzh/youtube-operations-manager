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
  insertLiveViewerSample,
  listLiveViewerSamples,
  listSampledLiveBroadcasts,
  listLiveBroadcastAnalytics,
  upsertLiveBroadcastAnalytics,
  listLiveStreamEvents,
  listLiveStreamSources,
  listLiveStreamVideos,
  listLiveStreams,
  listLiveStreamLibrarySegments,
  upsertLiveStreamLibrarySegment,
  updateLiveStreamLibrarySegment,
  deleteLiveStreamLibrarySegment,
  setLiveStreamLibrarySegmentOrder,
  appendLiveStreamLibrarySegment,
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

// BL-233 (FO-REQ-0047 ask 1): schema v113 adds the stream's own bitrate -- null until saved (the computer's setting is used), set by
// an update, kept by writes of other columns and by a whole-row write without it, cleared by null; the migration converges.
test("v113: bitrate_kbps is null on a new row, set by an update, kept by other writes, cleared by null", async () => {
  await withDb(async (database, client) => {
    const columns = await client.execute("PRAGMA table_info(live_streams)");
    assert.ok(columns.rows.some((row) => row.name === "bitrate_kbps"));
    const v113 = SCHEMA_MIGRATIONS.find((m) => m.version === 113);
    assert.ok(v113, "schema v113 exists");
    await v113.apply(client);
    assert.ok(SCHEMA_CURRENT_VERSION >= 113);
    await upsertLiveStream(stream(), database);
    assert.equal((await getLiveStream("UC1", database))?.bitrateKbps, null);
    assert.equal(await updateLiveStream("UC1", { bitrateKbps: 4000 }, database), true);
    await updateLiveStream("UC1", { title: "Other", updatedAt: T }, database);
    await upsertLiveStream(stream({ title: "Again" }), database);
    assert.equal((await getLiveStream("UC1", database))?.bitrateKbps, 4000);
    assert.equal(await updateLiveStream("UC1", { bitrateKbps: null }, database), true);
    assert.equal((await getLiveStream("UC1", database))?.bitrateKbps, null);
  });
});

// BL-211 (LIVE_ANALYTICS_PLAN.md stage 1): schema v105 keeps viewer samples per channel; null viewers stay null; a second
// sample at the same instant is ignored; a range is [from, to), oldest first.
test("v105: live_viewer_samples per channel, oldest first, [from, to), null kept, same instant ignored", () =>
  withDb(async (database) => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 22, 12, m));
    const row = (channelId: string, m: number, viewers: number | null) => ({ channelId, sampledAt: at(m), broadcastId: "BC1", viewers, lifeCycleStatus: "live", streamStatus: "active", healthStatus: "good" });
    await insertLiveViewerSample(row("UC1", 10, 12), database);
    await insertLiveViewerSample(row("UC1", 0, 5), database);
    await insertLiveViewerSample(row("UC1", 5, null), database);
    await insertLiveViewerSample(row("UC1", 5, 99), database);
    await insertLiveViewerSample(row("UC2", 5, 40), database);
    const got = await listLiveViewerSamples("UC1", at(0), at(10), database);
    assert.deepEqual(got.map((s) => [s.sampledAt.getTime(), s.viewers]), [[at(0).getTime(), 5], [at(5).getTime(), null]]);
    assert.equal((await listLiveViewerSamples("UC1", at(0), at(11), database)).length, 3);
    assert.deepEqual((await listLiveViewerSamples("UC2", at(0), at(11), database)).map((s) => s.viewers), [40]);
  }));

// BL-212: schema v106 -- the broadcasts sampled (first/last sample per channel and broadcast) and one analytics row per broadcast,
// replaced in full by a later pull.
test("v106: sampled broadcasts with first/last sample; live_broadcast_analytics upserted per broadcast", () =>
  withDb(async (database) => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 22, 12, m));
    for (const [m, b] of [[0, "B1"], [5, "B1"], [10, "B2"]] as const) {
      await insertLiveViewerSample({ channelId: "UC1", sampledAt: at(m), broadcastId: b, viewers: 1, lifeCycleStatus: "live", streamStatus: null, healthStatus: null }, database);
    }
    const sampled = (await listSampledLiveBroadcasts(database)).sort((a, b) => a.broadcastId.localeCompare(b.broadcastId));
    assert.deepEqual(sampled, [
      { channelId: "UC1", broadcastId: "B1", firstSampleAt: at(0).getTime(), lastSampleAt: at(5).getTime() },
      { channelId: "UC1", broadcastId: "B2", firstSampleAt: at(10).getTime(), lastSampleAt: at(10).getTime() },
    ]);
    const row = { broadcastId: "B1", channelId: "UC1", status: "failed", final: false, attempts: 1, lastAttemptAt: at(20), collectedAt: null, dataJson: null, error: "500" };
    await upsertLiveBroadcastAnalytics(row, database);
    await upsertLiveBroadcastAnalytics({ ...row, status: "collected", attempts: 2, collectedAt: at(30), dataJson: "{}", error: null }, database);
    const stored = await listLiveBroadcastAnalytics(["B1", "B9"], database);
    assert.deepEqual(stored.map((r) => [r.broadcastId, r.status, r.attempts, r.collectedAt?.getTime(), r.dataJson, r.error]), [["B1", "collected", 2, at(30).getTime(), "{}", null]]);
    assert.deepEqual(await listLiveBroadcastAnalytics([], database), []);
  }));

// BL-234 (FO-REQ-0048, ADR 0056): schema v114 adds the stream's source mode (null = videos, as before) and the selection from the
// segment library -- per channel, in the owner's order, the order settable only to exactly the selection; the migration converges.
test("v114: source_mode null on a new row; library selection per channel, ordered, order only to exactly the selection", () =>
  withDb(async (database, client) => {
    const columns = await client.execute("PRAGMA table_info(live_streams)");
    assert.ok(columns.rows.some((row) => row.name === "source_mode"));
    const v114 = SCHEMA_MIGRATIONS.find((m) => m.version === 114);
    assert.ok(v114, "schema v114 exists");
    await v114.apply(client);
    await v114.apply(client);
    await upsertLiveStream(stream(), database);
    assert.equal((await getLiveStream("UC1", database))?.sourceMode, null);
    assert.equal(await updateLiveStream("UC1", { sourceMode: "segments" }, database), true);
    assert.equal((await getLiveStream("UC1", database))?.sourceMode, "segments");
    const seg = (channelId: string, seq: number, rotationIndex: number) => ({
      channelId, seq, rotationIndex, title: `S${seq}`, durationSeconds: 1800, sidecarDurationSeconds: 1800, bytes: 1, tracksJson: "[]", checkStatus: "ok" as const, checkReason: null, checkedAt: T, addedAt: T,
    });
    await upsertLiveStreamLibrarySegment(seg("UC1", 7, 1), database);
    await upsertLiveStreamLibrarySegment(seg("UC1", 3, 0), database);
    await upsertLiveStreamLibrarySegment(seg("UC2", 9, 0), database);
    assert.deepEqual((await listLiveStreamLibrarySegments("UC1", database)).map((r) => r.seq), [3, 7]);
    assert.equal(await setLiveStreamLibrarySegmentOrder("UC1", [7], database), false);
    assert.equal(await setLiveStreamLibrarySegmentOrder("UC1", [7, 9], database), false);
    assert.equal(await setLiveStreamLibrarySegmentOrder("UC1", [7, 7], database), false);
    assert.equal(await setLiveStreamLibrarySegmentOrder("UC1", [7, 3], database), true);
    assert.deepEqual((await listLiveStreamLibrarySegments("UC1", database)).map((r) => r.seq), [7, 3]);
    assert.equal(await updateLiveStreamLibrarySegment("UC1", 3, { checkStatus: "refused", checkReason: "audio_unsupported" }, database), true);
    assert.equal(await updateLiveStreamLibrarySegment("UC1", 9, { checkStatus: "refused" }, database), false);
    assert.equal(await deleteLiveStreamLibrarySegment("UC1", 9, database), false);
    assert.equal(await deleteLiveStreamLibrarySegment("UC1", 7, database), true);
    assert.deepEqual((await listLiveStreamLibrarySegments("UC1", database)).map((r) => [r.seq, r.checkStatus]), [[3, "refused"]]);
    assert.deepEqual((await listLiveStreamLibrarySegments("UC2", database)).map((r) => r.seq), [9]);
  }));

// BL-234 review item 4: two adds at the same moment never share a rotation index; an already selected seq is not added twice.
test("v114: appendLiveStreamLibrarySegment -- concurrent appends get distinct indexes; a repeated seq is refused (null)", () =>
  withDb(async (database) => {
    const row = (seq: number) => ({ channelId: "UC1", seq, title: null, durationSeconds: 1800, sidecarDurationSeconds: 1800, bytes: 1, tracksJson: "[]", checkStatus: "ok" as const, checkReason: null, checkedAt: T, addedAt: T });
    const indexes = await Promise.all([1, 2, 3, 4, 5].map((seq) => appendLiveStreamLibrarySegment(row(seq), database)));
    assert.deepEqual([...indexes].sort(), [0, 1, 2, 3, 4]);
    assert.equal(await appendLiveStreamLibrarySegment(row(3), database), null);
    assert.equal(await appendLiveStreamLibrarySegment({ ...row(9), channelId: "UC2" }, database), 0, "per channel");
    const listed = await listLiveStreamLibrarySegments("UC1", database);
    assert.equal(new Set(listed.map((r) => r.rotationIndex)).size, 5);
    assert.equal(listed[0].checkedAt?.getTime(), T.getTime());
  }));
