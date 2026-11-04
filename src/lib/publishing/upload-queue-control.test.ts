import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { isDomainError } from "@/lib/shared-domain";
import type { SlotDecision } from "./auto-upload";
import type { ScannedPackage } from "./package-scan";
import { DEFAULT_PUBLISHING_SETTINGS } from "./settings";
import { createUploadApproval } from "./upload-approval";
import { CANCELLED_BY_PRODUCER, createUploadQueueControl, type UploadQueueControlDeps } from "./upload-queue-control";

// BL-239 -- the upload queue's control against fakes. Requirements: docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md AC-UQ-03..08 and
// AC-UQ-10 (owner msgs 3928/3930: the Producer orders the queue of every channel, adds to it and cancels what has not started;
// ADR 0046's switch is the standing approval of private uploads from this computer; ADR 0051 §7: a date only from an approved slot).
// The add goes through the real approval's `queueByProducer`. Expected values are worked out by hand.

const NOW = new Date("2026-11-01T12:00:00Z");
const SHA = "a".repeat(64);
const SETTINGS = { ...DEFAULT_PUBLISHING_SETTINGS, playlistId: null };

function row(id: string, over: Partial<StoredPublishingUpload> = {}): StoredPublishingUpload {
  return {
    id,
    channelId: "UC_x",
    video: id.toUpperCase(),
    manifestPath: `p/${id}`,
    manifestSha256: `mf-${id}`,
    packageJson: JSON.stringify({ title: `Title ${id}` }),
    settingsJson: "{}",
    publishAt: null,
    approvedBy: "u-x",
    approvedAt: NOW,
    status: "queued",
    resumeStatus: null,
    pausedReason: null,
    pausedUntil: null,
    sessionUri: null,
    totalBytes: 100,
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
    automatic: false,
    slotId: null,
    queueRank: 0,
    queuedBy: "owner",
    ...over,
  };
}

function pkg(video: string, over: Partial<ScannedPackage> = {}, pkgOver: Record<string, unknown> = {}): ScannedPackage {
  const folder = `04 Videos/11 November/x ${video}`;
  return {
    manifestPath: `${folder}/${video}_release.json`,
    folder,
    video,
    title: `Title ${video}`,
    plannedPublishDate: null,
    thumbnailPath: `${folder}/Thumbnail_${video}_A.jpg`,
    sizeBytes: 1000,
    durationSeconds: 7200,
    state: "ready",
    problems: [],
    youtube: null,
    manifestSha256: `mf-${video}`,
    pkg: {
      channelId: "UC_x",
      video,
      mix: 1,
      plannedPublishDate: null,
      files: { video: `${video}.mp4`, thumbnail: `Thumbnail_${video}_A.jpg` },
      sizeBytes: 1000,
      durationSeconds: 7200,
      title: `Title ${video}`,
      description: "00:00 A",
      tags: ["jazz"],
      defaultLanguage: "en",
      defaultAudioLanguage: "en",
      ready: true,
      problems: [],
      sha256: SHA,
      ...pkgOver,
    },
    ...over,
  } as ScannedPackage;
}

const ACTIVE = new Set(["queued", "uploading", "processing", "finishing", "paused"]);

