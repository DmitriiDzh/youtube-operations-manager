import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { createAutoPrivateUpload, type AutoUploadDeps } from "./auto-upload";
import type { ScannedPackage } from "./package-scan";
import { packageProblems, type ReleasePackage } from "./packages";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import { createUploadApproval, type UploadApprovalDeps } from "./upload-approval";
import { holdsPackage } from "./upload-runner";

// BL-209 (FO-REQ-0036; docs/roadmap/plans/AUTO_PRIVATE_UPLOAD_PLAN.md "Acceptance", written before the code; ADR 0046). The
// automatic private upload against fakes, through the REAL approval checks (`createUploadApproval().queueAutomatic`): a package is
// queued only while the owner's switch is on, only when it is ready by the scan's own checks (`packageProblems`), only when its
// manifest names the video's SHA-256 and the file matches it (size first, the hash only then, once), once per manifest version,
// and never past the day's `videos.insert` bucket. Expected values are worked out by hand from the plan.

const NOW = new Date("2026-10-21T12:00:00Z");
const CHANNEL = "UC_t";
const OWNER = "u-owner";
const SETTINGS = { ...DEFAULT_PUBLISHING_SETTINGS, playlistId: "PL_jazz" };
/** The video file's real SHA-256 in these tests (64 hex digits), and another one. */
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function release(video: string, over: Partial<ReleasePackage> = {}): ReleasePackage {
  return {
    channelId: CHANNEL,
    video,
    mix: 1,
    plannedPublishDate: "2026-10-24",
    files: { video: `${video} Tropico Jazz.mp4`, thumbnail: `Thumbnail_${video}_A.jpg` },
    sizeBytes: 1000,
    durationSeconds: 7200,
    title: `Title ${video}`,
    description: "00:00 A\n10:00 B\n20:00 C",
    tags: ["jazz"],
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    ready: true,
    problems: [],
    sha256: HASH_A,
    ...over,
  };
}

/** A package as the scan reports it: its state from the scan's own checks (`packageProblems`) on a video of `fileBytes`. */
function scanned(pkg: ReleasePackage, manifestSha256: string, fileBytes = pkg.sizeBytes): ScannedPackage {
  const folder = `04 Videos/10 October/1024 ${pkg.video}`;
  const problems = packageProblems(
    pkg,
    {
      video: { exists: true, sizeBytes: fileBytes, durationSeconds: 7200 },
      thumbnail: { exists: true, sizeBytes: 300_000, kind: "jpeg" },
      youtubeRecordExists: false,
      sameTitleVideoId: null,
    },
    { channelId: CHANNEL, defaultLanguage: "en", defaultAudioLanguage: "en" }
  );
  return {
    manifestPath: `${folder}/${pkg.video}_release.json`,
    folder,
    video: pkg.video,
    title: pkg.title,
    plannedPublishDate: pkg.plannedPublishDate,
    thumbnailPath: `${folder}/${pkg.files.thumbnail}`,
    sizeBytes: pkg.sizeBytes,
    durationSeconds: pkg.durationSeconds,
    state: problems.length > 0 ? "not_ready" : "ready",
    problems,
    youtube: null,
    pkg,
    manifestSha256,
  };
}

