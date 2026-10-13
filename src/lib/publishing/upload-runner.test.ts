import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { DEFAULT_PUBLISHING_SETTINGS, type PublishingSettings } from "./settings";
import { classifyUploadError, createUploadRunner, holdsPackage, isCancellable, readBackMismatches, type ApprovedPackage, type InsertResource, type UploadRunnerDeps, type VideoReadBack } from "./upload-runner";

// BL-182 stage 2 -- the upload runner against fakes (no real YouTube call, DEVELOPMENT_PLAYBOOK §6.11). Requirements: the
// acceptance list in upload-runner.acceptance.test.ts (FO-REQ-0023 §4 B5–B7 and §5; ADR 0037; owner msgs 2717, 2725/2727) and
// the YouTube resumable-upload protocol: a session holds the bytes it got (308 + Range), `bytes */total` asks where it stands, a
// 404 means the session expired, and the video exists only once the last byte is in. Expected values are worked out by hand.

const NOW = new Date("2026-10-13T12:00:00Z");
const PKG: ApprovedPackage = {
  video: "V65",
  title: "Cuban Jazz at Sunrise",
  description: "00:00 A\n10:00 B\n20:00 C",
  tags: ["jazz"],
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  manifestPath: "04 Videos/10 October/1024 V65/V65_release.json",
  videoFile: "04 Videos/10 October/1024 V65/V65 Tropico Jazz.mp4",
  thumbnailFile: "04 Videos/10 October/1024 V65/Thumbnail_V65_A.jpg",
  sizeBytes: 10,
};
const SETTINGS: PublishingSettings = { ...DEFAULT_PUBLISHING_SETTINGS, playlistId: "PL_jazz" };
const VIDEO_BYTES = Buffer.from("0123456789");

function job(over: Partial<StoredPublishingUpload> = {}): StoredPublishingUpload {
  return {
    id: "u1",
    channelId: "UC_t",
    video: "V65",
    manifestPath: PKG.manifestPath,
    manifestSha256: "sha-approved",
    packageJson: JSON.stringify(PKG),
    settingsJson: JSON.stringify(SETTINGS),
    publishAt: "2026-10-24T12:00:00.000Z",
    approvedBy: "u-owner",
    approvedAt: NOW,
    status: "queued",
    resumeStatus: null,
    pausedReason: null,
    pausedUntil: null,
    sessionUri: null,
    totalBytes: 10,
    storedBytes: 0,
    videoId: null,
    publishAtAtInsert: false,
    stepsJson: "{}",
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    ...over,
  };
}