function harness(rows: StoredPublishingUpload[], options: { packages?: ScannedPackage[]; switchOn?: boolean | (() => boolean); slots?: Map<string, SlotDecision>; fileBytes?: number; fileHash?: string; peers?: string[]; connected?: boolean; race?: boolean } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const audits: Array<Record<string, unknown>> = [];
  const hashed: string[] = [];
  const mismatches: unknown[] = [];
  let id = 0;
  const switchOn = () => (typeof options.switchOn === "function" ? options.switchOn() : (options.switchOn ?? true));
  const approval = createUploadApproval({
    scan: async () => ({ status: "ok", removedVideoIds: [], packages: options.packages ?? [] }),
    settings: async () => ({ channelId: "UC_x", settings: SETTINGS, defaults: DEFAULT_PUBLISHING_SETTINGS, saved: [], conflictedFields: [] }),
    liveVideos: async () => new Set([...store.values()].filter((r) => ACTIVE.has(r.status) || r.status === "done").map((r) => r.video)),
    peerUploads: async () => new Map(),
    insertsToday: async () => 0,
    pending: async () => ({ inserts: 0, units: 0 }),
    checkUnits: async (units) => ({ decision: "allow", estimatedUnits: units, remainingUnits: 9000 }),
    insert: async (inserted) => {
      for (const [index, r] of inserted.entries()) store.set(r.id, { ...r, queueRank: r.queueRank || r.createdAt.getTime() + index });
      return true;
    },
    newId: () => `new-${++id}`,
    audit: async ({ detail }) => void audits.push(detail),
    clock: { now: () => NOW },
  });
  const deps: UploadQueueControlDeps = {
    listActive: async () => [...store.values()].filter((r) => ACTIVE.has(r.status)).map((r) => ({ ...r })),
    get: async (uploadId) => (store.has(uploadId) ? { ...store.get(uploadId)! } : null),
    reorder: async (ids) => {
      if (options.race) return false; // the runner took a queued row between the read and the write
      if (ids.some((i) => store.get(i)?.status !== "queued")) return false;
      ids.forEach((i, index) => store.set(i, { ...store.get(i)!, queueRank: index + 1 }));
      return true;
    },
    cancelQueued: async (uploadId, set) => {
      if (options.race) return false; // the runner took the row between the read and the compare-and-set
      const r = store.get(uploadId);
      if (!r || r.status !== "queued") return false;
      store.set(uploadId, { ...r, ...set });
      return true;
    },
    assertMutationAllowed: async () => undefined,
    autoSwitchOn: async () => switchOn(),
    channelTitles: async () => new Map([["UC_x", "Channel X"], ["UC_y", "Channel Y"]]),
    channelUser: async (channelId) => (options.connected === false ? null : channelId === "UC_x" ? "u-x" : null),
    scan: async () => ({ status: "ok", removedVideoIds: [], packages: options.packages ?? [] }),
    liveVideos: async () => new Set([...store.values()].filter((r) => ACTIVE.has(r.status) || r.status === "done").map((r) => r.video)),
    peerUploads: async () => new Map((options.peers ?? []).map((v) => [v, { host: "Windows", uploaded: false }])),
    blockedHashes: async () => new Set([...store.values()].filter((r) => !(r.status === "cancelled" && r.errorCode === CANCELLED_BY_PRODUCER && r.queuedBy === "producer")).map((r) => r.manifestSha256)),
    ...(options.slots ? { slotDecisions: async () => options.slots! } : {}),
    videoFile: async (_channelId, relativePath) => ({ path: `/ws/${relativePath}`, bytes: options.fileBytes ?? 1000, mtimeMs: 1 }),
    hashFile: async (path) => {
      hashed.push(path);
      return options.fileHash ?? SHA;
    },
    queue: (input) => approval.queueByProducer(input),
    logMismatch: async (args) => void mismatches.push(args),
    audit: async ({ detail }) => void audits.push(detail),
    clock: { now: () => NOW },
  };
  return { control: createUploadQueueControl(deps), store, audits, hashed, mismatches };
}

const PRODUCER = { kind: "producer" as const, tokenId: "tok-1" };
const OWNER = { kind: "owner" as const, userId: "u-owner" };
const refused = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
const order = async (h: ReturnType<typeof harness>) => (await h.control.list()).queue.map((entry) => entry.uploadId);

test("AC-UQ-03: the queue is every channel's queued rows by place, then age; a move puts a row at a place, the rest keep their order", async () => {
  const h = harness([
    row("a", { queueRank: 10 }),
    row("b", { queueRank: 20, channelId: "UC_y" }),
    row("c", { queueRank: 30 }),
    row("s", { status: "uploading", queueRank: 1 }),
  ]);
  assert.deepEqual(await order(h), ["a", "b", "c"]);
  const moved = await h.control.move({ channelId: "UC_x", uploadId: "c", position: 1 }, PRODUCER);
  assert.deepEqual(moved, { uploadId: "c", channelId: "UC_x", video: "C", from: 3, position: 1, queueLength: 3, moved: true });
  assert.deepEqual(await order(h), ["c", "a", "b"]);
  await h.control.move({ channelId: "UC_x", uploadId: "a", position: 3 }, PRODUCER);
  assert.deepEqual(await order(h), ["c", "b", "a"]);
  // Another channel's row moves the same way (one Producer over every channel, msg 3930 (а)); past the end is the end.
  await h.control.move({ channelId: "UC_y", uploadId: "b", position: 99 }, PRODUCER);
  assert.deepEqual(await order(h), ["c", "a", "b"]);
  assert.equal(h.store.get("s")!.status, "uploading", "the sending row is not touched");
  assert.equal(h.store.get("s")!.queueRank, 1);
  assert.deepEqual(h.audits.map((a) => [a.event, a.by, a.tokenId, a.uploadId, a.from, a.to]), [
    ["publishing.upload_queue_moved", "producer", "tok-1", "c", 3, 1],
    ["publishing.upload_queue_moved", "producer", "tok-1", "a", 2, 3],
    ["publishing.upload_queue_moved", "producer", "tok-1", "b", 2, 3],
  ]);
});

