import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import type { SlotDecision } from "./auto-upload";
import { createPlanSchedule, desiredDate, isVideoNotFound, RETRY_AFTER_MS } from "./plan-schedule";

// BL-225 stage 3 (WEEKLY_PUBLISHING_PLAN.md AC-WP-32 and the owner's answer 2, msg 3537; ADR 0051 §5, §10; FO-REQ-0040 item 5).
// Requirements: a vetoed slot's scheduled video loses its date and stays private, read back; a slot approved after its package was
// uploaded, or re-approved with a new time, gets that time on its video, read back -- only when the upload's own checks passed and
// the time is more than 15 minutes ahead; a pending slot is left alone; a video that is not private is never touched; nothing is
// written while Live writes are off. Values by hand: NOW is 2026-10-25 12:00Z.

const NOW = new Date("2026-10-25T12:00:00Z");
const OK_STEPS = { thumbnail: "set", playlist: "added", verify: { result: "verified", mismatches: [] }, publishAt: "set", localizations: "verified" };

function row(over: Partial<StoredPublishingUpload> = {}): StoredPublishingUpload {
  return {
    id: "u1",
    channelId: "UC_j",
    video: "V64",
    manifestPath: "m",
    manifestSha256: "h",
    packageJson: "{}",
    settingsJson: "{}",
    publishAt: "2026-10-26T09:00:00.000Z",
    approvedBy: "owner",
    approvedAt: NOW,
    status: "done",
    resumeStatus: null,
    pausedReason: null,
    pausedUntil: null,
    sessionUri: null,
    totalBytes: 1,
    storedBytes: 1,
    videoId: "vid64",
    publishAtAtInsert: false,
    stepsJson: JSON.stringify(OK_STEPS),
    errorCode: null,
    errorMessage: null,
    attempts: 1,
    nextAttemptAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    finishedAt: NOW,
    leaseOwner: null,
    leaseUntil: null,
    // BL-239 (schema v117): the queue place (0: the order falls back to createdAt) and who queued it.
    queueRank: 0,
    queuedBy: null,
    automatic: true,
    slotId: "w44-mon",
    ...over,
  };
}

function harness(
  initial: StoredPublishingUpload,
  decision: SlotDecision | undefined,
  video: { privacyStatus: string; publishAt: string | null } = { privacyStatus: "private", publishAt: initial.publishAt },
  removedVideoIds?: () => Promise<ReadonlySet<string>>
) {
  const state = { row: { ...initial }, video: { ...video }, writes: [] as Array<string | null>, audits: [] as Array<Record<string, unknown>>, reads: 0, liveWrites: true, dataReads: true, quotaOut: false, readBackWrong: false, now: NOW };
  const schedule = createPlanSchedule({
    rows: async () => [state.row],
    slotDecisions: async () => new Map(decision ? [["w44-mon", decision]] : []),
    ...(removedVideoIds ? { removedVideoIds } : {}),
    read: async () => {
      state.reads += 1;
      if (state.quotaOut) throw new DomainError({ code: "youtube_quota_exceeded", message: "quota" });
      return { ...state.video };
    },
    write: async (_row, publishAt) => {
      if (!state.liveWrites) throw new DomainError({ code: "live_writes_disabled", message: "off" });
      state.writes.push(publishAt);
      state.video.publishAt = state.readBackWrong ? "2026-12-01T00:00:00.000Z" : publishAt;
    },
    update: async (_row, set) => {
      state.row = { ...state.row, ...set };
      return true;
    },
    audit: async (_row, detail) => void state.audits.push(detail),
    clock: { now: () => state.now },
    // Review #4: the switches, read at the start of a pass; the next quota day (midnight Pacific = 07:00Z in October).
    liveWritesEnabled: async () => state.liveWrites,
    dataReadsEnabled: async () => state.dataReads,
    nextQuotaReset: () => new Date("2026-10-26T07:00:00Z"),
  });
  return { state, schedule, steps: () => JSON.parse(state.row.stepsJson) };
}

test("AC-WP-32: a vetoed slot's scheduled video loses its date, stays private, read back; the slot's row and audit say so", async () => {
  const h = harness(row(), { kind: "vetoed" });
  assert.deepEqual(await h.schedule.tick(), { changed: 1 });
  assert.deepEqual(h.state.writes, [null]);
  assert.equal(h.state.row.publishAt, null);
  assert.deepEqual([h.steps().planSync.action, h.steps().planSync.result], ["unscheduled", "verified"]);
  assert.deepEqual([h.state.audits[0].event, h.state.audits[0].previous], ["publishing.plan_unscheduled", "2026-10-26T09:00:00.000Z"]);
  // A second pass has nothing to do and makes no YouTube call.
  const reads = h.state.reads;
  assert.deepEqual(await h.schedule.tick(), { changed: 0 });
  assert.equal(h.state.reads, reads);
});

