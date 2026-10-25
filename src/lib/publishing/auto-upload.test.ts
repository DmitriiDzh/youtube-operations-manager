import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { createAutoPrivateUpload, type AutoUploadDeps, type AutoUploadWaiting, type SlotDecision } from "./auto-upload";
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

function harness(initial: { packages: ScannedPackage[]; enabled?: boolean; files?: Record<string, { bytes: number; mtimeMs: number; hash: string }>; slots?: Map<string, SlotDecision> }) {
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
    waitingLog: [] as AutoUploadWaiting[],
    saved: [] as AutoUploadWaiting[][],
    channels: [{ channelId: CHANNEL, userId: OWNER as string | null }],
    quotaShort: false,
    noWorkspace: false,
  };
  let id = 0;
  const approvalDeps: UploadApprovalDeps = {
    scan: async () => ({ status: "ok", packages: state.packages }),
    settings: async () => ({ channelId: CHANNEL, settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: ["playlistId"], conflictedFields: [] }),
    liveVideos: async () => new Set(state.rows.filter(holdsPackage).map((row) => row.video)),
    peerUploads: async () => state.peers,
    insertsToday: async () => state.insertsToday,
    pending: async () => ({ inserts: state.rows.filter((row) => row.status === "queued").length, units: 0 }),
    checkUnits: async (units) =>
      state.quotaShort
        ? { decision: "insufficient", estimatedUnits: units, remainingUnits: 10, resetsAt: "2026-10-22T07:00:00.000Z" }
        : { decision: "allow", estimatedUnits: units, remainingUnits: 9000 },
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
    channels: async () => state.channels,
    scan: async () => (state.noWorkspace ? { status: "no_workspace" } : { status: "ok", packages: state.packages }),
    liveVideos: approvalDeps.liveVideos,
    peerUploads: approvalDeps.peerUploads,
    // Review M1: every row here counts as tried, automatic or the owner's, whatever its status.
    triedHashes: async () => new Set(state.rows.map((row) => row.manifestSha256)),
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
    logWaiting: async (entry) => void state.waitingLog.push(entry),
    saveWaiting: async (entries) => void state.saved.push(entries),
    waiting: new Map(),
    // BL-225 stage 3: the plan's slot decisions (absent: the plan module is not plugged in).
    ...(initial.slots ? { slotDecisions: async () => initial.slots!, now: () => NOW } : {}),
  };
  return { state, auto: createAutoPrivateUpload(deps) };
}

const videoPath = (p: ScannedPackage) => `${p.folder}/${p.pkg!.files.video}`;
const fileOf = (p: ScannedPackage, over: Partial<{ bytes: number; mtimeMs: number; hash: string }> = {}) => ({ [videoPath(p)]: { bytes: 1000, mtimeMs: 1, hash: HASH_A, ...over } });

test("AC-AU-01: switched off (the default) a ready, matching package is never queued and nothing is hashed", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], enabled: false, files: fileOf(p) });
  const result = await h.auto.tick();
  assert.deepEqual(result, { enabled: false, queued: [], waiting: null, reasons: [] });
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
    triedHashes: async () => new Set(),
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
    logWaiting: async () => undefined,
    saveWaiting: async () => undefined,
    waiting: new Map(),
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
  assert.deepEqual(await h.auto.tick(), {
    enabled: true,
    queued: [],
    waiting: "upload_daily_limit",
    reasons: [{ kind: "package", channelId: CHANNEL, video: "V65", manifestSha256: "mf-1", reason: "upload_daily_limit" }],
  });
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
    triedHashes: async () => new Set(),
    videoFile: async () => ({ path: "/ws/v", bytes: 1000, mtimeMs: 1 }),
    hashFile: async () => HASH_A,
    queue: async () => {
      throw new Error("must not queue");
    },
    logMismatch: async () => undefined,
    hashCache: new Map(),
    loggedMismatches: new Set(),
    logWaiting: async () => undefined,
    saveWaiting: async () => undefined,
    waiting: new Map(),
  });
  assert.deepEqual((await auto.tick()).queued, []);
  assert.equal(h.state.rows.length, 0);
});

