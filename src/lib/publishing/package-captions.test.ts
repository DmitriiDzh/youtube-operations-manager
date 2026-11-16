import assert from "node:assert/strict";
import test from "node:test";
import type { CaptionWriteInput, CaptionWriteResult } from "@/lib/video-captions";
import { sha256Hex } from "@/lib/video-captions/hash";
import { createPackageCaptions, type PackageCaptionsDeps, type PackageCaptionsFound } from "./package-captions";
import { parseReleasePackage } from "./packages";

// BL-269 add path (VIDEO_CAPTIONS_PLAN.md §3.5, §3.7, §7: AC-CAP-31, 33, 36, 37, 46, 47; ADR 0074 §8, §10). Requirements:
// - only a package whose upload record names the video id; the captions only from that package's CURRENT manifest; the mp4 may be gone;
// - refused while this computer's upload of the video still runs its steps; a package without captions is refused;
// - the owner's apply pins the preview (manifest SHA-256 and the track to replace); the Producer may pin;
// - the app's own tracks are those in the record and in this computer's finished upload rows; after a write the record lists the
//   track with the SHA-256 sent (only `captions` changes) and the upload rows whose step did not pass are marked.

const VTT = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n");
const SHA = sha256Hex(VTT);
const pkgWith = (captions: unknown) =>
  parseReleasePackage({
    schema: "yt-release-package/2",
    channelId: "UC_wwe",
    video: "V27",
    mix: null,
    plannedPublishDate: null,
    files: { video: "V27.mp4", thumbnail: "V27.jpg" },
    sizeBytes: 1000,
    durationSeconds: 600,
    title: "Long",
    description: "Text",
    tags: [],
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    ready: true,
    problems: [],
    ...(captions === undefined ? {} : { captions }),
  }).pkg!;
const CAPTION = { language: "en", file: "V27_captions.en.vtt", name: "", sha256: SHA };
const FOUND: PackageCaptionsFound = { pkg: pkgWith([CAPTION]), manifestSha256: "m1", manifestPath: "04 Videos/11 November/1120 V27/V27_release.json", folder: "04 Videos/11 November/1120 V27", videoId: "vid27" };

function result(over: Partial<CaptionWriteResult> = {}): CaptionWriteResult {
  return {
    channelId: "UC_wwe",
    videoId: "vid27",
    dryRun: false,
    mode: "insert",
    units: 550,
    file: { bytes: VTT.length, sha256: SHA, format: "vtt" },
    target: null,
    englishTracks: [],
    written: true,
    adopted: false,
    trackId: "NEW",
    trackName: "",
    alreadyPresent: false,
    backupPath: "/b",
    verified: true,
    verificationDetail: null,
    pending: false,
    writeUnits: 550,
    ...over,
  };
}

function harness(over: { found?: PackageCaptionsFound | "not_found"; rows?: Array<{ status: string; videoId: string | null; stepsJson: string }>; file?: Uint8Array | null; record?: Array<{ trackId: string; sha256: string; verified?: boolean; pending?: boolean }>; answer?: CaptionWriteResult } = {}) {
  const writes: CaptionWriteInput[] = [];
  const recorded: unknown[] = [];
  const marked: unknown[] = [];
  const deps: PackageCaptionsDeps = {
    findPackage: async () => over.found ?? FOUND,
    uploadRows: async () => over.rows ?? [],
    readFile: async (_c, path) => (path === `${FOUND.folder}/V27_captions.en.vtt` ? (over.file === undefined ? VTT : over.file) : null),
    recordCaptions: async () => over.record ?? [],
    writeRecordCaptions: async (_c, path, entry) => void recorded.push({ path, entry }),
    frameMemo: async () => "horizontal",
    write: async (input) => (writes.push(input), over.answer ?? result({ dryRun: input.dryRun === true })),
    markUploadCaptionsLater: async (_c, videoId, track) => (marked.push({ videoId, track }), 1),
    clock: { now: () => new Date("2026-11-17T12:00:00Z") },
  };
  return { service: createPackageCaptions(deps), writes, recorded, marked };
}

const owner = { kind: "owner" as const, userId: "owner-1" };
const producer = { kind: "producer" as const };