test("owner msg 3537 (2): a slot re-approved with a new time moves the video's date; approved after a dateless upload gets one", async () => {
  const moved = harness(row(), { kind: "approved", publishAt: "2026-10-26T12:00:00.000Z" });
  await moved.schedule.tick();
  assert.deepEqual(moved.state.writes, ["2026-10-26T12:00:00.000Z"]);
  assert.deepEqual([moved.state.row.publishAt, moved.steps().publishAt, moved.steps().planSync.result], ["2026-10-26T12:00:00.000Z", "set", "verified"]);
  const dateless = harness(row({ publishAt: null, stepsJson: JSON.stringify({ ...OK_STEPS, publishAt: undefined }) }), { kind: "approved", publishAt: "2026-10-27T09:00:00.000Z" }, { privacyStatus: "private", publishAt: null });
  await dateless.schedule.tick();
  assert.deepEqual(dateless.state.writes, ["2026-10-27T09:00:00.000Z"]);
});

test("AC-WP-32: nothing is done for a pending slot, a date already right, failed upload checks, or a time within 15 minutes", () => {
  const ms = NOW.getTime();
  assert.equal(desiredDate(row(), { kind: "pending" }, ms), null);
  assert.equal(desiredDate(row(), undefined, ms), null);
  assert.equal(desiredDate(row(), { kind: "approved", publishAt: "2026-10-26T09:00:00Z" }, ms), null, "same instant");
  assert.equal(desiredDate(row({ stepsJson: JSON.stringify({ ...OK_STEPS, thumbnail: "failed" }) }), { kind: "approved", publishAt: "2026-10-27T09:00:00Z" }, ms), null);
  assert.equal(desiredDate(row({ stepsJson: JSON.stringify({ ...OK_STEPS, localizations: "mismatch" }) }), { kind: "approved", publishAt: "2026-10-27T09:00:00Z" }, ms), null);
  assert.equal(desiredDate(row(), { kind: "approved", publishAt: "2026-10-25T12:15:00Z" }, ms), null, "15 minutes ahead is too close");
  assert.equal(desiredDate(row({ publishAt: "2026-10-25T12:10:00.000Z" }), { kind: "vetoed" }, ms), null, "a release within 15 minutes is not stopped");
  assert.equal(desiredDate(row({ publishAt: null }), { kind: "vetoed" }, ms), null, "no date to remove");
  assert.deepEqual(desiredDate(row(), { kind: "approved", publishAt: "2026-10-25T12:16:00Z" }, ms), { publishAt: "2026-10-25T12:16:00.000Z" });
});

test("AC-WP-32: a video that is no longer private is never touched -- refused and recorded, not retried within an hour", async () => {
  const h = harness(row(), { kind: "vetoed" }, { privacyStatus: "public", publishAt: null });
  await h.schedule.tick();
  assert.deepEqual(h.state.writes, []);
  assert.deepEqual([h.steps().planSync.result, h.steps().planSync.reason], ["refused", "video is public"]);
  assert.equal(h.state.row.publishAt, "2026-10-26T09:00:00.000Z", "the row keeps what it knew");
  const reads = h.state.reads;
  await h.schedule.tick();
  assert.equal(h.state.reads, reads, "not tried again at once");
  h.state.now = new Date(NOW.getTime() + RETRY_AFTER_MS + 1);
  await h.schedule.tick();
  assert.equal(h.state.reads, reads + 1, "tried again an hour later");
});

test("AC-WP-32/34: Live writes off -> nothing written and nothing recorded (the next pass tries); a read-back that differs is a mismatch", async () => {
  const off = harness(row(), { kind: "vetoed" });
  off.state.liveWrites = false;
  assert.deepEqual(await off.schedule.tick(), { changed: 0 });
  assert.equal(off.steps().planSync, undefined);
  off.state.liveWrites = true;
  await off.schedule.tick();
  assert.equal(off.state.row.publishAt, null);
  const wrong = harness(row(), { kind: "approved", publishAt: "2026-10-27T09:00:00.000Z" });
  wrong.state.readBackWrong = true;
  await wrong.schedule.tick();
  assert.deepEqual([wrong.steps().planSync.result, wrong.state.row.publishAt], ["mismatch", "2026-10-26T09:00:00.000Z"]);
});