/** A resumable-upload server: it keeps the bytes it got; a scripted fault can lose an answer after the bytes arrived. */
function fakeYoutube() {
  const sessions = new Map<string, { bytes: number; resource: InsertResource; expired: boolean; videoId: string | null }>();
  const videos: Array<{ videoId: string; title: string; resource: InsertResource }> = [];
  const log: string[] = [];
  let faults: Array<"lose_answer" | "network_before" | "expire" | "live_writes_off" | "quota" | "upload_limit"> = [];
  let liveWrites = true;
  const take = () => faults.shift();
  const gateway: UploadRunnerDeps["gateway"] = {
    async begin(args) {
      if (!liveWrites) throw new DomainError({ code: "live_writes_disabled", message: "off" });
      const fault = take();
      if (fault === "quota") throw new DomainError({ code: "update_failed", message: "quotaExceeded", details: { status: 403, reason: "quotaExceeded" } });
      if (fault === "upload_limit") throw new DomainError({ code: "update_failed", message: "uploadLimitExceeded", details: { status: 400, reason: "uploadLimitExceeded" } });
      const sessionUri = `https://www.googleapis.com/upload/youtube/v3/videos?s=${sessions.size + 1}`;
      sessions.set(sessionUri, { bytes: 0, resource: args.resource, expired: false, videoId: null });
      log.push(`begin ${sessionUri}`);
      return { sessionUri };
    },
    async putChunk(args) {
      if (!liveWrites) throw new DomainError({ code: "live_writes_disabled", message: "off" });
      const session = sessions.get(args.sessionUri)!;
      const fault = take();
      if (fault === "network_before") throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      if (fault === "expire") session.expired = true;
      if (fault === "live_writes_off") {
        liveWrites = false;
        throw new DomainError({ code: "live_writes_disabled", message: "off" });
      }
      if (session.expired) return { expired: true };
      assert.equal(args.start, session.bytes, "a chunk always starts where the session stands");
      session.bytes += args.chunk.length;
      log.push(`put ${args.start}-${args.start + args.chunk.length - 1}`);
      if (session.bytes === args.total && !session.videoId) {
        session.videoId = `vid${videos.length + 1}`;
        videos.push({ videoId: session.videoId, title: session.resource.snippet.title, resource: session.resource });
      }
      if (fault === "lose_answer") throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
      return session.videoId ? { done: true, videoId: session.videoId } : { done: false, storedBytes: session.bytes };
    },
    async queryOffset(args) {
      if (!liveWrites) throw new DomainError({ code: "live_writes_disabled", message: "off" });
      const session = sessions.get(args.sessionUri)!;
      log.push("query");
      if (session.expired) return { expired: true };
      return session.videoId ? { done: true, videoId: session.videoId } : { done: false, storedBytes: session.bytes };
    },
    async setThumbnail(_c, videoId) {
      log.push(`thumbnail ${videoId}`);
    },
    async addToPlaylist(_c, videoId, playlistId) {
      log.push(`playlist ${playlistId} ${videoId}`);
    },
  };
  return {
    gateway,
    sessions,
    videos,
    log,
    setFaults: (next: typeof faults) => (faults = next),
    setLiveWrites: (on: boolean) => (liveWrites = on),
    liveWrites: () => liveWrites,
  };
}

function harness(rows: StoredPublishingUpload[], over: Partial<UploadRunnerDeps> = {}) {
  const yt = fakeYoutube();
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const clock = { at: NOW };
  const records: Array<{ path: string; record: Record<string, unknown> }> = [];
  const publishAtWrites: string[] = [];
  let processing: string = "processed";
  let readBack: Partial<VideoReadBack> = {};
  const deps: UploadRunnerDeps = {
    store: {
      listActive: async () => [...store.values()].filter((r) => ["queued", "uploading", "processing", "finishing", "paused"].includes(r.status)).map((r) => ({ ...r })),
      update: async (id, from, set) => {
        const row = store.get(id);
        if (!row || row.status !== from) return false;
        store.set(id, { ...row, ...set });
        return true;
      },
      claim: async (id, owner, until, at) => {
        const row = store.get(id);
        if (!row || (row.leaseUntil && row.leaseUntil.getTime() > at.getTime() && row.leaseOwner !== owner)) return false;
        store.set(id, { ...row, leaseOwner: owner, leaseUntil: until });
        return true;
      },
    },
    credentials: async (j) => ({ credentialRef: { userId: j.approvedBy }, credentials: { token: "t" } }),
    assertWriteChannel: async () => undefined,
    accessToken: async () => "access",
    liveWritesEnabled: async () => yt.liveWrites(),
    gateway: yt.gateway,
    reads: {
      uploadState: async () => ({ uploadStatus: processing, rejectionReason: processing === "rejected" ? "duplicate" : null, failureReason: null }),
      recentUploads: async () => yt.videos.map((v) => ({ videoId: v.videoId, title: v.title })),
      playlistHasVideo: async () => false,
      snapshot: async ({ videoId }) => {
        const video = yt.videos.find((v) => v.videoId === videoId)!;
        return {
          title: video.resource.snippet.title,
          description: video.resource.snippet.description,
          tags: video.resource.snippet.tags ?? [],
          categoryId: video.resource.snippet.categoryId ?? null,
          defaultLanguage: video.resource.snippet.defaultLanguage ?? null,
          defaultAudioLanguage: video.resource.snippet.defaultAudioLanguage ?? null,
          privacyStatus: "private",
          publishAt: video.resource.status.publishAt?.replace(".000Z", "Z") ?? publishAtWrites.at(-1) ?? null,
          selfDeclaredMadeForKids: video.resource.status.selfDeclaredMadeForKids,
          license: video.resource.status.license ?? null,
          embeddable: video.resource.status.embeddable ?? null,
          ...readBack,
        };
      },
    },
    setPublishAt: async ({ publishAt, containsSyntheticMedia }) => {
      assert.equal(containsSyntheticMedia, true, "the status write sends AI use explicitly");
      publishAtWrites.push(publishAt);
    },
    files: {
      resolve: async (_c, relativePath) => ({ path: `/ws/${relativePath}`, bytes: relativePath.endsWith(".mp4") ? 10 : 100 }),
      readChunk: async (_p, start, length) => VIDEO_BYTES.subarray(start, start + length),
      sha256: async () => "sha-approved",
      writeRecord: async (_c, path, record) => void records.push({ path, record: record as Record<string, unknown> }),
    },
    audit: async () => undefined,
    syncChannel: async () => undefined,
    device: async () => ({ deviceId: "mac-1", hostname: "Mac" }),
    clock: { now: () => new Date(clock.at) },
    nextQuotaReset: () => new Date("2026-10-14T07:00:00Z"),
    chunkBytes: 4,
    sliceMs: 60_000,
    runnerId: "runner-1",
    ...over,
  };
  const runner = createUploadRunner(deps);
  const row = (id = "u1") => store.get(id)!;
  /** Ticks until nothing changes or `limit` passes, moving the clock past any wait. */
  async function runAll(limit = 30) {
    for (let i = 0; i < limit; i += 1) {
      await runner.tick();
      clock.at = new Date(clock.at.getTime() + 31_000);
      if ([...store.values()].every((r) => !["queued", "uploading", "processing", "finishing"].includes(r.status))) return;
    }
  }
  return { yt, store, row, runner, deps, clock, records, publishAtWrites, runAll, setProcessing: (s: string) => (processing = s), setReadBack: (r: Partial<VideoReadBack>) => (readBack = r) };
}

