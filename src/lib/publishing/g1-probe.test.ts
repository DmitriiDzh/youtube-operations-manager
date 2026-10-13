import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { G1ProbeRecord, VideoUploadStateView } from "./contracts";
import { createG1Probe, G1_CHUNK_BYTES, type G1ProbeDependencies } from "./g1-probe";

// BL-182 stage 0 (ADR 0037 §7; PUBLISHING_PLAN.md §2 stage 0; owner msg 2702). Requirements:
// - before any byte goes out: the recovery gate, the channel identity check and the metadata limits (title ≤ 100 characters, no
//   < >; description ≤ 5000 bytes; private, no publish date) -- a failure sends nothing;
// - the file goes up in chunks until YouTube answers with the video; the probe runs once (persisted);
// - the read-back is polled until processing ends and reported, with defaultAudioLanguage sent vs read back;
// - only the probe's own video can be deleted, once; the deletion is verified and audited.

const CH = "UC-JAPAN";
const REF = { userId: "u-japan" };
const RESOURCE = {
  snippet: { title: "TEST upload check FO-REQ-0023 (private, will be deleted)", description: "Internal API upload test. Will be deleted.", defaultLanguage: "en", defaultAudioLanguage: "en" },
  status: { privacyStatus: "private" as const, selfDeclaredMadeForKids: false, containsSyntheticMedia: true },
};
const STATE = (over: Partial<VideoUploadStateView>): VideoUploadStateView => ({
  title: RESOURCE.snippet.title,
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  privacyStatus: "private",
  publishAt: null,
  uploadStatus: "uploaded",
  failureReason: null,
  rejectionReason: null,
  selfDeclaredMadeForKids: false,
  containsSyntheticMedia: true,
  processingStatus: "processing",
  ...over,
});

function setup(opts: { bytes?: number; identityFails?: boolean; recovery?: boolean; record?: G1ProbeRecord; states?: Array<VideoUploadStateView | null>; deletedState?: VideoUploadStateView | null } = {}) {
  const bytes = opts.bytes ?? 3_832_961;
  const log: string[] = [];
  let record: G1ProbeRecord | null = opts.record ?? null;
  let now = new Date("2026-10-13T12:00:00Z").getTime();
  const states = [...(opts.states ?? [STATE({ uploadStatus: "processed", processingStatus: "succeeded" })])];
  const audits: unknown[] = [];
  let deleted = false;
  const deps: G1ProbeDependencies = {
    async assertDeviceAvailable() {
      log.push("gate");
      if (opts.recovery) throw new DomainError({ code: "validation_failed", message: "recovery mode" });
    },
    async resolveWriteCredentials() {
      log.push("credentials");
      return { credentialRef: REF, accessToken: "tok", refreshToken: "r", scopeSet: new Set<string>() };
    },
    async assertWriteChannel({ expectedChannelId }) {
      log.push(`identity:${expectedChannelId}`);
      if (opts.identityFails) throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "mismatch" });
    },
    async resolveFile() {
      log.push("file");
      return { path: "/ws/clip.mp4", bytes };
    },
    async readChunk(_path, start, length) {
      return Buffer.alloc(length, start % 251);
    },
    async accessTokenOf() {
      return "fresh-token";
    },
    gateway: {
      async begin(args) {
        log.push(`begin:${args.contentLength}:${args.notifySubscribers}`);
        return { sessionUri: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=1" };
      },
      async putChunk(args) {
        log.push(`chunk:${args.start}+${args.chunk.length}`);
        const end = args.start + args.chunk.length;
        return end >= args.total ? { done: true, videoId: "vidG1" } : { done: false, storedBytes: end };
      },
      async deleteVideo(_credentials, videoId) {
        log.push(`delete:${videoId}`);
        deleted = true;
      },
    },
    async readState() {
      if (deleted) return opts.deletedState === undefined ? null : opts.deletedState;
      return states.length > 1 ? (states.shift() ?? null) : (states[0] ?? null);
    },
    record: {
      async get() {
        return record;
      },
      async save(next) {
        record = next;
      },
    },
    async audit(event) {
      audits.push(event);
    },
    async removeLocalVideoRow() {
      return true;
    },
    clock: { now: () => new Date(now) },
    async sleep(ms) {
      now += ms;
    },
  };
  return { probe: createG1Probe(deps), log, audits, getRecord: () => record };
}

