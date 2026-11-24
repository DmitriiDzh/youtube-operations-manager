import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { READ_BACK_RETRIES } from "@/lib/video-details/read-back";
import { DEFAULT_PUBLISHING_SETTINGS, type PublishingSettings } from "./settings";
import { createUploadRunner, type ApprovedPackage, type UploadRunnerDeps, type VideoReadBack } from "./upload-runner";

// Package playlists at upload (owner, Telegram 4858/4859, 2026-11-24). Requirements, written before the code:
// - right after a successful upload, in the playlist step, the video is added to every playlist its package names plus the
//   channel's publishing playlist (settings), each once (an id in both is the settings playlist);
// - idempotent: a playlist that already holds the video is `already_there`, nothing written; each add is read back
//   (playlistItems by video) and is `added` only when the read shows it; a read-back that never shows it fails that playlist
//   without a second insert;
// - each package playlist must belong to the upload's channel (a read through the read gateway); an unknown or foreign id fails that
//   playlist only and is never written;
// - the identity check runs before every playlist write (one playlist per pass), Live writes off pauses the job (never fails it);
// - the date rule: a failed SETTINGS playlist withholds the date (unchanged); a failed PACKAGE playlist does not -- it is reported
//   (the upload row's steps and notes, errorCode step_failed, the audit) and the date still goes on.
// Expected values worked out by hand from these rules.

const NOW = new Date("2026-11-24T12:00:00Z");
const PUBLISH_AT = "2026-11-30T12:00:00.000Z";
const CHANNEL = "UC_wwe";
const PKG: ApprovedPackage = {
  video: "V70",
  title: "Long video",
  description: "Text.",
  tags: ["wwe"],
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  manifestPath: "04 Videos/V70/V70_release.json",
  videoFile: "04 Videos/V70/V70 Long.mp4",
  thumbnailFile: "04 Videos/V70/Thumbnail_V70_A.jpg",
  sizeBytes: 10,
};
const SETTINGS: PublishingSettings = { ...DEFAULT_PUBLISHING_SETTINGS, playlistId: "PL_set" };

function finishingRow(pkg: Partial<ApprovedPackage>, settings: Partial<PublishingSettings> = {}, over: Partial<StoredPublishingUpload> = {}): StoredPublishingUpload {
  return {
    id: "u1",
    channelId: CHANNEL,
    video: "V70",
    manifestPath: PKG.manifestPath,
    manifestSha256: "sha",
    packageJson: JSON.stringify({ ...PKG, ...pkg }),
    settingsJson: JSON.stringify({ ...SETTINGS, ...settings }),
    publishAt: PUBLISH_AT,
    approvedBy: "u-owner",
    approvedAt: NOW,
    status: "finishing",
    resumeStatus: null,
    pausedReason: null,
    pausedUntil: null,
    sessionUri: null,
    totalBytes: 10,
    storedBytes: 10,
    videoId: "vid1",
    publishAtAtInsert: false,
    // The upload and the steps before the playlist are done: the next pass starts at the playlist step.
    stepsJson: JSON.stringify({ uploadedAt: NOW.toISOString(), localizations: "none", captions: "none", thumbnail: "set" }),
    errorCode: null,
    errorMessage: null,
    attempts: 0,
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
    ...over,
  };
}

type Fault = { kind: "refuse" } | { kind: "lose_answer" } | { kind: "live_writes_off" };