// BL-209 follow-up (coordinator, Q2 + Q4): a ready, matching package that cannot be queued now, or a channel that is skipped, is
// recorded once per (manifest hash, reason) or (channel, reason) change -- one `publishing.upload_auto_waiting` event and the list
// shown on the Settings card -- never again on every tick while nothing changes.
test("waiting reasons: logged and saved once per change, not every tick; a cleared reason is dropped and logged again if it returns", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  const entry = (reason: string): AutoUploadWaiting => ({ kind: "package", channelId: CHANNEL, video: "V65", manifestSha256: "mf-1", reason });
  h.state.insertsToday = 100;
  await h.auto.tick();
  await h.auto.tick();
  await h.auto.tick();
  assert.deepEqual(h.state.waitingLog, [entry("upload_daily_limit")]);
  assert.deepEqual(h.state.saved, [[entry("upload_daily_limit")]]);
  // The reason changes (the bucket has room, the pool is now short): logged once more, then not again.
  h.state.insertsToday = 0;
  h.state.quotaShort = true;
  await h.auto.tick();
  await h.auto.tick();
  assert.deepEqual(h.state.waitingLog, [entry("upload_daily_limit"), entry("quota_insufficient")]);
  assert.deepEqual(h.state.saved, [[entry("upload_daily_limit")], [entry("quota_insufficient")]]);
  // Queued at last: the reason is gone, the card's list is empty again; nothing new is logged.
  h.state.quotaShort = false;
  const result = await h.auto.tick();
  assert.deepEqual([result.queued.map((q) => q.video), result.reasons], [["V65"], []]);
  assert.equal(h.state.waitingLog.length, 2);
  assert.deepEqual(h.state.saved.at(-1), []);
});

test("waiting reasons: a refusal for one package (tags over 500 characters) is recorded once with its code; the reason changing is logged again", async () => {
  // 26 tags of 20 characters: 26 × 20 + 25 commas = 545 characters, over YouTube's 500 (the package's own check counts them too,
  // so the package's tags stay short and the CHANNEL's tags -- used when the package has none -- are the long ones).
  const p = scanned(release("V65", { tags: [] }), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  const longTags = Array.from({ length: 26 }, (_, i) => `tag${String(i).padStart(2, "0")}${"x".repeat(15)}`);
  const auto = createAutoPrivateUpload({
    enabled: async () => true,
    channels: async () => [{ channelId: CHANNEL, userId: OWNER }],
    scan: async () => ({ status: "ok", packages: [p] }),
    liveVideos: async () => new Set(),
    peerUploads: async () => new Map(),
    triedHashes: async () => new Set(),
    videoFile: async () => ({ path: "/ws/v", bytes: 1000, mtimeMs: 1 }),
    hashFile: async () => HASH_A,
    queue: (input) =>
      createUploadApproval({
        scan: async () => ({ status: "ok", packages: [p] }),
        settings: async () => ({ channelId: CHANNEL, settings: { ...SETTINGS, channelTags: longTags }, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: [], conflictedFields: [] }),
        liveVideos: async () => new Set(),
        peerUploads: async () => new Map(),
        insertsToday: async () => 0,
        pending: async () => ({ inserts: 0, units: 0 }),
        checkUnits: async (units) => ({ decision: "allow", estimatedUnits: units, remainingUnits: 9000 }),
        insert: async () => true,
        newId: () => "up-x",
        audit: async () => undefined,
        clock: { now: () => NOW },
      }).queueAutomatic(input),
    logMismatch: async () => undefined,
    hashCache: new Map(),
    loggedMismatches: new Set(),
    logWaiting: async (entry) => void h.state.waitingLog.push(entry),
    saveWaiting: async (entries) => void h.state.saved.push(entries),
    waiting: new Map(),
  });
  await auto.tick();
  await auto.tick();
  assert.deepEqual(h.state.waitingLog, [{ kind: "package", channelId: CHANNEL, video: "V65", manifestSha256: "mf-1", reason: "upload_tags_too_long" }]);
  assert.equal(h.state.saved.length, 1);
});

test("waiting reasons: a channel without a connected account or without a workspace is recorded once per (channel, reason) change", async () => {
  const p = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p) });
  h.state.channels = [{ channelId: "UC_other", userId: null }];
  await h.auto.tick();
  await h.auto.tick();
  assert.deepEqual(h.state.waitingLog, [{ kind: "channel", channelId: "UC_other", reason: "no_connected_account" }]);
  assert.deepEqual(h.state.saved, [[{ kind: "channel", channelId: "UC_other", reason: "no_connected_account" }]]);
  // The channel connected but its workspace is missing: a new reason for the same channel, logged once.
  h.state.channels = [{ channelId: "UC_other", userId: OWNER }];
  h.state.noWorkspace = true;
  await h.auto.tick();
  await h.auto.tick();
  assert.deepEqual(h.state.waitingLog.map((e) => e.reason), ["no_connected_account", "no_workspace"]);
  // Switched off: nothing waits any more -- the card's list is cleared once.
  h.state.enabled = false;
  await h.auto.tick();
  await h.auto.tick();
  assert.deepEqual(h.state.saved.slice(2), [[]]);
});

