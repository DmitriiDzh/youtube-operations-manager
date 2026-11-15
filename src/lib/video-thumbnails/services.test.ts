// ---------------------------------------------------------------------------
// BL-255 acceptance (ADR 0069 AC-TH-01..11, 14), derived from the owner's requirement (Telegram msgs 4380/4383: replace an uploaded
// video's thumbnail, the owner and the Producer, any video) and the YouTube Data API reference for `thumbnails.set` ("Maximum file
// size: 2MB", image/jpeg or image/png; changes only the thumbnail), plus AGENTS.md §G's write model. Expected values are stated by
// hand from those sources, never copied from a run of the code.
// ---------------------------------------------------------------------------
import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedCredentials } from "@/lib/shared-domain";
import { isDomainError, type VideoThumbnailState, type VideoThumbnailsDeps } from "./contracts";
import { createVideoThumbnailsServices, isThumbnailCandidatePath } from "./services";

const CHANNEL = "UCa2amtpeOmgP-HkiLKPm1gg";
const OTHER = "UC-IdugmwWRvRo9-j0yK5AbA";
const VIDEO = "ZeRdh3bZlkg";
const PATH = "04 Videos/11 November/1115 V91/Thumbnail_V91_logo.jpg";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
// sha256 of the 7 bytes above, computed independently (`printf '\xff\xd8\xff\xe0\x01\x02\x03' | shasum -a 256`).
const JPEG_SHA = "474ebe266cd7f9ed28807fa3fdfe0c04cdb3cef9313cdda5c08b15910fcc8184";

function state(overrides: Partial<VideoThumbnailState> = {}): VideoThumbnailState {
  return {
    channelId: CHANNEL,
    thumbnails: { high: { url: "https://i.ytimg.com/vi/x/hqdefault.jpg", width: 480, height: 360 }, maxres: { url: "https://i.ytimg.com/vi/x/maxresdefault.jpg", width: 1280, height: 720 } },
    hasCustomThumbnail: true,
    privacyStatus: "private",
    publishAt: "2026-11-15T12:00:00Z",
    ...overrides,
  };
}

type Harness = { deps: VideoThumbnailsDeps; calls: string[]; writes: Array<{ videoId: string; mimeType: string; bytes: Buffer }>; audits: Array<{ eventType: string; detail: Record<string, unknown> }>; stored: unknown[] };

function harness(options: {
  file?: { bytes: Uint8Array; contentType: string } | null;
  before?: VideoThumbnailState | null;
  after?: VideoThumbnailState | null;
  pending?: boolean;
  backupFails?: boolean;
  identityFails?: boolean;
  liveWritesOff?: boolean;
  deviceBusy?: boolean;
  sameImageAfter?: boolean;
  auditFailsAfterWrite?: boolean;
} = {}): Harness {
  const calls: string[] = [];
  const writes: Harness["writes"] = [];
  const audits: Harness["audits"] = [];
  const stored: unknown[] = [];
  let reads = 0;
  let downloads = 0;
  let written = false;
  const credentials = { credentialRef: { userId: "u1" }, accessToken: "t", scopeSet: new Set<string>() } as ResolvedCredentials;
  const deps: VideoThumbnailsDeps = {
    async credentials() {
      calls.push("credentials");
      return { credentialRef: { userId: "u1" }, credentials };
    },
    async readFile() {
      calls.push("readFile");
      return options.file === undefined ? { bytes: JPEG, contentType: "image/jpeg" } : options.file;
    },
    async readVideo() {
      reads += 1;
      calls.push(`readVideo${reads}`);
      if (reads === 1) return options.before === undefined ? state() : options.before;
      return options.after === undefined ? state() : options.after;
    },
    async uploadThumbnailStepPending() {
      calls.push("pending");
      return options.pending ?? false;
    },
    async downloadImage() {
      downloads += 1;
      calls.push("downloadImage");
      // The image before the write is [1, 2]; after it YouTube serves the new one unless the test says it still serves the old.
      return { bytes: Buffer.from(downloads === 1 || options.sameImageAfter ? [1, 2] : [9, 9]), contentType: "image/jpeg" };
    },
    backup: {
      async checkInfrastructureHealth() {
        calls.push("health");
        return { healthy: true };
      },
      async captureBackup(args) {
        calls.push("backup");
        if (options.backupFails) throw new Error("disk full");
        assert.equal(args.snapshot.kind, "video_thumbnail");
        return { path: "/backups/x.json", capturedAt: "2026-11-15T10:00:00.000Z" };
      },
    },
    async assertWriteChannel() {
      calls.push("identity");
      if (options.identityFails) throw Object.assign(new Error("wrong channel"), { code: "WRITE_CHANNEL_MISMATCH" });
    },
    async setThumbnail(_c, videoId, image) {
      calls.push("setThumbnail");
      if (options.liveWritesOff) throw Object.assign(new Error("Live writes are off"), { code: "live_writes_disabled" });
      writes.push({ videoId, ...image });
      written = true;
    },
    async audit(args) {
      calls.push(`audit:${args.eventType}`);
      if (options.auditFailsAfterWrite && written) throw new Error("database is locked");
      audits.push({ eventType: args.eventType, detail: args.detail });
    },
    async storeThumbnails(...args) {
      calls.push("store");
      stored.push(args);
    },
    newOperationId: () => "op-1",
    async assertDeviceAvailable() {
      calls.push("device");
      if (options.deviceBusy) throw Object.assign(new Error("operation lock held"), { code: "operation_lock_held" });
    },
  };
  return { deps, calls, writes, audits, stored };
}

