import assert from "node:assert/strict";
import test from "node:test";
import type { MediaProbe } from "@/lib/ffmpeg-host";
import { DomainError, type VideoFacts } from "./contracts";
import { createLiveStreamsServices, type LiveStreamsDependencies, type StoredStreamRow, type StoredVideoRow } from "./services";

// BL-176 acceptance (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.4/§3.5/§4.1 "Guard", §4.2 "Guard"): a video enters the
// rotation only if it is this channel's, public with no future publishAt (read fresh), and its file passes the checks;
// a refusal writes nothing; overrides need a reason and are audited. Fakes stand in for YouTube, the files and the store.

const NOW = new Date("2026-10-12T12:00:00Z");
const PUBLIC_A = "AAAAAAAAAA1";
const PUBLIC_B = "BBBBBBBBBB2";
const PRIVATE_V55 = "V55V55V55V5";
const SCHEDULED = "SCHEDULED01";
const OTHER_CHANNEL = "OTHERCHAN01";

const GOOD_PROBE: MediaProbe = {
  durationSeconds: 7382.344375,
  sizeBytes: 920220699,
  video: { codec: "h264", width: 1920, height: 1080, frameRate: 30 },
  audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  audioStreams: 1,
  videoStreams: 1,
};

function harness(overrides: { facts?: VideoFacts[]; probe?: Partial<MediaProbe>; files?: Record<string, number>; workspaceMissing?: boolean } = {}) {
  const streams = new Map<string, StoredStreamRow>();
  const videos: StoredVideoRow[] = [];
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  const sources: Array<{ channelId: string; videoId: string; originalPath: string; setBy: string; setAt: Date }> = [];
  const youtubeCalls: string[][] = [];
  const facts: VideoFacts[] = overrides.facts ?? [
    { videoId: PUBLIC_A, title: "A", privacyStatus: "public", publishAt: null, durationSeconds: 7382 },
    { videoId: PUBLIC_B, title: "B", privacyStatus: "public", publishAt: "2026-10-01T00:00:00Z", durationSeconds: 7382 },
    { videoId: PRIVATE_V55, title: "V55", privacyStatus: "private", publishAt: null, durationSeconds: 7382 },
    { videoId: SCHEDULED, title: "S", privacyStatus: "private", publishAt: "2026-10-20T00:00:00Z", durationSeconds: 7382 },
  ];
  const files = overrides.files ?? { "04 Videos/a.mp4": 920220699, "04 Videos/b.mp4": 915152566 };
  const channelVideoTitles: Record<string, string> = { [PUBLIC_A]: "A", [PUBLIC_B]: "B", [PRIVATE_V55]: "V55", [SCHEDULED]: "S" };
  let id = 0;

  const deps: LiveStreamsDependencies = {
    store: {
      async getStream(channelId) {
        return streams.get(channelId) ?? null;
      },
      async upsertStream(row) {
        streams.set(row.channelId, { streamId: null, broadcastId: null, passOrderJson: null, nextPassOrderJson: null, positionUpdatedAt: null, onSince: null, ...row } as StoredStreamRow);
      },
      async updateStream(channelId, set) {
        const row = streams.get(channelId);
        if (!row) return false;
        streams.set(channelId, { ...row, ...set });
        return true;
      },
      async listVideos(channelId) {
        return videos.filter((v) => v.channelId === channelId).sort((a, b) => a.rotationIndex - b.rotationIndex);
      },
      async upsertVideo(row) {
        const i = videos.findIndex((v) => v.channelId === row.channelId && v.videoId === row.videoId);
        if (i >= 0) videos[i] = row;
        else videos.push(row);
      },
      async updateVideo(channelId, videoId, set) {
        const v = videos.find((x) => x.channelId === channelId && x.videoId === videoId);
        if (!v) return false;
        Object.assign(v, set);
        return true;
      },
      async deleteVideo(channelId, videoId) {
        const i = videos.findIndex((v) => v.channelId === channelId && v.videoId === videoId);
        if (i < 0) return false;
        videos.splice(i, 1);
        return true;
      },
      async setOrder(channelId, ids) {
        const mine = videos.filter((v) => v.channelId === channelId);
        if (ids.length !== mine.length || new Set(ids).size !== ids.length || ids.some((x) => !mine.some((v) => v.videoId === x))) return false;
        ids.forEach((x, i) => (mine.find((v) => v.videoId === x)!.rotationIndex = i));
        return true;
      },
      async insertEvent(row) {
        events.push({ kind: row.kind, detail: JSON.parse(row.detailJson) });
      },
      async upsertSource(row) {
        const i = sources.findIndex((s) => s.channelId === row.channelId && s.videoId === row.videoId);
        if (i >= 0) sources[i] = row;
        else sources.push(row);
      },
      async listSources(channelId) {
        return sources.filter((s) => s.channelId === channelId);
      },
    },
    channelVideos: {
      async titleOf(channelId, videoId) {
        return channelId === "UC1" ? (channelVideoTitles[videoId] ?? null) : videoId === OTHER_CHANNEL ? "other" : null;
      },
    },
    youtube: {
      async readVideoFacts(_channelId, ids) {
        youtubeCalls.push([...ids]);
        return facts.filter((f) => ids.includes(f.videoId));
      },
    },
    files: {
      async resolveOriginal(_channelId, relativePath) {
        if (overrides.workspaceMissing) return { ok: false, workspaceMissing: true, detail: "the channel has no workspace folder on this computer" };
        if (relativePath.includes("..") || !(relativePath in files)) return { ok: false, workspaceMissing: false, detail: `${relativePath} is not in the channel workspace` };
        return { ok: true, path: `/ws/${relativePath}`, bytes: files[relativePath] };
      },
      async probe() {
        return { ...GOOD_PROBE, ...overrides.probe };
      },
    },
    clock: () => NOW,
    newId: () => `id-${++id}`,
  };
  return {
    services: createLiveStreamsServices(deps),
    videos,
    events,
    sources,
    youtubeCalls,
    streamRow: (c: string) => streams.get(c),
    setStreamRow: (c: string, row: StoredStreamRow) => void streams.set(c, row),
  };
}

