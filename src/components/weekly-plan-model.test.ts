import assert from "node:assert/strict";
import test from "node:test";
import { canApprove, changedField, defaultWeek, duplicateWarningOf, stageOf, strayDateOf, lengthLabel, mondayOf, pipelineOf, replacedToPull, shiftWeek, slotsToApprove, splitVetoed, tileCounts, wallParts, weekCoverageLine, zonedParts, type PlanSlotDto } from "./weekly-plan-model";

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
  replaces: null,
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

// BL-235 (owner msg 3806): «План недели» shows what YouTube has for the week next to the approvals -- the owner's example: «Закрыто 4
// из 7 · без видео: 6, 7, 8 нояб. · без переводов: …».
test("BL-235: the week's coverage line -- covered of 7, the days without a video, the days without translations with languages", () => {
  const line = weekCoverageLine({
    asOf: "2026-11-02T10:00:00.000Z",
    days: [
      { date: "2026-11-02", status: "covered", missingLanguages: [] },
      { date: "2026-11-03", status: "covered", missingLanguages: [] },
      { date: "2026-11-04", status: "covered", missingLanguages: [] },
      { date: "2026-11-05", status: "covered", missingLanguages: [] },
      { date: "2026-11-06", status: "gap", missingLanguages: [] },
      { date: "2026-11-07", status: "missing_translations", missingLanguages: ["es", "ja"] },
      { date: "2026-11-08", status: "gap", missingLanguages: [] },
    ],
    summary: { covered: 4, missingTranslations: 1, gaps: 2 },
  });
  assert.deepEqual(line, { covered: 4, total: 7, gaps: ["2026-11-06", "2026-11-08"], missing: [{ date: "2026-11-07", languages: ["es", "ja"] }] });
});

// BL-240 (WEEKLY_PUBLISHING_PLAN.md AC-WP-47): pulled slots are listed apart, in the plan's order, each keeping its number; the
// approval names the replaced slots it would pull (found, not pulled, not past; each once).
test("AC-WP-47: pulled slots split from the live ones in plan order, numbers kept", () => {
  const pulled = { at: "2026-10-25T08:00:00Z", device: "Mac" };
  const { live, vetoed } = splitVetoed([slot({ slotId: "a", vetoed: pulled }), slot({ slotId: "b" }), slot({ slotId: "c", vetoed: pulled }), slot({ slotId: "d" })]);
  assert.deepEqual(live.map((s) => [s.slot.slotId, s.number]), [["b", 2], ["d", 4]]);
  assert.deepEqual(vetoed.map((s) => [s.slot.slotId, s.number]), [["a", 1], ["c", 3]]);
});

test("AC-WP-47: approving names the replaced slots it would pull", () => {
  const target = (slotId: string, over: Partial<NonNullable<PlanSlotDto["replaces"]>> = {}) => ({ slotId, weekStart: "2026-10-26", publishAt: "2026-10-27T18:00", video: "V66", vetoed: false, released: false, found: true, ...over });
  const pulls = replacedToPull([
    slot({ slotId: "n1", replaces: target("o1") }),
    slot({ slotId: "n2", replaces: target("o1") }),
    slot({ slotId: "n3", replaces: target("o2", { vetoed: true }) }),
    slot({ slotId: "n4", replaces: target("o3", { released: true }) }),
    slot({ slotId: "n5", replaces: target("o4", { found: false }) }),
    slot({ slotId: "n6" }),
  ]);
  assert.deepEqual(pulls.map((r) => r.slotId), ["o1"]);
});

// BL-242 (WEEKLY_PUBLISHING_PLAN.md AC-WP-59; ADR 0062): in the `packaged` stage a slot waiting for its package has nothing to approve
// -- no approve button and not in «Одобрить все готовые»; the switch shows the stage the server names; a package changed after the
// approval is named as such.
test("AC-WP-59: a slot awaiting its package is never approvable and not in «Одобрить все готовые»", () => {
  const plan = {
    slots: [
      slot({ slotId: "a", contentHash: "ha", approval: "awaiting_package" }),
      slot({ slotId: "b", contentHash: "hb" }),
      slot({ slotId: "c", contentHash: "hc", approval: "awaiting_package", changedAfterApproval: { previous: { date: "2026-10-26", publishAt: "2026-10-26T18:00", lengthHint: null, note: null, timeZone: "Asia/Tokyo" }, approvedAt: "x", changedAt: "y", changedBy: "worker" } }),
    ],
  };
  assert.deepEqual(slotsToApprove(plan), [{ slotId: "b", contentHash: "hb" }]);
  assert.equal(canApprove(plan.slots[0]), false);
  assert.equal(canApprove(plan.slots[1]), true);
  assert.equal(canApprove(slot({ approval: "approved" })), false);
});

test("AC-WP-59: the switch shows the server's stage (an older server without one behaves as the slot stage)", () => {
  assert.equal(stageOf({ approvalStage: "packaged" }), "packaged");
  assert.equal(stageOf({ approvalStage: "slot" }), "slot");
  assert.equal(stageOf({}), "slot");
});