test("AC-UQ-03: the owner's ↑/↓ moves one place in the shared queue, audited as the owner; a move to the same place writes nothing", async () => {
  const h = harness([row("a", { queueRank: 1 }), row("b", { queueRank: 2, channelId: "UC_y" }), row("c", { queueRank: 3 })]);
  await h.control.moveStep({ channelId: "UC_x", uploadId: "c", direction: "up" }, OWNER);
  assert.deepEqual(await order(h), ["a", "c", "b"]);
  const top = await h.control.moveStep({ channelId: "UC_x", uploadId: "a", direction: "up" }, OWNER);
  assert.equal(top.moved, false);
  await h.control.moveStep({ channelId: "UC_x", uploadId: "a", direction: "down" }, OWNER);
  assert.deepEqual(await order(h), ["c", "a", "b"]);
  assert.deepEqual(h.audits.map((a) => [a.by, a.userId, a.uploadId]), [
    ["owner", "u-owner", "c"],
    ["owner", "u-owner", "a"],
  ]);
});

test("AC-UQ-04: a move refuses an unknown id, another channel's row, a row that is not queued, and a queue changed meanwhile", async () => {
  const h = harness([row("a", { queueRank: 1 }), row("b", { queueRank: 2 }), row("s", { status: "uploading" }), row("d", { status: "done" }), row("y", { channelId: "UC_y" })]);
  await refused(h.control.move({ channelId: "UC_x", uploadId: "nope", position: 1 }, PRODUCER), "upload_not_found");
  await refused(h.control.move({ channelId: "UC_x", uploadId: "y", position: 1 }, PRODUCER), "upload_not_found");
  await refused(h.control.move({ channelId: "UC_x", uploadId: "s", position: 1 }, PRODUCER), "upload_not_movable");
  await refused(h.control.move({ channelId: "UC_x", uploadId: "d", position: 1 }, PRODUCER), "upload_not_movable");
  await refused(h.control.moveStep({ channelId: "UC_x", uploadId: "s", direction: "up" }, OWNER), "upload_not_movable");
  // The runner takes a queued row between the read and the write: refused, nothing renumbered.
  const raced = harness([row("a", { queueRank: 1 }), row("b", { queueRank: 2 })], { race: true });
  await refused(raced.control.move({ channelId: "UC_x", uploadId: "b", position: 1 }, PRODUCER), "upload_queue_changed");
  assert.deepEqual([raced.store.get("a")!.queueRank, raced.store.get("b")!.queueRank], [1, 2]);
  assert.equal(h.audits.length + raced.audits.length, 0);
});

test("AC-UQ-05: the Producer cancels a queued row of any channel; never one that started; unknown or another channel's is not found", async () => {
  const h = harness([row("a"), row("y", { channelId: "UC_y" }), row("s", { status: "uploading" }), row("p", { status: "paused", resumeStatus: "queued" }), row("d", { status: "done" })]);
  const result = await h.control.cancel({ channelId: "UC_y", uploadId: "y" }, PRODUCER);
  assert.deepEqual(result, { uploadId: "y", channelId: "UC_y", video: "Y", status: "cancelled" });
  assert.deepEqual([h.store.get("y")!.status, h.store.get("y")!.errorCode, h.store.get("y")!.finishedAt?.toISOString()], ["cancelled", CANCELLED_BY_PRODUCER, NOW.toISOString()]);
  for (const id of ["s", "p", "d"]) await refused(h.control.cancel({ channelId: "UC_x", uploadId: id }, PRODUCER), "upload_not_cancellable");
  await refused(h.control.cancel({ channelId: "UC_x", uploadId: "y" }, PRODUCER), "upload_not_found");
  await refused(h.control.cancel({ channelId: "UC_x", uploadId: "zzz" }, PRODUCER), "upload_not_found");
  assert.deepEqual([h.store.get("s")!.status, h.store.get("p")!.status, h.store.get("d")!.status], ["uploading", "paused", "done"]);
  assert.deepEqual(h.audits, [{ event: "publishing.upload_cancelled", by: "producer", tokenId: "tok-1", at: NOW.toISOString(), uploadId: "y", video: "Y" }]);
});