test("the whole way: one session, the bytes in order, processing, then thumbnail, playlist, read-back, record, sync -- done", async () => {
  const h = harness([job()]);
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().errorCode, null);
  assert.equal(h.yt.videos.length, 1);
  assert.deepEqual(h.yt.log, ["begin https://www.googleapis.com/upload/youtube/v3/videos?s=1", "put 0-3", "put 4-7", "put 8-9", "thumbnail vid1", "playlist PL_jazz vid1"]);
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([steps.publishAt, steps.thumbnail, steps.playlist, steps.verify.result, steps.record, steps.sync], ["at_insert", "set", "added", "verified", "written", "synced"]);
  // Review B1: the record names the video as soon as YouTube gives its id, then the record step writes it in full.
  assert.deepEqual(h.records.map((r) => r.path), ["04 Videos/10 October/1024 V65/V65_youtube.json", "04 Videos/10 October/1024 V65/V65_youtube.json"]);
  assert.deepEqual([h.records[0].record.videoId, h.records[0].record.result], ["vid1", "uploaded"]);
  assert.deepEqual([h.records[1].record.videoId, h.records[1].record.publishAt, h.records[1].record.result], ["vid1", "2026-10-24T12:00:00.000Z", "verified"]);
  assert.equal(h.records[1].record.uploadedAt, h.records[0].record.uploadedAt, "the upload's own time, not the record step's");
});

test("AC-UP-02b, AC-UP-02c: at least 6 h ahead -> publishAt at insert; nearer -> after processing through video-details; no date -> never", async () => {
  const far = harness([job()]);
  await far.runAll();
  assert.equal(far.yt.videos[0].resource.status.publishAt, "2026-10-24T12:00:00.000Z");
  assert.deepEqual(far.publishAtWrites, []);
  // 5 h 59 min ahead: not at insert; set after processing (still well over 15 minutes ahead then).
  const near = harness([job({ publishAt: "2026-10-13T17:59:00.000Z" })]);
  await near.runAll();
  assert.equal(near.yt.videos[0].resource.status.publishAt, undefined);
  assert.deepEqual(near.publishAtWrites, ["2026-10-13T17:59:00.000Z"]);
  assert.equal(JSON.parse(near.row().stepsJson).publishAt, "set");
  const none = harness([job({ publishAt: null })]);
  await none.runAll();
  assert.equal(none.yt.videos[0].resource.status.publishAt, undefined);
  assert.deepEqual(none.publishAtWrites, []);
  assert.equal(none.row().status, "done");
  assert.equal(JSON.parse(none.row().stepsJson).publishAt, undefined);
});