test("AC-WP-59: a package changed after the approval (same slot) is the field «package»; the slot's own fields still come first", () => {
  const previous = { date: "2026-10-26", publishAt: "2026-10-26T18:00", lengthHint: null, note: null, timeZone: "Asia/Tokyo", package: { video: "V64", manifestSha256: "a".repeat(64), videoId: null } };
  const pkg = { video: "V64", title: "T", durationSeconds: 1, languages: [], containsSyntheticMedia: false, thumbnailPath: null, testThumbnails: 0, problems: [], manifestSha256: "b".repeat(64) };
  const changed = (over: Partial<PlanSlotDto>) => slot({ changedAfterApproval: { previous, approvedAt: "a", changedAt: "b", changedBy: "worker" }, package: pkg, ...over });
  assert.equal(changedField(changed({}), "Asia/Tokyo"), "package");
  assert.equal(changedField(changed({ package: { ...pkg, manifestSha256: "a".repeat(64) } }), "Asia/Tokyo"), null, "the approved package");
  assert.equal(changedField(changed({ publishAt: "2026-10-26T19:00" }), "Asia/Tokyo"), "time");
});

test("AC-WP-59: the new texts exist in English and Russian", async () => {
  const en = (await import("@/lib/ui-text/locales/en/content")).content as Record<string, string>;
  const ru = (await import("@/lib/ui-text/locales/ru/content")).content as Record<string, string>;
  for (const key of ["weekPlan.stage.toggle", "weekPlan.stage.hintPackaged", "weekPlan.stage.hintSlot", "weekPlan.stage.failed", "weekPlan.awaitingPackage", "weekPlan.action.approveReady", "weekPlan.state.planned", "weekPlan.bar.waitingPackages", "weekPlan.changed.package", "weekPlan.error.notPackaged"]) {
    assert.ok(en[key] && ru[key] && en[key] !== ru[key], key);
  }
  assert.equal(ru["weekPlan.stage.toggle"], "Одобрять пустые слоты");
  assert.equal(ru["weekPlan.action.approveReady"], "Одобрить все готовые");
  // Review #3: each hint says the other setting's approvals do not carry over and come back when switched back.
  assert.match(en["weekPlan.stage.hintPackaged"], /do not count here; switching it back on brings them back/);
  assert.match(en["weekPlan.stage.hintSlot"], /do not count here; switching it back off brings them back/);
  assert.match(ru["weekPlan.stage.hintPackaged"], /не действуют; включите снова — вернутся/);
  assert.match(ru["weekPlan.stage.hintSlot"], /не действуют; выключите снова — вернутся/);
});

// BL-242 R3 (re-review): a slot not approved whose video still carries a date on YouTube shows it («на YouTube: …»), so the owner sees
// a date no approval counts for and moves it (approve) or removes it (veto). Approved or vetoed slots, or no date: nothing.
test("R3: the stray YouTube date is shown on a slot that needs approval or awaits its package", async () => {
  const at = "2026-10-27T09:00:00.000Z";
  assert.equal(strayDateOf(slot({ approval: "needs_approval", youtubePublishAt: at })), at);
  assert.equal(strayDateOf(slot({ approval: "awaiting_package", youtubePublishAt: at })), at);
  assert.equal(strayDateOf(slot({ approval: "approved", youtubePublishAt: at })), null);
  assert.equal(strayDateOf(slot({ approval: "needs_approval", youtubePublishAt: at, vetoed: { at: "x", device: null } })), null);
  assert.equal(strayDateOf(slot({ approval: "needs_approval", youtubePublishAt: null })), null);
  const en = (await import("@/lib/ui-text/locales/en/content")).content as Record<string, string>;
  const ru = (await import("@/lib/ui-text/locales/ru/content")).content as Record<string, string>;
  assert.equal(en["weekPlan.onYoutube"], "On YouTube: {at}");
  assert.equal(ru["weekPlan.onYoutube"], "на YouTube: {at}");
});

// BL-242 round 3 item 2: an approved slot whose video number another counting approval also names gets a warning line -- the uploads
// give it no date. Shown only for such a slot.
test("round 3: the duplicate video number warning is shown only on a flagged approved slot; texts in en and ru", async () => {
  assert.equal(duplicateWarningOf(slot({ approval: "approved", duplicateVideo: true })), true);
  assert.equal(duplicateWarningOf(slot({ approval: "approved", duplicateVideo: false })), false);
  assert.equal(duplicateWarningOf(slot({ approval: "approved" })), false);
  assert.equal(duplicateWarningOf(slot({ approval: "approved", duplicateVideo: true, vetoed: { at: "x", device: null } })), false);
  const en = (await import("@/lib/ui-text/locales/en/content")).content as Record<string, string>;
  const ru = (await import("@/lib/ui-text/locales/ru/content")).content as Record<string, string>;
  assert.equal(ru["weekPlan.duplicateVideo"], "Ещё один пакет с тем же номером — дата не ставится");
  assert.equal(en["weekPlan.duplicateVideo"], "Another package has the same video number — no date is set");
});
