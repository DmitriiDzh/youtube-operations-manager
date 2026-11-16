import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { checksPassed } from "./plan-schedule";
import { estimateUploadUnits } from "./publish-dates";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import { createUploadRunner, type ApprovedPackage, type UploadRunnerDeps, type UploadSteps } from "./upload-runner";

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

function harness(start: StoredPublishingUpload, writeCaptions?: UploadRunnerDeps["writeCaptions"]) {
  let current = { ...start };
  const order: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const clock = { at: NOW };
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
      addToPlaylist: async () => void order.push("playlist"),
    },
    reads: {
      uploadState: async () => ({ uploadStatus: "processed", rejectionReason: null, failureReason: null, hasCustomThumbnail: true }),
      recentUploads: async () => [],
      playlistHasVideo: async () => false,
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
  assert.deepEqual(seen, [null, { trackIdsBefore: ["DE"] }]);
  assert.deepEqual([h.steps().captions, h.steps().captionsTrack?.trackId, h.steps().captionsAttempt?.trackIdsBefore], ["verified", "LOST", ["DE"]]);
});

test("pending (YouTube still syncing) is read again later with the track as ours, then decided", async () => {
  const owns: Array<Array<{ trackId: string }>> = [];
  let calls = 0;
  const h = harness(row(PKG), async (args) => {
    owns.push(args.ownTracks);
    calls += 1;
    return calls === 1 ? { outcome: "pending", trackId: "T1", trackName: "", detail: "syncing" } : { outcome: "already_present", trackId: "T1", trackName: "", detail: null };
  });
  await h.runAll();
  assert.deepEqual(owns, [[], [{ trackId: "T1", sha256: CAPTIONS.sha256 }]]);
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
