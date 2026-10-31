import assert from "node:assert/strict";
import test from "node:test";
import type { CleanupLogEntry, VideoTombstone } from "./contracts";
import { createLocalVideoCleanup, parseCleanupSettings, type CleanupInspected, type CleanupUpload, type CleanupYoutubeState, type LocalVideoCleanupDeps } from "./services";

// BL-238 (ADR 0058). The sweep, with the file system and YouTube faked: AC-4 the switch is off by default and only uploads finished
// after it went on are touched; AC-2 waits are retried, refusals logged once and never retried; AC-3 no tombstone, no delete;
// AC-6 one log entry (and one CSV line) per delete or refusal.

const WS = "/T9/YouTube/01 Tropico Jazz";
const CH = "UCa2amtpeOmgP-HkiLKPm1gg";
const ENABLED_AT = 1_000_000;

const upload = (n: number, over: Partial<CleanupUpload> = {}): CleanupUpload => ({
  id: `up-${n}`,
  channelId: CH,
  approvedBy: "user-1",
  video: `V${n}`,
  videoFile: `04 Videos/11 November/11${String(n % 28 + 1).padStart(2, "0")} V${n}/V${n} Tropico Jazz.mp4`,
  videoId: `vid${String(n).padStart(8, "0")}`,
  storedBytes: 1000 + n,
  totalBytes: 1000 + n,
  finishedAt: ENABLED_AT + n,
  sha256: null,
  ...over,
});

const ytOk = (bytes: number, over: Partial<CleanupYoutubeState> = {}): CleanupYoutubeState => ({
  uploadStatus: "processed",
  processingStatus: "succeeded",
  privacyStatus: "public",
  publishAt: null,
  fileSize: bytes,
  duration: "PT3H",
  ...over,
});

function harness(opts: { uploads: CleanupUpload[]; enabled?: boolean; yt?: (id: string) => CleanupYoutubeState | undefined; ytThrows?: boolean; tombstoneFails?: boolean; files?: Map<string, CleanupInspected> }) {
  let settings: string | null = opts.enabled === false ? null : JSON.stringify({ channels: { [CH]: { enabled: true, enabledAt: ENABLED_AT } } });
  const files = opts.files ?? new Map(opts.uploads.map((u) => [u.videoFile, { kind: "file" as const, bytes: u.totalBytes as number, tombstone: null, absolutePath: `${WS}/${u.videoFile}`, identity: { dev: 1, ino: Number(u.id.slice(3)) } }]));
  const log: CleanupLogEntry[] = [];
  const csv: CleanupLogEntry[] = [];
  const reads: string[][] = [];
  const tombstones: VideoTombstone[] = [];
  const unlinked: string[] = [];
  let id = 0;
  const deps: LocalVideoCleanupDeps = {
    getSettingsJson: async () => settings,
    setSettingsJson: async (json) => void (settings = json),
    doneUploads: async () => opts.uploads,
    activeUploadFiles: async () => new Set(),
    liveRotation: async () => [],
    workspace: async () => WS,
    async readYoutube({ videoIds }) {
      reads.push(videoIds);
      if (opts.ytThrows) throw new Error("quota");
      const out = new Map<string, CleanupYoutubeState>();
      for (const v of videoIds) {
        const u = opts.uploads.find((x) => x.videoId === v);
        const state = opts.yt ? opts.yt(v) : u ? ytOk(u.totalBytes as number) : undefined;
        if (state) out.set(v, state);
      }
      return out;
    },
    fs: {
      inspect: async (_ws, rel) => files.get(rel) ?? { kind: "missing", tombstone: null },
      sha256: async () => "ab".repeat(32),
      probeDuration: async () => 10800,
      async writeTombstone(_p, t) {
        if (opts.tombstoneFails) throw new Error("read-only");
        tombstones.push(t);
      },
      async unlink(args) {
        unlinked.push(args.relativePath);
        files.set(args.relativePath, { kind: "missing", tombstone: tombstones.at(-1) ?? null });
      },
      appendCsv: async (_ws, e) => void csv.push(e),
    },
    log: {
      async insert(e) {
        if (log.some((x) => x.uploadId === e.uploadId)) return false;
        log.push(e);
        return true;
      },
      loggedUploadIds: async () => new Set(log.map((e) => e.uploadId)),
      list: async () => [...log].reverse(),
      freed: async () => ({ bytes: log.filter((e) => e.action === "deleted").reduce((s, e) => s + (e.bytes ?? 0), 0), count: log.filter((e) => e.action === "deleted").length }),
    },
    newId: () => `log-${++id}`,
    clock: () => 2_000_000,
    note: () => undefined,
  };
  return { cleanup: createLocalVideoCleanup(deps), log, csv, reads, tombstones, unlinked, files, settings: () => settings };
}

test("AC-4: the switch is off by default -- nothing is read or deleted", async () => {
  const h = harness({ uploads: [upload(72)], enabled: false });
  await h.cleanup.tick();
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.unlinked, []);
  assert.equal((await h.cleanup.view(CH)).enabled, false);
  assert.deepEqual(parseCleanupSettings(null), { channels: {} });
});

test("AC-4: only uploads finished after the switch went on; turning it on again keeps the first time", async () => {
  const h = harness({ uploads: [upload(71, { finishedAt: ENABLED_AT - 1 }), upload(72)] });
  await h.cleanup.tick();
  assert.deepEqual(h.unlinked, [upload(72).videoFile]);
  assert.deepEqual((await h.cleanup.setEnabled(CH, true)).enabledAt, ENABLED_AT);
  assert.deepEqual(await h.cleanup.setEnabled(CH, false), { enabled: false, enabledAt: null });
  assert.equal((await h.cleanup.setEnabled(CH, true)).enabledAt, 2_000_000, "a new start time after it was off");
});

