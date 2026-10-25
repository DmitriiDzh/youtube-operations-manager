import assert from "node:assert/strict";
import test from "node:test";
import { changedField, defaultWeek, lengthLabel, mondayOf, pipelineOf, shiftWeek, slotsToApprove, tileCounts, wallParts, zonedParts, type PlanSlotDto } from "./weekly-plan-model";

// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 6, AC-WP-15): the screen's pure rules. Values by hand: 2026-10-26 is a Monday,
// 2026-11-01 its Sunday; 18:00 in Tokyo is 09:00Z, which is 10:00 in Berlin (CET, UTC+1, after 25.10); 23:30Z on 31.10 is 08:30 on Sunday 1.11 in Tokyo.

const slot = (over: Partial<PlanSlotDto>): PlanSlotDto => ({
  slotId: "s",
  date: "2026-10-26",
  publishAt: "2026-10-26T18:00",
  publishAtUtc: "2026-10-26T09:00:00.000Z",
  lengthHint: null,
  note: null,
  contentHash: "h",
  approval: "needs_approval",
  approvedAt: null,
  changedAfterApproval: null,
  vetoed: null,
  status: "planned",
  statusCode: null,
  videoId: null,
  package: null,
  released: false,
  updatedAt: "2026-10-25T07:00:00Z",
  updatedBy: "factory",
  ...over,
});

test("AC-WP-15: weeks -- the Monday of any day, the arrows step seven days", () => {
  assert.equal(mondayOf("2026-10-26"), "2026-10-26");
  assert.equal(mondayOf("2026-11-01"), "2026-10-26");
  assert.equal(mondayOf("2026-10-25"), "2026-10-19");
  assert.equal(shiftWeek("2026-10-26", 1), "2026-11-02");
  assert.equal(shiftWeek("2026-10-26", -1), "2026-10-19");
});

test("AC-WP-15: the screen opens on the earliest week waiting for the owner, else this week's plan, else the next one, else this week", () => {
  const plan = (weekStart: string, needsApproval: number) => ({ weekStart, counts: { slots: 3, approved: 0, needsApproval, vetoed: 0 } });
  assert.equal(defaultWeek([plan("2026-11-09", 2), plan("2026-11-02", 1), plan("2026-10-26", 0)], "2026-10-28"), "2026-11-02");
  assert.equal(defaultWeek([plan("2026-11-02", 0), plan("2026-10-26", 0)], "2026-10-28"), "2026-10-26");
  assert.equal(defaultWeek([plan("2026-11-09", 0), plan("2026-10-19", 0)], "2026-10-28"), "2026-11-09");
  assert.equal(defaultWeek([], "2026-10-28"), "2026-10-26");
});

test("AC-WP-15: «Одобрить неделю» covers the slots that wait -- never a vetoed, released or approved one", () => {
  const plan = {
    slots: [
      slot({ slotId: "a", contentHash: "ha" }),
      slot({ slotId: "b", approval: "approved" }),
      slot({ slotId: "c", vetoed: { at: "x", device: null } }),
      slot({ slotId: "d", released: true }),
      slot({ slotId: "e", contentHash: "he", changedAfterApproval: { previous: { date: "2026-10-26", publishAt: "2026-10-26T15:00", lengthHint: null, note: null, timeZone: "Asia/Tokyo" }, approvedAt: "x", changedAt: "y", changedBy: "worker" } }),
    ],
  };
  assert.deepEqual(slotsToApprove(plan), [{ slotId: "a", contentHash: "ha" }, { slotId: "e", contentHash: "he" }]);
});

test("AC-WP-15: the pipeline -- a planned slot lights План only; uploading has YouTube under way; failed marks YouTube; vetoed is a dash", () => {
  assert.deepEqual(pipelineOf(slot({}))!.map((s) => s.state), ["done", "todo", "todo", "todo", "todo"]);
  assert.deepEqual(pipelineOf(slot({ status: "packaged" }))!.map((s) => s.state), ["done", "done", "done", "todo", "todo"]);
  assert.deepEqual(pipelineOf(slot({ status: "uploading" }))!.map((s) => s.state), ["done", "done", "done", "active", "todo"]);
  assert.deepEqual(pipelineOf(slot({ status: "scheduled" }))!.map((s) => s.state), ["done", "done", "done", "done", "done"]);
  assert.deepEqual(pipelineOf(slot({ status: "failed" }))!.map((s) => s.state), ["done", "done", "done", "failed", "todo"]);
  assert.equal(pipelineOf(slot({ status: "vetoed" })), null);
  assert.deepEqual(tileCounts({ slots: [slot({ status: "packaged" }), slot({ status: "scheduled" }), slot({ status: "vetoed" }), slot({})] }), { packaged: 2, scheduled: 1 });
});

test("AC-WP-15: times -- the channel's wall time as stored, the owner's time in his zone", () => {
  assert.deepEqual(wallParts("2026-10-26T18:00"), { day: "26.10", time: "18:00", weekday: 0 });
  assert.deepEqual(zonedParts("2026-10-26T09:00:00.000Z", "Europe/Berlin"), { day: "26.10", time: "10:00", weekday: 0, ymd: "2026-10-26" });
  assert.deepEqual(zonedParts("2026-10-31T23:30:00.000Z", "Asia/Tokyo"), { day: "01.11", time: "08:30", weekday: 6, ymd: "2026-11-01" });
});

test("AC-WP-15: which field the agent changed after approval", () => {
  const previous = { date: "2026-10-26", publishAt: "2026-10-26T15:00", lengthHint: "≈ 3 ч", note: null, timeZone: "Asia/Tokyo" };
  const changed = (over: Partial<PlanSlotDto>) => slot({ lengthHint: "≈ 3 ч", changedAfterApproval: { previous, approvedAt: "a", changedAt: "b", changedBy: "worker" }, ...over });
  assert.equal(changedField(changed({ publishAt: "2026-10-26T18:00" }), "Asia/Tokyo"), "time");
  assert.equal(changedField(changed({ publishAt: "2026-10-26T15:00", lengthHint: "≈ 2 ч" }), "Asia/Tokyo"), "length");
  assert.equal(changedField(changed({ publishAt: "2026-10-26T15:00", note: "снег" }), "Asia/Tokyo"), "note");
  assert.equal(changedField(changed({ publishAt: "2026-10-26T15:00" }), "Asia/Seoul"), "zone");
  assert.equal(changedField(slot({}), "Asia/Tokyo"), null);
});

test("BL-225 stage 2: a package's length on the row -- whole hours from one hour, else minutes", () => {
  assert.deepEqual(lengthLabel(3 * 3600 + 600), { unit: "h", value: 3 });
  assert.deepEqual(lengthLabel(3599), { unit: "min", value: 60 });
  assert.deepEqual(lengthLabel(20), { unit: "min", value: 1 });
});