test("AC-CAP-31 the package's current manifest captions for the video its record names; the mp4 need not exist", async () => {
  const h = harness();
  const r = await h.service.apply("UC_wwe", { video: "V27" }, producer);
  assert.equal(h.writes.length, 1);
  const w = h.writes[0];
  assert.deepEqual([w.videoId, w.video, w.file.name, w.language, w.name, w.sha256, w.durationSeconds, w.frameFallback, w.overwrite], ["vid27", "V27", "V27_captions.en.vtt", "en", "", SHA, 600, "horizontal", false]);
  assert.deepEqual(Buffer.from(w.file.bytes), Buffer.from(VTT));
  assert.deepEqual([r.video, r.manifestSha256, r.recorded], ["V27", "m1", true]);
});

test("AC-CAP-31 refusals: no package, not uploaded (no record), no captions in the package, the file missing", async () => {
  await assert.rejects(harness({ found: "not_found" }).service.apply("UC_wwe", { video: "V27" }, producer), { code: "upload_package_not_ready" });
  await assert.rejects(harness({ found: { ...FOUND, videoId: null } }).service.apply("UC_wwe", { video: "V27" }, producer), { code: "package_metadata_not_uploaded" });
  await assert.rejects(harness({ found: { ...FOUND, pkg: pkgWith(undefined) } }).service.apply("UC_wwe", { video: "V27" }, producer), { code: "captions_not_in_package" });
  const missing = harness({ file: null });
  await assert.rejects(missing.service.apply("UC_wwe", { video: "V27" }, producer), { code: "captions_missing" });
  assert.equal(missing.writes.length, 0);
  const wrongHash = harness({ found: { ...FOUND, pkg: pkgWith([{ ...CAPTION, sha256: "0".repeat(64) }]) } });
  await assert.rejects(wrongHash.service.apply("UC_wwe", { video: "V27" }, producer), { code: "captions_invalid" });
  assert.equal(wrongHash.writes.length, 0);
});

test("AC-CAP-33 this computer's upload of the video still running its steps -> captions_step_pending, nothing written", async () => {
  for (const status of ["queued", "uploading", "processing", "finishing", "paused"]) {
    const h = harness({ rows: [{ status, videoId: "vid27", stepsJson: "{}" }] });
    await assert.rejects(h.service.apply("UC_wwe", { video: "V27" }, producer), { code: "captions_step_pending" });
    assert.equal(h.writes.length, 0);
  }
});

test("AC-CAP-36 / AC-CAP-46 the owner's apply must pin the preview; a re-packaged manifest refuses", async () => {
  const h = harness();
  assert.throws(() => h.service.apply("UC_wwe", { video: "V27", expectedTrackId: null }, owner), { code: "validation_failed" });
  assert.throws(() => h.service.apply("UC_wwe", { video: "V27", expectedManifestSha256: "m1" }, owner), { code: "validation_failed" });
  await assert.rejects(h.service.apply("UC_wwe", { video: "V27", expectedManifestSha256: "m0", expectedTrackId: null }, owner), { code: "package_metadata_manifest_changed" });
  assert.equal(h.writes.length, 0);
  await h.service.apply("UC_wwe", { video: "V27", expectedManifestSha256: "m1", expectedTrackId: "F1", overwrite: true }, owner);
  assert.deepEqual([h.writes[0].expectedTrackId, h.writes[0].overwrite], ["F1", true]);
});

test("preview: a dry run, nothing recorded or marked", async () => {
  const h = harness();
  const r = await h.service.preview("UC_wwe", { video: "V27", overwrite: true }, owner);
  assert.deepEqual([h.writes[0].dryRun, h.writes[0].overwrite, r.recorded], [true, true, false]);
  assert.deepEqual([h.recorded, h.marked], [[], []]);
});

