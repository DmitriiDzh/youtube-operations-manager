import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument } from "@/lib/sync-gateway/publishing-plans";
import type { PublishingPlansDocument } from "@/lib/sync-gateway";
import { agentSurface, createPublishingPlansService } from "./services";
import { isDomainError, type PlanAuditEntry, type PlanView } from "./contracts";

// BL-225 stage 1 acceptance (docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md AC-WP-01..14; ADR 0051). Expected values are computed by
// hand from the plan: Asia/Tokyo is UTC+9 all year; Europe/Berlin leaves summer time (UTC+2 -> UTC+1) at 01:00Z on Sunday
// 2026-10-25; 2026-10-26 and 2026-10-19 are Mondays, 2026-10-27 a Tuesday, 2026-11-01 a Sunday.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";
const WEEK = "2026-10-26";

function harness(startAt = "2026-10-25T07:00:00Z", connected = [CH]) {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  const clock = { now: new Date(startAt) };
  const audits: PlanAuditEntry[] = [];
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async (channelId) => connected.includes(channelId),
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
  });
  const tick = (iso: string) => (clock.now = new Date(iso));
  return { service, audits, tick, core };
}

const tokyoSlot = (slotId: string, day: string, time: string, extra: { lengthHint?: string | null; note?: string | null } = {}) => ({ slotId, date: day, publishAt: `${day}T${time}`, lengthHint: "≈ 3 ч", ...extra });
const slotOf = (plan: PlanView, slotId: string) => plan.slots.find((s) => s.slotId === slotId)!;
const refusedOf = (error: unknown) => (isDomainError(error) ? ((error.details as { refused?: Array<{ slotId?: string; reason: string }> })?.refused ?? []) : []);
const rejectsWith = (code: string) => (error: unknown) => isDomainError(error) && error.code === code;

async function weekOfThree(h: ReturnType<typeof harness>) {
  return h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-26", "15:00"), tokyoSlot("s2", "2026-10-27", "18:00"), tokyoSlot("s3", "2026-10-28", "18:00")] }, "factory");
}

test("AC-WP-01: a new Tokyo plan -- the slot is planned, needs approval, 18:00 JST is 09:00Z; the week ends on Sunday", async () => {
  const h = harness();
  const { plan, changed } = await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-26", "18:00")] }, "factory");
  assert.deepEqual(changed, ["s1"]);
  assert.equal(plan.weekEnd, "2026-11-01");
  assert.equal(plan.state, "awaiting_approval");
  assert.equal(plan.updatedBy, "factory");
  const s1 = slotOf(plan, "s1");
  assert.equal(s1.publishAtUtc, "2026-10-26T09:00:00.000Z");
  assert.equal(s1.status, "planned");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.lengthHint, "≈ 3 ч");
  assert.deepEqual(plan.counts, { slots: 1, approved: 0, needsApproval: 1, vetoed: 0 });
  assert.equal(plan.firstRelease, "2026-10-26T09:00:00.000Z");
  assert.deepEqual((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, plan);
});