// Review #4 (MEDIUM): with Live writes or reads off a pending change cost a read every pass (and the quota on top). The pass now
// reads the switches first and stops without any YouTube call; a quota refusal is recorded (the hourly retry applies) and nothing
// is read again until the quota day resets.
test("review #4: Live writes off or reads off -> the pass makes no YouTube call at all", async () => {
  const writesOff = harness(row(), { kind: "vetoed" });
  writesOff.state.liveWrites = false;
  await writesOff.schedule.tick();
  assert.equal(writesOff.state.reads, 0);
  const readsOff = harness(row(), { kind: "vetoed" });
  readsOff.state.dataReads = false;
  await readsOff.schedule.tick();
  assert.equal(readsOff.state.reads, 0);
});

test("review #4: a quota refusal is recorded and nothing is read again until the quota resets", async () => {
  const h = harness(row(), { kind: "vetoed" });
  h.state.quotaOut = true;
  await h.schedule.tick();
  assert.deepEqual([h.steps().planSync.result, h.steps().planSync.reason], ["refused", "youtube_quota_exceeded"]);
  const reads = h.state.reads;
  h.state.quotaOut = false;
  h.state.now = new Date(NOW.getTime() + RETRY_AFTER_MS + 1); // an hour later, still before the reset
  await h.schedule.tick();
  assert.equal(h.state.reads, reads, "waits for the quota day");
  h.state.now = new Date("2026-10-26T07:00:01Z");
  await h.schedule.tick();
  assert.equal(h.state.row.publishAt, null, "after the reset the veto lands");
});

// BL-242 (WEEKLY_PUBLISHING_PLAN.md AC-WP-57; ADR 0062 §3-§4): a slot takes an uploaded video by its package; the owner's approval
// then names the video id, and the plan schedule dates the finished upload by that video id although its row names the old slot.
// Two approved slots naming the same video schedule nothing. An approval without a video id dates only its own manifest.
function multiHarness(initial: StoredPublishingUpload, decisions: Map<string, SlotDecision>) {
  const state = { row: { ...initial }, writes: [] as Array<string | null>, video: { privacyStatus: "private", publishAt: initial.publishAt as string | null } };
  const schedule = createPlanSchedule({
    rows: async () => [state.row],
    slotDecisions: async () => decisions,
    read: async () => ({ ...state.video }),
    write: async (_row, publishAt) => {
      state.writes.push(publishAt);
      state.video.publishAt = publishAt;
    },
    update: async (_row, set) => {
      state.row = { ...state.row, ...set };
      return true;
    },
    audit: async () => undefined,
    clock: { now: () => NOW },
    liveWritesEnabled: async () => true,
    dataReadsEnabled: async () => true,
    nextQuotaReset: () => new Date("2026-10-26T07:00:00Z"),
  });
  return { state, schedule };
}
const dateless = (over: Partial<StoredPublishingUpload> = {}) => row({ slotId: "old", videoId: "vid1", manifestSha256: "mf-aa", publishAt: null, stepsJson: JSON.stringify({ ...OK_STEPS, publishAt: undefined }), ...over });
const byVideo = (publishAt: string, videoId = "vid1"): SlotDecision => ({ kind: "approved", publishAt, package: { video: "V73", manifestSha256: "mf-aa", videoId } });

test("AC-WP-57: a finished upload (slot old, vid1, no date) and an approved slot new naming vid1 -> one write with new's time", async () => {
  const h = multiHarness(dateless(), new Map([["old", { kind: "pending" }], ["new", byVideo("2026-11-04T09:00:00.000Z")]]));
  assert.deepEqual(await h.schedule.tick(), { changed: 1 });
  assert.deepEqual(h.state.writes, ["2026-11-04T09:00:00.000Z"]);
  // The old slot's own veto does not stop the slot that took the video over.
  const vetoedOld = multiHarness(dateless(), new Map<string, SlotDecision>([["old", { kind: "vetoed" }], ["new", byVideo("2026-11-04T09:00:00.000Z")]]));
  await vetoedOld.schedule.tick();
  assert.deepEqual(vetoedOld.state.writes, ["2026-11-04T09:00:00.000Z"]);
});

test("AC-WP-57: two approved live slots naming vid1 -> no write", async () => {
  const h = multiHarness(dateless(), new Map([["new", byVideo("2026-11-04T09:00:00.000Z")], ["other", byVideo("2026-11-05T09:00:00.000Z")]]));
  assert.deepEqual(await h.schedule.tick(), { changed: 0 });
  assert.deepEqual(h.state.writes, []);
});

