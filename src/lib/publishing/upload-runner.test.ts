import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { DEFAULT_PUBLISHING_SETTINGS, type PublishingSettings } from "./settings";
import { classifyUploadError, createUploadRunner, holdsPackage, isCancellable, isPublishAtSet, readBackMismatches, type ApprovedPackage, type InsertResource, type UploadRunnerDeps, type VideoReadBack } from "./upload-runner";

// BL-182 stage 2 -- the upload runner against fakes (no real YouTube call, DEVELOPMENT_PLAYBOOK §6.11). Requirements: the
// acceptance list in upload-runner.acceptance.test.ts (FO-REQ-0023 §4 B5–B7 and §5; ADR 0037; owner msgs 2725/2727; owner msgs
// 3510/3511 = FO-REQ-0040 item 4, the publish time last, which replaces msg 2717's "scheduled at insert") and
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
    // BL-209 (schema v103): every row now carries `automatic`; these jobs are the owner's approvals.
    automatic: false,
    slotId: null,
    ...over,
  };
}

/** A resumable-upload server: it keeps the bytes it got; a scripted fault can lose an answer after the bytes arrived. */
function fakeYoutube() {
  const sessions = new Map<string, { bytes: number; resource: InsertResource; expired: boolean; videoId: string | null }>();
  /** `publishAtAtInsert`: a video from before owner msgs 3510/3511 whose old insert carried the date (the insert type has none now). */
  const videos: Array<{ videoId: string; title: string; resource: InsertResource; publishAtAtInsert?: string }> = [];
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
  /** Every call after the upload that the order requirement is about: thumbnail, playlist item, read, publish-time write. */
  const order: string[] = [];
  let paidPromotionDropped = false;
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
    gateway: {
      ...yt.gateway,
      setThumbnail: async (c, videoId, image) => {
        order.push("thumbnail");
        return yt.gateway.setThumbnail(c, videoId, image);
      },
      addToPlaylist: async (c, videoId, playlistId) => {
        order.push("playlist");
        return yt.gateway.addToPlaylist(c, videoId, playlistId);
      },
    },
    reads: {
      // «Прямая реклама» as YouTube keeps it: what the insert sent, unless a test says YouTube dropped it.
      uploadState: async () => ({
        uploadStatus: processing,
        rejectionReason: processing === "rejected" ? "duplicate" : null,
        failureReason: null,
        hasPaidProductPlacement: paidPromotionDropped ? false : (yt.videos[0]?.resource.paidProductPlacementDetails?.hasPaidProductPlacement ?? null),
      }),
      recentUploads: async () => yt.videos.map((v) => ({ videoId: v.videoId, title: v.title })),
      playlistHasVideo: async () => false,
      snapshot: async ({ videoId }) => {
        order.push("read");
        const video = yt.videos.find((v) => v.videoId === videoId)!;
        return {
          title: video.resource.snippet.title,
          description: video.resource.snippet.description,
          tags: video.resource.snippet.tags ?? [],
          categoryId: video.resource.snippet.categoryId ?? null,
          defaultLanguage: video.resource.snippet.defaultLanguage ?? null,
          defaultAudioLanguage: video.resource.snippet.defaultAudioLanguage ?? null,
          privacyStatus: "private",
          publishAt: video.publishAtAtInsert?.replace(".000Z", "Z") ?? publishAtWrites.at(-1) ?? null,
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
      order.push(`publishAt ${publishAt}`);
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
  return { yt, store, row, runner, deps, clock, records, publishAtWrites, order, runAll, setProcessing: (s: string) => (processing = s), setReadBack: (r: Partial<VideoReadBack>) => (readBack = r), dropPaidPromotion: () => (paidPromotionDropped = true) };
}

test("AC-UP-02d, the whole way: one session, the bytes in order, processing, then thumbnail, playlist, read-back, publish time, record, sync -- done", async () => {
  const h = harness([job()]);
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().errorCode, null);
  assert.equal(h.yt.videos.length, 1);
  assert.deepEqual(h.yt.log, ["begin https://www.googleapis.com/upload/youtube/v3/videos?s=1", "put 0-3", "put 4-7", "put 8-9", "thumbnail vid1", "playlist PL_jazz vid1"]);
  // Owner msgs 3510/3511 (FO-REQ-0040 item 4): insert without a date; thumbnail, playlist, read-back; only then the date, and the
  // date read back on its own. (Before, msg 2717 put a date 6 h or more ahead into the insert -- superseded, so "at_insert" is gone.)
  assert.equal("publishAt" in h.yt.videos[0].resource.status, false, "the insert never carries the date");
  assert.deepEqual(h.order, ["thumbnail", "playlist", "read", "read", "publishAt 2026-10-24T12:00:00.000Z", "read"]);
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([steps.thumbnail, steps.playlist, steps.verify.result, steps.publishAt, steps.record, steps.sync], ["set", "added", "verified", "set", "written", "synced"]);
  // Review B1: the record names the video as soon as YouTube gives its id, then the record step writes it in full.
  assert.deepEqual(h.records.map((r) => r.path), ["04 Videos/10 October/1024 V65/V65_youtube.json", "04 Videos/10 October/1024 V65/V65_youtube.json"]);
  assert.deepEqual([h.records[0].record.videoId, h.records[0].record.result], ["vid1", "uploaded"]);
  assert.deepEqual([h.records[1].record.videoId, h.records[1].record.publishAt, h.records[1].record.result], ["vid1", "2026-10-24T12:00:00.000Z", "verified"]);
  assert.equal(h.records[1].record.uploadedAt, h.records[0].record.uploadedAt, "the upload's own time, not the record step's");
});

test("AC-UP-02b, AC-UP-02c: any date -> never at insert, written last through video-details; no date -> never", async () => {
  // Owner msgs 3510/3511 replace msg 2717: 11 days ahead used to go into the insert; now it is written after the read-back too.
  const far = harness([job()]);
  await far.runAll();
  assert.equal("publishAt" in far.yt.videos[0].resource.status, false);
  assert.deepEqual(far.publishAtWrites, ["2026-10-24T12:00:00.000Z"]);
  assert.equal(JSON.parse(far.row().stepsJson).publishAt, "set");
  // 5 h 59 min ahead: the same (still well over 15 minutes ahead when it is written).
  const near = harness([job({ publishAt: "2026-10-13T17:59:00.000Z" })]);
  await near.runAll();
  assert.equal("publishAt" in near.yt.videos[0].resource.status, false);
  assert.deepEqual(near.publishAtWrites, ["2026-10-13T17:59:00.000Z"]);
  assert.equal(JSON.parse(near.row().stepsJson).publishAt, "set");
  const none = harness([job({ publishAt: null })]);
  await none.runAll();
  assert.equal("publishAt" in none.yt.videos[0].resource.status, false);
  assert.deepEqual(none.publishAtWrites, []);
  assert.equal(none.row().status, "done");
  assert.equal(JSON.parse(none.row().stepsJson).publishAt, undefined);
});

test("AC-UP-02b: a date that comes within 15 minutes before processing ends is not written; the job says so", async () => {
  const h = harness([job({ publishAt: "2026-10-13T12:20:00.000Z" })]);
  h.setProcessing("uploaded");
  await h.runner.tick(); // sent at 12:00: 20 min ahead; processing has not finished
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
  // No publishAt: owner msgs 3510/3511 (the date is written last, never at insert).
  assert.deepEqual(status, { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true, license: "youtube", embeddable: true });
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
  h.yt.videos.push({ videoId: "vid1", title: PKG.title, resource: { snippet: { title: PKG.title, description: PKG.description, tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false, license: "youtube", embeddable: true } }, publishAtAtInsert: "2026-10-24T12:00:00.000Z" });
  const restarted = createUploadRunner({ ...h.deps, reads: { ...h.deps.reads, playlistHasVideo: async () => true } });
  for (let i = 0; i < 6; i += 1) await restarted.tick();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.yt.log, [], "neither the thumbnail nor the playlist item is written again");
  assert.equal(JSON.parse(h.row().stepsJson).playlist, "already_there");
  // A row from before owner msgs 3510/3511 whose date went in with the insert: kept as at_insert, never written again.
  assert.deepEqual(h.publishAtWrites, []);
});

// Owner msgs 3510/3511 (2026-10-25, FO-REQ-0040 item 4): a video is never scheduled before its thumbnail is set and the upload is
// verified. Order: insert private without a date -> thumbnail and playlist -> read-back -> only then the date. A failed step before
// the date leaves the video private and unscheduled, with that step's error on the upload. Expected values by hand from that order.
const VID1_UPLOADED = { videoId: "vid1", title: PKG.title, resource: { snippet: { title: PKG.title, description: PKG.description, tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en" }, status: { privacyStatus: "private" as const, selfDeclaredMadeForKids: false, license: "youtube" as const, embeddable: true } } };

test("AC-UP-02d: a row whose session began before the change with the date in its insert finishes as at_insert -- no second write, the read-back checks the date", async () => {
  const h = harness([job({ status: "finishing", videoId: "vid1", publishAtAtInsert: true, stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString() }) })]);
  h.yt.videos.push({ ...VID1_UPLOADED, publishAtAtInsert: "2026-10-24T12:00:00.000Z" });
  const runner = createUploadRunner(h.deps);
  for (let i = 0; i < 10 && h.row().status !== "done"; i += 1) await runner.tick();
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().status, h.row().errorCode, steps.publishAt, steps.thumbnail, steps.verify.result], ["done", null, "at_insert", "set", "verified"]);
  assert.deepEqual(h.publishAtWrites, []);
  assert.equal(h.records.at(-1)?.record.publishAt, "2026-10-24T12:00:00.000Z");
});