test("a delete: the tombstone carries the contract, then the mp4 goes, one log entry and one CSV line", async () => {
  const u = upload(72, { sha256: "AB".repeat(32) });
  const h = harness({ uploads: [u], yt: () => ytOk(u.totalBytes as number, { privacyStatus: "private", publishAt: "2026-11-05T15:00:00Z" }) });
  await h.cleanup.tick();
  assert.deepEqual(h.tombstones, [
    {
      schema: "deleted-video/1",
      file: "V72 Tropico Jazz.mp4",
      bytes: 1072,
      sha256: "ab".repeat(32),
      durationSec: 10800,
      youtubeVideoId: "vid00000072",
      privacyStatus: "private",
      publishAt: "2026-11-05T15:00:00Z",
      deletedAt: new Date(2_000_000).toISOString(),
      deletedBy: "ytm-cleanup",
      tempDeleted: [],
    },
  ]);
  assert.deepEqual(h.unlinked, [u.videoFile]);
  assert.equal(h.log.length, 1);
  assert.deepEqual({ action: h.log[0].action, reason: h.log[0].reason, bytes: h.log[0].bytes, path: h.log[0].path }, { action: "deleted", reason: null, bytes: 1072, path: u.videoFile });
  assert.equal(h.csv.length, 1);
  const view = await h.cleanup.view(CH);
  assert.deepEqual([view.freedBytes, view.deletedCount], [1072, 1]);
  await h.cleanup.tick();
  assert.equal(h.log.length, 1, "logged once, never checked again");
});

test("AC-2: waits are not logged and are retried; they show on the card", async () => {
  const u = upload(72);
  let state: CleanupYoutubeState = ytOk(1072, { processingStatus: "processing", uploadStatus: "uploaded" });
  const h = harness({ uploads: [u], yt: () => state });
  await h.cleanup.tick();
  assert.deepEqual(h.log, []);
  assert.deepEqual((await h.cleanup.view(CH)).waiting.map((w) => w.reason), ["processing"]);
  state = ytOk(1072, { privacyStatus: "unlisted" });
  await h.cleanup.tick();
  assert.deepEqual((await h.cleanup.view(CH)).waiting.map((w) => w.reason), ["not_public_or_scheduled"]);
  state = ytOk(1072);
  await h.cleanup.tick();
  assert.deepEqual(h.unlinked, [u.videoFile]);
  assert.deepEqual((await h.cleanup.view(CH)).waiting, []);
});

test("AC-2: YouTube unreadable is a wait; the video missing on YouTube or another size is a refusal, logged once", async () => {
  const quota = harness({ uploads: [upload(72)], ytThrows: true });
  await quota.cleanup.tick();
  assert.deepEqual(quota.log, []);
  assert.deepEqual((await quota.cleanup.view(CH)).waiting.map((w) => w.reason), ["youtube_unavailable"]);

  const gone = harness({ uploads: [upload(72)], yt: () => undefined });
  await gone.cleanup.tick();
  await gone.cleanup.tick();
  assert.deepEqual(gone.log.map((e) => [e.action, e.reason]), [["refused", "video_not_on_youtube"]]);
  assert.equal(gone.reads.length, 1, "a refused upload is not read again");
  assert.deepEqual(gone.unlinked, []);

  const size = harness({ uploads: [upload(72)], yt: () => ytOk(999) });
  await size.cleanup.tick();
  assert.deepEqual(size.log.map((e) => [e.action, e.reason]), [["refused", "size_mismatch_youtube"]]);
  assert.deepEqual(size.unlinked, []);
});

test("AC-2: a wrong path is refused without any YouTube read", async () => {
  const h = harness({ uploads: [upload(72, { videoFile: "04 Videos/Live Segments/V72 Tropico Jazz.mp4" })] });
  await h.cleanup.tick();
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.log.map((e) => e.reason), ["path_not_allowed"]);
  assert.deepEqual(h.unlinked, []);
});

test("AC-2: the package's sha256 differs -- refused, the file stays", async () => {
  const h = harness({ uploads: [upload(72, { sha256: "cd".repeat(32) })] });
  await h.cleanup.tick();
  assert.deepEqual(h.log.map((e) => e.reason), ["sha256_mismatch"]);
  assert.deepEqual(h.tombstones, []);
  assert.deepEqual(h.unlinked, []);
});

test("AC-3: a tombstone that cannot be written leaves the mp4 and logs nothing (it waits)", async () => {
  const h = harness({ uploads: [upload(72)], tombstoneFails: true });
  await h.cleanup.tick();
  assert.deepEqual(h.unlinked, []);
  assert.deepEqual(h.log, []);
  assert.equal((await h.cleanup.view(CH)).waiting.length, 1);
});

test("50 videos per YouTube read", async () => {
  const uploads = Array.from({ length: 51 }, (_, i) => upload(i + 1));
  const h = harness({ uploads });
  await h.cleanup.tick();
  assert.deepEqual(h.reads.map((r) => r.length), [50, 1]);
  assert.equal(h.unlinked.length, 51);
});

test("an mp4 already gone (with or without a tombstone) is not read, deleted or logged", async () => {
  const u = upload(72);
  const h = harness({ uploads: [u], files: new Map([[u.videoFile, { kind: "missing", tombstone: null }]]) });
  await h.cleanup.tick();
  assert.deepEqual([h.reads, h.unlinked, h.log], [[], [], []]);
});