function isRefusal(reason: string) {
  return (error: unknown) => error instanceof DomainError && error.code === "live_stream_video_refused" && (error.details as { reason?: string })?.reason === reason;
}

test("addVideo: a public video of the channel with a matching file joins the end of the rotation, checked ok, with an event", async () => {
  const h = harness();
  const a = await h.services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" });
  const b = await h.services.addVideo("UC1", { videoId: PUBLIC_B, originalPath: "04 Videos/b.mp4" });
  assert.deepEqual([a.rotationIndex, b.rotationIndex], [0, 1]);
  assert.deepEqual([a.check.status, a.videoDurationSeconds, a.originalDurationSeconds, a.originalBytes], ["ok", 7382, 7382.344375, 920220699]);
  assert.deepEqual(h.events.map((e) => e.kind), ["rotation_add", "rotation_add"]);
  assert.deepEqual(h.youtubeCalls, [[PUBLIC_A], [PUBLIC_B]], "the guard reads YouTube fresh for each add");
});

test("addVideo: a private video (V55) and a scheduled one are refused with the reason, and nothing is written", async () => {
  const h = harness();
  await assert.rejects(() => h.services.addVideo("UC1", { videoId: PRIVATE_V55, originalPath: "04 Videos/a.mp4" }), isRefusal("private"));
  await assert.rejects(() => h.services.addVideo("UC1", { videoId: SCHEDULED, originalPath: "04 Videos/a.mp4" }), isRefusal("scheduled"));
  assert.equal(h.videos.length, 0);
  assert.equal(h.events.length, 0);
});

test("addVideo: another channel's video is refused before YouTube is asked", async () => {
  const h = harness();
  await assert.rejects(() => h.services.addVideo("UC1", { videoId: OTHER_CHANNEL, originalPath: "04 Videos/a.mp4" }), isRefusal("not_channel_video"));
  assert.deepEqual(h.youtubeCalls, []);
});

test("addVideo: a video YouTube does not return is refused as not_found", async () => {
  const h = harness({ facts: [] });
  await assert.rejects(() => h.services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" }), isRefusal("not_found"));
});

test("addVideo: a file outside the workspace or missing, a 2 s duration gap, and MP3 sound are refused", async () => {
  await assert.rejects(() => harness().services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "../outside.mp4" }), isRefusal("file_unavailable"));
  await assert.rejects(() => harness().services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/missing.mp4" }), isRefusal("file_unavailable"));
  await assert.rejects(
    () => harness({ probe: { durationSeconds: 7384.5 } }).services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" }),
    isRefusal("duration_mismatch")
  );
  await assert.rejects(
    () => harness({ probe: { audio: { codec: "mp3", sampleRate: 48000, channels: 2 } } }).services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" }),
    isRefusal("audio_unsupported")
  );
});

