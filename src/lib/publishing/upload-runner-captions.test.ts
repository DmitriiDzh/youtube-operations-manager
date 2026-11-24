import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError, type ResolvedCredentials } from "@/lib/shared-domain";
import type { VideoCaptionTrack, VideoCaptionsDeps } from "@/lib/video-captions/contracts";
import { sha256Hex } from "@/lib/video-captions/hash";
import { createVideoCaptionsServices } from "@/lib/video-captions/services";
import { captionStepOutcome, createCaptionStepWriter } from "./caption-step";
import { checksPassed } from "./plan-schedule";
import { estimateUploadUnits } from "./publish-dates";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import { createUploadRunner, mergeRecordCaptions, type ApprovedPackage, type UploadRunnerDeps, type UploadSteps } from "./upload-runner";

// BL-269 upload step (VIDEO_CAPTIONS_PLAN.md §3.3, §3.4, §7: AC-CAP-24..30, AC-CAP-38; ADR 0074 §7, §9). Requirements:
// - order after processing: translations -> captions -> thumbnail -> playlist -> read-back -> date -> record -> sync;
// - the date only when the captions step is none / verified / already present (and the read-back passed); failed, mismatch or refused
//   withhold it and the video stays private; the plan pass never dates such a row later either;
// - quota short (the guard or YouTube) and Live writes off are pauses, never failures; a lost insert answer is adopted (the writer);
// - the step never asks for an overwrite; a row from before BL-269 finishes with `none`;
// - the record carries the mp4's sha256 (or null) and size, and after captions the track id and sha256.

const NOW = new Date("2026-11-17T12:00:00Z");
const CAPTIONS = { language: "en", file: "04 Videos/11 November/1120 V27/V27_captions.en.vtt", name: "", sha256: "c".repeat(64) };
const PKG: ApprovedPackage = {
  video: "V27",
  title: "Long",
  description: "Text",
  tags: [],
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  manifestPath: "04 Videos/11 November/1120 V27/V27_release.json",
  videoFile: "04 Videos/11 November/1120 V27/V27.mp4",
  thumbnailFile: "04 Videos/11 November/1120 V27/V27.jpg",
  sizeBytes: 10,
  videoSha256: "d".repeat(64),
  captions: CAPTIONS,
  orientation: "horizontal",
};

function row(pkg: ApprovedPackage, steps: UploadSteps = {}): StoredPublishingUpload {
  return {
    id: "u1",
    channelId: "UC_wwe",
    video: pkg.video,
    manifestPath: pkg.manifestPath,
    manifestSha256: "m",
    packageJson: JSON.stringify(pkg),
    settingsJson: JSON.stringify({ ...DEFAULT_PUBLISHING_SETTINGS, playlistId: null }),
    publishAt: "2026-11-24T12:00:00.000Z",
    approvedBy: "owner-1",
    approvedAt: NOW,
    status: "finishing",
    resumeStatus: null,
    pausedReason: null,
    pausedUntil: null,
    sessionUri: "s",
    totalBytes: 10,
    storedBytes: 10,
    videoId: "vid27",
    publishAtAtInsert: false,
    stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), ...steps }),
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    nextAttemptAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    queueRank: 0,
    queuedBy: null,
    automatic: false,
    slotId: null,
  };
}

type CaptionsAnswer = Awaited<ReturnType<NonNullable<UploadRunnerDeps["writeCaptions"]>>>;