test("AC-WP-57: an approval without a video id dates the upload of its manifest; another manifest -> no write", async () => {
  const own = (manifestSha256: string): Map<string, SlotDecision> => new Map([["old", { kind: "approved", publishAt: "2026-11-04T09:00:00.000Z", package: { video: "V73", manifestSha256, videoId: null } }]]);
  const same = multiHarness(dateless(), own("mf-aa"));
  await same.schedule.tick();
  assert.deepEqual(same.state.writes, ["2026-11-04T09:00:00.000Z"]);
  const other = multiHarness(dateless(), own("mf-bb"));
  assert.deepEqual(await other.schedule.tick(), { changed: 0 });
  assert.deepEqual(other.state.writes, []);
  // The row's own slot approved with another video id named: not this video.
  const otherVideo = multiHarness(dateless(), new Map([["old", byVideo("2026-11-04T09:00:00.000Z", "vid2")]]));
  assert.deepEqual(await otherVideo.schedule.tick(), { changed: 0 });
});

test("AC-WP-57: a veto of the slot that took the video (its approval named vid1) removes the video's date", async () => {
  const scheduled = row({ slotId: "old", videoId: "vid1", manifestSha256: "mf-aa", publishAt: "2026-11-04T09:00:00.000Z" });
  const h = multiHarness(scheduled, new Map<string, SlotDecision>([["old", { kind: "pending" }], ["new", { kind: "vetoed", package: { video: "V73", manifestSha256: "mf-aa", videoId: "vid1" } }]]));
  await h.schedule.tick();
  assert.deepEqual(h.state.writes, [null]);
});

// BL-243 (WEEKLY_PUBLISHING_PLAN.md AC-WP-71, rule of review round 2 / ADR 0063 §4): a video the channel sync found removed on YouTube
// is never DATED -- no read, no write -- and an unreadable removed list dates nothing (fail closed). Removing a date (a veto) never
// waits on the local mark or the list: it asks YouTube (`read`), and YouTube's "no such video" means there is nothing to remove.
test("BL-243 AC-WP-71: dating skips a removed video and an unreadable list; the cleared mark dates again", async () => {
  const approved = { kind: "approved", publishAt: "2026-10-27T09:00:00.000Z" } as SlotDecision;
  const removed = harness(row(), approved, undefined, async () => new Set(["vid64"]));
  assert.deepEqual(await removed.schedule.tick(), { changed: 0 });
  assert.equal(removed.state.reads, 0);
  assert.deepEqual(removed.state.writes, []);
  assert.deepEqual(removed.state.audits, []);
  assert.equal(removed.state.row.stepsJson, JSON.stringify(OK_STEPS));
  const failed = harness(row(), approved, undefined, async () => {
    throw new Error("db down");
  });
  assert.deepEqual(await failed.schedule.tick(), { changed: 0 }, "an unreadable list: no date (fail closed)");
  assert.equal(failed.state.reads, 0);
  const cleared = harness(row(), approved, undefined, async () => new Set());
  assert.deepEqual(await cleared.schedule.tick(), { changed: 1 });
  assert.deepEqual(cleared.state.writes, ["2026-10-27T09:00:00.000Z"]);
});

test("BL-243 AC-WP-71: a veto removes the date whatever the local mark or the list say; YouTube's 'no such video' ends it", async () => {
  const vetoed = { kind: "vetoed" } as SlotDecision;
  // The mark says removed, but YouTube still has the video (a wrong mark): the veto's un-dating happens.
  const marked = harness(row(), vetoed, undefined, async () => new Set(["vid64"]));
  assert.deepEqual(await marked.schedule.tick(), { changed: 1 });
  assert.deepEqual(marked.state.writes, [null]);
  assert.equal(marked.state.row.publishAt, null);
  // The list cannot be read: the veto still goes through.
  const unreadable = harness(row(), vetoed, undefined, async () => {
    throw new Error("db down");
  });
  assert.deepEqual(await unreadable.schedule.tick(), { changed: 1 });
  assert.deepEqual(unreadable.state.writes, [null]);
  // YouTube says there is no such video: nothing written, the row has no date any more, and the next pass reads nothing.
  const gone = harness(row(), vetoed, { privacyStatus: null, publishAt: null, missing: true } as never, async () => new Set(["vid64"]));
  assert.deepEqual(await gone.schedule.tick(), { changed: 1 });
  assert.deepEqual(gone.state.writes, []);
  assert.equal(gone.state.reads, 1);
  assert.equal(gone.state.row.publishAt, null);
  assert.deepEqual([gone.steps().planSync.action, gone.steps().planSync.result], ["unscheduled", "video_missing"]);
  assert.deepEqual(await gone.schedule.tick(), { changed: 0 });
  assert.equal(gone.state.reads, 1);
});