function harness(row: StoredPublishingUpload, options: { owners?: Record<string, string | null>; withOwnerRead?: boolean } = {}) {
  const store = new Map([[row.id, { ...row }]]);
  const clock = { at: NOW };
  /** What YouTube holds: playlist id -> its videos. */
  const playlistContents = new Map<string, Set<string>>();
  /** Every call in order: identity checks, ownership reads, membership reads, inserts, the date. */
  const calls: string[] = [];
  const inserts: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const publishAtWrites: string[] = [];
  /** Playlists whose inserts YouTube answers 200 but never shows (read-back stays empty). */
  const invisible = new Set<string>();
  const faults = new Map<string, Fault[]>();
  /** Ownership reads that throw: `refuse` a 403 (given up at once), `timeout` an ambiguous error (retried, then given up). */
  const ownerFaults = new Map<string, "refuse" | "timeout">();
  /** Membership reads of a playlist that answer "not there" although the item exists (YouTube's lag), counted down per read. */
  const lagReads = new Map<string, number>();
  /** Membership reads that throw an ambiguous error (counted down; Infinity: always). */
  const readFaults = new Map<string, number>();
  let liveWrites = true;
  let datePublished: string | null = null;
  const owners = options.owners ?? {};
  const pkg = JSON.parse(row.packageJson) as ApprovedPackage;
  const settings = JSON.parse(row.settingsJson) as PublishingSettings;
  const deps: UploadRunnerDeps = {
    store: {
      listActive: async () => [...store.values()].filter((r) => ["queued", "uploading", "processing", "finishing", "paused"].includes(r.status)).map((r) => ({ ...r })),
      update: async (id, from, set) => {
        const current = store.get(id);
        if (!current || current.status !== from) return false;
        store.set(id, { ...current, ...set });
        return true;
      },
      claim: async (id) => Boolean(store.get(id)),
    },
    credentials: async (j) => ({ credentialRef: { userId: j.approvedBy }, credentials: { token: "t" } }),
    assertWriteChannel: async ({ channelId }) => {
      calls.push(`identity ${channelId}`);
    },
    accessToken: async () => "access",
    liveWritesEnabled: async () => liveWrites,
    gateway: {
      begin: async () => assert.fail("no upload in these tests"),
      putChunk: async () => assert.fail("no upload in these tests"),
      queryOffset: async () => assert.fail("no upload in these tests"),
      setThumbnail: async () => assert.fail("the thumbnail step already ran"),
      async addToPlaylist(_c, videoId, playlistId) {
        // The adapter checks Live writes right before its gateway call (ADR 0005): off -> live_writes_disabled, nothing written.
        if (!liveWrites) throw new DomainError({ code: "live_writes_disabled", message: "off" });
        const fault = faults.get(playlistId)?.shift();
        if (fault?.kind === "live_writes_off") {
          liveWrites = false;
          throw new DomainError({ code: "live_writes_disabled", message: "off" });
        }
        if (fault?.kind === "refuse") throw new DomainError({ code: "update_failed", message: "forbidden", details: { status: 403, reason: "playlistForbidden" } });
        calls.push(`insert ${playlistId}`);
        inserts.push(playlistId);
        if (!invisible.has(playlistId)) (playlistContents.get(playlistId) ?? playlistContents.set(playlistId, new Set()).get(playlistId)!).add(videoId);
        if (fault?.kind === "lose_answer") throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
      },
    },
    reads: {
      uploadState: async () => ({ uploadStatus: "processed", rejectionReason: null, failureReason: null, hasPaidProductPlacement: null, hasCustomThumbnail: true }),
      recentUploads: async () => [],
      playlistHasVideo: async (_c, playlistId, videoId) => {
        calls.push(`has ${playlistId}`);
        const failing = readFaults.get(playlistId) ?? 0;
        if (failing > 0) {
          readFaults.set(playlistId, failing - 1);
          throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
        }
        const present = playlistContents.get(playlistId)?.has(videoId) ?? false;
        const lag = lagReads.get(playlistId) ?? 0;
        if (present && lag > 0) {
          lagReads.set(playlistId, lag - 1);
          return false;
        }
        return present;
      },
      ...(options.withOwnerRead === false
        ? {}
        : {
            playlistChannel: async (_c: unknown, playlistId: string) => {
              calls.push(`owner ${playlistId}`);
              const ownerFault = ownerFaults.get(playlistId);
              if (ownerFault === "refuse") throw new DomainError({ code: "update_failed", message: "forbidden", details: { status: 403, reason: "forbidden" } });
              if (ownerFault === "timeout") throw Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
              return playlistId in owners ? owners[playlistId] : CHANNEL;
            },
          }),
      snapshot: async (): Promise<VideoReadBack> => ({
        title: pkg.title,
        description: pkg.description,
        tags: pkg.tags,
        categoryId: settings.categoryId,
        defaultLanguage: pkg.defaultLanguage,
        defaultAudioLanguage: pkg.defaultAudioLanguage,
        privacyStatus: "private",
        publishAt: datePublished,
        selfDeclaredMadeForKids: settings.madeForKids,
        license: settings.license,
        embeddable: settings.embeddable,
      }),
    },
    setPublishAt: async ({ publishAt }) => {
      calls.push(`publishAt ${publishAt}`);
      publishAtWrites.push(publishAt);
      datePublished = publishAt;
    },
    files: {
      resolve: async (_c, relativePath) => ({ path: `/ws/${relativePath}`, bytes: 100 }),
      readChunk: async () => Buffer.alloc(0),
      sha256: async () => "sha",
      writeRecord: async () => undefined,
    },
    audit: async ({ detail }) => void audits.push(detail),
    syncChannel: async () => undefined,
    device: async () => ({ deviceId: "mac-1", hostname: "Mac" }),
    clock: { now: () => new Date(clock.at) },
    nextQuotaReset: () => new Date("2026-11-25T08:00:00Z"),
    chunkBytes: 4,
    sliceMs: 60_000,
    runnerId: "runner-1",
  };
  const runner = createUploadRunner(deps);
  const current = () => store.get(row.id)!;
  async function runAll(limit = 60) {
    for (let i = 0; i < limit; i += 1) {
      await runner.tick();
      clock.at = new Date(clock.at.getTime() + 31_000);
      const r = current();
      if (r.status === "done" || r.status === "failed" || r.status === "paused") return;
    }
  }
  return {
    deps,
    runner,
    row: current,
    steps: () => JSON.parse(current().stepsJson),
    calls,
    inserts,
    audits,
    publishAtWrites,
    playlistContents,
    invisible,
    ownerFaults,
    lagReads,
    readFaults,
    faults,
    setLiveWrites: (on: boolean) => (liveWrites = on),
    runAll,
    clock,
  };
}