test("AC-UQ-05: a row the runner took between the read and the cancel is not cancelled", async () => {
  const h = harness([row("a")], { race: true });
  await refused(h.control.cancel({ channelId: "UC_x", uploadId: "a" }, PRODUCER), "upload_not_cancellable");
  assert.deepEqual([h.store.get("a")!.status, h.audits.length], ["queued", 0]);
});

test("AC-UQ-06: the Producer adds a ready package: one private row without a date, marked producer, its SHA-256 frozen, last in the queue", async () => {
  const h = harness([row("a", { queueRank: 1 })], { packages: [pkg("V61")] });
  const result = await h.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER);
  assert.deepEqual(result.upload, { uploadId: "new-1", channelId: "UC_x", video: "V61", status: "queued", queuedBy: "producer", slotId: null, publishAt: null, position: 2, queueLength: 2 });
  const added = h.store.get("new-1")!;
  assert.deepEqual([added.status, added.publishAt, added.automatic, added.queuedBy, added.approvedBy], ["queued", null, false, "producer", "u-x"]);
  assert.equal(JSON.parse(added.packageJson).videoSha256, SHA, "the runner checks the file again before its session");
  assert.deepEqual(h.hashed, ["/ws/04 Videos/11 November/x V61/V61.mp4"]);
  const event = h.audits.find((a) => a.event === "publishing.upload_producer_queued")!;
  assert.deepEqual([event.by, event.tokenId, event.uploadId, event.video, event.manifestSha256, event.uploadPrivate, event.publish, event.publishAt], ["producer", "tok-1", "new-1", "V61", "mf-V61", true, false, null]);
  assert.deepEqual(await order(h), ["a", "new-1"]);
});

test("AC-UQ-07: an approved slot more than 15 min ahead gives the date; a pending slot none; a vetoed slot is refused", async () => {
  const approved = harness([], { packages: [pkg("V61", {}, { slotId: "w45-mon" })], slots: new Map([["w45-mon", { kind: "approved", publishAt: "2026-11-03T15:00:00.000Z" }]]) });
  assert.equal((await approved.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER)).upload.publishAt, "2026-11-03T15:00:00.000Z");
  assert.equal(approved.store.get("new-1")!.slotId, "w45-mon");
  const soon = harness([], { packages: [pkg("V61", {}, { slotId: "w45-mon" })], slots: new Map([["w45-mon", { kind: "approved", publishAt: "2026-11-01T12:10:00.000Z" }]]) });
  assert.equal((await soon.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER)).upload.publishAt, null, "10 minutes ahead: no date");
  const pending = harness([], { packages: [pkg("V61", {}, { slotId: "w45-mon" })], slots: new Map() });
  assert.equal((await pending.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER)).upload.publishAt, null);
  const vetoed = harness([], { packages: [pkg("V61", {}, { slotId: "w45-mon" })], slots: new Map([["w45-mon", { kind: "vetoed" }]]) });
  await refused(vetoed.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER), "upload_slot_vetoed");
  assert.deepEqual([vetoed.store.size, vetoed.hashed.length], [0, 0]);
});

test("AC-UQ-08: the add is refused, nothing queued, for every failed check; the size fails before any hash", async () => {
  const cases: Array<[string, ReturnType<typeof harness>, Record<string, unknown>]> = [
    ["upload_auto_switch_off", harness([], { packages: [pkg("V61")], switchOn: false }), {}],
    ["CHANNEL_NOT_ACTIVE", harness([], { packages: [pkg("V61")], connected: false }), {}],
    ["upload_package_not_ready", harness([], { packages: [pkg("V62")] }), {}],
    ["upload_package_not_ready", harness([], { packages: [pkg("V61", { state: "not_ready", problems: [{ code: "title_too_long" } as never] })] }), {}],
    ["upload_package_changed", harness([], { packages: [pkg("V61")] }), { manifestSha256: "b".repeat(64) }],
    ["upload_package_no_sha256", harness([], { packages: [pkg("V61", {}, { sha256: undefined })] }), {}],
    ["upload_already_queued", harness([row("q", { video: "V61", manifestSha256: "mf-other" })], { packages: [pkg("V61")] }), {}],
    ["upload_already_queued", harness([], { packages: [pkg("V61")], peers: ["V61"] }), {}],
    ["upload_already_tried", harness([row("f", { video: "V61", manifestSha256: "mf-V61", status: "failed" })], { packages: [pkg("V61")] }), {}],
    ["upload_already_tried", harness([row("o", { video: "V61", manifestSha256: "mf-V61", status: "cancelled" })], { packages: [pkg("V61")] }), {}],
    ["upload_video_mismatch", harness([], { packages: [pkg("V61")], fileBytes: 999 }), {}],
    ["upload_video_mismatch", harness([], { packages: [pkg("V61")], fileHash: "c".repeat(64) }), {}],
  ];
  for (const [code, h, extra] of cases) {
    const before = h.store.size;
    await refused(h.control.add({ channelId: "UC_x", video: "V61", ...extra }, PRODUCER), code);
    assert.equal(h.store.size, before, `${code}: nothing queued`);
  }
  assert.deepEqual(cases[10][1].hashed, [], "a different size is never hashed");
  assert.equal(cases[11][1].mismatches.length, 1, "a SHA-256 mismatch is logged");
  // The switch turned off while the file was hashed: refused before anything is queued.
  let reads = 0;
  const midway = harness([], { packages: [pkg("V61")], switchOn: () => ++reads < 2 });
  await refused(midway.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER), "upload_auto_switch_off");
  assert.equal(midway.store.size, 0);
});