// BL-209 independent review fixes (coordinator): M1, M2(b), L1, L3, L4.
test("review M1: a manifest version the owner approved and then cancelled is never queued by the automatic upload", async () => {
  const p = scanned(release("V65"), "mf-1");
  // The owner's own approval of this very manifest version, cancelled before YouTube (it no longer holds the package).
  const first = harness({ packages: [p], files: fileOf(p) });
  await first.auto.tick();
  const manual: StoredPublishingUpload = { ...first.state.rows[0], id: "manual-1", automatic: false, status: "cancelled", finishedAt: NOW };
  assert.equal(holdsPackage(manual), false);
  const h = harness({ packages: [p], files: fileOf(p) });
  h.state.rows.push(manual);
  assert.deepEqual((await h.auto.tick()).queued, []);
  assert.deepEqual([h.state.rows.length, h.state.hashCalls.length], [1, 0]);
});

test("review M2(b): a package another computer reports in any state (uploading or uploaded) is skipped before any hash", async () => {
  for (const uploaded of [false, true]) {
    const p = scanned(release("V65"), "mf-1");
    const h = harness({ packages: [p], files: fileOf(p) });
    h.state.peers.set("V65", { host: "Windows", uploaded });
    assert.deepEqual((await h.auto.tick()).queued, [], String(uploaded));
    assert.deepEqual([h.state.rows.length, h.state.hashCalls.length], [0, 0]);
  }
});

test("review L1: the first tick after a start always saves the list, so a reason stored before a restart is cleared (on and off)", async () => {
  const p = scanned(release("V65"), "mf-1");
  const on = harness({ packages: [p], files: fileOf(p) });
  on.state.packages = []; // nothing waits now
  await on.auto.tick();
  await on.auto.tick();
  assert.deepEqual(on.state.saved, [[]], "saved once after the start, not again while nothing changes");
  const off = harness({ packages: [p], files: fileOf(p), enabled: false });
  await off.auto.tick();
  await off.auto.tick();
  assert.deepEqual(off.state.saved, [[]]);
});

test("review L3: switched off while a video is hashed -- the standing reasons are cleared and nothing is queued", async () => {
  const a = scanned(release("V65"), "mf-1");
  const h = harness({ packages: [a], files: fileOf(a) });
  h.state.insertsToday = 100;
  await h.auto.tick(); // V65 waits for the bucket
  assert.deepEqual(h.state.saved.at(-1)?.map((e) => e.reason), ["upload_daily_limit"]);
  h.state.insertsToday = 0;
  let reads = 0;
  const auto = createAutoPrivateUpload({
    enabled: async () => ++reads === 1,
    channels: async () => [{ channelId: CHANNEL, userId: OWNER }],
    scan: async () => ({ status: "ok", packages: [a] }),
    liveVideos: async () => new Set(),
    peerUploads: async () => new Map(),
    triedHashes: async () => new Set(),
    videoFile: async () => ({ path: "/ws/v", bytes: 1000, mtimeMs: 1 }),
    hashFile: async () => HASH_A,
    queue: async () => {
      throw new Error("must not queue");
    },
    logMismatch: async () => undefined,
    hashCache: new Map(),
    loggedMismatches: new Set(),
    logWaiting: async () => undefined,
    saveWaiting: async (entries) => void h.state.saved.push(entries),
    waiting: new Map([["package|UC_t|mf-1", { kind: "package", channelId: CHANNEL, video: "V65", manifestSha256: "mf-1", reason: "upload_daily_limit" }]]),
  });
  const result = await auto.tick();
  assert.deepEqual([result.queued, result.reasons], [[], []]);
  assert.deepEqual(h.state.saved.at(-1), []);
});