const entries = (steps: { playlists?: Array<{ playlistId: string; source: string; result: string; reason?: string }> }) =>
  (steps.playlists ?? []).map((e) => [e.playlistId, e.source, e.result, e.reason ?? null]);

test("AC-PP-10: the video goes into every package playlist and the settings playlist, each read back; the date goes on", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a", "PL_b"] }));
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.equal(h.row().errorCode, null);
  assert.deepEqual(h.inserts, ["PL_set", "PL_a", "PL_b"], "the settings playlist first, then the package's in its order");
  for (const id of ["PL_set", "PL_a", "PL_b"]) assert.ok(h.playlistContents.get(id)?.has("vid1"), id);
  const steps = h.steps();
  assert.equal(steps.playlist, "added", "steps.playlist keeps meaning the settings playlist");
  assert.deepEqual(entries(steps), [
    ["PL_set", "settings", "added", null],
    ["PL_a", "package", "added", null],
    ["PL_b", "package", "added", null],
  ]);
  assert.equal(steps.publishAt, "set");
  assert.deepEqual(h.publishAtWrites, [PUBLISH_AT]);
});

test("AC-PP-11: each playlist write has its own identity check right before it; package playlists are checked for ownership first", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  await h.runAll();
  const playlistCalls = h.calls.filter((c) => !c.startsWith("publishAt"));
  const insertAt = (id: string) => playlistCalls.indexOf(`insert ${id}`);
  const lastIdentityBefore = (index: number) => playlistCalls.slice(0, index).lastIndexOf(`identity ${CHANNEL}`);
  for (const id of ["PL_set", "PL_a"]) {
    const at = insertAt(id);
    assert.ok(at > 0, `${id} inserted`);
    const identity = lastIdentityBefore(at);
    assert.ok(identity >= 0, `an identity check before ${id}`);
    // Between that identity check and the insert there is no other playlist's insert (one playlist per pass).
    assert.equal(playlistCalls.slice(identity + 1, at).some((c) => c.startsWith("insert")), false, `${id}: its own pass`);
  }
  assert.ok(playlistCalls.indexOf("owner PL_a") < insertAt("PL_a"), "ownership read before the package playlist's write");
  assert.equal(playlistCalls.includes("owner PL_set"), false, "the owner's own settings playlist is written as before");
  // Read-back: a membership read after each insert.
  for (const id of ["PL_set", "PL_a"]) assert.ok(playlistCalls.lastIndexOf(`has ${id}`) > insertAt(id), `${id} read back`);
});