test("AC-UP-02d: a thumbnail YouTube refuses -> no publish time is written; the video stays private without a date and the job says why", async () => {
  const h = harness([job()]);
  h.deps.gateway.setThumbnail = async () => Promise.reject(new DomainError({ code: "update_failed", message: "invalid image", details: { status: 400, reason: "invalidImage" } }));
  const runner = createUploadRunner(h.deps);
  for (let i = 0; i < 20 && h.row().status !== "done"; i += 1) {
    await runner.tick();
    h.clock.at = new Date(h.clock.at.getTime() + 31_000);
  }
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().status, h.row().errorCode, steps.thumbnail, steps.publishAt], ["done", "step_failed", "failed", "withheld"]);
  assert.deepEqual(h.publishAtWrites, [], "never scheduled");
  assert.equal(h.order.some((o) => o.startsWith("publishAt")), false);
  assert.ok(steps.notes.some((n: string) => n.startsWith("thumbnail:")), "the thumbnail's own error is on the upload");
  assert.ok(steps.notes.some((n: string) => n.includes("publish time not set (thumbnail failed)")));
  assert.equal(h.records.at(-1)?.record.publishAt, null, "the record says no date");
});

test("AC-UP-02d: a missing thumbnail file or a failed playlist item -> no publish time is written", async () => {
  const noFile = harness([job()]);
  const resolve = noFile.deps.files.resolve;
  noFile.deps.files.resolve = async (c, rel) => (rel === PKG.thumbnailFile ? null : resolve(c, rel));
  await createUploadRunner(noFile.deps).tick();
  for (let i = 0; i < 20 && noFile.row().status !== "done"; i += 1) {
    noFile.clock.at = new Date(noFile.clock.at.getTime() + 31_000);
    await createUploadRunner(noFile.deps).tick();
  }
  assert.deepEqual([noFile.row().status, JSON.parse(noFile.row().stepsJson).publishAt], ["done", "withheld"]);
  assert.deepEqual(noFile.publishAtWrites, []);

  const playlist = harness([job()]);
  playlist.deps.gateway.addToPlaylist = async () => Promise.reject(new DomainError({ code: "update_failed", message: "forbidden", details: { status: 403, reason: "playlistForbidden" } }));
  const runner = createUploadRunner(playlist.deps);
  for (let i = 0; i < 20 && playlist.row().status !== "done"; i += 1) {
    await runner.tick();
    playlist.clock.at = new Date(playlist.clock.at.getTime() + 31_000);
  }
  const steps = JSON.parse(playlist.row().stepsJson);
  assert.deepEqual([playlist.row().errorCode, steps.thumbnail, steps.playlist, steps.publishAt], ["step_failed", "set", "failed", "withheld"]);
  assert.deepEqual(playlist.publishAtWrites, []);
});