function harness(initial: { packages: ScannedPackage[]; enabled?: boolean; files?: Record<string, { bytes: number; mtimeMs: number; hash: string }> }) {
  const state = {
    enabled: initial.enabled ?? true,
    packages: initial.packages,
    files: initial.files ?? {},
    rows: [] as StoredPublishingUpload[],
    insertsToday: 0,
    peers: new Map<string, { host: string | null; uploaded: boolean }>(),
    hashCalls: [] as string[],
    mismatches: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
  };
  let id = 0;
  const approvalDeps: UploadApprovalDeps = {
    scan: async () => ({ status: "ok", packages: state.packages }),
    settings: async () => ({ channelId: CHANNEL, settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: ["playlistId"], conflictedFields: [] }),
    liveVideos: async () => new Set(state.rows.filter(holdsPackage).map((row) => row.video)),
    peerUploads: async () => state.peers,
    insertsToday: async () => state.insertsToday,
    pending: async () => ({ inserts: state.rows.filter((row) => row.status === "queued").length, units: 0 }),
    checkUnits: async (units) => ({ decision: "allow", estimatedUnits: units, remainingUnits: 9000 }),
    insert: async (rows) => {
      if (rows.some((row) => state.rows.some((held) => held.video === row.video && holdsPackage(held)))) return false;
      state.rows.push(...rows);
      return true;
    },
    newId: () => `up-${++id}`,
    audit: async ({ detail }) => void state.audits.push(detail),
    clock: { now: () => NOW },
  };
  const approval = createUploadApproval(approvalDeps);
  const deps: AutoUploadDeps = {
    enabled: async () => state.enabled,
    channels: async () => [{ channelId: CHANNEL, userId: OWNER }],
    scan: async () => ({ status: "ok", packages: state.packages }),
    liveVideos: approvalDeps.liveVideos,
    peerUploads: approvalDeps.peerUploads,
    autoQueuedHashes: async () => new Set(state.rows.filter((row) => row.automatic).map((row) => row.manifestSha256)),
    videoFile: async (_channelId, relativePath) => {
      const file = state.files[relativePath];
      return file ? { path: `/ws/${relativePath}`, bytes: file.bytes, mtimeMs: file.mtimeMs } : null;
    },
    hashFile: async (path) => {
      state.hashCalls.push(path);
      const file = state.files[path.replace(/^\/ws\//, "")];
      return file.hash;
    },
    queue: (input) => approval.queueAutomatic(input),
    logMismatch: async (args) => void state.mismatches.push(args),
    hashCache: new Map(),
    loggedMismatches: new Set(),
  };
  return { state, auto: createAutoPrivateUpload(deps) };
}

const videoPath = (p: ScannedPackage) => `${p.folder}/${p.pkg!.files.video}`;
const fileOf = (p: ScannedPackage, over: Partial<{ bytes: number; mtimeMs: number; hash: string }> = {}) => ({ [videoPath(p)]: { bytes: 1000, mtimeMs: 1, hash: HASH_A, ...over } });

test("AC-AU-01: switched off (the default) a ready, matching package is never queued and nothing is hashed", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], enabled: false, files: fileOf(p) });
  const result = await h.auto.tick();
  assert.deepEqual(result, { enabled: false, queued: [], waiting: null });
  assert.deepEqual([h.state.rows.length, h.state.hashCalls.length, h.state.audits.length], [0, 0, 0]);
});

test("AC-AU-02: switched on, ready, size and SHA-256 match -> one private row without a date, marked automatic, and one log event", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  const result = await h.auto.tick();
  assert.deepEqual(result.queued, [{ channelId: CHANNEL, video: "V65", uploadId: "up-1", manifestSha256: "mf-1" }]);
  assert.equal(h.state.rows.length, 1);
  const row = h.state.rows[0];
  assert.deepEqual(
    [row.channelId, row.video, row.publishAt, row.automatic, row.status, row.approvedBy, row.manifestSha256, row.totalBytes],
    [CHANNEL, "V65", null, true, "queued", OWNER, "mf-1", 1000]
  );
  assert.deepEqual(h.state.audits, [
    {
      event: "publishing.upload_auto_queued",
      at: "2026-10-21T12:00:00.000Z",
      channelId: CHANNEL,
      uploadId: "up-1",
      video: "V65",
      manifestSha256: "mf-1",
      switchOn: true,
      publishAt: null,
      uploadPrivate: true,
      publish: false,
      automatic: true,
    },
  ]);
  assert.deepEqual(h.state.hashCalls, [`/ws/${videoPath(p)}`]);
});

test("AC-AU-03: a manifest without `sha256` is not queued (the owner's approval only) and its video is not hashed", async () => {
  const p = scanned(release("V65", { sha256: null }), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  assert.deepEqual((await h.auto.tick()).queued, []);
  assert.deepEqual([h.state.rows.length, h.state.hashCalls.length], [0, 0]);
});

test("AC-AU-04: a video whose size differs from the manifest's is not queued and not hashed", async () => {
  // The file changed after the scan (the scan saw 1000 bytes, the file has 999 now).
  const changed = scanned(release("V65"), "mf-1");
  const h1 = harness({ packages: [changed], files: fileOf(changed, { bytes: 999 }) });
  assert.deepEqual((await h1.auto.tick()).queued, []);
  assert.deepEqual([h1.state.rows.length, h1.state.hashCalls.length], [0, 0]);
  // The scan itself saw the other size: not ready (video_size_differs).
  const differs = scanned(release("V66"), "mf-2", 999);
  assert.equal(differs.state, "not_ready");
  const h2 = harness({ packages: [differs], files: fileOf(differs, { bytes: 999 }) });
  assert.deepEqual((await h2.auto.tick()).queued, []);
  assert.deepEqual([h2.state.rows.length, h2.state.hashCalls.length], [0, 0]);
});

test("AC-AU-05: same size, another SHA-256 -> not queued, logged once; a second tick with the same manifest and file does not hash again", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p, { hash: HASH_B }) });
  assert.deepEqual((await h.auto.tick()).queued, []);
  assert.deepEqual((await h.auto.tick()).queued, []);
  assert.equal(h.state.rows.length, 0);
  assert.equal(h.state.hashCalls.length, 1);
  assert.deepEqual(h.state.mismatches, [{ channelId: CHANNEL, video: "V65", manifestSha256: "mf-1", expected: HASH_A, actual: HASH_B }]);
  // The file was replaced (a new mtime): hashed once more -- now it matches and is queued.
  h.state.files = fileOf(p, { mtimeMs: 2, hash: HASH_A });
  assert.deepEqual((await h.auto.tick()).queued.map((q) => q.video), ["V65"]);
  assert.equal(h.state.hashCalls.length, 2);
});

