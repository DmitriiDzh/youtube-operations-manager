import assert from "node:assert/strict";
import test from "node:test";
import type { StoredPublishingUpload } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import type { SlotDecision } from "./auto-upload";
import { createPlanSchedule, desiredDate, RETRY_AFTER_MS } from "./plan-schedule";

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
    automatic: true,
    slotId: "w44-mon",
    ...over,
  };
}

function harness(initial: StoredPublishingUpload, decision: SlotDecision | undefined, video: { privacyStatus: string; publishAt: string | null } = { privacyStatus: "private", publishAt: initial.publishAt }) {
  const state = { row: { ...initial }, video: { ...video }, writes: [] as Array<string | null>, audits: [] as Array<Record<string, unknown>>, reads: 0, liveWrites: true, dataReads: true, quotaOut: false, readBackWrong: false, now: NOW };
  const schedule = createPlanSchedule({
    rows: async () => [state.row],
    slotDecisions: async () => new Map(decision ? [["w44-mon", decision]] : []),
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