test("ours = the record's and this computer's finished rows' tracks (the record's word last)", async () => {
  const rows = [
    { status: "done", videoId: "vid27", stepsJson: JSON.stringify({ captions: "verified", captionsTrack: { trackId: "T1", sha256: "1".repeat(64) } }) },
    { status: "done", videoId: "vid27", stepsJson: JSON.stringify({ captions: "refused", captionsTrack: { trackId: "T9", sha256: "9".repeat(64) } }) },
    { status: "done", videoId: "other", stepsJson: JSON.stringify({ captions: "verified", captionsTrack: { trackId: "T5", sha256: "5".repeat(64) } }) },
  ];
  const h = harness({ rows, record: [{ trackId: "T1", sha256: "2".repeat(64) }, { trackId: "T2", sha256: SHA }] });
  await h.service.apply("UC_wwe", { video: "V27" }, producer);
  assert.deepEqual(h.writes[0].ownTracks, [
    { trackId: "T1", sha256: "2".repeat(64) },
    { trackId: "T2", sha256: SHA },
  ]);
});

test("AC-CAP-37 / AC-CAP-47 after a verified write the record lists the track (sent SHA-256, actor) and failed upload steps are marked", async () => {
  const h = harness({ answer: result({ mode: "update", trackId: "F1", trackName: "Mine" }) });
  const r = await h.service.apply("UC_wwe", { video: "V27", overwrite: true }, producer);
  assert.deepEqual(h.recorded, [
    { path: `${FOUND.folder}/V27_youtube.json`, entry: { trackId: "F1", language: "en", name: "Mine", sha256: SHA, at: "2026-11-17T12:00:00.000Z", by: "producer", verified: true } },
  ]);
  assert.deepEqual([r.recorded, r.uploadStepsMarked], [true, 1]);
  // Not verified: recorded (it was written), no upload step marked.
  const unverified = harness({ answer: result({ verified: false, verificationDetail: "syncing" }) });
  const u = await unverified.service.apply("UC_wwe", { video: "V27" }, producer);
  assert.deepEqual([u.recorded, u.uploadStepsMarked, unverified.marked.length], [true, 0, 0]);
  assert.equal((unverified.recorded[0] as { entry: { verified: boolean } }).entry.verified, false);
  // Already present as recorded: nothing rewritten.
  const present = harness({ record: [{ trackId: "T2", sha256: SHA }], answer: result({ mode: "none", written: false, alreadyPresent: true, trackId: "T2" }) });
  await present.service.apply("UC_wwe", { video: "V27" }, producer);
  assert.deepEqual(present.recorded, []);
});

test("AC-CAP-47 an unverified record entry (or a mismatched upload step) is ours but never 'already present': its sha256 is not trusted", async () => {
  const rows = [{ status: "done", videoId: "vid27", stepsJson: JSON.stringify({ captions: "mismatch", captionsTrack: { trackId: "T1", sha256: SHA } }) }];
  const h = harness({ rows, record: [{ trackId: "T2", sha256: SHA, verified: false }] });
  await h.service.apply("UC_wwe", { video: "V27", overwrite: true }, producer);
  assert.deepEqual(h.writes[0].ownTracks, [
    { trackId: "T1", sha256: "unverified" },
    { trackId: "T2", sha256: "unverified" },
  ]);
});

test("review #4 a write YouTube still processes is recorded NOT verified (pending); the next plain add re-checks it, then records it verified", async () => {
  const pending = harness({ answer: result({ verified: false, pending: true, verificationDetail: "YouTube is still processing the track (syncing)" }) });
  const p = await pending.service.apply("UC_wwe", { video: "V27" }, producer);
  const entry = (pending.recorded[0] as { entry: Record<string, unknown> }).entry;
  assert.deepEqual([entry.verified, entry.pending, p.uploadStepsMarked], [false, true, 0]);
  // Next call: the track is the app's own from this very file (sha256 kept, so no "own track differs" refusal) -- the writer
  // re-checks it; now serving -> already present, the entry rewritten as verified, the upload rows marked.
  const later = harness({ record: [{ trackId: "NEW", sha256: SHA, verified: false, pending: true }], answer: result({ mode: "none", written: false, alreadyPresent: true, trackId: "NEW", verified: true }) });
  const r = await later.service.apply("UC_wwe", { video: "V27" }, producer);
  assert.deepEqual(later.writes[0].ownTracks, [{ trackId: "NEW", sha256: SHA }]);
  assert.equal((later.recorded[0] as { entry: Record<string, unknown> }).entry.verified, true);
  assert.equal("pending" in (later.recorded[0] as { entry: Record<string, unknown> }).entry, false);
  assert.deepEqual([r.recorded, r.uploadStepsMarked], [true, 1]);
});