test("AC-UP-02d: a read-back that differs -> no publish time is written; verify_mismatch names the fields", async () => {
  const h = harness([job()]);
  h.setReadBack({ title: "Cuban Jazz at Sunset" });
  await h.runAll();
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().status, h.row().errorCode, steps.verify.mismatches, steps.publishAt], ["done", "verify_mismatch", ["title"], "withheld"]);
  assert.deepEqual(h.publishAtWrites, []);
  // A read-back that cannot be read at all counts the same: nothing is scheduled on an unverified upload.
  const unreadable = harness([job()]);
  unreadable.deps.reads = { ...unreadable.deps.reads, snapshot: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "TimeoutError" })) };
  const runner = createUploadRunner(unreadable.deps);
  for (let i = 0; i < 60 && unreadable.row().status !== "done"; i += 1) {
    await runner.tick();
    unreadable.clock.at = new Date(unreadable.clock.at.getTime() + 11 * 60_000);
  }
  assert.deepEqual([unreadable.row().errorCode, JSON.parse(unreadable.row().stepsJson).publishAt], ["verify_mismatch", "withheld"]);
  assert.deepEqual(unreadable.publishAtWrites, []);
});

test("AC-UP-02d, AC-UP-11: a job resumed after its thumbnail -> no second thumbnail, the date written exactly once, after the read-back", async () => {
  const h = harness([job({ status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set" }) })]);
  h.yt.videos.push(VID1_UPLOADED);
  const restarted = createUploadRunner(h.deps);
  for (let i = 0; i < 10 && h.row().status !== "done"; i += 1) await restarted.tick();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.order, ["playlist", "read", "read", "publishAt 2026-10-24T12:00:00.000Z", "read"]);
  assert.deepEqual(h.publishAtWrites, ["2026-10-24T12:00:00.000Z"]);
  assert.equal(JSON.parse(h.row().stepsJson).publishAt, "set");
});

test("AC-UP-02d: the date write's answer is lost but the date is there -> it is not written again; a date that does not read back fails the step", async () => {
  const lost = harness([job({ status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) })]);
  lost.yt.videos.push(VID1_UPLOADED);
  const write = lost.deps.setPublishAt;
  let lose = true;
  lost.deps.setPublishAt = async (args) => {
    await write(args);
    if (lose) {
      lose = false;
      throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
    }
  };
  const runner = createUploadRunner(lost.deps);
  for (let i = 0; i < 10 && lost.row().status !== "done"; i += 1) {
    await runner.tick();
    lost.clock.at = new Date(lost.clock.at.getTime() + 31_000);
  }
  assert.deepEqual([lost.row().status, lost.row().errorCode, JSON.parse(lost.row().stepsJson).publishAt], ["done", null, "set"]);
  assert.deepEqual(lost.publishAtWrites, ["2026-10-24T12:00:00.000Z"], "written once");

  const ignored = harness([job({ status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) })]);
  ignored.yt.videos.push(VID1_UPLOADED);
  ignored.deps.setPublishAt = async () => undefined; // an answer of success, but YouTube kept no date
  const runner2 = createUploadRunner(ignored.deps);
  for (let i = 0; i < 10 && ignored.row().status !== "done"; i += 1) await runner2.tick();
  assert.deepEqual([ignored.row().errorCode, JSON.parse(ignored.row().stepsJson).publishAt], ["step_failed", "failed"]);
  assert.equal(ignored.records.at(-1)?.record.publishAt, null, "the record never claims a date the read-back did not show");
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
  const none = { errorCode: null };
  assert.equal(holdsPackage({ ...none, status: "queued", videoId: null }), true);
  assert.equal(holdsPackage({ ...none, status: "done", videoId: "v" }), true);
  assert.equal(holdsPackage({ ...none, status: "failed", videoId: "v" }), true);
  assert.equal(holdsPackage({ ...none, status: "failed", videoId: null }), false);
  assert.equal(holdsPackage({ ...none, status: "cancelled", videoId: null }), false);
  // Re-check 1: an unknown outcome (the last chunk went, no answer) holds until the owner releases it after looking in Studio.
  assert.equal(holdsPackage({ status: "failed", videoId: null, errorCode: "unknown_outcome" }), true);
  assert.equal(holdsPackage({ status: "failed", videoId: null, errorCode: "unknown_outcome_released" }), false);
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
  // Only a row whose session began before owner msgs 3510/3511 with the date in the insert (`publishAtAtInsert`, kept for such
  // rows); a pause of Live writes holds the upload until 10 minutes before its date.
  const h = harness([job({ publishAt: "2026-10-13T18:01:00.000Z" })]);
  h.yt.setFaults([undefined as never, undefined as never, "live_writes_off"]);
  await h.runner.tick();
  assert.equal(h.row().status, "paused");
  h.store.set("u1", { ...h.row(), publishAtAtInsert: true });
  h.clock.at = new Date("2026-10-13T17:50:00Z");
  h.yt.setLiveWrites(true);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().errorCode, h.row().videoId], ["failed", "publish_at_passed", null]);
  assert.equal(h.yt.videos.length, 0, "the last chunk never went");
  assert.equal(holdsPackage(h.row()), false, "nothing exists: the owner can approve it again with a new date");
});