test("AC-UP-02b: a date that comes within 15 minutes before processing ends is not written; the job says so", async () => {
  const h = harness([job({ publishAt: "2026-10-13T12:20:00.000Z" })]);
  h.setProcessing("uploaded");
  await h.runner.tick(); // sent at 12:00: 20 min ahead, so not at insert; processing has not finished
  h.clock.at = new Date("2026-10-13T12:06:00Z"); // processing ends with 14 minutes left
  h.setProcessing("processed");
  await h.runAll();
  assert.deepEqual(h.publishAtWrites, []);
  assert.equal(JSON.parse(h.row().stepsJson).publishAt, "skipped_too_soon");
  assert.equal(h.row().errorCode, "publish_at_too_soon");
});

test("the insert carries the package and the channel defaults: private, AI use, made for kids, license, embedding, category, languages", async () => {
  const h = harness([job()]);
  await h.runAll();
  const { snippet, status } = h.yt.videos[0].resource;
  assert.deepEqual(snippet, { title: PKG.title, description: PKG.description, tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en" });
  assert.deepEqual(status, { privacyStatus: "private", publishAt: "2026-10-24T12:00:00.000Z", selfDeclaredMadeForKids: false, containsSyntheticMedia: true, license: "youtube", embeddable: true });
});

test("AC-UP-05: a cut connection mid-upload resumes from what the session holds -- same session, no byte twice, one video", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, "network_before"]); // [begin, 0-3, 4-7]
  await h.runner.tick(); // begin, 0-3, then the second chunk fails before it is sent
  assert.equal(h.row().status, "uploading");
  assert.equal(h.row().storedBytes, 4);
  h.clock.at = new Date(h.clock.at.getTime() + 60_000);
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.yt.log.filter((l) => l.startsWith("begin") || l.startsWith("put") || l === "query"), [
    "begin https://www.googleapis.com/upload/youtube/v3/videos?s=1",
    "put 0-3",
    "query",
    "put 4-7",
    "put 8-9",
  ]);
  assert.equal(h.yt.videos.length, 1);
});

test("AC-UP-07: the last chunk's answer is lost -- the session says done, the video is adopted, never a second begin", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, undefined as never, "lose_answer"]); // [begin, 0-3, 4-7, 8-9]
  await h.runner.tick();
  assert.equal(h.row().status, "uploading", "the outcome is unknown after the lost answer");
  assert.equal(h.yt.videos.length, 1, "YouTube did make the video");
  h.clock.at = new Date(h.clock.at.getTime() + 60_000);
  await h.runner.tick();
  assert.equal(h.row().videoId, "vid1");
  assert.equal(h.row().status, "processing");
  assert.equal(h.yt.log.filter((l) => l.startsWith("begin")).length, 1);
  assert.equal(h.yt.videos.length, 1);
});

test("AC-UP-06: an expired session -- a video with the title among the newest uploads is adopted; none -> a new session from 0", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, undefined as never, "lose_answer"]);
  await h.runner.tick(); // the video exists, the answer was lost
  [...h.yt.sessions.values()][0].expired = true; // and the session expired before the next attempt
  h.clock.at = new Date(h.clock.at.getTime() + 60_000);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().videoId], ["processing", "vid1"], "found by title and adopted");
  assert.equal(h.yt.log.filter((l) => l.startsWith("begin")).length, 1);

  const fresh = harness([job()]);
  fresh.yt.setFaults([undefined as never, undefined as never, "expire"]); // [begin, 0-3, 4-7]
  await fresh.runner.tick(); // 0-3 stored, then the session expires
  assert.deepEqual([fresh.row().status, fresh.row().sessionUri, fresh.row().storedBytes], ["uploading", null, 0], "nothing with the title: start again");
  fresh.clock.at = new Date(fresh.clock.at.getTime() + 60_000);
  await fresh.runAll();
  assert.equal(fresh.row().status, "done");
  assert.equal(fresh.yt.log.filter((l) => l.startsWith("begin")).length, 2);
  assert.equal(fresh.yt.videos.length, 1, "the expired session never made a video");
});