function harness(start: StoredPublishingUpload, writeCaptions?: UploadRunnerDeps["writeCaptions"], extraFiles: Partial<UploadRunnerDeps["files"]> = {}) {
  let current = { ...start };
  const order: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const clock = { at: NOW };
  const playlistItems = new Set<string>();
  const deps: UploadRunnerDeps = {
    store: {
      listActive: async () => (["queued", "uploading", "processing", "finishing", "paused"].includes(current.status) ? [{ ...current }] : []),
      update: async (_id, from, set) => {
        if (current.status !== from) return false;
        current = { ...current, ...set };
        return true;
      },
      claim: async () => true,
    },
    credentials: async (j) => ({ credentialRef: { userId: j.approvedBy }, credentials: {} }),
    assertWriteChannel: async () => undefined,
    accessToken: async () => "t",
    liveWritesEnabled: async () => true,
    gateway: {
      begin: async () => assert.fail("no upload"),
      putChunk: async () => assert.fail("no upload"),
      queryOffset: async () => assert.fail("no upload"),
      setThumbnail: async () => void order.push("thumbnail"),
      // A playlist item YouTube made is listed afterwards (package playlists: every add is read back).
      addToPlaylist: async (_c, videoId, playlistId) => void (order.push("playlist"), playlistItems.add(`${playlistId} ${videoId}`)),
    },
    reads: {
      uploadState: async () => ({ uploadStatus: "processed", rejectionReason: null, failureReason: null, hasCustomThumbnail: true }),
      recentUploads: async () => [],
      playlistHasVideo: async (_c, playlistId, videoId) => playlistItems.has(`${playlistId} ${videoId}`),
      snapshot: async () => {
        order.push("read");
        return {
          title: "Long",
          description: "Text",
          tags: [],
          categoryId: "10",
          defaultLanguage: "en",
          defaultAudioLanguage: "en",
          privacyStatus: "private",
          publishAt: order.includes("publishAt") ? "2026-11-24T12:00:00Z" : null,
          selfDeclaredMadeForKids: false,
          license: "youtube",
          embeddable: true,
        };
      },
    },
    setPublishAt: async () => void order.push("publishAt"),
    writeLocalizations: async () => (order.push("localizations"), { verified: true }),
    ...(writeCaptions
      ? {
          writeCaptions: async (args) => {
            order.push("captions");
            return writeCaptions(args);
          },
        }
      : {}),
    files: {
      resolve: async (_c, p) => ({ path: `/ws/${p}`, bytes: 10 }),
      readChunk: async () => Buffer.from("0123456789"),
      sha256: async () => "x",
      writeRecord: async (_c, _p, record) => void records.push(record as Record<string, unknown>),
      ...extraFiles,
    },
    audit: async () => undefined,
    syncChannel: async () => undefined,
    device: async () => ({ deviceId: "mac", hostname: "Mac" }),
    clock: { now: () => new Date(clock.at) },
    nextQuotaReset: () => new Date("2026-11-18T08:00:00Z"),
    chunkBytes: 4,
    sliceMs: 1000,
    runnerId: "r",
  };
  const runner = createUploadRunner(deps);
  return {
    order,
    records,
    row: () => current,
    steps: () => JSON.parse(current.stepsJson) as UploadSteps,
    async runAll(limit = 40) {
      for (let i = 0; i < limit && !["done", "failed", "cancelled"].includes(current.status); i += 1) {
        await runner.tick();
        clock.at = new Date(clock.at.getTime() + 10 * 60_000);
      }
    },
  };
}

const verified: CaptionsAnswer = { outcome: "verified", trackId: "T1", trackName: "", detail: null };

test("AC-CAP-24 order translations -> captions -> thumbnail; verified captions let the date through; the record names the track", async () => {
  const h = harness(row({ ...PKG, localizations: { de: { title: "T", description: "D" } } }), async (args) => {
    assert.equal("overwrite" in args, false, "AC-CAP-38: the step never asks for an overwrite");
    assert.deepEqual(args.captions, CAPTIONS);
    assert.equal(args.frameFallback, "horizontal");
    return verified;
  });
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().errorCode, null);
  assert.deepEqual(h.order.slice(0, 3), ["localizations", "captions", "thumbnail"]);
  assert.ok(h.order.includes("publishAt"));
  const steps = h.steps();
  assert.deepEqual([steps.captions, steps.publishAt, steps.captionsTrack?.trackId, steps.captionsTrack?.sha256], ["verified", "set", "T1", CAPTIONS.sha256]);
  // AC-CAP-29: the record step carries the mp4 identity and the track.
  const record = h.records.at(-1)!;
  assert.equal(record.videoSha256, "d".repeat(64));
  assert.equal(record.videoSizeBytes, 10);
  assert.deepEqual((record.captions as Array<Record<string, unknown>>).map((c) => [c.trackId, c.language, c.name, c.sha256, c.by]), [["T1", "en", "", CAPTIONS.sha256, "upload"]]);
  assert.equal(checksPassed(steps), true);
});

test("AC-CAP-24 already present also lets the date through", async () => {
  const h = harness(row(PKG), async () => ({ outcome: "already_present", trackId: "T0", trackName: "", detail: null }));
  await h.runAll();
  assert.deepEqual([h.steps().captions, h.steps().publishAt], ["already_present", "set"]);
});