test("AC-PP-12: an id in both the package and the settings is written once, as the settings playlist", async () => {
  const h = harness(finishingRow({ playlists: ["PL_set", "PL_a"] }));
  await h.runAll();
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"]);
  assert.deepEqual(entries(h.steps()), [
    ["PL_set", "settings", "added", null],
    ["PL_a", "package", "added", null],
  ]);
});

test("AC-PP-13: a playlist that already holds the video is already_there -- nothing written", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.playlistContents.set("PL_a", new Set(["vid1"]));
  h.playlistContents.set("PL_set", new Set(["vid1"]));
  await h.runAll();
  assert.deepEqual(h.inserts, []);
  const steps = h.steps();
  assert.equal(steps.playlist, "already_there");
  assert.deepEqual(entries(steps), [
    ["PL_set", "settings", "already_there", null],
    ["PL_a", "package", "already_there", null],
  ]);
  assert.equal(steps.publishAt, "set");
});

test("AC-PP-14: a foreign or unknown package playlist fails that playlist only, is never written, and does not withhold the date", async () => {
  const h = harness(finishingRow({ playlists: ["PL_foreign", "PL_a", "PL_gone"] }), { owners: { PL_foreign: "UC_someone_else", PL_gone: null } });
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"], "nothing is ever added to another channel's or an unknown playlist");
  assert.equal(h.calls.includes("has PL_foreign"), false, "a foreign playlist is not even read further");
  const steps = h.steps();
  assert.deepEqual(entries(steps), [
    ["PL_set", "settings", "added", null],
    ["PL_foreign", "package", "failed", "other_channel"],
    ["PL_a", "package", "added", null],
    ["PL_gone", "package", "failed", "not_found"],
  ]);
  assert.equal(steps.playlist, "added");
  assert.equal(steps.publishAt, "set", "a failed package playlist never withholds the date");
  assert.deepEqual(h.publishAtWrites, [PUBLISH_AT]);
  assert.equal(h.row().errorCode, "step_failed", "reported on the upload row");
  assert.ok(steps.notes.some((n: string) => n.includes("PL_foreign")), "the note names the playlist");
  assert.ok(steps.notes.some((n: string) => n.includes("PL_gone")));
});

test("AC-PP-15: without an ownership read on this computer, a package playlist fails closed (never written)", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }), { withOwnerRead: false });
  await h.runAll();
  assert.deepEqual(h.inserts, ["PL_set"]);
  assert.deepEqual(entries(h.steps()).at(-1), ["PL_a", "package", "failed", "ownership_unchecked"]);
  assert.equal(h.steps().publishAt, "set");
});

test("AC-PP-16: a package playlist whose read-back never shows the video is re-read, never inserted twice, then failed; the date goes on", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.invisible.add("PL_a");
  await h.runAll();
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"], "one insert only");
  assert.equal(h.calls.filter((c) => c === "has PL_a").length, 1 + 1 + READ_BACK_RETRIES, "the check before, the read-back, then the re-reads");
  const steps = h.steps();
  assert.deepEqual(entries(steps).at(-1), ["PL_a", "package", "failed", "read_back_missing"]);
  assert.equal(steps.publishAt, "set");
  assert.equal(h.row().errorCode, "step_failed");
});

// Changed after the independent review (coordinator's decision, AGENTS.md §D -- keep today's behaviour for the owner's own playlist):
// for the SETTINGS playlist a 200 from playlistItems.insert counts as added, as it did before this branch; the read-back still runs
// and, when it never shows the item, records `added_unverified` with a note -- never a failure, never a withheld date. The first
// version of this test (read-back failure withholds the date) asserted a rule the requirement does not make for this playlist.
test("AC-PP-17: the settings playlist's read-back that never shows the item is added_unverified -- a note, the date goes on", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.invisible.add("PL_set");
  await h.runAll();
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"], "one insert each");
  assert.equal(h.calls.filter((c) => c === "has PL_set").length, 1 + 1 + READ_BACK_RETRIES, "the check before, the read-back, the re-reads");
  const steps = h.steps();
  assert.equal(steps.playlist, "added", "the date rule sees the settings playlist as added (the 200)");
  assert.deepEqual(entries(steps), [
    ["PL_set", "settings", "added_unverified", null],
    ["PL_a", "package", "added", null],
  ]);
  assert.ok(steps.notes.some((n: string) => n.includes("PL_set")), "a note says the read-back did not show it");
  assert.equal(steps.publishAt, "set");
  assert.deepEqual(h.publishAtWrites, [PUBLISH_AT]);
  assert.equal(h.row().errorCode, null, "not a failed step");
});