test("AC-UP-02d: a new row's date is not in the insert, so the same pause does not stop it; at the date step it is too soon and not written", async () => {
  const h = harness([job({ publishAt: "2026-10-13T18:01:00.000Z" })]);
  h.yt.setFaults([undefined as never, undefined as never, "live_writes_off"]);
  await h.runner.tick();
  assert.equal(h.row().status, "paused");
  h.clock.at = new Date("2026-10-13T17:50:00Z");
  h.yt.setLiveWrites(true);
  await h.runAll();
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().status, h.row().errorCode, steps.thumbnail, steps.publishAt], ["done", "publish_at_too_soon", "set", "skipped_too_soon"]);
  assert.deepEqual(h.publishAtWrites, []);
  assert.equal("publishAt" in h.yt.videos[0].resource.status, false, "private, no date");
});

test("review should-fix 6: a row another runner holds is left alone until its lease ends", async () => {
  const h = harness([job({ leaseOwner: "runner-other", leaseUntil: new Date(NOW.getTime() + 60_000) })]);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.yt.log.length], ["queued", 0]);
  h.clock.at = new Date(NOW.getTime() + 61_000);
  await h.runAll();
  assert.equal(h.row().status, "done");
});

test("re-check 2: network errors with an underscore are asked again, not failed", () => {
  for (const code of ["EAI_AGAIN", "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET"]) {
    assert.equal(classifyUploadError(Object.assign(new Error(code), { code }), NOW, () => NOW).kind, "retry", code);
  }
});

test("re-check 1: after the last chunk, answers that stay unknown keep the job asking its session slowly -- never 'approvable again'", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, undefined as never, "lose_answer"]); // the last answer is lost
  await h.runner.tick();
  const down = { ...h.deps.gateway, queryOffset: async () => Promise.reject(Object.assign(new Error("dns"), { code: "EAI_AGAIN" })) };
  const runner = createUploadRunner({ ...h.deps, gateway: down });
  for (let i = 0; i < 30; i += 1) {
    h.clock.at = new Date(h.clock.at.getTime() + 31 * 60_000);
    await runner.tick();
  }
  assert.equal(h.row().status, "uploading", "15 hours of unknown answers: still asking, not failed");
  assert.equal(holdsPackage(h.row()), true);
  // The session answers again: the video YouTube made is adopted.
  h.clock.at = new Date(h.clock.at.getTime() + 31 * 60_000);
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().videoId], ["processing", "vid1"]);
});

test("re-check 3: processing whose state stays unreadable keeps polling slowly instead of failing the uploaded video", async () => {
  const h = harness([job()]);
  await h.runner.tick(); // uploaded
  const unreadable = { ...h.deps.reads, uploadState: async () => Promise.reject(Object.assign(new Error("timeout"), { code: "TimeoutError" })) };
  const runner = createUploadRunner({ ...h.deps, reads: unreadable });
  for (let i = 0; i < 20; i += 1) {
    h.clock.at = new Date(h.clock.at.getTime() + 6 * 60_000);
    await runner.tick();
  }
  assert.deepEqual([h.row().status, h.row().videoId], ["processing", "vid1"]);
  h.clock.at = new Date(h.clock.at.getTime() + 6 * 60_000);
  await h.runAll();
  assert.equal(h.row().status, "done", "readable again: it finishes");
});

test("after a sending pass the lease is short again: a restarted process takes the upload over within 2 minutes", async () => {
  const h = harness([job()]);
  h.yt.setFaults([undefined as never, undefined as never, "network_before"]); // stops mid-upload
  await h.runner.tick();
  assert.equal(h.row().leaseUntil?.getTime(), NOW.getTime() + 2 * 60_000);
  const restarted = createUploadRunner({ ...h.deps, runnerId: "runner-after-restart" });
  h.clock.at = new Date(NOW.getTime() + 2 * 60_000 + 1);
  await restarted.tick();
  assert.equal(h.row().leaseOwner, "runner-after-restart");
});

// Owner msgs 2751/2753: «Прямая реклама» is sent as the `paidProductPlacementDetails` part at insert. The docs accept the part on
// videos.insert but do not list the property as settable, so the read-back checks it: a value YouTube did not keep is a mismatch.
test("paid promotion: sent at insert as its own part only when on; YouTube keeping it verifies, dropping it is a mismatch; off or older sends none", async () => {
  const on = harness([job({ settingsJson: JSON.stringify({ ...SETTINGS, paidProductPlacement: true }) })]);
  await on.runAll();
  assert.deepEqual(on.yt.videos[0].resource.paidProductPlacementDetails, { hasPaidProductPlacement: true });
  assert.equal(JSON.parse(on.row().stepsJson).verify.result, "verified");

  const dropped = harness([job({ settingsJson: JSON.stringify({ ...SETTINGS, paidProductPlacement: true }) })]);
  dropped.dropPaidPromotion();
  await dropped.runAll();
  assert.deepEqual(JSON.parse(dropped.row().stepsJson).verify, { result: "mismatch", mismatches: ["paidProductPlacement"] });

  const off = harness([job({ settingsJson: JSON.stringify({ ...SETTINGS, paidProductPlacement: false }) })]);
  await off.runAll();
  assert.equal(off.yt.videos[0].resource.paidProductPlacementDetails, undefined, "off: the insert is exactly as before");
  assert.equal(JSON.parse(off.row().stepsJson).verify.result, "verified");

  const { paidProductPlacement: _unused, channelTags: _tags, ...older } = SETTINGS;
  void _unused;
  void _tags;
  const before = harness([job({ settingsJson: JSON.stringify(older) })]);
  await before.runAll();
  assert.equal(before.yt.videos[0].resource.paidProductPlacementDetails, undefined, "an approval from before this setting sends no part");
});