test("AC-CAP-24 / AC-CAP-26 refused (switch off now, foreign track) or mismatch -> date withheld, private; the plan never dates it", async () => {
  const cases: Array<[CaptionsAnswer, string, string]> = [
    [{ outcome: "refused", code: "captions_invalid:channel_disabled", detail: "off" }, "refused", "step_failed"],
    [{ outcome: "refused", code: "captions_foreign_track", detail: "a person's track" }, "refused", "step_failed"],
    [{ outcome: "mismatch", trackId: "T1", trackName: "", detail: "failed" }, "mismatch", "verify_mismatch"],
  ];
  for (const [answer, step, problem] of cases) {
    const h = harness(row(PKG), async () => answer);
    await h.runAll();
    const steps = h.steps();
    assert.deepEqual([steps.captions, steps.publishAt, h.row().errorCode], [step, "withheld", problem]);
    assert.equal(h.order.includes("publishAt"), false);
    assert.equal(h.order.includes("thumbnail"), true, "the other steps still run");
    assert.ok((steps.notes ?? []).some((n) => /captions/.test(n)));
    assert.equal(checksPassed(steps), false, "the weekly plan pass never dates it later");
  }
});

test("AC-CAP-24 no writer on this computer -> failed, date withheld", async () => {
  const h = harness(row(PKG));
  await h.runAll();
  assert.deepEqual([h.steps().captions, h.steps().publishAt], ["failed", "withheld"]);
});

test("AC-CAP-25 the quota short (guard or YouTube) -> paused quota_exceeded until the reset; the step runs again after it, never failed", async () => {
  let calls = 0;
  const h = harness(row(PKG), async () => {
    calls += 1;
    if (calls === 1) throw new DomainError({ code: "youtube_quota_exceeded", message: "short" });
    if (calls === 2) throw Object.assign(new Error("quota"), { response: { status: 403, data: { error: { errors: [{ reason: "quotaExceeded" }] } } } });
    return verified;
  });
  await h.runAll(1);
  assert.deepEqual([h.row().status, h.row().pausedReason, h.steps().captions], ["paused", "quota_exceeded", undefined]);
  assert.equal(h.row().pausedUntil?.toISOString(), "2026-11-18T08:00:00.000Z", "until the quota day's reset");
  // The clock passes the reset (runAll moves it 10 minutes a tick): the row resumes, pauses once more on YouTube's own
  // quotaExceeded, then completes after the next reset.
  await h.runAll(400);
  assert.equal(calls, 3);
  assert.deepEqual([h.row().status, h.steps().captions], ["done", "verified"]);
});

test("AC-CAP-25 Live writes off -> a pause, never a failure", async () => {
  const h = harness(row(PKG), async () => {
    throw new DomainError({ code: "live_writes_disabled", message: "off" });
  });
  await h.runAll(1);
  assert.deepEqual([h.row().status, h.row().pausedReason, h.steps().captions], ["paused", "live_writes_off", undefined]);
});

test("AC-CAP-27 the attempt mark is saved before the insert and handed to the retry (the writer adopts a lost answer)", async () => {
  let calls = 0;
  const seen: Array<{ trackIdsBefore: string[] } | null> = [];
  const h = harness(row(PKG), async (args) => {
    calls += 1;
    seen.push(args.adoptAfterAttempt);
    if (calls === 1) {
      await args.onAttempt(["DE"]);
      throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }); // the insert's answer is lost
    }
    return { outcome: "verified", trackId: "LOST", trackName: "", detail: null };
  });
  await h.runAll();
  // Review #3: the retry also gets the mark's time (adoption only of a track updated at or after it).
  assert.deepEqual(seen, [null, { trackIdsBefore: ["DE"], at: NOW.toISOString() }]);
  assert.deepEqual([h.steps().captions, h.steps().captionsTrack?.trackId, h.steps().captionsAttempt?.trackIdsBefore], ["verified", "LOST", ["DE"]]);
});

test("pending (YouTube still syncing) is read again later with the track as ours, then decided", async () => {
  const owns: Array<Array<{ trackId: string }>> = [];
  const adopts: unknown[] = [];
  let calls = 0;
  const h = harness(row(PKG, { captionsAttempt: { at: NOW.toISOString(), trackIdsBefore: [] } }), async (args) => {
    owns.push(args.ownTracks);
    adopts.push(args.adoptAfterAttempt);
    calls += 1;
    return calls === 1 ? { outcome: "pending", trackId: "T1", trackName: "", detail: "syncing" } : { outcome: "already_present", trackId: "T1", trackName: "", detail: null };
  });
  await h.runAll();
  assert.deepEqual(owns, [[], [{ trackId: "T1", sha256: CAPTIONS.sha256 }]]);
  // The first pass may adopt (a mark is there); once the track is known it is ours by id, never adopted again.
  assert.deepEqual(adopts, [{ trackIdsBefore: [], at: NOW.toISOString() }, null]);
  assert.deepEqual([h.steps().captions, h.steps().captionsRereads, h.steps().publishAt], ["already_present", 1, "set"]);
});