test("AC-PP-23: an ownership read refused (4xx) fails that playlist only (ownership_unreadable); the next package playlist still runs", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a", "PL_b"] }));
  h.ownerFaults.set("PL_a", "refuse");
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.inserts, ["PL_set", "PL_b"], "PL_a never written, PL_b tried");
  const steps = h.steps();
  assert.deepEqual(entries(steps), [
    ["PL_set", "settings", "added", null],
    ["PL_a", "package", "failed", "ownership_unreadable"],
    ["PL_b", "package", "added", null],
  ]);
  assert.equal(steps.playlist, "added");
  assert.equal(steps.publishAt, "set", "a package playlist's failure never withholds the date");
  assert.equal(h.row().errorCode, "step_failed");
  assert.ok(h.audits.some((a) => a.event === "publishing.upload_playlist" && a.playlistId === "PL_a" && a.reason === "ownership_unreadable"));
});

test("AC-PP-24: an ownership read that times out past the retries fails that playlist only; the next package playlist still runs", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a", "PL_b"] }));
  h.ownerFaults.set("PL_a", "timeout");
  await h.runAll(400);
  assert.equal(h.row().status, "done");
  assert.ok(h.calls.filter((c) => c === "owner PL_a").length > 1, "retried before giving up");
  assert.deepEqual(h.inserts, ["PL_set", "PL_b"]);
  assert.deepEqual(entries(h.steps()), [
    ["PL_set", "settings", "added", null],
    ["PL_a", "package", "failed", "ownership_unreadable"],
    ["PL_b", "package", "added", null],
  ]);
  assert.equal(h.steps().publishAt, "set");
});

test("AC-PP-25: a lost insert answer followed by lagging reads is re-read, never inserted twice; seen in time it is added", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.faults.set("PL_a", [{ kind: "lose_answer" }]);
  h.lagReads.set("PL_a", READ_BACK_RETRIES); // the item shows only on the last allowed read
  await h.runAll(200);
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"], "one insert");
  assert.deepEqual(entries(h.steps()).at(-1), ["PL_a", "package", "added", null]);
  assert.equal(h.steps().publishAt, "set");
});

test("AC-PP-26: a lost insert answer never seen within the re-reads is unknown_outcome -- no second insert; the date goes on", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.faults.set("PL_a", [{ kind: "lose_answer" }]);
  h.lagReads.set("PL_a", 1000);
  await h.runAll(200);
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"], "one insert");
  assert.equal(h.calls.filter((c) => c === "has PL_a").length, 1 + 1 + READ_BACK_RETRIES, "the check before, then 1 + READ_BACK_RETRIES reads after the lost answer");
  assert.deepEqual(entries(h.steps()).at(-1), ["PL_a", "package", "failed", "unknown_outcome"]);
  assert.equal(h.steps().publishAt, "set");
  assert.equal(h.row().errorCode, "step_failed");
});

test("AC-PP-27: a package read-back that keeps failing to read past the retries is read_back_unreadable (one insert)", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  // The check before the insert passes; every read after it throws.
  const realInsert = h.deps.gateway.addToPlaylist;
  h.deps.gateway.addToPlaylist = async (c, v, p) => {
    await realInsert(c, v, p);
    if (p === "PL_a") h.readFaults.set("PL_a", Number.POSITIVE_INFINITY);
  };
  await h.runAll(400);
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"]);
  assert.deepEqual(entries(h.steps()).at(-1), ["PL_a", "package", "failed", "read_back_unreadable"]);
  assert.equal(h.steps().publishAt, "set");
});