// The first real uploads (2026-10-13, V50-V57, read through the app's own Details read): YouTube returned the package's tags in
// alphabetical order and the description without its final line break. Those are the same values, not a mismatch; a changed tag or
// changed text still is.
test("read-back: YouTube's sorted tags and trimmed trailing line breaks are no mismatch; a different tag or text is", () => {
  const pkg = { ...PKG, tags: ["japanese music", "ambient music", "study music"], description: "Line one\n\nLine two\n" };
  const after: VideoReadBack = {
    title: pkg.title,
    description: "Line one\n\nLine two",
    tags: ["ambient music", "japanese music", "study music"],
    categoryId: "10",
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    privacyStatus: "private",
    publishAt: "2026-10-24T12:00:00Z",
    selfDeclaredMadeForKids: false,
    license: "youtube",
    embeddable: true,
  };
  assert.deepEqual(readBackMismatches(after, pkg, SETTINGS, "2026-10-24T12:00:00.000Z", NOW.getTime()), []);
  assert.deepEqual(readBackMismatches({ ...after, tags: ["ambient music", "japanese music"] }, pkg, SETTINGS, "2026-10-24T12:00:00.000Z", NOW.getTime()), ["tags"]);
  assert.deepEqual(readBackMismatches({ ...after, description: "Line one\nLine two" }, pkg, SETTINGS, "2026-10-24T12:00:00.000Z", NOW.getTime()), ["description"]);
});

// BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3, §4 criteria 6 and 8, ADR 0041): the upload writes Vn_cost.json into the package's
// folder with the record; a cost that cannot be written is a note, never a failed upload.
test("BL-194 criterion 6: the record step writes V65_cost.json into the package folder", async () => {
  const written: unknown[] = [];
  const h = harness([job()], { costFile: async (args) => void written.push(args) });
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(written, [{ channelId: "UC_t", video: "V65", folder: "04 Videos/10 October/1024 V65" }]);
  assert.equal(JSON.parse(h.row().stepsJson).cost, "written");
});

test("BL-194 criterion 8: a cost file that cannot be written leaves the upload done, with a note", async () => {
  const h = harness([job()], {
    costFile: async () => {
      throw new Error("video-costs module failed");
    },
  });
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().errorCode, null, "not a failed step");
  const steps = JSON.parse(h.row().stepsJson);
  assert.equal(steps.cost, "failed");
  assert.ok((steps.notes as string[]).some((n) => n.includes("V65_cost.json not written")));
});

// BL-209 AC-AU-10 (AUTO_PRIVATE_UPLOAD_PLAN.md §2 item 4: "Never public, never scheduled"; owner msg 3333: the playlist step runs as
// for a manual upload): an automatic row is sent private with no publishAt, no publish time is written afterwards, and it is still
// added to the release playlist.
test("AC-AU-10: an automatic row is inserted private without publishAt, never gets a date afterwards, and goes to the playlist", async () => {
  const h = harness([job({ publishAt: null, automatic: true })]);
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.yt.videos[0].resource.status, { privacyStatus: "private", selfDeclaredMadeForKids: false, containsSyntheticMedia: true, license: "youtube", embeddable: true });
  assert.equal("publishAt" in h.yt.videos[0].resource.status, false);
  assert.deepEqual(h.publishAtWrites, []);
  assert.ok(h.yt.log.includes("playlist PL_jazz vid1"));
});

// BL-209 review L5: an automatic row's video is hashed again right before a new session starts -- a mismatch fails the row for good
// with `video_hash_mismatch` before any YouTube call; a resumed session is never hashed again; an approval's row is never hashed.
test("review L5: an automatic row whose video no longer matches its manifest's SHA-256 fails before any YouTube call", async () => {
  const sha = (videoHash: string) => async (path: string) => (path.endsWith(".mp4") ? videoHash : "sha-approved");
  const identityCalls: string[] = [];
  const h = harness([job({ publishAt: null, automatic: true, packageJson: JSON.stringify({ ...PKG, videoSha256: "a".repeat(64) }) })], {
    assertWriteChannel: async () => void identityCalls.push("identity"),
  });
  h.deps.files.sha256 = sha("b".repeat(64));
  await h.runAll();
  assert.deepEqual([h.row().status, h.row().errorCode], ["failed", "video_hash_mismatch"]);
  assert.deepEqual([h.yt.log, identityCalls, h.yt.videos.length], [[], [], 0]);
  await h.runAll();
  assert.deepEqual(h.yt.log, [], "not retried");
});

test("review L5: a matching automatic row uploads; a resumed session is not hashed again; an approval's row is never hashed", async () => {
  const hashed: string[] = [];
  const counting = (videoHash: string) => async (path: string) => {
    if (path.endsWith(".mp4")) hashed.push(path);
    return path.endsWith(".mp4") ? videoHash : "sha-approved";
  };
  const ok = harness([job({ publishAt: null, automatic: true, packageJson: JSON.stringify({ ...PKG, videoSha256: "a".repeat(64) }) })]);
  ok.deps.files.sha256 = counting("a".repeat(64));
  await ok.runAll();
  assert.deepEqual([ok.row().status, hashed.length], ["done", 1]);

  // Resuming: a session holds 4 bytes already; the file now hashes differently -- not looked at, the upload finishes.
  hashed.length = 0;
  const resumed = harness([job({ publishAt: null, automatic: true, status: "uploading", attempts: 1, packageJson: JSON.stringify({ ...PKG, videoSha256: "a".repeat(64) }) })]);
  resumed.deps.files.sha256 = counting("b".repeat(64));
  await resumed.deps.gateway.begin({ accessToken: "t", resource: { snippet: { title: PKG.title, description: "" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } }, contentLength: 10, contentType: "video/*", notifySubscribers: false });
  await resumed.deps.gateway.putChunk({ accessToken: "t", sessionUri: "https://www.googleapis.com/upload/youtube/v3/videos?s=1", chunk: VIDEO_BYTES.subarray(0, 4), start: 0, total: 10, contentType: "video/*" });
  resumed.store.set("u1", { ...resumed.row(), sessionUri: "https://www.googleapis.com/upload/youtube/v3/videos?s=1", storedBytes: 4 });
  await resumed.runAll();
  assert.deepEqual([resumed.row().status, hashed.length], ["done", 0]);

  const manual = harness([job({ publishAt: null })]);
  manual.deps.files.sha256 = counting("b".repeat(64));
  await manual.runAll();
  assert.deepEqual([manual.row().status, hashed.length], ["done", 0]);
});