test("AC-CAP-28 estimateUploadUnits adds 550 for a package with captions (and nothing otherwise)", () => {
  const base = estimateUploadUnits({ playlist: true, deferredPublishAt: true });
  assert.equal(base, 50 + 45 + 51 + 55);
  assert.equal(estimateUploadUnits({ playlist: true, deferredPublishAt: true, captions: true }), base + 550);
  assert.equal(estimateUploadUnits({ playlist: true, deferredPublishAt: true, captions: false }), base);
});

test("AC-CAP-29 / AC-CAP-30 a row from before BL-269 (no captions): steps.captions none, its date as before; the record's sha256 null when unstated", async () => {
  const old = { ...PKG };
  delete old.captions;
  delete old.videoSha256;
  delete old.orientation;
  const h = harness(row(old), async () => assert.fail("no captions step write"));
  await h.runAll();
  assert.deepEqual([h.row().status, h.steps().captions, h.steps().publishAt], ["done", "none", "set"]);
  const record = h.records.at(-1)!;
  assert.equal(record.videoSha256, null);
  assert.equal(record.videoSizeBytes, 10);
  assert.equal("captions" in record, false);
  assert.equal(h.order.includes("captions"), false);
});

// ---- The real wiring: the captions writer (fake YouTube) -> the step writer's mapping -> the runner (independent review #1) ----
// Requirement (ADR 0074 §7, plan §3.2 step 9, R3): only a track YouTube SERVES lets the date through. `syncing` is read again
// (bounded) and then withheld; `failed` is not verified (with `failureReason`) and withholds the date -- also when the track is the
// app's own from this very file ("already there"), which must not pass on the sha256 alone.

const REAL_VTT = Buffer.from("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n");
const REAL_CAPTIONS = { ...CAPTIONS, sha256: sha256Hex(REAL_VTT) };
const REAL_PKG: ApprovedPackage = { ...PKG, captions: REAL_CAPTIONS };
const enTrack = (over: Partial<VideoCaptionTrack> & { id: string }): VideoCaptionTrack => ({
  language: "en",
  name: "",
  trackKind: "standard",
  isDraft: false,
  status: "serving",
  failureReason: null,
  lastUpdated: "2026-11-17T12:00:00Z",
  ...over,
});

/** A fake YouTube for the real writer: `lists` is what each captions.list returns, in order (the last one repeats). */
function realWriter(lists: VideoCaptionTrack[][], log: string[] = []) {
  let n = 0;
  const deps: VideoCaptionsDeps = {
    credentials: async () => ({ credentialRef: { userId: "owner-1" }, credentials: {} as ResolvedCredentials }),
    captionsEnabled: async () => true,
    readVideo: async () => ({ channelId: "UC_wwe", frame: { width: 1920, height: 1080 } }),
    listTracks: async () => lists[Math.min(n++, lists.length - 1)],
    downloadTrack: async () => assert.fail("never an overwrite"),
    checkUnits: async () => ({ decision: "allow" }),
    assertDeviceAvailable: async () => undefined,
    backup: { checkInfrastructureHealth: async () => ({ healthy: true }), captureBackup: async () => ({ path: "/b", capturedAt: "now" }) },
    assertWriteChannel: async () => undefined,
    markAttempt: async () => undefined,
    clearAttempt: async () => undefined,
    insert: async () => (log.push("insert"), { trackId: "NEW" }),
    update: async () => assert.fail("never an overwrite"),
    audit: async () => undefined,
    newOperationId: () => "op",
    sleep: async () => undefined,
  };
  return createCaptionStepWriter({
    files: { resolve: async (_c, p) => ({ path: p, bytes: REAL_VTT.length }), readChunk: async () => REAL_VTT },
    write: (input, actor, attempt) => createVideoCaptionsServices({ ...deps, markAttempt: ({ trackIdsBefore }) => attempt.mark(trackIdsBefore), clearAttempt: () => attempt.clear() }).write(input, actor),
  });
}

