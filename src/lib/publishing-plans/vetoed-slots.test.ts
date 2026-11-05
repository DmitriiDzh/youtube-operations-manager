import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import * as Automerge from "@automerge/automerge";
import { createPublishingPlansCore, emptyDocument, genesisDocument } from "@/lib/sync-gateway/publishing-plans";
import type { PublishingPlansDocument } from "@/lib/sync-gateway";
import { createPublishingPlansService } from "./services";
import { isDomainError, type PlanAuditEntry, type PlanSlotProgress, type PlanView } from "./contracts";

// BL-240 acceptance (docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md "BL-240", AC-WP-40..46; ADR 0060). Expected values by hand:
// Asia/Tokyo is UTC+9; 2026-10-26 and 2026-11-02 are Mondays; the clock stands at 2026-10-25T07:00Z, before every slot.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";
const WEEK = "2026-10-26";
const NEXT = "2026-11-02";

function harness(progress?: Map<string, PlanSlotProgress>) {
  const clock = { now: new Date("2026-10-25T07:00:00Z") };
  const bytes = new Map<string, Uint8Array>();
  // BL-242 (AC-WP-58): these BL-225/BL-240 acceptance tests run in the `slot` stage, set on the channel's document before the first
  // read (a new document is in `packaged`, ADR 0062 §1).
  bytes.set(CH, Automerge.save(Automerge.change(genesisDocument(CH), (d) => void (d.approvalStage = "slot"))));
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  const audits: PlanAuditEntry[] = [];
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async (channelId) => channelId === CH,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
    ...(progress ? { progress: async (_c: string, _w: string, ids: string[]) => ({ progress: new Map([...progress].filter(([id]) => ids.includes(id))), packagesUnavailable: false }) } : {}),
  });
  return { service, audits, core, clock };
}

const slot = (slotId: string, day: string, time: string, extra: Record<string, unknown> = {}) => ({ slotId, date: day, publishAt: `${day}T${time}`, lengthHint: "≈ 3 ч", ...extra });
const slotOf = (plan: PlanView, slotId: string) => plan.slots.find((s) => s.slotId === slotId)!;
const refusedOf = (error: unknown) => (isDomainError(error) ? ((error.details as { refused?: Array<{ slotId?: string; reason: string }> })?.refused ?? []) : []);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

async function week(h: ReturnType<typeof harness>) {
  return (await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [slot("s1", "2026-10-26", "15:00"), slot("s2", "2026-10-27", "18:00")] }, "factory")).plan;
}
async function approve(h: ReturnType<typeof harness>, weekStart: string, slotId: string) {
  const plan = (await h.service.get({ channelId: CH, weekStart })).plan;
  return h.service.decide(CH, weekStart, { action: "approve", slots: [{ slotId, contentHash: slotOf(plan, slotId).contentHash }] }, "u1");
}

test("AC-WP-40: a slot without replacesSlotId keeps the content hash it had before BL-240", async () => {
  const h = harness();
  const plan = await week(h);
  const expected = createHash("sha256").update('["Asia/Tokyo","2026-10-26","2026-10-26T15:00","≈ 3 ч",null]').digest("hex");
  assert.equal(slotOf(plan, "s1").contentHash, expected);
  assert.equal(slotOf(plan, "s1").replaces, null);
});

test("AC-WP-41: an approved-then-vetoed slot without an upload is removed, audited, and stays vetoed for the uploads", async () => {
  const h = harness();
  await week(h);
  await approve(h, WEEK, "s1");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  const before = h.audits.length;
  const { removed, plan } = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker");
  assert.deepEqual(removed, ["s1"]);
  assert.deepEqual(plan.slots.map((s) => s.slotId), ["s2"]);
  const added = h.audits.slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].slotId, "s1");
  assert.equal(added[0].detail.event, "publishing_plan.vetoed_slot_removed");
  assert.equal(added[0].detail.by, "worker");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "vetoed" });
});

test("AC-WP-42: a vetoed slot whose video is on YouTube is refused slot_uploaded; an approved one still slot_approved", async () => {
  const h = harness(new Map([["s1", { status: "packaged" as const, code: null, videoId: "vid1", package: null }]]));
  await week(h);
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  await approve(h, WEEK, "s2");
  const error = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1", "s2"] }, "worker"));
  assert.deepEqual(refusedOf(error).map((r) => [r.slotId, r.reason]).sort(), [["s1", "slot_uploaded"], ["s2", "slot_approved"]]);
});

test("AC-WP-43: a removed vetoed slot's id cannot be used for a new slot", async () => {
  const h = harness();
  await week(h);
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker");
  const error = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-28", "18:00")] }, "worker"));
  assert.deepEqual(refusedOf(error).map((r) => [r.slotId, r.reason]), [["s1", "slot_id_removed"]]);
});