test("addVideo: no workspace folder is its own error, not a refusal of the video", async () => {
  await assert.rejects(
    () => harness({ workspaceMissing: true }).services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" }),
    (error: unknown) => error instanceof DomainError && error.code === "live_stream_workspace_unavailable"
  );
});

test("addVideo: without a path the Operator's mapped file is used; with neither it is a validation error; a duplicate is refused", async () => {
  const h = harness();
  await assert.rejects(() => h.services.addVideo("UC1", { videoId: PUBLIC_A }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  await h.services.setSources("UC1", { items: [{ videoId: PUBLIC_A, file: "04 Videos/a.mp4" }] }, "operator");
  const added = await h.services.addVideo("UC1", { videoId: PUBLIC_A });
  assert.equal(added.originalPath, "04 Videos/a.mp4");
  await assert.rejects(() => h.services.addVideo("UC1", { videoId: PUBLIC_A }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
});

test("setSources: a result per item; only accepted items are stored; the map does not touch the rotation", async () => {
  const h = harness();
  const results = await h.services.setSources(
    "UC1",
    {
      items: [
        { videoId: PUBLIC_A, file: "04 Videos/a.mp4" },
        { videoId: PRIVATE_V55, file: "04 Videos/b.mp4" },
        { videoId: PUBLIC_B, file: "../../etc/passwd" },
        { videoId: OTHER_CHANNEL, file: "04 Videos/a.mp4" },
      ],
    },
    "operator"
  );
  assert.deepEqual(
    results.map((r) => [r.videoId, r.status, r.reason ?? null]),
    [
      [PUBLIC_A, "accepted", null],
      [PRIVATE_V55, "refused", "private"],
      [PUBLIC_B, "refused", "file_unavailable"],
      [OTHER_CHANNEL, "refused", "not_channel_video"],
    ]
  );
  assert.deepEqual(h.sources.map((s) => [s.videoId, s.originalPath, s.setBy]), [[PUBLIC_A, "04 Videos/a.mp4", "operator"]]);
  assert.equal(h.videos.length, 0);
  assert.deepEqual(h.events.at(-1), { kind: "sources_set", detail: { setBy: "operator", accepted: 1, refused: 3 } });
});

test("recheckRotation: a video that stopped being public is refused with an event; an overridden one stays playable", async () => {
  const facts: VideoFacts[] = [
    { videoId: PUBLIC_A, title: "A", privacyStatus: "public", publishAt: null, durationSeconds: 7382 },
    { videoId: PUBLIC_B, title: "B", privacyStatus: "public", publishAt: null, durationSeconds: 7382 },
  ];
  const h = harness({ facts });
  await h.services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" });
  await h.services.addVideo("UC1", { videoId: PUBLIC_B, originalPath: "04 Videos/a.mp4" });
  facts[0].privacyStatus = "private";
  facts[1].privacyStatus = "unlisted";
  await h.services.overrideGuard("UC1", { videoId: PUBLIC_B, reason: "unlisted on purpose for this stream" });

  const first = await h.services.recheckRotation("UC1");
  assert.deepEqual(first, { playable: [PUBLIC_B], refused: [{ videoId: PUBLIC_A, reason: "private" }] });
  assert.deepEqual(h.youtubeCalls.at(-1), [PUBLIC_A, PUBLIC_B], "one read for the whole rotation");
  assert.deepEqual(h.videos.find((v) => v.videoId === PUBLIC_A)?.checkStatus, "refused");
  const kinds = h.events.map((e) => e.kind);
  assert.deepEqual(kinds.slice(-2), ["guard_override", "guard_refused"]);

  await h.services.recheckRotation("UC1");
  assert.equal(h.events.filter((e) => e.kind === "guard_refused").length, 1, "an unchanged refusal is not recorded again");

  facts[0].privacyStatus = "public";
  assert.deepEqual((await h.services.recheckRotation("UC1")).playable, [PUBLIC_A, PUBLIC_B]);
  assert.equal(h.videos.find((v) => v.videoId === PUBLIC_A)?.checkStatus, "ok");
});

test("overrideGuard: needs a reason of at least 5 characters and a rotation video; it is audited with the reason", async () => {
  const h = harness();
  await h.services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" });
  await assert.rejects(() => h.services.overrideGuard("UC1", { videoId: PUBLIC_A, reason: "ok" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  await assert.rejects(() => h.services.overrideGuard("UC1", { videoId: PUBLIC_B, reason: "a good reason" }), (e: unknown) => e instanceof DomainError && e.code === "live_stream_video_not_found");
  await h.services.overrideGuard("UC1", { videoId: PUBLIC_A, reason: "a good reason" });
  assert.deepEqual(h.events.at(-1), { kind: "guard_override", detail: { videoId: PUBLIC_A, reason: "a good reason" } });
  await h.services.clearGuardOverride("UC1", { videoId: PUBLIC_A });
  assert.equal(h.videos[0].guardOverrideReason, null);
});

test("reorder and remove: only exactly the rotation's videos; removing an unknown video is not_found", async () => {
  const h = harness();
  await h.services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" });
  await h.services.addVideo("UC1", { videoId: PUBLIC_B, originalPath: "04 Videos/a.mp4" });
  await h.services.reorder("UC1", { videoIds: [PUBLIC_B, PUBLIC_A] });
  assert.deepEqual((await h.services.getOverview("UC1")).rotation.map((v) => v.videoId), [PUBLIC_B, PUBLIC_A]);
  await assert.rejects(() => h.services.reorder("UC1", { videoIds: [PUBLIC_B] }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  await h.services.removeVideo("UC1", { videoId: PUBLIC_A });
  await assert.rejects(() => h.services.removeVideo("UC1", { videoId: PUBLIC_A }), (e: unknown) => e instanceof DomainError && e.code === "live_stream_video_not_found");
});

test("saveSettings: a title of 1–100 characters and a description of at most 5,000; saved off with an event", async () => {
  const h = harness();
  await assert.rejects(() => h.services.saveSettings("UC1", { title: "", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" }));
  await assert.rejects(() => h.services.saveSettings("UC1", { title: "x".repeat(101), description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" }));
  await assert.rejects(() => h.services.saveSettings("UC1", { title: "ok", description: "x".repeat(5001), privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" }));
  await h.services.saveSettings("UC1", { title: "Tropico Jazz Radio", description: "24/7", privacyStatus: "unlisted", madeForKids: false, orderMode: "shuffle" });
  const overview = await h.services.getOverview("UC1");
  assert.deepEqual([overview.stream?.intent, overview.stream?.settings.title, overview.stream?.settings.orderMode], ["off", "Tropico Jazz Radio", "shuffle"]);
  assert.equal(h.events.at(-1)?.kind, "settings_saved");
});

test("saveSettings changes only the five settings of an existing stream -- never its ids, intent or position (independent review)", async () => {
  const h = harness();
  await h.services.saveSettings("UC1", { title: "First", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" });
  // A Start (or YouTube ending it) changes the row between the page's read and its Save:
  const row = h.streamRow("UC1")!;
  h.setStreamRow("UC1", { ...row, intent: "on", streamId: "STREAM1", broadcastId: "BC1", positionIndex: 3 });
  await h.services.saveSettings("UC1", { title: "Second", description: "d", privacyStatus: "public", madeForKids: false, orderMode: "shuffle" });
  const after = h.streamRow("UC1")!;
  assert.deepEqual([after.title, after.orderMode, after.intent, after.streamId, after.broadcastId, after.positionIndex], ["Second", "shuffle", "on", "STREAM1", "BC1", 3]);
});

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4 "Adding", §4.1 "Adding"): the picker's «Добавить N видео» adds each item as
// `addVideo` would, in order; one refusal does not stop the others; nothing is added twice.
test("addVideos: a batch of 3 with one file 5 s off adds 2 in order and reports the refusal with its reason", async () => {
  const third = "SCHEDULED01";
  const h = harness({
    facts: [
      { videoId: PUBLIC_A, title: "A", privacyStatus: "public", publishAt: null, durationSeconds: 7382 },
      { videoId: PUBLIC_B, title: "B", privacyStatus: "public", publishAt: null, durationSeconds: 7377 },
      { videoId: third, title: "S", privacyStatus: "public", publishAt: null, durationSeconds: 7382 },
    ],
    files: { "04 Videos/a.mp4": 1, "04 Videos/b.mp4": 2, "04 Videos/c.mp4": 3 },
  });
  const result = await h.services.addVideos("UC1", {
    items: [
      { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" },
      { videoId: PUBLIC_B, originalPath: "04 Videos/b.mp4" },
      { videoId: third, originalPath: "04 Videos/c.mp4" },
    ],
  });
  assert.deepEqual(result.added.map((v) => [v.videoId, v.rotationIndex]), [[PUBLIC_A, 0], [third, 1]]);
  assert.equal(result.refused.length, 1);
  assert.deepEqual([result.refused[0].videoId, result.refused[0].code, result.refused[0].reason], [PUBLIC_B, "live_stream_video_refused", "duration_mismatch"]);
  assert.deepEqual(h.videos.map((v) => v.videoId), [PUBLIC_A, third]);
});

test("addVideos: an item repeated in the list, or already in the rotation, is not added twice", async () => {
  const h = harness();
  await h.services.addVideo("UC1", { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" });
  const result = await h.services.addVideos("UC1", {
    items: [
      { videoId: PUBLIC_B, originalPath: "04 Videos/b.mp4" },
      { videoId: PUBLIC_B, originalPath: "04 Videos/b.mp4" },
      { videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" },
    ],
  });
  assert.deepEqual(result.added.map((v) => v.videoId), [PUBLIC_B]);
  assert.deepEqual(result.refused.map((r) => [r.videoId, r.code]), [[PUBLIC_A, "validation_failed"]]);
  assert.equal(h.videos.length, 2);
});

test("addVideos: a video not of the channel and a private one are refused; an empty or malformed list is a validation error", async () => {
  const h = harness();
  const result = await h.services.addVideos("UC1", {
    items: [
      { videoId: OTHER_CHANNEL, originalPath: "04 Videos/a.mp4" },
      { videoId: PRIVATE_V55, originalPath: "04 Videos/a.mp4" },
    ],
  });
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.refused.map((r) => r.reason), ["not_channel_video", "private"]);
  await assert.rejects(() => h.services.addVideos("UC1", { items: [] }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  await assert.rejects(() => h.services.addVideos("UC1", { items: [{ videoId: PUBLIC_A }] }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.equal(h.videos.length, 0);
});

test("addVideos: a missing workspace stops the batch with its own error (every file would fail the same way)", async () => {
  const h = harness({ workspaceMissing: true });
  await assert.rejects(
    () => h.services.addVideos("UC1", { items: [{ videoId: PUBLIC_A, originalPath: "04 Videos/a.mp4" }] }),
    (e: unknown) => e instanceof DomainError && e.code === "live_stream_workspace_unavailable"
  );
});

// BL-233 (FO-REQ-0047 ask 1): the stream's own bitrate is saved with its settings -- a whole 1000..12000, null back to the
// computer's, absent left as it is -- and shown in the overview (null when never set).
test("BL-233: saveSettings stores the stream's own bitrate; null clears it; absent keeps it; out of range is refused", async () => {
  const h = harness();
  const base = { title: "Cuban Jazz Radio", description: "", privacyStatus: "unlisted", madeForKids: false, orderMode: "sequence" } as const;
  await h.services.saveSettings("UC1", base);
  assert.equal((await h.services.getOverview("UC1")).stream?.settings.bitrateKbps, null);
  await h.services.saveSettings("UC1", { ...base, bitrateKbps: 4000 });
  assert.equal((await h.services.getOverview("UC1")).stream?.settings.bitrateKbps, 4000);
  await h.services.saveSettings("UC1", { ...base, title: "Renamed" });
  assert.equal((await h.services.getOverview("UC1")).stream?.settings.bitrateKbps, 4000, "absent = unchanged");
  for (const bad of [999, 12001, 4000.5, "4000"]) {
    await assert.rejects(() => h.services.saveSettings("UC1", { ...base, bitrateKbps: bad }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed", String(bad));
  }
  await h.services.saveSettings("UC1", { ...base, bitrateKbps: null });
  assert.equal((await h.services.getOverview("UC1")).stream?.settings.bitrateKbps, null);
});