test("AC-PP-18: a refused insert of a package playlist fails it only; the date goes on. A refused settings playlist withholds it.", async () => {
  const pkgRefused = harness(finishingRow({ playlists: ["PL_a", "PL_b"] }));
  pkgRefused.faults.set("PL_a", [{ kind: "refuse" }]);
  await pkgRefused.runAll();
  assert.deepEqual(pkgRefused.inserts, ["PL_set", "PL_b"]);
  assert.deepEqual(entries(pkgRefused.steps()), [
    ["PL_set", "settings", "added", null],
    ["PL_a", "package", "failed", "write_failed"],
    ["PL_b", "package", "added", null],
  ]);
  assert.equal(pkgRefused.steps().publishAt, "set");
  assert.equal(pkgRefused.row().errorCode, "step_failed");

  const settingsRefused = harness(finishingRow({ playlists: ["PL_a"] }));
  settingsRefused.faults.set("PL_set", [{ kind: "refuse" }]);
  await settingsRefused.runAll();
  assert.deepEqual(settingsRefused.inserts, ["PL_a"]);
  assert.equal(settingsRefused.steps().playlist, "failed");
  assert.equal(settingsRefused.steps().publishAt, "withheld");
  assert.deepEqual(settingsRefused.publishAtWrites, []);
});

test("AC-PP-19: a lost answer to an insert is asked again by reading, never by a second insert", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.faults.set("PL_a", [{ kind: "lose_answer" }]);
  await h.runAll();
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"]);
  assert.deepEqual(entries(h.steps()).at(-1), ["PL_a", "package", "added", null]);
  assert.equal(h.steps().publishAt, "set");
});

test("AC-PP-20: Live writes off at a playlist write pauses the job (nothing failed); back on, it goes on where it stood", async () => {
  const h = harness(finishingRow({ playlists: ["PL_a"] }));
  h.faults.set("PL_a", [{ kind: "live_writes_off" }]);
  await h.runAll();
  assert.equal(h.row().status, "paused");
  assert.equal(h.row().pausedReason, "live_writes_off");
  assert.deepEqual(h.inserts, ["PL_set"]);
  h.setLiveWrites(true);
  await h.runAll();
  assert.equal(h.row().status, "done");
  assert.deepEqual(h.inserts, ["PL_set", "PL_a"]);
  assert.deepEqual(entries(h.steps()).at(-1), ["PL_a", "package", "added", null]);
});

test("AC-PP-21: a package without playlists and no settings playlist: none, nothing read or written (rows read as before)", async () => {
  const h = harness(finishingRow({}, { playlistId: null }));
  await h.runAll();
  assert.deepEqual(h.inserts, []);
  assert.equal(h.calls.some((c) => c.startsWith("has ") || c.startsWith("owner ")), false);
  const steps = h.steps();
  assert.equal(steps.playlist, "none");
  assert.equal(steps.playlists, undefined);
  // Only package playlists, no settings playlist: steps.playlist is none (the settings rule has nothing to say).
  const only = harness(finishingRow({ playlists: ["PL_a"] }, { playlistId: null }));
  await only.runAll();
  assert.deepEqual(only.inserts, ["PL_a"]);
  assert.equal(only.steps().playlist, "none");
  assert.deepEqual(entries(only.steps()), [["PL_a", "package", "added", null]]);
});

test("AC-PP-22: the audit names each playlist's outcome", async () => {
  const h = harness(finishingRow({ playlists: ["PL_foreign", "PL_a"] }), { owners: { PL_foreign: "UC_other" } });
  await h.runAll();
  const perPlaylist = h.audits.filter((a) => a.event === "publishing.upload_playlist").map((a) => [a.playlistId, a.source, a.result, a.reason ?? null]);
  assert.deepEqual(perPlaylist, [
    ["PL_set", "settings", "added", null],
    ["PL_foreign", "package", "failed", "other_channel"],
    ["PL_a", "package", "added", null],
  ]);
  const done = h.audits.find((a) => a.event === "publishing.upload_done") as { steps: { playlists: unknown[] } };
  assert.equal(done.steps.playlists.length, 3);
});