test("AC-WP-02: week bounds, the date of publishAt, the zone -- each refused with its reason and nothing saved", async () => {
  const h = harness();
  const cases: Array<[unknown, string]> = [
    [{ channelId: CH, weekStart: "2026-10-27", timeZone: "Asia/Tokyo", slots: [] }, "week_start_not_monday"],
    [{ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-11-02", "18:00")] }, "outside_week"],
    [{ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-25", "18:00")] }, "outside_week"],
    [{ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [{ slotId: "s1", date: "2026-10-26", publishAt: "2026-10-27T18:00" }] }, "date_mismatch"],
    [{ channelId: CH, weekStart: WEEK, timeZone: "Mars/Base", slots: [] }, "time_zone_invalid"],
    [{ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "18:00")] }, "time_zone_required"],
    [{ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-26", "24:00")] }, "publish_at_invalid"],
    [{ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-26", "18:00"), tokyoSlot("s1", "2026-10-27", "18:00")] }, "duplicate_slot"],
  ];
  for (const [input, reason] of cases) {
    const error = await h.service.save(input, "factory").then(() => null, (e: unknown) => e);
    assert.ok(isDomainError(error) && error.code === "validation_failed", reason);
    assert.ok(refusedOf(error).some((r) => r.reason === reason), `${reason}: ${JSON.stringify(refusedOf(error))}`);
  }
  await assert.rejects(h.service.get({ channelId: CH, weekStart: WEEK }), rejectsWith("publishing_plan_not_found"));
  // The Sunday that ends the week is inside it.
  const { plan } = await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("sun", "2026-11-01", "18:00")] }, "factory");
  assert.equal(slotOf(plan, "sun").publishAtUtc, "2026-11-01T09:00:00.000Z");
});

test("AC-WP-03: a zone with summer time -- Berlin 18:00 is 16:00Z on Saturday 24.10 and 17:00Z on Sunday 25.10", async () => {
  const h = harness("2026-10-20T00:00:00Z");
  const { plan } = await h.service.save({ channelId: CH, weekStart: "2026-10-19", timeZone: "Europe/Berlin", slots: [tokyoSlot("sat", "2026-10-24", "18:00"), tokyoSlot("sun", "2026-10-25", "18:00")] }, "factory");
  assert.equal(slotOf(plan, "sat").publishAtUtc, "2026-10-24T16:00:00.000Z");
  assert.equal(slotOf(plan, "sun").publishAtUtc, "2026-10-25T17:00:00.000Z");
});

test("AC-WP-04: a new slot whose time has passed is refused; the same slot re-sent unchanged is a no-op", async () => {
  const h = harness();
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-26", "18:00")] }, "factory");
  h.tick("2026-10-26T10:00:00Z"); // 19:00 in Tokyo
  const error = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s2", "2026-10-26", "18:00")] }, "factory").then(() => null, (e: unknown) => e);
  assert.deepEqual(refusedOf(error).map((r) => r.reason), ["in_past"]);
  const again = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "18:00")] }, "worker");
  assert.deepEqual(again.changed, []);
  assert.equal(again.plan.updatedBy, "factory", "nothing was written");
  assert.equal(slotOf(again.plan, "s1").released, true);
  assert.equal(again.plan.state, "past");
});

test("AC-WP-05: an agent's save cannot carry an approval or a veto; the agents' surface has only save, get and list", async () => {
  const h = harness();
  const bad = [
    { channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", approved: true },
    { channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", approval: "approved" },
    { channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [{ ...tokyoSlot("s1", "2026-10-26", "18:00"), approved: true }] },
    { channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [{ ...tokyoSlot("s1", "2026-10-26", "18:00"), vetoed: false }] },
  ];
  for (const input of bad) await assert.rejects(h.service.save(input, "factory"), rejectsWith("validation_failed"), JSON.stringify(input));
  await assert.rejects(h.service.get({ channelId: CH, weekStart: WEEK }), rejectsWith("publishing_plan_not_found"));
  assert.deepEqual(Object.keys(agentSurface(h.service)).sort(), ["get", "list", "save"]);
});

test("AC-WP-06: approving the week with the hashes shown approves every slot, audited; one stale hash approves nothing", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  const shown = plan.slots.map((s) => ({ slotId: s.slotId, contentHash: s.contentHash }));
  const stale = shown.map((s) => (s.slotId === "s2" ? { ...s, contentHash: "0".repeat(64) } : s));
  await assert.rejects(h.service.decide(CH, WEEK, { action: "approve", slots: stale }, "u1"), rejectsWith("publishing_plan_changed"));
  assert.equal((await h.service.ownerGet(CH, WEEK)).plan.counts.approved, 0);
  assert.equal(h.audits.length, 0);
  const result = await h.service.decide(CH, WEEK, { action: "approve", slots: shown }, "u1");
  assert.deepEqual(result.decided.sort(), ["s1", "s2", "s3"]);
  assert.equal(result.plan.state, "approved");
  for (const s of result.plan.slots) {
    assert.equal(s.approval, "approved");
    assert.equal(s.approvedAt, "2026-10-25T07:00:00.000Z");
  }
  assert.deepEqual(h.audits.map((a) => [a.slotId, a.detail.event, a.detail.by]).sort(), [["s1", "publishing_plan.approved", "u1"], ["s2", "publishing_plan.approved", "u1"], ["s3", "publishing_plan.approved", "u1"]]);
  // Approving again changes nothing and audits nothing.
  assert.deepEqual((await h.service.decide(CH, WEEK, { action: "approve", slots: shown }, "u1")).decided, []);
  assert.equal(h.audits.length, 3);
  assert.deepEqual((await h.service.ownerList(CH)).waiting, 0);
});

test("AC-WP-07: an agent moving an approved slot from 15:00 to 18:00 needs the owner again, showing «было 15:00»; moving it back is approved", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  const s1 = slotOf(plan, "s1");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1");
  h.tick("2026-10-25T07:20:00Z");
  const moved = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "18:00")] }, "worker");
  assert.deepEqual(moved.unlocked, ["s1"]);
  const after = slotOf(moved.plan, "s1");
  assert.equal(after.approval, "needs_approval");
  assert.equal(after.changedAfterApproval?.previous.publishAt, "2026-10-26T15:00");
  assert.equal(after.changedAfterApproval?.changedBy, "worker");
  assert.equal(after.changedAfterApproval?.changedAt, "2026-10-25T07:20:00.000Z");
  assert.equal(moved.plan.state, "awaiting_approval");
  const back = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "15:00")] }, "worker");
  assert.equal(slotOf(back.plan, "s1").approval, "approved");
  assert.equal(slotOf(back.plan, "s1").changedAfterApproval, null);
});