test("AC-UP-04: Live writes off between chunks pauses the job; on again it continues from the stored bytes", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, "live_writes_off"]); // [begin, 0-3, 4-7]
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().pausedReason, h.row().resumeStatus, h.row().storedBytes], ["paused", "live_writes_off", "uploading", 4]);
  await h.runner.tick();
  assert.equal(h.row().status, "paused", "still off: still paused, not failed");
  h.yt.setLiveWrites(true);
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.yt.videos.length, 1);
  assert.equal(h.yt.log.filter((l) => l.startsWith("begin")).length, 1);
});

test("AC-UP-08: quotaExceeded pauses until the quota day resets, uploadLimitExceeded for 24 h; the channel's other uploads wait too", async () => {
  const h = harness([job(), job({ id: "u2", video: "V66", createdAt: new Date(NOW.getTime() + 1) })]);
  h.yt.setFaults(["quota"]);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().pausedReason, h.row().pausedUntil?.toISOString()], ["paused", "quota_exceeded", "2026-10-14T07:00:00.000Z"]);
  await h.runner.tick();
  assert.equal(h.row("u2").status, "queued", "not sent into the same refusal");
  assert.equal(h.yt.log.length, 0);

  const capped = harness([job()]);
  capped.yt.setFaults(["upload_limit"]);
  await capped.runner.tick();
  assert.deepEqual([capped.row().pausedReason, capped.row().pausedUntil?.toISOString()], ["upload_limit", "2026-10-14T12:00:00.000Z"]);
  capped.clock.at = new Date("2026-10-14T12:00:01Z");
  await capped.runAll();
  assert.equal(capped.row().status, "done", "after 24 h it continues by itself");
});

test("AC-UP-09: processing rejected stops the job with the reason, no retry", async () => {
  const h = harness([job()]);
  h.setProcessing("rejected");
  await h.runAll();
  assert.deepEqual([h.row().status, h.row().errorCode], ["failed", "processing_rejected"]);
  assert.match(h.row().errorMessage ?? "", /duplicate/);
  assert.equal(h.yt.log.filter((l) => l.startsWith("thumbnail")).length, 0);
});

test("AC-UP-03 and approval binding: a wrong channel or a package changed on disk fails before any upload call", async () => {
  const wrong = harness([job()], {
    assertWriteChannel: async () => {
      throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "The token belongs to another channel" });
    },
  });
  await wrong.runner.tick();
  assert.deepEqual([wrong.row().status, wrong.row().errorCode], ["failed", "WRITE_CHANNEL_MISMATCH"]);
  assert.equal(wrong.yt.log.length, 0);
  const changed = harness([job()]);
  changed.deps.files.sha256 = async () => "sha-edited";
  const runner = createUploadRunner(changed.deps);
  await runner.tick();
  assert.deepEqual([changed.row().status, changed.row().errorCode], ["failed", "package_changed"]);
  assert.equal(changed.yt.log.length, 0);
});