// Independent review of the FO-REQ-0040 item 4 fix. The date now hangs on the read-back, so (owner msgs 3510/3511) a read-back must
// neither schedule an unverified video nor withhold the date over YouTube's lag. Expected values by hand from that requirement.
test("AC-UP-02d: a read-back that differs only at first (YouTube's lag) is read again 10 s later and verifies; the date is then written", async () => {
  const h = harness([job({ status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) })]);
  h.yt.videos.push(VID1_UPLOADED);
  const read = h.deps.reads.snapshot;
  let reads = 0;
  h.deps.reads.snapshot = async (args) => ({ ...(await read(args)), ...(++reads === 1 ? { description: "" } : {}) });
  const runner = createUploadRunner(h.deps);
  await runner.tick();
  assert.equal(JSON.parse(h.row().stepsJson).verify, undefined, "one differing read decides nothing");
  assert.equal(h.row().nextAttemptAt?.getTime(), NOW.getTime() + 10_000);
  h.clock.at = new Date(NOW.getTime() + 10_000);
  for (let i = 0; i < 6 && h.row().status !== "done"; i += 1) await runner.tick();
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().errorCode, steps.verify.result, steps.publishAt], [null, "verified", "set"]);
  assert.deepEqual(h.publishAtWrites, ["2026-10-24T12:00:00.000Z"]);
});

test("AC-UP-02d: a read-back that keeps differing is read 1 + 3 times (video-details' READ_BACK_RETRIES), then a mismatch and no date", async () => {
  const h = harness([job({ status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) })]);
  h.yt.videos.push(VID1_UPLOADED);
  h.setReadBack({ embeddable: false });
  const runner = createUploadRunner(h.deps);
  for (let i = 0; i < 12 && h.row().status !== "done"; i += 1) {
    await runner.tick();
    h.clock.at = new Date(h.clock.at.getTime() + 10_000);
  }
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().errorCode, steps.verify.mismatches, steps.publishAt], ["verify_mismatch", ["embeddable"], "withheld"]);
  assert.equal(h.order.filter((o) => o === "read").length, 4);
  assert.deepEqual(h.publishAtWrites, []);
});

test("AC-UP-02d: paid promotion read back empty at first, then true, verifies (the same re-read); still empty after the re-reads is a mismatch", async () => {
  const settings = { ...SETTINGS, paidProductPlacement: true };
  const start = () => job({ status: "finishing", videoId: "vid1", settingsJson: JSON.stringify(settings), stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) });
  for (const [emptyReads, expected] of [[1, "verified"], [99, "mismatch"]] as const) {
    const h = harness([start()]);
    h.yt.videos.push(VID1_UPLOADED);
    let reads = 0;
    h.deps.reads.uploadState = async () => ({ uploadStatus: "processed", rejectionReason: null, failureReason: null, hasPaidProductPlacement: ++reads <= emptyReads ? null : true });
    const runner = createUploadRunner(h.deps);
    for (let i = 0; i < 12 && h.row().status !== "done"; i += 1) {
      await runner.tick();
      h.clock.at = new Date(h.clock.at.getTime() + 10_000);
    }
    const steps = JSON.parse(h.row().stepsJson);
    assert.equal(steps.verify.result, expected);
    assert.equal(steps.publishAt, expected === "verified" ? "set" : "withheld");
  }
});