test("AC-WP-44: replacesSlotId naming the slot itself or no slot of the channel is refused", async () => {
  const h = harness();
  await week(h);
  const self = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s3", "2026-10-28", "18:00", { replacesSlotId: "s3" })] }, "worker"));
  assert.deepEqual(refusedOf(self).map((r) => [r.slotId, r.reason]), [["s3", "replaces_self"]]);
  const unknown = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s3", "2026-10-28", "18:00", { replacesSlotId: "nope" })] }, "worker"));
  assert.deepEqual(refusedOf(unknown).map((r) => [r.slotId, r.reason]), [["s3", "replaces_unknown"]]);
});

test("AC-WP-45: adding replacesSlotId to an approved slot drops its approval", async () => {
  const h = harness();
  await week(h);
  await approve(h, WEEK, "s2");
  const { unlocked, plan } = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s2", "2026-10-27", "18:00", { replacesSlotId: "s1" })] }, "worker");
  assert.deepEqual(unlocked, ["s2"]);
  assert.equal(slotOf(plan, "s2").approval, "needs_approval");
  assert.equal(slotOf(plan, "s2").replaces?.slotId, "s1");
  assert.equal(slotOf(plan, "s2").replaces?.found, true);
});

test("AC-WP-46: approving a slot that replaces another vetoes that one in the same decision, audited, also across weeks", async () => {
  const h = harness();
  await week(h);
  await approve(h, WEEK, "s1");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s3", "2026-10-28", "18:00", { replacesSlotId: "s1" })] }, "worker");
  const before = h.audits.length;
  const result = await approve(h, WEEK, "s3");
  assert.deepEqual(result.decided, ["s3"]);
  assert.deepEqual(result.replacedVetoed, ["s1"]);
  assert.equal(slotOf(result.plan, "s3").approval, "approved");
  assert.equal(slotOf(result.plan, "s1").vetoed?.replacedBy, "s3");
  assert.equal(slotOf(result.plan, "s1").status, "vetoed");
  const added = h.audits.slice(before).map((a) => [a.slotId, a.detail.event, a.detail.replacedBy ?? null]);
  assert.deepEqual(added, [["s3", "publishing_plan.approved", null], ["s1", "publishing_plan.vetoed", "s3"]]);
  const uploads = await h.service.slotDecisions(CH);
  assert.deepEqual(uploads.get("s1"), { kind: "vetoed" });
  assert.deepEqual(uploads.get("s3"), { kind: "approved", publishAt: "2026-10-28T09:00:00.000Z" });

  // Another week: n1 (2 Nov) replaces s2 (27 Oct).
  await h.service.save({ channelId: CH, weekStart: NEXT, timeZone: "Asia/Tokyo", slots: [slot("n1", "2026-11-02", "18:00", { replacesSlotId: "s2" })] }, "factory");
  const next = await approve(h, NEXT, "n1");
  assert.deepEqual(next.replacedVetoed, ["s2"]);
  assert.equal(slotOf(next.plan, "n1").replaces?.vetoed, true);
  assert.equal(slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "s2").vetoed?.replacedBy, "n1");
});

test("AC-WP-46: a replaced slot already vetoed gets no second record; restoring it stays possible", async () => {
  const h = harness();
  await week(h);
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s3", "2026-10-28", "18:00", { replacesSlotId: "s1" })] }, "worker");
  const before = h.audits.length;
  const result = await approve(h, WEEK, "s3");
  assert.deepEqual(result.replacedVetoed, []);
  assert.equal(h.audits.length - before, 1);
  const restored = await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s1" }] }, "u1");
  assert.equal(slotOf(restored.plan, "s1").vetoed, null);
});

test("AC-WP-46: a replaced slot whose time has passed gets no veto record", async () => {
  const h = harness();
  await week(h);
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s3", "2026-10-28", "18:00", { replacesSlotId: "s1" })] }, "worker");
  h.clock.now = new Date("2026-10-26T07:00:00Z"); // 16:00 JST on 26 Oct: s1 (15:00) is released, s3 (28 Oct) is not
  const result = await approve(h, WEEK, "s3");
  assert.deepEqual(result.replacedVetoed, []);
  assert.equal(slotOf(result.plan, "s1").vetoed, null);
});

test("review: two slots replacing each other are refused replaces_cycle (one save, or against a stored slot)", async () => {
  const h = harness();
  await week(h);
  const together = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "15:00", { replacesSlotId: "s2" }), slot("s2", "2026-10-27", "18:00", { replacesSlotId: "s1" })] }, "worker"));
  assert.deepEqual(refusedOf(together).map((r) => [r.slotId, r.reason]).sort(), [["s1", "replaces_cycle"], ["s2", "replaces_cycle"]]);
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "15:00", { replacesSlotId: "s2" })] }, "worker");
  const later = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s2", "2026-10-27", "18:00", { replacesSlotId: "s1" })] }, "worker"));
  assert.deepEqual(refusedOf(later).map((r) => [r.slotId, r.reason]), [["s2", "replaces_cycle"]]);
});