test("captionStepOutcome: only a serving track passes; already present + syncing is pending, + failed is a mismatch", () => {
  assert.equal(captionStepOutcome({ alreadyPresent: true, verified: true, pending: false }), "already_present");
  assert.equal(captionStepOutcome({ alreadyPresent: true, verified: false, pending: true }), "pending");
  assert.equal(captionStepOutcome({ alreadyPresent: true, verified: false, pending: false }), "mismatch");
  assert.equal(captionStepOutcome({ alreadyPresent: false, verified: true, pending: false }), "verified");
  assert.equal(captionStepOutcome({ alreadyPresent: false, verified: false, pending: true }), "pending");
  assert.equal(captionStepOutcome({ alreadyPresent: false, verified: false, pending: false }), "mismatch");
});

test("review #1 the app's own track already there but FAILED on YouTube -> mismatch, date withheld with the reason (real writer)", async () => {
  const own = enTrack({ id: "T0", status: "failed", failureReason: "processingFailed" });
  const h = harness(row(REAL_PKG, { captionsTrack: { trackId: "T0", language: "en", name: "", sha256: REAL_CAPTIONS.sha256, at: NOW.toISOString() } }), realWriter([[own]]));
  await h.runAll();
  const steps = h.steps();
  assert.deepEqual([steps.captions, steps.publishAt, h.row().errorCode], ["mismatch", "withheld", "verify_mismatch"]);
  assert.equal(h.order.includes("publishAt"), false);
  assert.ok((steps.notes ?? []).some((n) => /captions/.test(n) && /processingFailed/.test(n)), "the owner sees why");
  assert.equal(checksPassed(steps), false);
});

test("review #1 the app's own track already there but still SYNCING -> read again, never already_present; stays syncing -> withheld", async () => {
  const own = enTrack({ id: "T0", status: "syncing" });
  const h = harness(row(REAL_PKG, { captionsTrack: { trackId: "T0", language: "en", name: "", sha256: REAL_CAPTIONS.sha256, at: NOW.toISOString() } }), realWriter([[own]]));
  await h.runAll();
  const steps = h.steps();
  assert.equal(h.order.filter((o) => o === "captions").length, 4, "the first read and READ_BACK_RETRIES (3) re-reads");
  assert.deepEqual([steps.captions, steps.captionsRereads, steps.publishAt], ["mismatch", 3, "withheld"]);
  assert.ok((steps.notes ?? []).some((n) => /captions/.test(n) && /syncing/.test(n)));
  // ...and once YouTube serves it, the re-read lets the date through.
  const later = harness(row(REAL_PKG, { captionsTrack: { trackId: "T0", language: "en", name: "", sha256: REAL_CAPTIONS.sha256, at: NOW.toISOString() } }), realWriter([[own], [{ ...own, status: "serving" }]]));
  await later.runAll();
  assert.deepEqual([later.steps().captions, later.steps().publishAt], ["already_present", "set"]);
});

test("review #1 a fresh insert whose re-reads end FAILED -> mismatch, date withheld, the reason in the notes (real writer)", async () => {
  const log: string[] = [];
  const syncing = enTrack({ id: "NEW", status: "syncing" });
  const failed = enTrack({ id: "NEW", status: "failed", failureReason: "unknownFormat" });
  // before, read-back, the writer's own re-read (syncing) -> pending; the runner's next pass finds it failed.
  const h = harness(row(REAL_PKG), realWriter([[], [syncing], [syncing], [failed]], log));
  await h.runAll();
  const steps = h.steps();
  assert.deepEqual(log, ["insert"], "one insert in total");
  assert.deepEqual([steps.captions, steps.captionsTrack?.trackId, steps.publishAt, h.row().errorCode], ["mismatch", "NEW", "withheld", "verify_mismatch"]);
  assert.ok((steps.notes ?? []).some((n) => /unknownFormat/.test(n)));
});

test("review #2 an insert that keeps failing after its attempt mark gives up after MAX_RETRIES: captions failed, date withheld", async () => {
  let calls = 0;
  const h = harness(row(PKG), async (args) => {
    calls += 1;
    await args.onAttempt([]);
    throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
  });
  await h.runAll(60);
  // MAX_RETRIES (10) retries after the first attempt, then giveUp -- never a retry every 30 s for ever.
  assert.equal(calls, 11);
  const steps = h.steps();
  assert.deepEqual([h.row().status, steps.captions, steps.publishAt, h.row().errorCode], ["done", "failed", "withheld", "step_failed"]);
  assert.ok((steps.notes ?? []).some((n) => /^captions: .*ETIMEDOUT/.test(n)));
});