test("AC-WP-08: changing only the note or only the length of an approved slot unlocks it; identical content keeps it approved", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  await h.service.decide(CH, WEEK, { action: "approve", slots: plan.slots.map((s) => ({ slotId: s.slotId, contentHash: s.contentHash })) }, "u1");
  const same = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "15:00"), tokyoSlot("s2", "2026-10-27", "18:00")] }, "factory");
  assert.deepEqual(same.unlocked, []);
  assert.equal(same.plan.state, "approved");
  const edited = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "15:00", { note: "вариант со снегом" }), tokyoSlot("s2", "2026-10-27", "18:00", { lengthHint: "≈ 2 ч" })] }, "factory");
  assert.deepEqual(edited.unlocked.sort(), ["s1", "s2"]);
  assert.equal(slotOf(edited.plan, "s1").approval, "needs_approval");
  assert.equal(slotOf(edited.plan, "s2").approval, "needs_approval");
  assert.equal(slotOf(edited.plan, "s3").approval, "approved");
  // A zone change re-times every slot: all approved ones need the owner again.
  const rezoned = await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Seoul" }, "factory");
  assert.deepEqual(rezoned.unlocked, ["s3"]);
  assert.equal(rezoned.plan.timeZone, "Asia/Seoul");
});

test("AC-WP-09: veto -- status vetoed even when approved, no approval, kept through an agent's edit, restored, refused after release", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  const s2 = slotOf(plan, "s2");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s2", contentHash: s2.contentHash }] }, "u1");
  const vetoed = await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  const v = slotOf(vetoed.plan, "s2");
  assert.equal(v.status, "vetoed");
  assert.equal(v.vetoed?.at, "2026-10-25T07:00:00.000Z");
  assert.equal(v.vetoed?.device, "Mac");
  assert.equal(vetoed.plan.counts.vetoed, 1);
  assert.equal(vetoed.plan.counts.needsApproval, 2, "a vetoed slot is not waiting for the owner");
  const s3 = slotOf(vetoed.plan, "s3");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s3" }] }, "u1");
  await assert.rejects(h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s3", contentHash: s3.contentHash }] }, "u1"), rejectsWith("publishing_plan_slot_vetoed"));
  const edited = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s2", "2026-10-27", "19:00")] }, "worker");
  assert.equal(slotOf(edited.plan, "s2").status, "vetoed");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s2", "2026-10-27", "18:00")] }, "worker");
  const restored = await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s2" }] }, "u1");
  assert.equal(slotOf(restored.plan, "s2").status, "planned");
  assert.equal(slotOf(restored.plan, "s2").approval, "approved", "restore returns the slot to its approval state");
  h.tick("2026-10-27T09:00:00Z"); // 18:00 Tokyo: s2's time
  await assert.rejects(h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1"), rejectsWith("publishing_plan_slot_past"));
  await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s3" }] }, "u1"); // s3 is still ahead (28.10 18:00)
  h.tick("2026-10-28T09:00:00Z");
  await assert.rejects(h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s3" }] }, "u1"), rejectsWith("publishing_plan_slot_past"));
});

test("AC-WP-10: removing -- a not approved slot is deleted; an approved one or an unknown one refuses the whole save", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: slotOf(plan, "s1").contentHash }] }, "u1");
  const approvedRemoval = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1", "s2"] }, "factory").then(() => null, (e: unknown) => e);
  assert.deepEqual(refusedOf(approvedRemoval).map((r) => [r.slotId, r.reason]), [["s1", "slot_approved"]]);
  const unknown = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s9"] }, "factory").then(() => null, (e: unknown) => e);
  assert.deepEqual(refusedOf(unknown).map((r) => [r.slotId, r.reason]), [["s9", "unknown_slot"]]);
  assert.equal((await h.service.get({ channelId: CH, weekStart: WEEK })).plan.slots.length, 3, "nothing was removed");
  const removed = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s2"] }, "factory");
  assert.deepEqual(removed.removed, ["s2"]);
  assert.deepEqual(removed.plan.slots.map((s) => s.slotId), ["s1", "s3"]);
});