test("read-back: AI use read back as null is not a mismatch (YouTube does not return it); read back different is; a date where none is expected is", () => {
  const after: VideoReadBack = { title: PKG.title, description: PKG.description, tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en", privacyStatus: "private", publishAt: null, selfDeclaredMadeForKids: false, license: "youtube", embeddable: true };
  assert.deepEqual(readBackMismatches({ ...after, containsSyntheticMedia: null }, PKG, SETTINGS, null, NOW.getTime()), []);
  assert.deepEqual(readBackMismatches({ ...after, containsSyntheticMedia: true }, PKG, SETTINGS, null, NOW.getTime()), []);
  assert.deepEqual(readBackMismatches({ ...after, containsSyntheticMedia: false }, PKG, SETTINGS, null, NOW.getTime()), ["containsSyntheticMedia"]);
  // A new row is read back before its date step: a video that already has a date would be scheduled unverified.
  assert.deepEqual(readBackMismatches({ ...after, publishAt: "2026-10-24T12:00:00Z" }, PKG, SETTINGS, null, NOW.getTime()), ["publishAt"]);
});

test("the uploads list shows the date as set only when it is on the video (set, or an old row's insert); planned otherwise", () => {
  const row = (publishAt?: string) => ({ stepsJson: JSON.stringify(publishAt ? { publishAt } : {}) });
  assert.deepEqual(
    [undefined, "set", "at_insert", "withheld", "skipped_too_soon", "failed"].map((value) => isPublishAtSet(row(value))),
    [false, true, true, false, false, false]
  );
});

// YouTube Data API videos resource: `contentDetails.hasCustomThumbnail` "Indicates whether the video uploader has provided a custom
// thumbnail image for the video" (uploader only). After thumbnails.set, false (after the re-reads) is a mismatch and withholds the
// date; not returned (null) leaves the 200 of thumbnails.set as the evidence.
test("AC-UP-02d: a thumbnail YouTube says is not custom after the re-reads -> mismatch 'thumbnail', no date; not returned -> verified", async () => {
  for (const [custom, expected] of [[false, "mismatch"], [null, "verified"], [true, "verified"]] as const) {
    const h = harness([job({ status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) })]);
    h.yt.videos.push(VID1_UPLOADED);
    h.deps.reads.uploadState = async () => ({ uploadStatus: "processed", rejectionReason: null, failureReason: null, hasPaidProductPlacement: null, hasCustomThumbnail: custom });
    const runner = createUploadRunner(h.deps);
    for (let i = 0; i < 12 && h.row().status !== "done"; i += 1) {
      await runner.tick();
      h.clock.at = new Date(h.clock.at.getTime() + 10_000);
    }
    const steps = JSON.parse(h.row().stepsJson);
    assert.deepEqual([steps.verify.result, steps.verify.mismatches, steps.publishAt], [expected, expected === "mismatch" ? ["thumbnail"] : [], expected === "mismatch" ? "withheld" : "set"], String(custom));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// BL-225 stage 3 (WEEKLY_PUBLISHING_PLAN.md AC-WP-30/33/34; FO-REQ-0040 items 2 and 4; ADR 0051 §8; AGENTS.md §F «Upload
// localizations»). Requirements: a v2 package's translations are written onto the video the upload made, first after processing,
// by the shared writer (which reads back); its own AI flag replaces the channel's in the insert and in the date write; the date
// goes on only when the translations, the thumbnail, the playlist and the read-back all passed -- any failure leaves the video
// private without a date.
// ---------------------------------------------------------------------------------------------------------------------------

const PKG_V2: ApprovedPackage = { ...PKG, localizations: { ja: { title: "キューバ", description: "朝" } }, containsSyntheticMedia: false, slotId: "w44-fri" };

function v2Harness(result: { verified: true } | { verified: false; detail: string } | "throw" | "absent") {
  const calls: Array<{ videoId: string; languages: string[]; expected: unknown }> = [];
  const synthetic: boolean[] = [];
  const h = harness([job({ packageJson: JSON.stringify(PKG_V2), slotId: "w44-fri" })], {
    ...(result === "absent"
      ? {}
      : {
          writeLocalizations: async (args) => {
            calls.push({ videoId: args.videoId, languages: Object.keys(args.localizations), expected: args.expected });
            h.order.push("translations");
            if (result === "throw") throw new DomainError({ code: "validation_failed", message: "own language" });
            return result;
          },
        }),
    setPublishAt: async ({ publishAt, containsSyntheticMedia }) => {
      synthetic.push(containsSyntheticMedia);
      h.publishAtWrites.push(publishAt);
      h.order.push(`publishAt ${publishAt}`);
    },
  });
  return { h, calls, synthetic };
}

test("AC-WP-30: translations first after processing, then thumbnail, playlist, read-back, and only then the date; the package's AI flag is sent", async () => {
  const { h, calls, synthetic } = v2Harness({ verified: true });
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().errorCode, null);
  assert.equal(h.yt.videos[0].resource.status.containsSyntheticMedia, false, "the package's own AI flag, not the channel's (true)");
  assert.deepEqual(calls, [{ videoId: "vid1", languages: ["ja"], expected: { tags: ["jazz"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "en" } }]);
  assert.deepEqual(h.order, ["translations", "thumbnail", "playlist", "read", "read", "publishAt 2026-10-24T12:00:00.000Z", "read"]);
  assert.deepEqual(synthetic, [false]);
  assert.equal(JSON.parse(h.row().stepsJson).localizations, "verified");
});

test("AC-WP-33/34: translations that read back differently, fail, or have no writer -> the video stays private without a date", async () => {
  for (const [result, step, code] of [
    [{ verified: false, detail: "text differs: ja" }, "mismatch", "verify_mismatch"],
    ["throw", "failed", "step_failed"],
    ["absent", "failed", "step_failed"],
  ] as const) {
    const { h } = v2Harness(result);
    await h.runAll();
    const steps = JSON.parse(h.row().stepsJson);
    assert.deepEqual([h.row().status, steps.localizations, steps.publishAt, h.row().errorCode], ["done", step, "withheld", code], JSON.stringify(result));
    assert.deepEqual(h.publishAtWrites, [], "no date was written");
  }
});

test("AC-WP-33: a forced thumbnail failure leaves the video private and unscheduled", async () => {
  const { h } = v2Harness({ verified: true });
  h.deps.gateway.setThumbnail = async () => {
    throw new DomainError({ code: "update_failed", message: "bad image", details: { status: 400, reason: "invalidImage" } });
  };
  const runner = createUploadRunner(h.deps);
  for (let i = 0; i < 40 && h.row().status !== "done"; i += 1) {
    await runner.tick();
    h.clock.at = new Date(h.clock.at.getTime() + 31_000);
  }
  const steps = JSON.parse(h.row().stepsJson);
  assert.deepEqual([h.row().status, steps.thumbnail, steps.publishAt, h.row().errorCode], ["done", "failed", "withheld", "step_failed"]);
  assert.deepEqual(h.publishAtWrites, []);
});

// Review #1 (HIGH): the slot's date was frozen when the row was queued; a veto, a revoke or a new time made meanwhile did not reach
// the date step. The runner asks the plan again right before the date (and before a queued row starts): vetoed -> no date (a row
// not started yet is cancelled); not approved now -> an automatic row gets no date (its date came from the approval); approved
// with another time -> that time.
function slotHarness(decision: import("./auto-upload").SlotDecision, over: Partial<StoredPublishingUpload> = {}) {
  const h = harness([job({ automatic: true, slotId: "w44-fri", packageJson: JSON.stringify({ ...PKG, slotId: "w44-fri" }), ...over })], {
    slotDecision: async () => decision,
  });
  return h;
}

test("review #1: a slot vetoed after queueing -- a row not started is cancelled before anything reaches YouTube", async () => {
  const h = slotHarness({ kind: "vetoed" });
  await h.runAll();
  assert.deepEqual([h.row().status, h.row().errorCode], ["cancelled", "slot_vetoed"]);
  assert.deepEqual(h.yt.log, []);
});

test("review #1: a slot vetoed or no longer approved before the date step -> the date is withheld (the video stays private)", async () => {
  for (const decision of [{ kind: "vetoed" }, { kind: "pending" }] as const) {
    const h = slotHarness(decision, { status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) });
    h.yt.videos.push(VID1_UPLOADED);
    const runner = createUploadRunner(h.deps);
    for (let i = 0; i < 10 && h.row().status !== "done"; i += 1) await runner.tick();
    assert.deepEqual([JSON.parse(h.row().stepsJson).publishAt, h.publishAtWrites], ["withheld", []], decision.kind);
  }
});

test("review #1: a slot re-approved with a new time -> the date step writes the new time; an owner's own row keeps its date when pending", async () => {
  const moved = slotHarness({ kind: "approved", publishAt: "2026-10-25T12:00:00.000Z" }, { status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) });
  moved.yt.videos.push(VID1_UPLOADED);
  let runner = createUploadRunner(moved.deps);
  for (let i = 0; i < 10 && moved.row().status !== "done"; i += 1) await runner.tick();
  assert.deepEqual([moved.publishAtWrites, moved.row().publishAt, JSON.parse(moved.row().stepsJson).publishAt], [["2026-10-25T12:00:00.000Z"], "2026-10-25T12:00:00.000Z", "set"]);
  const manual = slotHarness({ kind: "pending" }, { automatic: false, status: "finishing", videoId: "vid1", stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), thumbnail: "set", playlist: "added" }) });
  manual.yt.videos.push(VID1_UPLOADED);
  runner = createUploadRunner(manual.deps);
  for (let i = 0; i < 10 && manual.row().status !== "done"; i += 1) await runner.tick();
  assert.deepEqual(manual.publishAtWrites, ["2026-10-24T12:00:00.000Z"], "the owner approved this date himself");
});