test("AC-UQ-08: a version only the Producer cancelled can be added again; one the owner cancelled stays his", async () => {
  const h = harness([row("old", { video: "V61", manifestSha256: "mf-V61", status: "cancelled", errorCode: CANCELLED_BY_PRODUCER, queuedBy: "producer" })], { packages: [pkg("V61")] });
  const added = await h.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER);
  assert.equal(added.upload.status, "queued");
  // Review #4: the owner's approved row, cancelled by the Producer, stays his -- the Producer cannot queue it again under its name.
  const owners = harness([row("own", { video: "V61", manifestSha256: "mf-V61", status: "cancelled", errorCode: CANCELLED_BY_PRODUCER, queuedBy: "owner" })], { packages: [pkg("V61")] });
  await refused(owners.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER), "upload_already_tried");
});

test("AC-UQ-10: the list -- rows in progress apart; queued rows in order with their place, channel title and the bytes ahead", async () => {
  const h = harness([
    row("s", { status: "uploading", totalBytes: 1000, storedBytes: 400, createdAt: new Date(NOW.getTime() - 60_000) }),
    row("p", { status: "processing", totalBytes: 500, storedBytes: 500 }),
    row("a", { queueRank: 2, totalBytes: 300 }),
    row("b", { queueRank: 1, totalBytes: 200, channelId: "UC_y", queuedBy: "producer", slotId: "w45-mon", publishAt: "2026-11-03T15:00:00.000Z" }),
    row("x", { status: "done" }),
  ]);
  const list = await h.control.list();
  assert.equal(list.autoUploadSwitchOn, true);
  assert.deepEqual(list.inProgress.map((r) => [r.uploadId, r.status, r.progressPercent]), [
    ["s", "uploading", 40],
    ["p", "processing", 100],
  ]);
  // Bytes ahead by hand: the sending row has 1000 - 400 = 600 left; b is first (600), a follows b's 200 (800).
  assert.deepEqual(list.queue.map((r) => [r.position, r.uploadId, r.channelTitle, r.bytesAhead, r.queuedBy]), [
    [1, "b", "Channel Y", 600, "producer"],
    [2, "a", "Channel X", 800, "owner"],
  ]);
  assert.deepEqual([list.queue[0].title, list.queue[0].slotId, list.queue[0].publishAt, list.queue[0].publishAtSet], ["Title b", "w45-mon", "2026-11-03T15:00:00.000Z", false]);
  assert.deepEqual([list.queuedCount, list.queuedBytes], [2, 500]);
});

// BL-242 (ADR 0062 §3): the Producer's add uses the same check -- an approval of another manifest gives no date.
test("AC-WP-56: the Producer's add gets the slot's date only for the approved manifest", async () => {
  const fingerprint = (manifestSha256: string) => new Map([["w45-mon", { kind: "approved" as const, publishAt: "2026-11-03T15:00:00.000Z", package: { video: "V61", manifestSha256, videoId: null } }]]);
  const named = harness([], { packages: [pkg("V61", {}, { slotId: "w45-mon" })], slots: fingerprint("mf-V61") });
  assert.equal((await named.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER)).upload.publishAt, "2026-11-03T15:00:00.000Z");
  const other = harness([], { packages: [pkg("V61", {}, { slotId: "w45-mon" })], slots: fingerprint("mf-other") });
  assert.equal((await other.control.add({ channelId: "UC_x", video: "V61" }, PRODUCER)).upload.publishAt, null);
});