test("review L4: one channel's failure does not stop the others; it is recorded once as that channel's reason", async () => {
  const p = scanned(release("V65"), "mf-1");
  const queued: string[] = [];
  const log: AutoUploadWaiting[] = [];
  const auto = createAutoPrivateUpload({
    enabled: async () => true,
    channels: async () => [
      { channelId: "UC_broken", userId: OWNER },
      { channelId: CHANNEL, userId: OWNER },
    ],
    scan: async (channelId) => {
      if (channelId === "UC_broken") throw new Error("database is locked");
      return { status: "ok", packages: [p] };
    },
    liveVideos: async () => new Set(queued),
    peerUploads: async () => new Map(),
    triedHashes: async () => new Set(),
    videoFile: async () => ({ path: "/ws/v", bytes: 1000, mtimeMs: 1 }),
    hashFile: async () => HASH_A,
    queue: async (input) => {
      queued.push("V65");
      return { id: `up-${input.channelId}`, video: "V65" };
    },
    logMismatch: async () => undefined,
    hashCache: new Map(),
    loggedMismatches: new Set(),
    logWaiting: async (entry) => void log.push(entry),
    saveWaiting: async () => undefined,
    waiting: new Map(),
  });
  const first = await auto.tick();
  await auto.tick();
  assert.deepEqual(first.queued.map((q) => [q.channelId, q.video]), [[CHANNEL, "V65"]]);
  assert.deepEqual(log, [{ kind: "channel", channelId: "UC_broken", reason: "channel_failed" }]);
});

// ---------------------------------------------------------------------------------------------------------------------------
// BL-225 stage 3 (WEEKLY_PUBLISHING_PLAN.md AC-WP-30/31; ADR 0051 §7; FO-REQ-0040 items 3 and 5; owner msg 3537: the computer with
// the switch on uploads approved slots). A v2 package names a slot: approved and more than 15 minutes ahead -> queued with the
// slot's time (written last by the runner); vetoed -> never queued; not approved, too close, or no plan module -> private without
// a date, exactly as before. Values by hand: NOW is 2026-10-21 12:00Z.
// ---------------------------------------------------------------------------------------------------------------------------

test("AC-WP-30: an approved slot gives the automatic upload its time; the row names the slot", async () => {
  const p = scanned(release("V65", { slotId: "w44-fri", schemaVersion: 2 }), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p), slots: new Map([["w44-fri", { kind: "approved", publishAt: "2026-10-30T09:00:00.000Z" }]]) });
  await h.auto.tick();
  assert.deepEqual([h.state.rows[0].publishAt, h.state.rows[0].slotId, h.state.rows[0].automatic], ["2026-10-30T09:00:00.000Z", "w44-fri", true]);
  assert.deepEqual([h.state.audits[0].publishAt, h.state.audits[0].publish, h.state.audits[0].slotId], ["2026-10-30T09:00:00.000Z", true, "w44-fri"]);
});

test("AC-WP-31: a vetoed slot's package is never queued (the reason is recorded); a pending or unknown slot uploads without a date", async () => {
  const vetoed = scanned(release("V65", { slotId: "w44-fri", schemaVersion: 2 }), "mf-1");
  const v = harness({ packages: [vetoed], files: fileOf(vetoed), slots: new Map([["w44-fri", { kind: "vetoed" }]]) });
  const result = await v.auto.tick();
  assert.equal(v.state.rows.length, 0);
  assert.deepEqual(result.reasons.map((r) => r.reason), ["slot_vetoed"]);
  assert.equal(v.state.hashCalls.length, 0, "a vetoed slot's video is not even hashed");
  for (const slots of [new Map<string, SlotDecision>([["w44-fri", { kind: "pending" }]]), new Map<string, SlotDecision>(), undefined]) {
    const p = scanned(release("V65", { slotId: "w44-fri", schemaVersion: 2 }), "mf-1");
    const h = harness({ packages: [p], files: fileOf(p), ...(slots ? { slots } : {}) });
    await h.auto.tick();
    assert.deepEqual([h.state.rows.length, h.state.rows[0].publishAt], [1, null], JSON.stringify(slots ? [...slots] : "no plan module"));
  }
});

test("AC-WP-31: an approved slot 15 minutes ahead or less is not given to the upload (private, no date)", async () => {
  const p = scanned(release("V65", { slotId: "w44-fri", schemaVersion: 2 }), "mf-1");
  const h = harness({ packages: [p], files: fileOf(p), slots: new Map([["w44-fri", { kind: "approved", publishAt: "2026-10-21T12:15:00.000Z" }]]) });
  await h.auto.tick();
  assert.equal(h.state.rows[0].publishAt, null);
});