test("AC-AU-06: a package that is not ready (a title over 100 characters) is not queued", async () => {
  const p = scanned(release("V65", { title: "a".repeat(101) }), "mf-1");
  assert.deepEqual([p.state, p.problems.map((x) => x.code)], ["not_ready", ["title_too_long"]]);
  const h = harness({ packages: [p], files: fileOf(p) });
  assert.deepEqual((await h.auto.tick()).queued, []);
  assert.deepEqual([h.state.rows.length, h.state.hashCalls.length], [0, 0]);
});

test("AC-AU-07: two ticks queue the package once; a package with a live row here, or reported by a peer, is not queued", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  await h.auto.tick();
  await h.auto.tick();
  assert.equal(h.state.rows.length, 1);

  // A live row of the owner's own approval (a different manifest version, so not "tried" by the automatic upload).
  const manual = scanned(release("V66"), "mf-2");
  const h2 = harness({ packages: [manual], files: fileOf(manual) });
  h2.state.rows.push({ ...h.state.rows[0], id: "manual-1", video: "V66", manifestSha256: "mf-old", automatic: false, status: "uploading" });
  assert.deepEqual((await h2.auto.tick()).queued, []);
  assert.deepEqual([h2.state.rows.length, h2.state.hashCalls.length], [1, 0]);

  const peer = scanned(release("V67"), "mf-3");
  const h3 = harness({ packages: [peer], files: fileOf(peer) });
  h3.state.peers.set("V67", { host: "Windows", uploaded: false });
  assert.deepEqual((await h3.auto.tick()).queued, []);
  assert.deepEqual([h3.state.rows.length, h3.state.hashCalls.length], [0, 0]);
});

test("AC-AU-07: a peer that starts the same package while the video is hashed still wins -- the approval's check runs at queue time", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  // The other computer reports V65 while this one hashes it.
  const auto = createAutoPrivateUpload({
    enabled: async () => h.state.enabled,
    channels: async () => [{ channelId: CHANNEL, userId: OWNER }],
    scan: async () => ({ status: "ok", packages: [p] }),
    liveVideos: async () => new Set(),
    peerUploads: async () => new Map(),
    autoQueuedHashes: async () => new Set(),
    videoFile: async () => ({ path: "/ws/v", bytes: 1000, mtimeMs: 1 }),
    hashFile: async () => {
      h.state.peers.set("V65", { host: "Windows", uploaded: false });
      return HASH_A;
    },
    queue: async (input) =>
      createUploadApproval({
        scan: async () => ({ status: "ok", packages: [p] }),
        settings: async () => ({ channelId: CHANNEL, settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: [], conflictedFields: [] }),
        liveVideos: async () => new Set(),
        peerUploads: async () => h.state.peers,
        insertsToday: async () => 0,
        pending: async () => ({ inserts: 0, units: 0 }),
        checkUnits: async (units) => ({ decision: "allow", estimatedUnits: units, remainingUnits: 9000 }),
        insert: async (rows) => (h.state.rows.push(...rows), true),
        newId: () => "up-x",
        audit: async () => undefined,
        clock: { now: () => NOW },
      }).queueAutomatic(input),
    logMismatch: async () => undefined,
    hashCache: new Map(),
    loggedMismatches: new Set(),
  });
  assert.deepEqual((await auto.tick()).queued, []);
  assert.equal(h.state.rows.length, 0);
});