test("AC-UP-11: a restart in the middle of the steps continues at the step -- no second thumbnail, no second playlist item", async () => {
  const h = harness([job({ status: "finishing", videoId: "vid1", publishAtAtInsert: true, stepsJson: JSON.stringify({ publishAt: "at_insert", thumbnail: "set" }) })]);
  h.yt.videos.push({ videoId: "vid1", title: PKG.title, resource: { snippet: { title: PKG.title, description: PKG.description, tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en" }, status: { privacyStatus: "private", publishAt: "2026-10-24T12:00:00.000Z", selfDeclaredMadeForKids: false, license: "youtube", embeddable: true } } });
  const restarted = createUploadRunner({ ...h.deps, reads: { ...h.deps.reads, playlistHasVideo: async () => true } });
  for (let i = 0; i < 6; i += 1) await restarted.tick();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.yt.log, [], "neither the thumbnail nor the playlist item is written again");
  assert.equal(JSON.parse(h.row().stepsJson).playlist, "already_there");
});

test("AC-UP-10: a read-back that differs ends the job with verify_mismatch and names the fields", async () => {
  const h = harness([job()]);
  h.setReadBack({ description: "edited in Studio", license: "creativeCommon" });
  await h.runAll();
  assert.deepEqual([h.row().status, h.row().errorCode], ["done", "verify_mismatch"]);
  assert.deepEqual(JSON.parse(h.row().stepsJson).verify.mismatches, ["description", "license"]);
});

test("read-back rules: the same instant in another format matches; a published video is public after its time", () => {
  const after: VideoReadBack = { title: PKG.title, description: PKG.description, tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en", privacyStatus: "private", publishAt: "2026-10-24T12:00:00Z", selfDeclaredMadeForKids: false, license: "youtube", embeddable: true };
  assert.deepEqual(readBackMismatches(after, PKG, SETTINGS, "2026-10-24T12:00:00.000Z", NOW.getTime()), []);
  assert.deepEqual(readBackMismatches({ ...after, privacyStatus: "public" }, PKG, SETTINGS, "2026-10-13T11:00:00.000Z", NOW.getTime()), [], "its time has passed");
  assert.deepEqual(readBackMismatches({ ...after, privacyStatus: "public" }, PKG, SETTINGS, "2026-10-24T12:00:00.000Z", NOW.getTime()), ["privacyStatus"]);
  assert.deepEqual(readBackMismatches({ ...after, publishAt: "2026-10-24T13:00:00Z" }, PKG, SETTINGS, "2026-10-24T12:00:00.000Z", NOW.getTime()), ["publishAt"]);
});

test("AC-UP-13: busy while an upload is sent or finished, not while it only waits in the queue", async () => {
  const h = harness([job()]);
  assert.equal(await h.runner.isBusy(), false);
  h.yt.setFaults([undefined as never, undefined as never, "network_before"]);
  await h.runner.tick();
  assert.equal(await h.runner.isBusy(), true);
});

test("cancel only before YouTube: queued, or paused while sending with bytes left; never once every byte is sent", () => {
  const base = { videoId: null, storedBytes: 4, totalBytes: 10, resumeStatus: null, stepsJson: "{}" };
  assert.equal(isCancellable({ ...base, status: "queued" }), true);
  assert.equal(isCancellable({ ...base, status: "paused", resumeStatus: "uploading" }), true);
  assert.equal(isCancellable({ ...base, status: "paused", resumeStatus: "uploading", storedBytes: 10 }), false, "the last byte is in: the video may exist");
  assert.equal(isCancellable({ ...base, status: "paused", resumeStatus: "processing", videoId: "v" }), false);
  assert.equal(isCancellable({ ...base, status: "uploading" }), false, "sending right now: pause it first (Live writes off)");
  assert.equal(isCancellable({ ...base, status: "done", videoId: "v" }), false);
});

test("AC-UP-06: the last chunk was sent, its answer lost, the session expired and the new video is not listed yet -- the job stops as unknown_outcome, never a second upload", async () => {
  const h = harness([job()]);
  // The uploads list lags: the new video is not in it yet.
  h.deps.reads = { ...h.deps.reads, recentUploads: async () => [] };
  const runner = createUploadRunner(h.deps);
  h.yt.setFaults([undefined as never, undefined as never, undefined as never, "lose_answer"]); // [begin, 0-3, 4-7, 8-9]
  await runner.tick();
  [...h.yt.sessions.values()][0].expired = true;
  h.clock.at = new Date(h.clock.at.getTime() + 60_000);
  await runner.tick();
  assert.deepEqual([h.row().status, h.row().errorCode], ["failed", "unknown_outcome"]);
  assert.equal(h.yt.log.filter((l) => l.startsWith("begin")).length, 1, "no second session");
  assert.equal(h.yt.videos.length, 1);
});

// Review B3: what an error means, in the shapes the real clients throw. Sources: Google's Data API errors (403 quotaExceeded /
// dailyLimitExceeded, 400 uploadLimitExceeded, 429 rateLimitExceeded, 5xx backendError), gaxios 7 (`response.status`,
// `response.data.error.errors[].reason`), the read gateway's wrapped client (`youtube_quota_exceeded` with `details.reasons`), Node's
// network errors (ECONNRESET, TimeoutError, AbortError), video-details' wrapped failures (update_failed without a status).
test("error shapes: quota and the upload cap pause, an unknown answer is asked again, a refusal fails", () => {
  const reset = () => new Date("2026-10-14T07:00:00Z");
  const kind = (error: unknown) => {
    const outcome = classifyUploadError(error, NOW, reset);
    return outcome.kind === "pause" ? `pause:${outcome.reason}` : outcome.kind === "fail" ? `fail:${outcome.code}` : "retry";
  };
  const gaxios = (status: number, reason: string) => Object.assign(new Error(reason), { response: { status, data: { error: { errors: [{ reason }] } } } });
  assert.equal(kind(gaxios(403, "quotaExceeded")), "pause:quota_exceeded");
  assert.equal(kind(new DomainError({ code: "youtube_quota_exceeded", message: "q", details: { reasons: ["quotaExceeded"] } })), "pause:quota_exceeded");
  assert.equal(kind(gaxios(400, "uploadLimitExceeded")), "pause:upload_limit");
  assert.equal(kind(gaxios(429, "rateLimitExceeded")), "retry");
  assert.equal(kind(gaxios(503, "backendError")), "retry");
  assert.equal(kind(Object.assign(new Error("timeout"), { code: "TimeoutError" })), "retry");
  assert.equal(kind(Object.assign(new Error("aborted"), { name: "AbortError" })), "retry");
  assert.equal(kind(Object.assign(new Error("reset"), { code: "ECONNRESET" })), "retry");
  assert.equal(kind(new DomainError({ code: "update_failed", message: "video-details lost the answer" })), "retry");
  assert.equal(kind(new DomainError({ code: "live_writes_disabled", message: "off" })), "pause:live_writes_off");
  assert.equal(kind(gaxios(400, "invalidTitle")), "fail:invalidTitle");
  assert.equal(kind(new DomainError({ code: "validation_failed", message: "bad" })), "fail:validation_failed");
  assert.equal(kind(new DomainError({ code: "update_failed", message: "refused", details: { status: 403, reason: "forbidden" } })), "fail:forbidden");
});

test("AC-UP-08: quota at the thumbnail step pauses the job until the quota day resets; the thumbnail is set afterwards", async () => {
  const h = harness([job()]);
  let quotaLeft = false;
  const setThumbnail = h.deps.gateway.setThumbnail;
  h.deps.gateway.setThumbnail = async (c, v, i) => {
    if (!quotaLeft) throw new DomainError({ code: "youtube_quota_exceeded", message: "q", details: { reasons: ["quotaExceeded"] } });
    return setThumbnail(c, v, i);
  };
  const runner = createUploadRunner(h.deps);
  for (let i = 0; i < 6 && h.row().status !== "paused"; i += 1) {
    await runner.tick();
    h.clock.at = new Date(h.clock.at.getTime() + 31_000);
  }
  assert.deepEqual([h.row().status, h.row().pausedReason, h.row().resumeStatus], ["paused", "quota_exceeded", "finishing"]);
  assert.equal(JSON.parse(h.row().stepsJson).thumbnail, undefined, "not marked failed");
  quotaLeft = true;
  h.clock.at = new Date("2026-10-14T07:00:01Z");
  for (let i = 0; i < 10 && h.row().status !== "done"; i += 1) {
    await runner.tick();
    h.clock.at = new Date(h.clock.at.getTime() + 31_000);
  }
  assert.deepEqual([h.row().status, JSON.parse(h.row().stepsJson).thumbnail], ["done", "set"]);
});

test("a step whose answers stay unknown gives up after the retries: the step is noted failed, the job still finishes", async () => {
  const h = harness([job()]);
  h.deps.reads = { ...h.deps.reads, playlistHasVideo: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "TimeoutError" })) };
  const runner = createUploadRunner(h.deps);
  for (let i = 0; i < 60 && h.row().status !== "done"; i += 1) {
    await runner.tick();
    h.clock.at = new Date(h.clock.at.getTime() + 11 * 60_000);
  }
  assert.deepEqual([h.row().status, h.row().errorCode, JSON.parse(h.row().stepsJson).playlist], ["done", "step_failed", "failed"]);
});

test("AC-UP-09: a video YouTube stops returning for 30 minutes after its upload ends the wait as video_missing; the package stays taken", async () => {
  const h = harness([job()], {});
  h.deps.reads = { ...h.deps.reads, uploadState: async () => null };
  const runner = createUploadRunner(h.deps);
  await runner.tick(); // uploaded
  for (let i = 0; i < 10 && h.row().status === "processing"; i += 1) {
    h.clock.at = new Date(h.clock.at.getTime() + 6 * 60_000);
    await runner.tick();
  }
  assert.deepEqual([h.row().status, h.row().errorCode, h.row().videoId], ["failed", "video_missing", "vid1"]);
  assert.equal(holdsPackage(h.row()), true, "its video existed: approving the package again stays refused");
});

test("review B1: which rows hold their package -- under way, done, or ended with a video; not one cancelled or failed before YouTube", () => {
  assert.equal(holdsPackage({ status: "queued", videoId: null }), true);
  assert.equal(holdsPackage({ status: "done", videoId: "v" }), true);
  assert.equal(holdsPackage({ status: "failed", videoId: "v" }), true);
  assert.equal(holdsPackage({ status: "failed", videoId: null }), false);
  assert.equal(holdsPackage({ status: "cancelled", videoId: null }), false);
});

test("review B2: once the last chunk went, the upload cannot be cancelled even when paused short of its stored bytes", () => {
  const paused = { status: "paused" as const, resumeStatus: "uploading", videoId: null, storedBytes: 8, totalBytes: 10 };
  assert.equal(isCancellable({ ...paused, stepsJson: "{}" }), true);
  assert.equal(isCancellable({ ...paused, stepsJson: JSON.stringify({ finalChunkSentAt: "2026-10-13T12:00:00Z" }) }), false);
});

test("review B2: resuming asks the session first -- a moved video file does not fail an upload YouTube already finished", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, undefined as never, "lose_answer"]); // the final answer is lost
  await h.runner.tick();
  h.deps.files.resolve = async (_c, rel) => (rel.endsWith(".mp4") ? null : { path: `/ws/${rel}`, bytes: 100 }); // the folder moved
  const runner = createUploadRunner(h.deps);
  h.clock.at = new Date(h.clock.at.getTime() + 60_000);
  await runner.tick();
  assert.deepEqual([h.row().status, h.row().videoId], ["processing", "vid1"]);
});

test("review should-fix 2: a publish time set at insert that comes within 15 minutes before the last chunk stops the upload, nothing is made", async () => {
  // 6 h 1 min ahead: set at insert; then a pause of Live writes holds the upload for 6 hours.
  const h = harness([job({ publishAt: "2026-10-13T18:01:00.000Z" })]);
  h.yt.setFaults([undefined as never, undefined as never, "live_writes_off"]);
  await h.runner.tick();
  assert.equal(h.row().status, "paused");
  h.clock.at = new Date("2026-10-13T17:50:00Z");
  h.yt.setLiveWrites(true);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().errorCode, h.row().videoId], ["failed", "publish_at_passed", null]);
  assert.equal(h.yt.videos.length, 0, "the last chunk never went");
  assert.equal(holdsPackage(h.row()), false, "nothing exists: the owner can approve it again with a new date");
});

test("review should-fix 6: a row another runner holds is left alone until its lease ends", async () => {
  const h = harness([job({ leaseOwner: "runner-other", leaseUntil: new Date(NOW.getTime() + 60_000) })]);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.yt.log.length], ["queued", 0]);
  h.clock.at = new Date(NOW.getTime() + 61_000);
  await h.runAll();
  assert.equal(h.row().status, "done");
});