test("AC-WP-11: revoke -- an approved slot needs approval again; revoking one that is not approved is refused", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  const s1 = slotOf(plan, "s1");
  await assert.rejects(h.service.decide(CH, WEEK, { action: "revoke", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1"), rejectsWith("publishing_plan_changed"));
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1");
  const revoked = await h.service.decide(CH, WEEK, { action: "revoke", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1");
  assert.equal(slotOf(revoked.plan, "s1").approval, "needs_approval");
  assert.equal(slotOf(revoked.plan, "s1").changedAfterApproval, null);
  assert.equal(h.audits.at(-1)?.detail.event, "publishing_plan.revoked");
  await assert.rejects(h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1" }] }, "u1"), rejectsWith("validation_failed"));
  await assert.rejects(h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s9", contentHash: s1.contentHash }] }, "u1"), rejectsWith("publishing_plan_slot_not_found"));
});

test("AC-WP-12: a channel not connected on this computer is refused before anything is read or written", async () => {
  const h = harness("2026-10-25T07:00:00Z", []);
  await assert.rejects(h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo" }, "factory"), rejectsWith("publishing_plan_channel_unavailable"));
  await assert.rejects(h.service.get({ channelId: CH, weekStart: WEEK }), rejectsWith("publishing_plan_channel_unavailable"));
  await assert.rejects(h.service.list({ channelId: CH }), rejectsWith("publishing_plan_channel_unavailable"));
  assert.deepEqual(await h.core.read(CH), { plans: {}, slots: {}, decisions: {} });
});

test("AC-WP-14: list -- newest week first, with counts and state; the waiting count is future, not vetoed slots needing approval", async () => {
  const h = harness();
  const first = await weekOfThree(h);
  await h.service.save({ channelId: CH, weekStart: "2026-11-02", timeZone: "Asia/Tokyo", slots: [tokyoSlot("n1", "2026-11-02", "18:00")] }, "factory");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s3" }] }, "u1");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: slotOf(first.plan, "s1").contentHash }] }, "u1");
  const { plans, waiting } = await h.service.ownerList(CH);
  assert.deepEqual(plans.map((p) => p.weekStart), ["2026-11-02", WEEK]);
  assert.deepEqual(plans[1].counts, { slots: 3, approved: 1, needsApproval: 1, vetoed: 1 });
  assert.equal(plans[1].state, "awaiting_approval");
  assert.equal(waiting, 2);
  assert.deepEqual((await h.service.list({ channelId: CH })).plans, plans);
  const empty = await h.service.save({ channelId: CH, weekStart: "2026-11-09", timeZone: "Asia/Tokyo" }, "factory");
  assert.equal(empty.plan.state, "empty");
});

// BL-225 stage 2: the agents' list is bounded -- the newest 12 weeks by default, `limit` 1-52; the owner's list (the screen) is not.
test("AC-WP-14: the agents' list returns the newest weeks only (default 12, limit 1..52)", async () => {
  const h = harness("2026-01-01T00:00:00Z");
  let monday = "2026-01-05";
  for (let i = 0; i < 14; i += 1) {
    await h.service.save({ channelId: CH, weekStart: monday, timeZone: "Asia/Tokyo" }, "factory");
    monday = new Date(Date.parse(`${monday}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  }
  const all = await h.service.list({ channelId: CH });
  assert.equal(all.plans.length, 12);
  assert.equal(all.plans[0].weekStart, "2026-04-06"); // the 14th Monday from 5 January
  assert.deepEqual((await h.service.list({ channelId: CH, limit: 2 })).plans.map((p) => p.weekStart), ["2026-04-06", "2026-03-30"]);
  await assert.rejects(h.service.list({ channelId: CH, limit: 53 }), rejectsWith("validation_failed"));
  assert.equal((await h.service.ownerList(CH)).plans.length, 14);
});

// BL-225 stage 2: the progress port's package reaches the slot view; a vetoed slot stays vetoed whatever its package says.
test("AC-WP-23: the slot shows its package progress; vetoed wins", async () => {
  const h = harness();
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-10-26", "18:00"), tokyoSlot("s2", "2026-10-27", "18:00")] }, "factory");
  const pkg = { video: "V64", title: "T", durationSeconds: 10800, languages: ["ja"], containsSyntheticMedia: true, thumbnailPath: null, testThumbnails: 0, problems: [] };
  const withProgress = createPublishingPlansService({
    store: h.core,
    isChannelConnected: async () => true,
    deviceLabel: async () => "Mac",
    now: () => new Date("2026-10-25T07:00:00Z"),
    randomId: () => "x",
    withLock: (fn) => fn(),
    audit: async () => undefined,
    progress: async () => new Map([["s1", { status: "packaged" as const, code: null, videoId: null, package: pkg }], ["s2", { status: "packaged" as const, code: null, videoId: null, package: pkg }]]),
  });
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  const { plan } = await withProgress.get({ channelId: CH, weekStart: WEEK });
  assert.equal(slotOf(plan, "s1").status, "packaged");
  assert.deepEqual(slotOf(plan, "s1").package, pkg);
  assert.equal(slotOf(plan, "s2").status, "vetoed");
});

// BL-225 stage 3 (ADR 0051 §5, §7): the uploads read each slot's decision -- approved (its UTC time), vetoed, or pending (not
// approved, changed since approval, released, or a slot id found in two plans).
test("AC-WP-30/31: slot decisions for the uploads", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: slotOf(plan, "s1").contentHash }, { slotId: "s2", contentHash: slotOf(plan, "s2").contentHash }] }, "u1");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), { kind: "approved", publishAt: "2026-10-26T06:00:00.000Z" }); // 15:00 JST
  assert.deepEqual(decisions.get("s2"), { kind: "vetoed" });
  // Review #2 changed this case: an id can no longer be saved in two weeks (see the review #2 tests); s3 is simply not approved.
  assert.deepEqual(decisions.get("s3"), { kind: "pending" }, "s3 is not approved");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "16:00")] }, "worker");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" }, "changed after approval");
  h.tick("2026-10-26T06:00:00Z");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s2"), { kind: "vetoed" }, "s2 (27.10) is still ahead");
  h.tick("2026-10-27T09:00:00Z");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s2"), { kind: "pending" }, "released");
});

// ---------------------------------------------------------------------------------------------------------------------------
// Independent review of BL-225 (2026-10-25). Each test states the failing scenario the review found; written before the fix.
// ---------------------------------------------------------------------------------------------------------------------------

// Review #2 (HIGH): a slot id reused in another week made every decision of it `pending` -- a veto stopped working. A slot id is
// unique per channel: a save naming an id that exists in another week is refused (`slot_id_in_other_week`).
test("review #2: a slot id that exists in another week of the channel is refused; nothing is saved", async () => {
  const h = harness();
  await weekOfThree(h);
  const error = await h.service.save({ channelId: CH, weekStart: "2026-11-02", timeZone: "Asia/Tokyo", slots: [tokyoSlot("s1", "2026-11-02", "18:00")] }, "factory").then(() => null, (e: unknown) => e);
  assert.deepEqual(refusedOf(error).map((r) => [r.slotId, r.reason]), [["s1", "slot_id_in_other_week"]]);
  await assert.rejects(h.service.get({ channelId: CH, weekStart: "2026-11-02" }), rejectsWith("publishing_plan_not_found"));
});

// Review #2: when an id is in two plans anyway (written before this check, or by two computers at once), a veto in either wins.
test("review #2: an ambiguous slot id is vetoed when any of its slots is vetoed, else pending", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  // Two computers each wrote "s1" in a different week before a sync: written straight into the store, past the save's check.
  await h.core.savePlan(CH, { weekStart: "2026-11-02", create: { weekStart: "2026-11-02", timeZone: "Asia/Tokyo", createdAt: "x", createdBy: "factory", updatedAt: "x", updatedBy: "factory" }, updatedAt: "x", updatedBy: "factory", upserts: [{ weekStart: "2026-11-02", slotId: "s1", date: "2026-11-02", publishAt: "2026-11-02T18:00", lengthHint: null, note: null, createdAt: "x", updatedAt: "x", updatedBy: "factory" }], removes: [] });
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: slotOf(plan, "s1").contentHash }] }, "u1");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
  await h.service.decide("UC-IdugmwWRvRo9-j0yK5AbA", "2026-11-02", { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "vetoed" });
});

// Review #3 (MEDIUM): an agent could remove an approved slot in two saves (edit it -> pending -> remove). A slot that has an
// approval still standing (even for older content), a vetoed slot, or one with an upload / a video, cannot be removed.
test("review #3: removing a slot with a standing approval (changed since), a vetoed slot or an uploaded one is refused", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: slotOf(plan, "s1").contentHash }] }, "u1");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s1", "2026-10-26", "19:00")] }, "worker");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  const error = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1", "s2"] }, "worker").then(() => null, (e: unknown) => e);
  assert.deepEqual(refusedOf(error).map((r) => [r.slotId, r.reason]).sort(), [["s1", "slot_approved"], ["s2", "slot_vetoed"]]);
  // A revoked approval no longer stands: the slot can go.
  const s1 = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "s1");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1");
  await h.service.decide(CH, WEEK, { action: "revoke", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1");
  assert.deepEqual((await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker")).removed, ["s1"]);
  // A slot with an upload (its video on YouTube) cannot be removed either.
  const uploaded = createPublishingPlansService({
    store: h.core,
    isChannelConnected: async () => true,
    deviceLabel: async () => "Mac",
    now: () => new Date("2026-10-25T07:00:00Z"),
    randomId: () => "y",
    withLock: (fn) => fn(),
    audit: async () => undefined,
    progress: async () => new Map([["s3", { status: "packaged" as const, code: null, videoId: "vid3", package: null }]]),
  });
  const refusedUpload = await uploaded.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s3"] }, "worker").then(() => null, (e: unknown) => e);
  assert.deepEqual(refusedUpload && refusedOf(refusedUpload).map((r) => [r.slotId, r.reason]), [["s3", "slot_uploaded"]]);
});

// Review #3: a slot moved earlier after approval stays vetoable until the later of its own time and the approved time it still
// stands on (the video may be scheduled at the approved time).
test("review #3: veto stays possible until the later of the slot's time and its standing approved time", async () => {
  const h = harness();
  const { plan } = await weekOfThree(h);
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s2", contentHash: slotOf(plan, "s2").contentHash }] }, "u1"); // 27.10 18:00 JST
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [tokyoSlot("s2", "2026-10-27", "12:00")] }, "worker"); // moved earlier
  h.tick("2026-10-27T04:00:00Z"); // 13:00 JST: the new time has passed, the approved 18:00 has not
  const vetoed = await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  assert.equal(slotOf(vetoed.plan, "s2").status, "vetoed");
});

// Review #7 (LOW): the newest decision was chosen by each computer's wall clock. A decision carries a counter one above the
// highest it saw, so a later decision wins even when its computer's clock is behind; the time only breaks ties.
test("review #7: a decision made after another wins even with an earlier clock (counter first, time as tiebreak)", async () => {
  const h = harness("2026-10-25T07:00:00Z");
  const { plan } = await weekOfThree(h);
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  h.tick("2026-10-25T06:00:00Z"); // the second computer's clock is an hour behind
  const restored = await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s1" }] }, "u1");
  assert.equal(slotOf(restored.plan, "s1").vetoed, null, "the restore made after the veto wins");
  void plan;
});