test("AC-AU-08: a failed automatic upload is not queued again for the same manifest hash; a changed manifest (new hash) is", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  await h.auto.tick();
  // The runner failed it before YouTube had a video: the row no longer holds the package, but the manifest version was tried.
  h.state.rows[0] = { ...h.state.rows[0], status: "failed", errorCode: "package_changed", finishedAt: NOW };
  assert.deepEqual((await h.auto.tick()).queued, []);
  assert.equal(h.state.rows.length, 1);
  // The factory wrote a new manifest (new hash): a new try.
  h.state.packages = [scanned(release("V65"), "mf-2")];
  assert.deepEqual((await h.auto.tick()).queued, [{ channelId: CHANNEL, video: "V65", uploadId: "up-2", manifestSha256: "mf-2" }]);
  assert.deepEqual(h.state.rows.map((row) => [row.manifestSha256, row.status, row.automatic]), [["mf-1", "failed", true], ["mf-2", "queued", true]]);
});

test("AC-AU-08: an automatic row the owner cancelled is not queued again by itself either", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  await h.auto.tick();
  h.state.rows[0] = { ...h.state.rows[0], status: "cancelled", finishedAt: NOW };
  assert.deepEqual((await h.auto.tick()).queued, []);
});

test("AC-AU-09: the day's insert bucket full -> not queued this tick (waiting, never dropped); queued on a later tick once there is room", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  h.state.insertsToday = 100; // UPLOADS_PER_DAY
  assert.deepEqual(await h.auto.tick(), { enabled: true, queued: [], waiting: "upload_daily_limit" });
  assert.equal(h.state.rows.length, 0);
  h.state.insertsToday = 99;
  assert.deepEqual((await h.auto.tick()).queued.map((q) => q.video), ["V65"]);
  assert.equal(h.state.hashCalls.length, 1, "the hash of the first tick is reused");
});

test("AC-AU-09: two packages and one insert left -> the first is queued, the second waits for a later tick", async () => {
  const a = scanned(release("V65"), "mf-1");
  const b = scanned(release("V66"), "mf-2");
  const h = harness({ packages: [a, b], files: { ...fileOf(a), ...fileOf(b) } });
  h.state.insertsToday = 99;
  const result = await h.auto.tick();
  assert.deepEqual([result.queued.map((q) => q.video), result.waiting], [["V65"], "upload_daily_limit"]);
});

test("AC-AU-10 (queue side): an automatic row has no publish date even when the manifest plans one", async () => {
  const p = scanned(release("V65", { plannedPublishDate: "2026-10-24" }), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  await h.auto.tick();
  assert.equal(h.state.rows[0].publishAt, null);
  assert.deepEqual(JSON.parse(h.state.rows[0].settingsJson).playlistId, "PL_jazz", "the playlist step runs as for a manual upload (owner msg 3333)");
});

test("an unknown quota is never acknowledged by the automatic path (it waits like a full bucket); a call with the switch off is refused", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  const approval = createUploadApproval({
    scan: async () => ({ status: "ok", packages: [p] }),
    settings: async () => ({ channelId: CHANNEL, settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: [], conflictedFields: [] }),
    liveVideos: async () => new Set(),
    peerUploads: async () => new Map(),
    insertsToday: async () => 0,
    pending: async () => ({ inserts: 0, units: 0 }),
    checkUnits: async () => ({ decision: "unknown", cloudConnected: false }) as never,
    insert: async () => true,
    newId: () => "up-x",
    audit: async () => undefined,
    clock: { now: () => NOW },
  });
  await assert.rejects(
    approval.queueAutomatic({ channelId: CHANNEL, userId: OWNER, manifestPath: p.manifestPath, manifestSha256: "mf-1", scanned: { status: "ok", packages: [p] }, switchOn: true }),
    (error: { code?: string }) => error.code === "quota_unknown"
  );
  await assert.rejects(
    approval.queueAutomatic({ channelId: CHANNEL, userId: OWNER, manifestPath: p.manifestPath, manifestSha256: "mf-1", scanned: { status: "ok", packages: [p] }, switchOn: false }),
    (error: { code?: string }) => error.code === "validation_failed"
  );
  assert.equal(h.state.rows.length, 0);
});

test("the switch turned off while a video was hashed: nothing is queued", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  let reads = 0;
  const auto = createAutoPrivateUpload({
    enabled: async () => ++reads === 1,
    channels: async () => [{ channelId: CHANNEL, userId: OWNER }],
    scan: async () => ({ status: "ok", packages: [p] }),
    liveVideos: async () => new Set(),
    peerUploads: async () => new Map(),
    autoQueuedHashes: async () => new Set(),
    videoFile: async () => ({ path: "/ws/v", bytes: 1000, mtimeMs: 1 }),
    hashFile: async () => HASH_A,
    queue: async () => {
      throw new Error("must not queue");
    },
    logMismatch: async () => undefined,
    hashCache: new Map(),
    loggedMismatches: new Set(),
  });
  assert.deepEqual((await auto.tick()).queued, []);
  assert.equal(h.state.rows.length, 0);
});
