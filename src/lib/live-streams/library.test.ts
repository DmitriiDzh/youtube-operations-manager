import assert from "node:assert/strict";
import test from "node:test";
import type { MediaProbe } from "@/lib/ffmpeg-host";
import { DomainError } from "./contracts";
import {
  checkSegmentMedia,
  completeSegments,
  createSegmentLibrary,
  isLibraryPath,
  parseSidecar,
  segmentFile,
  segmentId,
  segmentSourceStatus,
  seqOfSegmentId,
  sourceModeOf,
  trackAt,
  type LibraryDependencies,
  type LibraryUnavailableReason,
  type StoredLibrarySegmentRow,
} from "./library";

// BL-234 acceptance (FO-REQ-0048 as changed by the owner, msgs 3792/3793/3795; ADR 0056). Expected values come from the request:
// the generator writes `04 Videos/Live Segments/seg-<6 digits>.mp4` + `.json` sidecar (+ `.jpg` poster), each as `.part` first;
// a `.part` and a segment without a valid sidecar are never listed; the selection is the owner's, in the owner's order; a missing
// or unreadable selected segment is skipped and logged and the rest keep going; none playable = a clear reason, never an empty
// pass; nothing in the library is ever deleted; the current track is the sidecar's track at the playing offset.

const NOW = new Date("2026-10-29T12:00:00Z");
const GOOD: MediaProbe = {
  durationSeconds: 1812.5,
  sizeBytes: 600_000_000,
  video: { codec: "h264", width: 1920, height: 1080, frameRate: 30 },
  audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  audioStreams: 1,
  videoStreams: 1,
};

const sidecar = (seq: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    seq,
    durationSec: 1812.5,
    createdAt: "2026-10-29T10:00:00Z",
    title: `Scene ${seq}`,
    posterFile: `seg-${String(seq).padStart(6, "0")}.jpg`,
    video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    tracks: [
      { title: "Track A", startSec: 0 },
      { title: "Track B", startSec: 600 },
      { title: "Track C", startSec: 1200 },
    ],
    scene: { painting: "x" },
    ...extra,
  });

