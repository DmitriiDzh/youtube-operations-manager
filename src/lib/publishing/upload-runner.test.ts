import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { DEFAULT_PUBLISHING_SETTINGS, type PublishingSettings } from "./settings";
import { createUploadRunner, readBackMismatches, type ApprovedPackage, type InsertResource, type UploadRunnerDeps, type VideoReadBack } from "./upload-runner";

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
    device: async () => ({ deviceId: "mac-1", name: "Mac" }),
    clock: { now: () => new Date(clock.at) },
    nextQuotaReset: () => new Date("2026-10-14T07:00:00Z"),
    chunkBytes: 4,
    sliceMs: 60_000,
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
  assert.equal(h.records[0].path, "04 Videos/10 October/1024 V65/V65_youtube.json");
  assert.deepEqual([h.records[0].record.videoId, h.records[0].record.publishAt, h.records[0].record.result], ["vid1", "2026-10-24T12:00:00.000Z", "verified"]);
});

test("AC-UP-02b/c: at least 6 h ahead -> publishAt at insert; nearer -> after processing through video-details; no date -> never", async () => {
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