const owner = { kind: "owner" as const, userId: "u1" };
const producer = { kind: "producer" as const, tokenId: "tok" };

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("AC-TH-01 path rule: only .jpg/.jpeg/.png under 04 Videos/, no absolute, backslash, empty, . or .. part", () => {
  assert.equal(isThumbnailCandidatePath(PATH), true);
  assert.equal(isThumbnailCandidatePath("04 Videos/a/b.PNG"), true);
  assert.equal(isThumbnailCandidatePath("04 Videos/a/b.jpeg"), true);
  for (const bad of ["/04 Videos/a.jpg", "05 Docs/a.jpg", "04 Videos/../x.jpg", "04 Videos/./a.jpg", "04 Videos//a.jpg", "04 Videos\\a.jpg", "04 Videos/a.gif", "04 Videos/a.jpg.mp4", "04 Videosx/a.jpg"]) {
    assert.equal(isThumbnailCandidatePath(bad), false, bad);
  }
});

test("AC-TH-01 a bad path or a non-image is refused before any YouTube call", async () => {
  const h = harness();
  await rejectsWith(createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: "04 Videos/../secret.jpg" }, owner), "thumbnail_file_invalid");
  assert.deepEqual(h.calls, []);
  const missing = harness({ file: null });
  await rejectsWith(createVideoThumbnailsServices(missing.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), "thumbnail_file_invalid");
  assert.deepEqual(missing.calls, ["readFile"]);
  const gif = harness({ file: { bytes: JPEG, contentType: "image/gif" } });
  await rejectsWith(createVideoThumbnailsServices(gif.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), "thumbnail_file_invalid");
  assert.equal(gif.writes.length, 0);
});

test("AC-TH-02 2 MB boundary: 2 097 152 bytes accepted, 2 097 153 refused", async () => {
  const exact = Buffer.alloc(2_097_152, 0);
  exact.set([0xff, 0xd8, 0xff]);
  const ok = harness({ file: { bytes: exact, contentType: "image/jpeg" } });
  const result = await createVideoThumbnailsServices(ok.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH, dryRun: true }, owner);
  assert.equal(result.file.bytes, 2_097_152);
  const over = harness({ file: { bytes: Buffer.alloc(2_097_153, 0), contentType: "image/jpeg" } });
  await rejectsWith(createVideoThumbnailsServices(over.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), "thumbnail_file_invalid");
  assert.ok(!over.calls.includes("readVideo1"));
});

test("AC-TH-03 a video YouTube does not return, or another channel's, is refused without a write", async () => {
  const gone = harness({ before: null });
  await rejectsWith(createVideoThumbnailsServices(gone.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), "video_not_in_channel");
  const foreign = harness({ before: state({ channelId: OTHER }) });
  await rejectsWith(createVideoThumbnailsServices(foreign.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, producer), "video_not_in_channel");
  for (const h of [gone, foreign]) {
    assert.equal(h.writes.length, 0);
    assert.ok(!h.calls.includes("backup"));
  }
});

test("AC-TH-04 a pending upload thumbnail step refuses the replace", async () => {
  const h = harness({ pending: true });
  await rejectsWith(createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), "thumbnail_step_pending");
  assert.equal(h.writes.length, 0);
  assert.ok(!h.calls.includes("backup"));
});

test("AC-TH-05 a failed backup stops the write", async () => {
  const h = harness({ backupFails: true });
  await assert.rejects(createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner));
  assert.equal(h.writes.length, 0);
  assert.ok(!h.calls.includes("setThumbnail"));
});

test("AC-TH-06 a wrong channel at the identity check fails closed", async () => {
  const h = harness({ identityFails: true });
  await assert.rejects(createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), /wrong channel/);
  assert.ok(!h.calls.includes("setThumbnail"));
});

test("AC-TH-07 Live writes off: the write is refused and audited as failed, nothing reported as written", async () => {
  const h = harness({ liveWritesOff: true });
  await assert.rejects(createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner), /Live writes/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.audits.at(-1)?.detail.event, "video_thumbnails.replace_failed");
  assert.ok(!h.calls.includes("store"));
});