function harness(options: { names?: string[]; texts?: Record<string, string>; probes?: Record<string, MediaProbe | "throws">; unavailable?: LibraryUnavailableReason; stream?: boolean } = {}) {
  let names = options.names ?? ["seg-000001.mp4", "seg-000001.json", "seg-000001.jpg", "seg-000002.mp4", "seg-000002.json", "seg-000003.mp4", "seg-000003.json"];
  const texts: Record<string, string> = options.texts ?? { [segmentFile(1, "json")]: sidecar(1), [segmentFile(2, "json")]: sidecar(2), [segmentFile(3, "json")]: sidecar(3) };
  const probes = options.probes ?? {};
  let unavailable = options.unavailable ?? null;
  const rows: StoredLibrarySegmentRow[] = [];
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  const stream = options.stream === false ? null : { sourceMode: null as string | null, nextPassCleared: 0, positionIndex: 0, positionOffsetSeconds: 0, passOrderJson: null };
  const deps: LibraryDependencies = {
    async listLibrary() {
      return unavailable ? { ok: false, reason: unavailable } : { ok: true, names: [...names] };
    },
    async readText(_channelId, relativePath) {
      if (unavailable) return null;
      const name = relativePath.split("/").at(-1)!;
      return names.includes(name) ? (texts[relativePath] ?? null) : null;
    },
    async resolve(_channelId, relativePath) {
      if (unavailable) return null;
      const name = relativePath.split("/").at(-1)!;
      return names.includes(name) ? { path: `/ws/${relativePath}`, bytes: 600_000_000 } : null;
    },
    async probe(path) {
      const probe = probes[path.replace("/ws/", "")];
      if (probe === "throws") throw new Error("moov atom not found");
      return probe ?? GOOD;
    },
    store: {
      async getStream() {
        return stream;
      },
      async setSourceMode(_channelId, mode) {
        if (!stream) return false;
        stream.sourceMode = mode;
        stream.nextPassCleared += 1;
        return true;
      },
      async list(channelId) {
        return rows.filter((r) => r.channelId === channelId).sort((a, b) => a.rotationIndex - b.rotationIndex);
      },
      async upsert(row) {
        const i = rows.findIndex((r) => r.channelId === row.channelId && r.seq === row.seq);
        if (i >= 0) rows[i] = row;
        else rows.push(row);
      },
      async update(channelId, seq, set) {
        const row = rows.find((r) => r.channelId === channelId && r.seq === seq);
        if (!row) return false;
        Object.assign(row, set);
        return true;
      },
      async remove(channelId, seq) {
        const i = rows.findIndex((r) => r.channelId === channelId && r.seq === seq);
        if (i < 0) return false;
        rows.splice(i, 1);
        return true;
      },
      async setOrder(channelId, seqs) {
        const mine = rows.filter((r) => r.channelId === channelId);
        if (seqs.length !== mine.length || new Set(seqs).size !== seqs.length || seqs.some((s) => !mine.some((r) => r.seq === s))) return false;
        seqs.forEach((seq, index) => (mine.find((r) => r.seq === seq)!.rotationIndex = index));
        return true;
      },
    },
    async event(_channelId, kind, detail) {
      events.push({ kind, detail });
    },
    clock: () => NOW,
  };
  return {
    library: createSegmentLibrary(deps),
    rows,
    events,
    stream,
    setNames: (next: string[]) => (names = next),
    setUnavailable: (reason: LibraryUnavailableReason | null) => (unavailable = reason),
  };
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

test("ids: seg-<6 digits> both ways; files under 04 Videos/Live Segments; a YouTube id is not a segment id", () => {
  assert.equal(segmentId(7), "seg-000007");
  assert.equal(segmentId(123456), "seg-123456");
  assert.equal(seqOfSegmentId("seg-000007"), 7);
  assert.equal(seqOfSegmentId("AAAAAAAAAA1"), null);
  assert.equal(seqOfSegmentId("seg-7"), null);
  assert.equal(segmentFile(42, "mp4"), "04 Videos/Live Segments/seg-000042.mp4");
  assert.equal(segmentFile(42, "json"), "04 Videos/Live Segments/seg-000042.json");
  assert.equal(isLibraryPath("04 Videos/Live Segments/seg-000042.mp4"), true);
  assert.equal(isLibraryPath("04 Videos/10 October/1013 V47/V47.mp4"), false, "the video picker keeps published videos");
  assert.equal(isLibraryPath("04 Videos/Live Segments Old/x.mp4"), false);
  assert.equal(sourceModeOf(null), "videos");
  assert.equal(sourceModeOf({ sourceMode: null }), "videos");
  assert.equal(sourceModeOf({ sourceMode: "segments" }), "segments");
  assert.equal(sourceModeOf({ sourceMode: "junk" }), "videos");
});

test("completeSegments: only an .mp4 with its .json and no .part beside it; the poster is optional", () => {
  assert.deepEqual(
    completeSegments([
      "seg-000001.mp4", "seg-000001.json", "seg-000001.jpg",
      "seg-000002.mp4", "seg-000002.json",
      "seg-000003.mp4.part", "seg-000003.json",
      "seg-000004.mp4", // no sidecar
      "seg-000005.json", // no video
      "seg-000006.mp4", "seg-000006.json", "seg-000006.json.part", // the sidecar is being rewritten
      "seg-000007.mp4.part",
      "seg-8.mp4", "seg-000009.MP4", "notes.txt", ".DS_Store",
    ]),
    [
      { seq: 1, poster: true },
      { seq: 2, poster: false },
    ]
  );
  assert.deepEqual(completeSegments([]), []);
});

test("parseSidecar: the contract's sidecar with extra keys parses; tracks sorted; a wrong seq, bad JSON or missing fields refuse", () => {
  const ok = parseSidecar(sidecar(12), 12);
  assert.ok(ok.ok);
  assert.equal(ok.sidecar.title, "Scene 12");
  assert.equal(ok.sidecar.durationSec, 1812.5);
  assert.deepEqual(ok.sidecar.tracks.map((t) => t.title), ["Track A", "Track B", "Track C"]);
  const unsorted = parseSidecar(sidecar(1, { tracks: [{ title: "B", startSec: 900 }, { title: "A", startSec: 0 }] }), 1);
  assert.ok(unsorted.ok);
  assert.deepEqual(unsorted.sidecar.tracks.map((t) => t.title), ["A", "B"]);
  assert.deepEqual(parseSidecar(sidecar(12), 13), { ok: false, reason: "seq_mismatch" });
  assert.deepEqual(parseSidecar("{not json", 1), { ok: false, reason: "not_json" });
  assert.deepEqual(parseSidecar(JSON.stringify({ seq: 1, createdAt: "x" }), 1), { ok: false, reason: "invalid" });
  assert.deepEqual(parseSidecar(sidecar(1, { durationSec: 0 }), 1), { ok: false, reason: "invalid" });
  assert.deepEqual(parseSidecar(sidecar(1, { tracks: [{ title: "A", startSec: -1 }] }), 1), { ok: false, reason: "invalid" });
  const noTracks = parseSidecar(JSON.stringify({ seq: 1, durationSec: 1800, createdAt: "x" }), 1);
  assert.ok(noTracks.ok);
  assert.deepEqual(noTracks.sidecar.tracks, []);
  assert.equal(noTracks.sidecar.title, null);
  assert.ok(parseSidecar(`﻿${sidecar(1)}`, 1).ok, "a BOM is tolerated");
});

test("trackAt: the last track started at or before the offset; none before the first or without tracks", () => {
  const tracks = [
    { title: "A", startSec: 5 },
    { title: "B", startSec: 600 },
  ];
  assert.equal(trackAt(tracks, 0), null);
  assert.equal(trackAt(tracks, 5)?.title, "A");
  assert.equal(trackAt(tracks, 599.9)?.title, "A");
  assert.equal(trackAt(tracks, 600)?.title, "B");
  assert.equal(trackAt(tracks, 99_999)?.title, "B");
  assert.equal(trackAt([], 100), null);
});

test("checkSegmentMedia: a picture, AAC 44.1/48 kHz with 1-2 channels and a known duration; no YouTube duration involved", () => {
  assert.equal(checkSegmentMedia(GOOD), null);
  assert.equal(checkSegmentMedia({ ...GOOD, audio: { codec: "aac", sampleRate: 44100, channels: 1 } }), null);
  assert.equal(checkSegmentMedia({ ...GOOD, video: null }), "no_video_stream");
  assert.equal(checkSegmentMedia({ ...GOOD, audio: null }), "audio_unsupported");
  assert.equal(checkSegmentMedia({ ...GOOD, audio: { codec: "opus", sampleRate: 48000, channels: 2 } }), "audio_unsupported");
  assert.equal(checkSegmentMedia({ ...GOOD, audio: { codec: "aac", sampleRate: 32000, channels: 2 } }), "audio_unsupported");
  assert.equal(checkSegmentMedia({ ...GOOD, audio: { codec: "aac", sampleRate: 48000, channels: 6 } }), "audio_unsupported");
  assert.equal(checkSegmentMedia({ ...GOOD, durationSeconds: null }), "duration_unknown");
  assert.equal(checkSegmentMedia({ ...GOOD, durationSeconds: 0 }), "duration_unknown");
});

test("listLibrary: complete segments with a valid sidecar only (a bad sidecar is counted, never listed); unavailable says why", async () => {
  const h = harness({
    names: ["seg-000001.mp4", "seg-000001.json", "seg-000001.jpg", "seg-000002.mp4", "seg-000002.json", "seg-000003.mp4.part", "seg-000003.json", "seg-000004.mp4", "seg-000004.json"],
    texts: { [segmentFile(1, "json")]: sidecar(1), [segmentFile(2, "json")]: "{oops", [segmentFile(3, "json")]: sidecar(3), [segmentFile(4, "json")]: sidecar(5) },
  });
  const listed = await h.library.listLibrary("UC1");
  assert.equal(listed.available, true);
  assert.deepEqual(listed.segments.map((s) => [s.seq, s.id, s.title, s.poster, s.selected]), [[1, "seg-000001", "Scene 1", true, false]]);
  assert.equal(listed.skipped, 2, "seg 2 (bad JSON) and seg 4 (seq 5 in the sidecar)");
  assert.equal(listed.segments[0].tracks.length, 3);

  h.setUnavailable("workspace_unavailable");
  const away = await h.library.listLibrary("UC1");
  assert.equal(away.available, false);
  assert.equal(away.reason, "workspace_unavailable");
  assert.deepEqual(away.segments, []);
});

test("addSegments: appended in the owner's order; a refused one adds nothing and the others still go in; repeats skipped", async () => {
  const h = harness({ probes: { [segmentFile(2, "mp4")]: "throws" } });
  const result = await h.library.addSegments("UC1", { seqs: [3, 2, 1, 3, 9] });
  assert.deepEqual(result.added.map((a) => [a.seq, a.rotationIndex]), [[3, 0], [1, 1]]);
  assert.deepEqual(result.refused.map((r) => [r.seq, r.reason]), [[2, "file_unavailable"], [9, "not_in_library"]]);
  assert.equal(result.added[0].durationSeconds, 1812.5);
  assert.deepEqual(result.added[0].tracks.map((t) => t.title), ["Track A", "Track B", "Track C"]);
  const again = await h.library.addSegments("UC1", { seqs: [1] });
  assert.deepEqual(again.added, [], "already selected");
  assert.deepEqual((await h.library.selection("UC1")).map((s) => s.seq), [3, 1]);
  assert.ok(h.events.some((e) => e.kind === "library_add"));
});

test("addSegments: wrong format refused by ffprobe; library unavailable and no stream row refuse; bad input refused", async () => {
  const h = harness({ probes: { [segmentFile(1, "mp4")]: { ...GOOD, audio: { codec: "mp3", sampleRate: 44100, channels: 2 } } } });
  const result = await h.library.addSegments("UC1", { seqs: [1] });
  assert.deepEqual(result.refused.map((r) => [r.seq, r.reason]), [[1, "audio_unsupported"]]);
  assert.equal(h.rows.length, 0);
  h.setUnavailable("workspace_not_configured");
  assert.equal((await refusal(h.library.addSegments("UC1", { seqs: [2] }))).code, "live_stream_workspace_unavailable");
  assert.equal((await refusal(harness({ stream: false }).library.addSegments("UC1", { seqs: [1] }))).code, "validation_failed");
  assert.equal((await refusal(h.library.addSegments("UC1", { seqs: [] }))).code, "validation_failed");
  assert.equal((await refusal(h.library.addSegments("UC1", { seqs: [1_000_000] }))).code, "validation_failed");
});

test("reorder and remove: only the selection's rows change; removing never touches a library file", async () => {
  const h = harness();
  await h.library.addSegments("UC1", { seqs: [1, 2, 3] });
  await h.library.reorderSegments("UC1", { seqs: [3, 1, 2] });
  assert.deepEqual((await h.library.selection("UC1")).map((s) => s.seq), [3, 1, 2]);
  assert.equal((await refusal(h.library.reorderSegments("UC1", { seqs: [3, 1] }))).code, "validation_failed");
  await h.library.removeSegment("UC1", { seq: 1 });
  assert.deepEqual((await h.library.selection("UC1")).map((s) => s.seq), [3, 2]);
  assert.equal((await refusal(h.library.removeSegment("UC1", { seq: 1 }))).code, "live_stream_video_not_found");
  // The library still lists segment 1 (the dependency surface has no way to write, rename or delete a library file).
  assert.ok((await h.library.listLibrary("UC1")).segments.some((s) => s.seq === 1));
});

test("recheck: the owner's order; a missing or unreadable segment is skipped and logged once per change, the rest play", async () => {
  const h = harness();
  await h.library.addSegments("UC1", { seqs: [2, 1, 3] });
  assert.deepEqual(await h.library.recheck("UC1"), ["seg-000002", "seg-000001", "seg-000003"]);
  // Segment 1 disappears from the library (moved away outside the app).
  h.setNames(["seg-000002.mp4", "seg-000002.json", "seg-000003.mp4", "seg-000003.json"]);
  assert.deepEqual(await h.library.recheck("UC1"), ["seg-000002", "seg-000003"]);
  assert.deepEqual(h.events.filter((e) => e.kind === "segment_refused").map((e) => e.detail), [{ seq: 1, reason: "not_in_library" }]);
  await h.library.recheck("UC1");
  assert.equal(h.events.filter((e) => e.kind === "segment_refused").length, 1, "logged once per change, not at every recheck");
  // Back in the library: playable again.
  h.setNames(["seg-000001.mp4", "seg-000001.json", "seg-000002.mp4", "seg-000002.json", "seg-000003.mp4", "seg-000003.json"]);
  assert.deepEqual(await h.library.recheck("UC1"), ["seg-000002", "seg-000001", "seg-000003"]);
});

test("recheck: an ffprobe failure or a .part rewrite skips that segment only", async () => {
  const probes: Record<string, MediaProbe | "throws"> = {};
  const h = harness({ probes });
  await h.library.addSegments("UC1", { seqs: [1, 2, 3] });
  probes[segmentFile(2, "mp4")] = "throws";
  h.setNames(["seg-000001.mp4", "seg-000001.json", "seg-000002.mp4", "seg-000002.json", "seg-000003.mp4", "seg-000003.json", "seg-000003.mp4.part"]);
  assert.deepEqual(await h.library.recheck("UC1"), ["seg-000001"]);
  assert.deepEqual((await h.library.selection("UC1")).map((s) => [s.seq, s.check.status, s.check.reason]), [[1, "ok", null], [2, "refused", "file_unavailable"], [3, "refused", "not_in_library"]]);
});

test("recheck: none selected / none playable is refused with its reason, never an empty pass", async () => {
  const h = harness();
  const none = await refusal(h.library.recheck("UC1"));
  assert.equal(none.code, "live_stream_video_refused");
  assert.equal((none.details as { reason: string }).reason, "no_segments_selected");
  await h.library.addSegments("UC1", { seqs: [1] });
  h.setNames([]);
  const gone = await refusal(h.library.recheck("UC1"));
  assert.equal((gone.details as { reason: string }).reason, "no_playable_segments");
});

test("recheck with the library unreadable (the drive away): the last checks stand -- never an empty pass while copies can play", async () => {
  const h = harness();
  await h.library.addSegments("UC1", { seqs: [1, 2] });
  h.setUnavailable("workspace_unavailable");
  assert.deepEqual(await h.library.recheck("UC1"), ["seg-000001", "seg-000002"]);
  assert.ok(h.events.some((e) => e.kind === "segment_library_unavailable"));
  // Nothing ever checked ok: refused with the library's reason.
  const fresh = harness({ unavailable: "workspace_not_configured" });
  fresh.rows.push({ channelId: "UC1", seq: 1, rotationIndex: 0, title: null, durationSeconds: null, sidecarDurationSeconds: null, bytes: null, tracksJson: null, checkStatus: "refused", checkReason: "not_in_library", checkedAt: NOW, addedAt: NOW });
  const refused = await refusal(fresh.library.recheck("UC1"));
  assert.equal((refused.details as { reason: string }).reason, "workspace_not_configured");
});

test("setSourceMode: the owner's switch is audited; same mode changes nothing; no stream row or a bad mode is refused", async () => {
  const h = harness();
  assert.deepEqual(await h.library.setSourceMode("UC1", { mode: "segments" }), { mode: "segments", changed: true });
  assert.equal(h.stream?.sourceMode, "segments");
  assert.equal(h.stream?.nextPassCleared, 1, "the store drops the next pass drawn in the old mode");
  assert.deepEqual(h.events.filter((e) => e.kind === "source_mode_changed").map((e) => e.detail), [{ from: "videos", to: "segments" }]);
  assert.deepEqual(await h.library.setSourceMode("UC1", { mode: "segments" }), { mode: "segments", changed: false });
  assert.equal(h.events.filter((e) => e.kind === "source_mode_changed").length, 1);
  assert.equal((await refusal(h.library.setSourceMode("UC1", { mode: "generated" }))).code, "validation_failed");
  assert.equal((await refusal(h.library.setSourceMode("UC1", { mode: "segments", by: "agent" }))).code, "validation_failed");
  assert.equal((await refusal(harness({ stream: false }).library.setSourceMode("UC1", { mode: "segments" }))).code, "validation_failed");
});

test("items: each selected segment as the buffer needs it -- its library file and its probed duration, no YouTube duration", async () => {
  const h = harness();
  await h.library.addSegments("UC1", { seqs: [2, 1] });
  assert.deepEqual(await h.library.items("UC1"), [
    { videoId: "seg-000002", originalPath: "04 Videos/Live Segments/seg-000002.mp4", videoDurationSeconds: null, originalDurationSeconds: 1812.5, kind: "segment" },
    { videoId: "seg-000001", originalPath: "04 Videos/Live Segments/seg-000001.mp4", videoDurationSeconds: null, originalDurationSeconds: 1812.5, kind: "segment" },
  ]);
});

test("segmentSourceStatus: the current segment and its track by offset; minutes of the playable selection; videos mode has no segment", () => {
  const row = (seq: number, status: "ok" | "refused", seconds: number): StoredLibrarySegmentRow => ({
    channelId: "UC1", seq, rotationIndex: seq, title: `Scene ${seq}`, durationSeconds: seconds, sidecarDurationSeconds: seconds, bytes: 1,
    tracksJson: JSON.stringify([{ title: "Track A", startSec: 0 }, { title: "Track B", startSec: 600 }]), checkStatus: status, checkReason: null, checkedAt: NOW, addedAt: NOW,
  });
  const rows = [row(1, "ok", 1800), row(2, "ok", 1860), row(3, "refused", 1800)];
  const status = segmentSourceStatus({ channelId: "UC1", sourceMode: "segments", rows, library: { ok: true }, position: { segmentId: "seg-000002", offsetSeconds: 601.7 } });
  assert.deepEqual(status, {
    channelId: "UC1",
    sourceMode: "segments",
    library: { available: true, reason: null },
    selection: { segments: 3, playable: 2, minutes: 61 },
    current: { seq: 2, title: "Scene 2", offsetSeconds: 601, track: "Track B" },
  });
  const away = segmentSourceStatus({ channelId: "UC1", sourceMode: "segments", rows, library: { ok: false, reason: "workspace_unavailable" }, position: { segmentId: "seg-000001", offsetSeconds: 10 } });
  assert.deepEqual(away.library, { available: false, reason: "workspace_unavailable" });
  assert.equal(away.current?.track, "Track A");
  const videos = segmentSourceStatus({ channelId: "UC1", sourceMode: "videos", rows: [], library: { ok: true }, position: { segmentId: "AAAAAAAAAA1", offsetSeconds: 10 } });
  assert.equal(videos.current, null);
  assert.deepEqual(videos.selection, { segments: 0, playable: 0, minutes: 0 });
});