test("upload: gate, identity and file come first; the file goes up in 8 MB chunks; the result is recorded and audited", async () => {
  const bytes = 2 * G1_CHUNK_BYTES + 1000;
  const { probe, log, audits, getRecord } = setup({ bytes });
  const report = await probe.upload({ credentialRef: REF, channelId: CH, relativePath: "99 Data Exchange/Sent to YTM/FO-REQ-0023/test_clip_25s.mp4", resource: RESOURCE });
  assert.deepEqual(log, [
    "gate",
    "credentials",
    `identity:${CH}`,
    "file",
    `begin:${bytes}:false`,
    `chunk:0+${G1_CHUNK_BYTES}`,
    `chunk:${G1_CHUNK_BYTES}+${G1_CHUNK_BYTES}`,
    `chunk:${2 * G1_CHUNK_BYTES}+1000`,
  ]);
  assert.equal(report.videoId, "vidG1");
  assert.deepEqual(report.defaultAudioLanguage, { sent: "en", readBack: "en" });
  assert.equal(getRecord()?.videoId, "vidG1");
  assert.equal(audits.length, 2, "the upload and the read-back are audited");
});

test("upload: an identity mismatch, recovery mode or bad metadata sends nothing", async () => {
  for (const opts of [{ identityFails: true }, { recovery: true }]) {
    const { probe, log } = setup(opts);
    await assert.rejects(probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: RESOURCE }));
    assert.ok(!log.some((entry) => entry.startsWith("begin") || entry.startsWith("chunk")), JSON.stringify(opts));
  }
  const badTitles = ["", "x".repeat(101), "a <b> c"];
  for (const title of badTitles) {
    const { probe, log } = setup();
    await assert.rejects(probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: { ...RESOURCE, snippet: { ...RESOURCE.snippet, title } } }));
    assert.deepEqual(log, [], title);
  }
  // The limit is 5000 bytes, not characters: 2501 Cyrillic letters are 2501 characters but 5002 bytes.
  const { probe, log } = setup();
  await assert.rejects(probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: { ...RESOURCE, snippet: { ...RESOURCE.snippet, description: "я".repeat(2501) } } }));
  await assert.rejects(probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: { ...RESOURCE, status: { ...RESOURCE.status, publishAt: "2026-10-20T12:00:00Z" } } }));
  assert.deepEqual(log, []);
});

test("upload: it runs once -- a second probe is refused before anything is sent", async () => {
  const { probe, log } = setup({ record: { channelId: CH, videoId: "vidOld", uploadedAt: "2026-10-13T11:00:00Z", deletedAt: null } });
  await assert.rejects(probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: RESOURCE }), /runs once/);
  assert.deepEqual(log, ["gate"]);
});

test("upload: the read-back is polled every 10 s until processing ends, and the last state is reported", async () => {
  const { probe } = setup({ states: [STATE({}), STATE({}), STATE({ uploadStatus: "processed", processingStatus: "succeeded", privacyStatus: "private" })] });
  const report = await probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: RESOURCE });
  assert.equal(report.state?.processingStatus, "succeeded");
  assert.equal(report.waitedSeconds, 20);
});

test("upload: a rejected upload (e.g. a duplicate) ends the wait and is reported as YouTube said it", async () => {
  const { probe } = setup({ states: [STATE({ uploadStatus: "rejected", rejectionReason: "duplicate", processingStatus: null })] });
  const report = await probe.upload({ credentialRef: REF, channelId: CH, relativePath: "a.mp4", resource: RESOURCE });
  assert.deepEqual([report.state?.uploadStatus, report.state?.rejectionReason, report.waitedSeconds], ["rejected", "duplicate", 0]);
});

test("delete: only the probe's own video, once; the deletion is verified on YouTube and recorded", async () => {
  const record = { channelId: CH, videoId: "vidG1", uploadedAt: "2026-10-13T12:00:00Z", deletedAt: null };
  const other = setup({ record });
  await assert.rejects(other.probe.remove({ credentialRef: REF, videoId: "someoneElse" }), /Only the video the G1 probe uploaded/);
  assert.ok(!other.log.some((entry) => entry.startsWith("delete")));

  const none = setup();
  await assert.rejects(none.probe.remove({ credentialRef: REF, videoId: "vidG1" }));

  const { probe, log, getRecord } = setup({ record });
  const report = await probe.remove({ credentialRef: REF, videoId: "vidG1" });
  assert.deepEqual(report, { videoId: "vidG1", goneOnYouTube: true, localRowRemoved: true });
  assert.deepEqual(log, ["gate", "credentials", `identity:${CH}`, "delete:vidG1"]);
  assert.equal(getRecord()?.deletedAt, "2026-10-13T12:00:00.000Z");
  await assert.rejects(probe.remove({ credentialRef: REF, videoId: "vidG1" }), /already deleted/);
});

test("delete: if YouTube still returns the video afterwards, the report says so", async () => {
  const { probe } = setup({ record: { channelId: CH, videoId: "vidG1", uploadedAt: "x", deletedAt: null }, deletedState: STATE({}) });
  assert.equal((await probe.remove({ credentialRef: REF, videoId: "vidG1" })).goneOnYouTube, false);
});