// BL-233 (FO-REQ-0047): the upload's share of the uplink while live streams run. Acceptance: a held upload sends nothing and asks
// YouTube nothing (no read, no hash, no session query); it keeps its session and goes on from the stored byte once released; a
// limited chunk is sized by the limit and paced; without a bandwidth reader the runner works as before; uploads still finish.
function bandwidth(options: { held?: boolean; chunk?: number } = {}) {
  const state = { held: options.held ?? false, asked: 0, paced: [] as number[] };
  return {
    state,
    deps: {
      mayStart: async () => {
        state.asked += 1;
        return !state.held;
      },
      chunkBytes: (n: number) => options.chunk ?? n,
      pace: async (bytes: number) => void state.paced.push(bytes),
    },
  };
}

test("BL-233: a held queued upload starts nothing -- no hash, no identity read, no session -- and starts once released", async () => {
  const bw = bandwidth({ held: true });
  let hashed = 0;
  const h = harness([job()], { bandwidth: bw.deps });
  const sha = h.deps.files.sha256;
  h.deps.files.sha256 = async (p) => ((hashed += 1), sha(p));
  for (let i = 0; i < 5; i += 1) await h.runner.tick();
  assert.deepEqual([h.row().status, h.yt.log, hashed], ["queued", [], 0]);
  bw.state.held = false;
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.yt.videos.length, 1);
});

test("BL-233: a hold between chunks keeps the session; released, the upload resumes from the stored byte and finishes", async () => {
  const bw = bandwidth();
  const h = harness([job()], { bandwidth: bw.deps });
  // Hold right after the first chunk: the gateway's put answers, then the next ask says no.
  const put = h.deps.gateway.putChunk;
  h.deps.gateway.putChunk = async (args) => {
    const answer = await put(args);
    bw.state.held = true;
    return answer;
  };
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().storedBytes], ["uploading", 4]);
  const sessionUri = h.row().sessionUri;
  for (let i = 0; i < 3; i += 1) await h.runner.tick();
  assert.deepEqual(h.yt.log, ["begin https://www.googleapis.com/upload/youtube/v3/videos?s=1", "put 0-3"], "held: nothing asked or sent");
  h.deps.gateway.putChunk = put;
  bw.state.held = false;
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().sessionUri, sessionUri, "the same session");
  assert.deepEqual(h.yt.log.slice(0, 5), ["begin https://www.googleapis.com/upload/youtube/v3/videos?s=1", "put 0-3", "query", "put 4-7", "put 8-9"]);
});

test("BL-233: a limited chunk is sized by the limit and every chunk goes with the pace; the bytes stay in order", async () => {
  const bw = bandwidth({ chunk: 2 });
  const paces: unknown[] = [];
  const h = harness([job()], { bandwidth: bw.deps });
  const put = h.deps.gateway.putChunk;
  h.deps.gateway.putChunk = async (args) => {
    paces.push(args.pace);
    await args.pace?.(args.chunk.length);
    return put(args);
  };
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.yt.log.filter((l) => l.startsWith("put")), ["put 0-1", "put 2-3", "put 4-5", "put 6-7", "put 8-9"]);
  assert.deepEqual(bw.state.paced, [2, 2, 2, 2, 2]);
  assert.ok(paces.every((p) => typeof p === "function"));
});

test("BL-233: without a bandwidth reader the chunks go unpaced at the usual size", async () => {
  const h = harness([job()]);
  const seen: Array<unknown> = [];
  const put = h.deps.gateway.putChunk;
  h.deps.gateway.putChunk = async (args) => (seen.push(args.pace), put(args));
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(seen, [undefined, undefined, undefined]);
});

test("review: a queued row whose slot was vetoed is cancelled even while uploads are held", async () => {
  const bw = bandwidth({ held: true });
  const h = harness([job({ slotId: "slot-1" })], { bandwidth: bw.deps, slotDecision: async () => ({ kind: "vetoed" }) as never });
  await h.runner.tick();
  assert.deepEqual([h.row().status, h.row().errorCode, h.yt.log], ["cancelled", "slot_vetoed", []]);
});