// BL-243 review round 3 (AC-WP-79): YouTube's "no such video" is not proof on its own (another account, a partial answer). Without the
// removed mark of a completed owner sync it is a refusal like any other -- recorded, the row keeps its date, tried again after the
// hour -- for a veto and for a date alike. With the mark (above) a veto's un-dating ends there.
test("BL-243 AC-WP-79: not_found without a removed mark is refused and retried, for a veto and for dating", async () => {
  const missing = { privacyStatus: null, publishAt: null, missing: true } as never;
  const veto = harness(row(), { kind: "vetoed" }, missing, async () => new Set());
  assert.deepEqual(await veto.schedule.tick(), { changed: 1 });
  assert.deepEqual(veto.state.writes, []);
  assert.equal(veto.state.row.publishAt, "2026-10-26T09:00:00.000Z", "the row keeps its date");
  assert.deepEqual([veto.steps().planSync.action, veto.steps().planSync.result], ["unscheduled", "refused"]);
  const reads = veto.state.reads;
  await veto.schedule.tick();
  assert.equal(veto.state.reads, reads, "not again within the hour");
  veto.state.now = new Date(NOW.getTime() + RETRY_AFTER_MS + 1);
  await veto.schedule.tick();
  assert.equal(veto.state.reads, reads + 1, "tried again after the hour");

  const unreadable = harness(row(), { kind: "vetoed" }, missing, async () => {
    throw new Error("db down");
  });
  await unreadable.schedule.tick();
  assert.equal(unreadable.steps().planSync.result, "refused", "an unreadable list is no mark");

  const dating = harness(row({ publishAt: null, stepsJson: JSON.stringify({ ...OK_STEPS, publishAt: undefined }) }), { kind: "approved", publishAt: "2026-10-27T09:00:00.000Z" }, missing, async () => new Set());
  assert.deepEqual(await dating.schedule.tick(), { changed: 1 });
  assert.deepEqual(dating.state.writes, []);
  assert.equal(dating.state.row.publishAt, null);
  assert.deepEqual([dating.steps().planSync.action, dating.steps().planSync.result], ["scheduled", "refused"]);
});

// BL-243 review round 6 (AC-WP-83): video_missing does not stick once the mark is cleared (the video reappeared). The row says "no
// date" from the earlier answer; the next pass asks YouTube again and re-applies the slot's wish -- a veto removes the date.
test("BL-243 AC-WP-83: after video_missing and a cleared mark, a veto re-runs through the live read", async () => {
  const missingSteps = JSON.stringify({ ...OK_STEPS, planSync: { at: NOW.toISOString(), action: "unscheduled", publishAt: null, result: "video_missing" } });
  const back = harness(row({ publishAt: null, stepsJson: missingSteps }), { kind: "vetoed" }, { privacyStatus: "private", publishAt: "2026-10-26T09:00:00.000Z" }, async () => new Set());
  assert.deepEqual(await back.schedule.tick(), { changed: 1 });
  assert.equal(back.state.reads, 2, "read before and after");
  assert.deepEqual(back.state.writes, [null]);
  assert.equal(back.steps().planSync.result, "verified");
  // Still marked removed: nothing to do (no read).
  const still = harness(row({ publishAt: null, stepsJson: missingSteps }), { kind: "vetoed" }, { privacyStatus: "private", publishAt: "2026-10-26T09:00:00.000Z" }, async () => new Set(["vid64"]));
  assert.deepEqual(await still.schedule.tick(), { changed: 0 });
  assert.equal(still.state.reads, 0);
});

// BL-243 review round 6 (AC-WP-79): only video-details' "no item for the id" is a not-found; an item without snippet/status is not.
test("BL-243 AC-WP-79: isVideoNotFound needs reason no_item for that video id", () => {
  const error = (details: Record<string, unknown>) => new DomainError({ code: "not_found", message: "x", details });
  assert.equal(isVideoNotFound(error({ videoId: "vid64", reason: "no_item" }), "vid64"), true);
  assert.equal(isVideoNotFound(error({ videoId: "vid64", reason: "partial" }), "vid64"), false);
  assert.equal(isVideoNotFound(error({ videoId: "vid64" }), "vid64"), false);
  assert.equal(isVideoNotFound(error({ videoId: "other", reason: "no_item" }), "vid64"), false);
  assert.equal(isVideoNotFound(new Error("network"), "vid64"), false);
});