test("review #3 the insert never sent (Live writes off after the mark) -> the mark is taken back, the earlier one kept; a pause", async () => {
  const fresh = harness(row(PKG), async (args) => {
    await args.onAttempt(["DE"]);
    await args.onAttemptCleared();
    throw new DomainError({ code: "live_writes_disabled", message: "off" });
  });
  await fresh.runAll(1);
  assert.deepEqual([fresh.row().status, fresh.row().pausedReason, fresh.steps().captionsAttempt], ["paused", "live_writes_off", undefined]);
  // A retry of an attempt whose answer was lost: that earlier mark (its insert may have been sent) survives this run's unsent one.
  const earlier = { at: "2026-11-17T11:00:00.000Z", trackIdsBefore: ["DE"] };
  const retry = harness(row(PKG, { captionsAttempt: earlier }), async (args) => {
    await args.onAttempt(["DE", "FR"]);
    await args.onAttemptCleared();
    throw new DomainError({ code: "live_writes_disabled", message: "off" });
  });
  await retry.runAll(1);
  assert.deepEqual(retry.steps().captionsAttempt, earlier);
});

test("review #5 the record step keeps a caption entry the other computer added meanwhile (the record is rewritten whole)", async () => {
  const theirs = { trackId: "B1", language: "en", name: "Other", sha256: "b".repeat(64), at: "2026-11-17T12:05:00.000Z", by: "owner", verified: true };
  const h = harness(row(PKG), async () => verified, { readRecordCaptions: async (_c, path) => (path === "04 Videos/11 November/1120 V27/V27_youtube.json" ? [theirs] : []) });
  await h.runAll();
  const captions = h.records.at(-1)!.captions as Array<Record<string, unknown>>;
  assert.deepEqual(captions.map((c) => c.trackId).sort(), ["B1", "T1"]);
  assert.deepEqual(captions.find((c) => c.trackId === "B1"), theirs, "kept byte for byte");
  // A package without captions: the other computer's entry still survives.
  const old = { ...PKG };
  delete old.captions;
  const none = harness(row(old), undefined, { readRecordCaptions: async () => [theirs] });
  await none.runAll();
  assert.deepEqual(none.records.at(-1)!.captions, [theirs]);
  // Unreadable record: the upload's own entry only (as before).
  const broken = harness(row(PKG), async () => verified, { readRecordCaptions: async () => Promise.reject(new Error("bad JSON")) });
  await broken.runAll();
  assert.deepEqual((broken.records.at(-1)!.captions as Array<{ trackId: string }>).map((c) => c.trackId), ["T1"]);
});

test("review #5 mergeRecordCaptions: one entry per track id; for the same id the later `at` wins", () => {
  const upload = { trackId: "T1", sha256: "1", at: "2026-11-17T12:00:00Z", by: "upload" };
  const newerOverwrite = { trackId: "T1", sha256: "2", at: "2026-11-17T13:00:00Z", by: "owner" };
  const olderEntry = { trackId: "T1", sha256: "0", at: "2026-11-17T11:00:00Z", by: "producer" };
  assert.deepEqual(mergeRecordCaptions([newerOverwrite], upload), [newerOverwrite]);
  assert.deepEqual(mergeRecordCaptions([olderEntry], upload), [upload]);
  assert.deepEqual(mergeRecordCaptions([null, "x", { name: "no id" }, olderEntry], null), [olderEntry]);
  assert.deepEqual(mergeRecordCaptions([], null), []);
});

test("review #3 a re-mark keeps the earlier mark's time: a lost answer's track listed only later is still adopted, not foreign", async () => {
  // Attempt 1 (11:00) was sent, its answer lost; the retry did not see the track yet and marked again -- the track YouTube made at
  // 11:00:05 must stay adoptable on the next retry (its time is after the FIRST mark, though before the second).
  const earlier = { at: "2026-11-17T11:00:00.000Z", trackIdsBefore: ["DE"] };
  const seen: unknown[] = [];
  let calls = 0;
  const h = harness(row(PKG, { captionsAttempt: earlier }), async (args) => {
    calls += 1;
    seen.push(args.adoptAfterAttempt);
    if (calls === 1) {
      await args.onAttempt(["DE"]);
      throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
    }
    return verified;
  });
  await h.runAll();
  assert.deepEqual(seen, [earlier, { trackIdsBefore: ["DE"], at: earlier.at }]);
});