test("AC-TH-08 dry run: reads and checks only -- no backup, no identity write path, no write, no audit; 52 units", async () => {
  const h = harness();
  const result = await createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH, dryRun: true }, owner);
  assert.deepEqual(h.calls, ["readFile", "credentials", "readVideo1", "pending"]);
  assert.equal(result.dryRun, true);
  assert.equal(result.written, false);
  assert.equal(result.units, 52);
  assert.equal(result.before.url, "https://i.ytimg.com/vi/x/maxresdefault.jpg");
  assert.equal(h.audits.length, 0);
});

test("AC-TH-09 success: order backup → identity → one write with the file's bytes → read-back → verified", async () => {
  const h = harness();
  const result = await createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, producer);
  assert.deepEqual(h.calls, ["readFile", "credentials", "readVideo1", "pending", "device", "health", "downloadImage", "backup", "audit:BACKUP", "identity", "setThumbnail", "audit:RESULT", "readVideo2", "downloadImage", "audit:VERIFICATION", "store"]);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].videoId, VIDEO);
  assert.equal(h.writes[0].mimeType, "image/jpeg");
  assert.deepEqual([...h.writes[0].bytes], [...JPEG]);
  assert.equal(result.written, true);
  assert.equal(result.verified, true);
  assert.equal(result.verificationDetail, null);
  assert.equal(result.backupPath, "/backups/x.json");
  assert.equal(result.imageChanged, true);
});

test("AC-TH-10 read-back without a custom thumbnail, or with privacy/publishAt changed, is not verified", async () => {
  const noCustom = harness({ after: state({ hasCustomThumbnail: false }) });
  const r1 = await createVideoThumbnailsServices(noCustom.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner);
  assert.equal(r1.verified, false);
  assert.match(r1.verificationDetail ?? "", /hasCustomThumbnail/);
  const moved = harness({ after: state({ publishAt: "2026-11-16T12:00:00Z", privacyStatus: "public" }) });
  const r2 = await createVideoThumbnailsServices(moved.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner);
  assert.equal(r2.verified, false);
  assert.match(r2.verificationDetail ?? "", /privacy private → public/);
  assert.match(r2.verificationDetail ?? "", /publishAt 2026-11-15T12:00:00Z → 2026-11-16T12:00:00Z/);
  assert.equal(moved.audits.find((a) => a.eventType === "VERIFICATION")?.detail.verified, false);
});

test("AC-TH-11 audit rows carry the source, the actor and the file's SHA-256", async () => {
  const h = harness();
  await createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, producer);
  assert.deepEqual(h.audits.map((a) => a.eventType), ["BACKUP", "RESULT", "VERIFICATION"]);
  for (const a of h.audits) {
    assert.equal(a.detail.source, "video_thumbnails");
    assert.equal(a.detail.actor, "producer");
    assert.equal(a.detail.tokenId, "tok");
    assert.equal(a.detail.sha256, JPEG_SHA);
  }
});

test("AC-TH-14 the service has no dependency that touches the plan or the upload rows (only the read of the pending step)", () => {
  const keys = Object.keys(harness().deps).sort();
  assert.deepEqual(keys, ["assertDeviceAvailable", "assertWriteChannel", "audit", "backup", "credentials", "downloadImage", "newOperationId", "readFile", "readVideo", "setThumbnail", "storeThumbnails", "uploadThumbnailStepPending"]);
});

test("AC-TH-15 a device handoff or recovery mode refuses before any backup or write (dry run still reads)", async () => {
  const h = harness({ deviceBusy: true });
  await assert.rejects(createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, producer), /operation lock/);
  assert.ok(!h.calls.includes("backup"));
  assert.ok(!h.calls.includes("setThumbnail"));
  assert.equal(h.audits.length, 0);
  const dry = harness({ deviceBusy: true });
  const result = await createVideoThumbnailsServices(dry.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH, dryRun: true }, producer);
  assert.equal(result.dryRun, true);
});

test("AC-TH-16 YouTube still serving the backed-up image after the write is not verified", async () => {
  const h = harness({ sameImageAfter: true });
  const result = await createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner);
  assert.equal(result.written, true);
  assert.equal(result.imageChanged, false);
  assert.equal(result.verified, false);
  assert.match(result.verificationDetail ?? "", /previous image/);
});

test("AC-TH-17 a failure after the write (audit) still reports the write as done", async () => {
  const h = harness({ auditFailsAfterWrite: true });
  const result = await createVideoThumbnailsServices(h.deps).replace({ channelId: CHANNEL, videoId: VIDEO, path: PATH }, owner);
  assert.equal(result.written, true);
  assert.equal(h.writes.length, 1);
});
