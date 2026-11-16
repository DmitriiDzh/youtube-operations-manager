import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument } from "@/lib/sync-gateway/publishing-plans";
import type { PublishingPlansDocument } from "@/lib/sync-gateway";
import { agentSurface, createPublishingPlansService, ownerSurface } from "./services";
import { decisionForRow } from "@/lib/publishing/plan-schedule";
import { isDomainError, type PlanAuditEntry, type PlanProgressResult, type PlanSlotPackage, type PlanSlotProgress, type PlanView } from "./contracts";

// BL-242 acceptance (docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md "BL-242", AC-WP-50..56; ADR 0062). Expected values by hand:
// Asia/Tokyo is UTC+9 (15:00 JST on 2026-10-26 is 06:00Z); 2026-10-26 is a Monday; the clock stands at 2026-10-25T07:00Z, before
// every slot. The hashes are SHA-256 over the literal JSON arrays the plan names, computed here with node:crypto -- never with the
// module's own hash function.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";
const WEEK = "2026-10-26";
const AA = "a".repeat(64);
const BB = "b".repeat(64);
const sha = (fields: unknown[]) => createHash("sha256").update(JSON.stringify(fields)).digest("hex");
/** The BL-225 slot of AC-WP-52 / AC-WP-40: Tokyo, Monday 15:00, «≈ 3 ч», no note. */
const SLOT_FIELDS = ["Asia/Tokyo", "2026-10-26", "2026-10-26T15:00", "≈ 3 ч", null];

const pkg = (over: Partial<PlanSlotPackage> = {}): PlanSlotPackage => ({
  video: "V64",
  title: "Title V64",
  durationSeconds: 10800,
  languages: ["ja"],
  containsSyntheticMedia: true,
  thumbnailPath: null,
  testThumbnails: 0,
  problems: [],
  manifestSha256: AA,
  ...over,
});
const packaged = (over: Partial<PlanSlotPackage> = {}, videoId: string | null = null): PlanSlotProgress => ({ status: "packaged", code: null, videoId, package: pkg(over) });

function harness(options: { progressFails?: () => boolean; packagesUnavailable?: () => boolean } = {}) {
  const clock = { now: new Date("2026-10-25T07:00:00Z") };
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  const audits: PlanAuditEntry[] = [];
  // What the packages say of each slot; tests change it between reads.
  const progress = new Map<string, PlanSlotProgress>();
  // Round 3 (item 3): every progress read, with the slot ids it asked for.
  const progressCalls: string[][] = [];
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async (channelId) => channelId === CH,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
    progress: async (_c, _w, ids) => {
      progressCalls.push([...ids].sort());
      if (options.progressFails?.()) throw new Error("the package scan failed");
      // BL-243: the port's result, with the production port's flag for a package scan that could not be read.
      const answer: PlanProgressResult = { progress: new Map([...progress].filter(([id]) => ids.includes(id))), packagesUnavailable: options.packagesUnavailable?.() ?? false };
      return answer;
    },
  });
  return { service, audits, core, progress, clock, progressCalls };
}

const slot = (slotId: string, day: string, time: string, extra: Record<string, unknown> = {}) => ({ slotId, date: day, publishAt: `${day}T${time}`, lengthHint: "≈ 3 ч", ...extra });
const slotOf = (plan: PlanView, slotId: string) => plan.slots.find((s) => s.slotId === slotId)!;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

async function week(h: ReturnType<typeof harness>) {
  return (await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [slot("s1", "2026-10-26", "15:00"), slot("s2", "2026-10-27", "18:00")] }, "factory")).plan;
}
const get = async (h: ReturnType<typeof harness>) => (await h.service.get({ channelId: CH, weekStart: WEEK })).plan;
async function approve(h: ReturnType<typeof harness>, slotId: string) {
  const plan = await get(h);
  return h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId, contentHash: slotOf(plan, slotId).contentHash }] }, "u1");
}

// BL-267 (ADR 0073, plan §3.8, AC-WT-38): the approval stage is retired. AC-WP-50 asserted the owner's stage switch; the requirement
// changed (owner msgs 4569/4575: no slot approval), so it now asserts that the switch writes nothing and a `slot` stage in the
// document is ignored -- an older build is never put into the slot stage by this one.
test("AC-WT-38 (was AC-WP-50): setApprovalStage validates and writes nothing; a document saying `slot` reads packaged", async () => {
  const h = harness();
  await week(h);
  assert.equal((await h.service.ownerList(CH)).approvalStage, "packaged");
  assert.deepEqual(await h.service.setApprovalStage(CH, { stage: "slot" }, "u1"), { approvalStage: "packaged", changed: false });
  assert.equal((await h.core.read(CH)).approvalStage, undefined);
  assert.equal(h.audits.filter((a) => a.detail.event === "publishing_plan.approval_stage").length, 0);
  await h.core.setApprovalStage(CH, "slot");
  assert.equal((await get(h)).approvalStage, "packaged");
  for (const input of [{ stage: "week" }, { stage: "slot", by: "agent" }, {}]) {
    const error = await refusal(h.service.setApprovalStage(CH, input, "u1"));
    assert.ok(isDomainError(error) && error.code === "validation_failed", JSON.stringify(input));
  }
});

test("AC-WP-50: an agent cannot set the stage -- the save schema has no such field and the agents' surface no such function", async () => {
  const h = harness();
  await week(h);
  for (const input of [
    { channelId: CH, weekStart: WEEK, approvalStage: "slot" },
    { channelId: CH, weekStart: WEEK, slots: [{ ...slot("s1", "2026-10-26", "15:00"), approvalStage: "slot" }] },
  ]) {
    const error = await refusal(h.service.save(input, "worker"));
    assert.ok(isDomainError(error) && error.code === "validation_failed", JSON.stringify(input));
  }
  assert.equal((await h.core.read(CH)).approvalStage, undefined);
  // BL-267 (ADR 0073 §1, plan §3.10): agents also READ the week template (agent_publishing_template_get) -- still no decision.
  assert.deepEqual(Object.keys(agentSurface(h.service)).sort(), ["get", "list", "save", "templateGet"]);
  assert.ok("setApprovalStage" in ownerSurface(h.service), "the owner's surface has it");
});

test("AC-WP-51: packaged -- slots without a package await it; the plan is planned, nothing waits; one ready package makes it awaiting_approval", async () => {
  const h = harness();
  const plan = await week(h);
  assert.deepEqual(plan.slots.map((s) => s.approval), ["awaiting_package", "awaiting_package"]);
  assert.equal(plan.state, "planned");
  assert.deepEqual(plan.counts, { slots: 2, approved: 0, needsApproval: 0, vetoed: 0 });
  assert.equal((await h.service.ownerList(CH)).waiting, 0, "no badge");
  assert.equal((await h.service.list({ channelId: CH })).plans[0].state, "planned");

  h.progress.set("s1", packaged());
  const later = await get(h);
  assert.equal(slotOf(later, "s1").approval, "needs_approval");
  assert.equal(slotOf(later, "s2").approval, "awaiting_package");
  assert.equal(later.state, "awaiting_approval");
  assert.equal(later.counts.needsApproval, 1);
  assert.equal((await h.service.ownerList(CH)).waiting, 1);
});

test("AC-WP-51: agents change a slot that awaits its package freely -- no unlocked, and it can be removed", async () => {
  const h = harness();
  await week(h);
  const moved = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "16:00")] }, "worker");
  assert.deepEqual([moved.changed, moved.unlocked], [["s1"], []]);
  const removed = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s2"] }, "worker");
  assert.deepEqual(removed.removed, ["s2"]);
});

test("AC-WP-52: a ready package makes the slot approvable with the fingerprint appended to its hash; problems keep it waiting; an upload is approvable", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged());
  let s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.contentHash, sha([...SLOT_FIELDS, ["V64", AA, null]]));
  assert.notEqual(s1.contentHash, sha(SLOT_FIELDS), "not the bare BL-225 hash");
  assert.deepEqual(s1.fingerprint, { video: "V64", manifestSha256: AA, videoId: null });

  h.progress.set("s1", packaged({ problems: ["thumbnail_missing"] }));
  s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "awaiting_package");
  assert.equal(s1.contentHash, sha(SLOT_FIELDS), "nothing to approve: the bare slot hash is shown");
  assert.equal(s1.fingerprint, null);

  h.progress.set("s1", { status: "built", code: null, videoId: null, package: pkg() });
  assert.equal(slotOf(await get(h), "s1").approval, "awaiting_package", "built, not packaged");

  // Uploaded private without a date: approvable whatever the scan's problems, with the video id in the fingerprint.
  h.progress.set("s1", packaged({ problems: ["video_missing"] }, "vid1"));
  s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.contentHash, sha([...SLOT_FIELDS, ["V64", AA, "vid1"]]));

  // No package at all (only an upload row's video id, the package moved to another slot): nothing to approve here.
  h.progress.set("s1", { status: "packaged", code: null, videoId: "vid1", package: null });
  assert.equal(slotOf(await get(h), "s1").approval, "awaiting_package");
});

test("AC-WP-53: approving a slot that awaits its package is refused publishing_plan_slot_not_packaged and records nothing", async () => {
  const h = harness();
  const plan = await week(h);
  const error = await refusal(h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: slotOf(plan, "s1").contentHash }] }, "u1"));
  assert.ok(isDomainError(error) && error.code === "publishing_plan_slot_not_packaged", String(error));
  // BL-267 (AC-WT-26): the week at once is refused outright (one slot per explicit date); nothing is approved.
  h.progress.set("s2", packaged({ video: "V65", manifestSha256: BB }));
  const both = await get(h);
  const week2 = await refusal(h.service.decide(CH, WEEK, { action: "approve", slots: both.slots.map((s) => ({ slotId: s.slotId, contentHash: s.contentHash })) }, "u1"));
  assert.ok(isDomainError(week2) && week2.code === "validation_failed");
  assert.deepEqual((await h.core.read(CH)).decisions, {});
  assert.deepEqual(h.audits, []);
});

test("AC-WP-54: approved with V64/aa; another manifest needs the owner again, the same one is approved again; an agent's new time needs him too", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged());
  const { decided } = await approve(h, "s1");
  assert.deepEqual(decided, ["s1"]);
  let s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "approved");
  assert.equal(s1.contentHash, sha([...SLOT_FIELDS, ["V64", AA, null]]));
  const record = Object.values((await h.core.read(CH)).decisions)[0];
  assert.deepEqual([record.kind, record.contentHash, record.package], ["approved", sha([...SLOT_FIELDS, ["V64", AA, null]]), { video: "V64", manifestSha256: AA, videoId: null }]);
  assert.deepEqual(h.audits[0].detail.package, { video: "V64", manifestSha256: AA, videoId: null });

  h.progress.set("s1", packaged({ manifestSha256: BB }));
  s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.contentHash, sha([...SLOT_FIELDS, ["V64", BB, null]]));
  assert.equal(s1.changedAfterApproval?.previous.package?.manifestSha256, AA, "what the owner approved");

  h.progress.set("s1", packaged());
  assert.equal(slotOf(await get(h), "s1").approval, "approved", "back to the approved manifest");

  // Another video number with the same manifest hash is another package too.
  h.progress.set("s1", packaged({ video: "V65" }));
  assert.equal(slotOf(await get(h), "s1").approval, "needs_approval");
  h.progress.set("s1", packaged());

  const moved = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "18:00")] }, "worker");
  assert.deepEqual(moved.unlocked, ["s1"]);
  s1 = slotOf(moved.plan, "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.changedAfterApproval?.previous.publishAt, "2026-10-26T15:00");
});

// Interpretation (ADR 0062 §2-§3, reported): the upload of the approved manifest gives the package a video id; the owner approved that
// package, so the approval made before the upload still stands for the video made of it -- else every approved slot would need him
// again once its upload finished. Another video id is another video.
test("AC-WP-54: an approval made before the upload stands for the video that upload made of the approved manifest", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged());
  await approve(h, "s1");
  h.progress.set("s1", packaged({}, "vid1"));
  const s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "approved");
  assert.equal(s1.contentHash, sha([...SLOT_FIELDS, ["V64", AA, null]]), "the approval's own hash (revoking names it)");
  await h.service.decide(CH, WEEK, { action: "revoke", slots: [{ slotId: "s1", contentHash: s1.contentHash }] }, "u1");
  const revoked = slotOf(await get(h), "s1");
  assert.equal(revoked.approval, "needs_approval");
  assert.equal(revoked.contentHash, sha([...SLOT_FIELDS, ["V64", AA, "vid1"]]));
  // Approved now with the video id: a different video id is not covered.
  await approve(h, "s1");
  h.progress.set("s1", packaged({}, "vid2"));
  assert.equal(slotOf(await get(h), "s1").approval, "needs_approval");
});

// BL-267 (AC-WT-38): the slot stage is retired. AC-WP-55 switched stages; now a slot-stage approval (no package) written by an older
// build simply never counts: the slot needs the owner's explicit date with its package, the uploads see pending.
test("AC-WT-38 (was AC-WP-55): a slot-stage approval in the document dates nothing; a packaged approval counts", async () => {
  const h = harness();
  const plan = await week(h);
  const s1 = slotOf(plan, "s1");
  await h.core.addDecisions(CH, [{ id: "old1", weekStart: WEEK, slotId: "s1", kind: "approved", contentHash: s1.contentHash, snapshot: { date: s1.date, publishAt: s1.publishAt, lengthHint: s1.lengthHint, note: s1.note, timeZone: "Asia/Tokyo" }, by: "owner", device: "Windows", at: "2026-10-25T07:00:00Z", seq: 1 }]);
  h.progress.set("s1", packaged());
  const after = slotOf(await get(h), "s1");
  assert.equal(after.approval, "needs_approval");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
  await approve(h, "s1");
  assert.equal((await h.service.slotDecisions(CH)).get("s1")?.kind, "approved");
});

test("AC-WP-56: the uploads' decision for an approved packaged slot names the fingerprint; a veto carries it too", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged());
  h.progress.set("s2", packaged({ video: "V65", manifestSha256: BB }, "vid65"));
  await approve(h, "s1");
  await approve(h, "s2");
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), { kind: "approved", publishAt: "2026-10-26T06:00:00.000Z", package: { video: "V64", manifestSha256: AA, videoId: null } , source: "owner" });
  assert.deepEqual(decisions.get("s2"), { kind: "approved", publishAt: "2026-10-27T09:00:00.000Z", package: { video: "V65", manifestSha256: BB, videoId: "vid65" } , source: "owner" });
  // R1 (re-review of BL-242): the uploads read the same package the screen does -- another manifest now, the approval counts nowhere.
  h.progress.set("s1", packaged({ manifestSha256: BB }));
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
  h.progress.set("s1", packaged());
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s2"), { kind: "vetoed", package: { video: "V65", manifestSha256: BB, videoId: "vid65" } });
  // An agent changing the time drops the approval for the uploads too.
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "18:00")] }, "worker");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
});

test("AC-WP-56: a slot never approved in the packaged stage is pending; the plan is approved once every live slot is", async () => {
  const h = harness();
  await week(h);
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
  h.progress.set("s1", packaged());
  h.progress.set("s2", packaged({ video: "V65", manifestSha256: BB }));
  await approve(h, "s1");
  assert.equal((await get(h)).state, "awaiting_approval");
  await approve(h, "s2");
  const plan = await get(h);
  assert.equal(plan.state, "approved");
  assert.deepEqual(plan.counts, { slots: 2, approved: 2, needsApproval: 0, vetoed: 0 });
});

// Re-review of BL-242 (2026-11-04), written before the fix (WEEKLY_PUBLISHING_PLAN.md BL-242 C/D, ADR 0062 §3-§4):
// R1 -- an approval counts only while it is the slot's standing approval AND covers the slot's CURRENT package; the screen and the
//      uploads read the same progress; progress unreadable -> nothing approved, vetoes still apply.
// R2 -- a veto records the slot's current package (else that of its last approval not revoked); for a video the newest decision
//      naming it decides: a counting approval -> its date, a standing veto -> no date; a restore cancels the veto.
// R3 -- nothing counts for a video -> pending, its YouTube date stays and the slot holding the package shows it.
const V73 = { video: "V73" };
const B_TIME = "2026-10-27T09:00:00.000Z"; // s2: 27.10 18:00 JST
const A_TIME = "2026-10-26T06:00:00.000Z"; // s1: 26.10 15:00 JST
/** A finished upload made for slot s3 (the slot the package first named), video vid1, manifest aa. */
const rowOfOld = { slotId: "s3", videoId: "vid1", manifestSha256: AA };
async function threeSlots(h: ReturnType<typeof harness>) {
  return (await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [slot("s1", "2026-10-26", "15:00"), slot("s2", "2026-10-27", "18:00"), slot("s3", "2026-10-28", "18:00")] }, "factory")).plan;
}
const uploaded = (publishAt: string | null = null): PlanSlotProgress => ({ ...packaged(V73, "vid1"), ...(publishAt ? { publishAt } : {}) });

test("AC-WP-60: the package (V73, vid1) moves from A to B and B is approved -> B dates vid1; A counts nowhere", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s1", uploaded());
  await approve(h, "s1");
  h.progress.delete("s1");
  h.progress.set("s2", uploaded(A_TIME));
  await approve(h, "s2");
  const plan = await get(h);
  assert.equal(slotOf(plan, "s1").approval, "awaiting_package");
  assert.equal(slotOf(plan, "s2").approval, "approved");
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), { kind: "pending" });
  assert.deepEqual(decisions.get("s2"), { kind: "approved", publishAt: B_TIME, package: { video: "V73", manifestSha256: AA, videoId: "vid1" } , source: "owner" });
  assert.deepEqual(decisionForRow(rowOfOld, decisions), decisions.get("s2"));
});

test("AC-WP-61: the package moves from X back to A -> X counts nowhere, vid1 pending with its date kept, A needs approval showing it; approving A gives A's time", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s2", uploaded());
  await approve(h, "s2"); // X, dated at B_TIME by the plan schedule
  h.progress.delete("s2");
  h.progress.set("s1", uploaded(B_TIME)); // the package is on A now, its video still dated at X's time
  const plan = await get(h);
  assert.equal(slotOf(plan, "s2").approval, "awaiting_package");
  const a = slotOf(plan, "s1");
  assert.equal(a.approval, "needs_approval");
  assert.equal(a.youtubePublishAt, B_TIME, "the stray date the owner sees on A");
  let decisions = await h.service.slotDecisions(CH);
  assert.deepEqual([decisions.get("s1"), decisions.get("s2")], [{ kind: "pending" }, { kind: "pending" }]);
  assert.deepEqual(decisionForRow(rowOfOld, decisions), { kind: "pending" }, "nothing counts: the date stays (pending, BL-225)");
  await approve(h, "s1");
  decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisionForRow(rowOfOld, decisions), { kind: "approved", publishAt: A_TIME, package: { video: "V73", manifestSha256: AA, videoId: "vid1" } , source: "owner" });
});

test("AC-WP-62: X approved naming vid1 and dated; an agent edits X (or the owner revokes X); the owner vetoes X -> vid1's date is removed", async () => {
  for (const how of ["edit", "revoke"] as const) {
    const h = harness();
    await threeSlots(h);
    h.progress.set("s2", uploaded(B_TIME));
    await approve(h, "s2");
    // BL-267 (AC-WT-35): an agent can no longer re-time a dated slot (slot_dated), so the agent's edit changes its note instead --
    // still a change that leaves the approval behind.
    if (how === "edit") await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s2", "2026-10-27", "18:00", { note: "другой вариант" })] }, "worker");
    else {
      const shown = slotOf(await get(h), "s2");
      await h.service.decide(CH, WEEK, { action: "revoke", slots: [{ slotId: "s2", contentHash: shown.contentHash }] }, "u1");
    }
    await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
    const decisions = await h.service.slotDecisions(CH);
    assert.deepEqual(decisions.get("s2"), { kind: "vetoed", package: { video: "V73", manifestSha256: AA, videoId: "vid1" } }, how);
    assert.equal(decisionForRow(rowOfOld, decisions)?.kind, "vetoed", how);
  }
});

test("AC-WP-62: a veto of a slot whose package has gone records the package of its last approval not revoked", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s2", uploaded(B_TIME));
  await approve(h, "s2");
  h.progress.delete("s2");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s2"), { kind: "vetoed", package: { video: "V73", manifestSha256: AA, videoId: "vid1" } });
});

test("AC-WP-63: X vetoed naming vid1, then the package moves to B and B is approved -> B dates it; restoring X changes nothing", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s2", uploaded());
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  assert.equal(decisionForRow(rowOfOld, await h.service.slotDecisions(CH))?.kind, "vetoed");
  h.progress.delete("s2");
  h.progress.set("s1", uploaded());
  await approve(h, "s1");
  let decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisionForRow(rowOfOld, decisions), { kind: "approved", publishAt: A_TIME, package: { video: "V73", manifestSha256: AA, videoId: "vid1" } , source: "owner" }, "the newer approval beats the older veto");
  assert.equal(decisions.get("s2")?.kind, "vetoed", "X itself stays vetoed");
  await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s2" }] }, "u1");
  decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisionForRow(rowOfOld, decisions), { kind: "approved", publishAt: A_TIME, package: { video: "V73", manifestSha256: AA, videoId: "vid1" } , source: "owner" });
  assert.deepEqual(decisions.get("s2"), { kind: "pending" });
});

test("AC-WP-63: a veto newer than the approval naming the same video removes its date; restoring it gives the date back", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s1", uploaded());
  await approve(h, "s1");
  h.progress.set("s2", uploaded()); // the same video number shows on X too (two packages of one video)
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  assert.equal(decisionForRow(rowOfOld, await h.service.slotDecisions(CH))?.kind, "vetoed");
  await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "s2" }] }, "u1");
  assert.equal(decisionForRow(rowOfOld, await h.service.slotDecisions(CH))?.kind, "approved");
});

test("defensive: two counting approvals naming the same video number are both pending", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s1", uploaded());
  h.progress.set("s2", uploaded());
  await approve(h, "s1");
  await approve(h, "s2");
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual([decisions.get("s1"), decisions.get("s2")], [{ kind: "pending" }, { kind: "pending" }]);
});

test("AC-WP-64: the progress read fails -> slotDecisions approves nothing; a recorded veto still applies", async () => {
  let failing = false;
  const h = harness({ progressFails: () => failing });
  await threeSlots(h);
  h.progress.set("s1", packaged());
  h.progress.set("s2", uploaded(B_TIME));
  await approve(h, "s1");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s2" }] }, "u1");
  failing = true;
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), { kind: "pending" });
  assert.deepEqual(decisions.get("s2"), { kind: "vetoed", package: { video: "V73", manifestSha256: AA, videoId: "vid1" } });
  assert.equal(decisionForRow(rowOfOld, decisions)?.kind, "vetoed");
});

// Round 3 review of BL-242 (2026-11-04), written before the fix (WEEKLY_PUBLISHING_PLAN.md BL-242 D, ADR 0062 §4):
// (a) a veto of a slot without a current package records its last approval's package only if no other slot of the channel has a
//     counting approval for that video number; otherwise none (it reaches only rows made with its slot id);
// (b) the YouTube date shows only on the slot whose CURRENT package names the video -- an upload row keyed by the old slot does not;
// item 2: a counting approval the uploads turn pending (two of one video number) is flagged on the screen;
// item 3: slotDecisions reads progress once for the channel's live slots.
const rowOnly = (publishAt: string): PlanSlotProgress => ({ status: "scheduled", code: null, videoId: "vid1", publishAt, package: null });

test("AC-WP-65: vid1 uploaded for A, A approved; the package moves to B, B approved and dated; the owner vetoes A -> B keeps its date, A's veto has no package", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s1", uploaded());
  await approve(h, "s1");
  h.progress.set("s1", rowOnly(B_TIME)); // A keeps only its upload row (the package now names B)
  h.progress.set("s2", uploaded(B_TIME));
  await approve(h, "s2");
  assert.equal(slotOf(await get(h), "s1").youtubePublishAt, null, "(b) A does not show the date: its current package does not name the video");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  const vetoRecord = Object.values((await h.core.read(CH)).decisions).find((d) => d.kind === "vetoed" && d.slotId === "s1")!;
  assert.equal(vetoRecord.package, undefined, "(a) B counts an approval for V73: the veto records none");
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), { kind: "vetoed" });
  const rowOfA = { slotId: "s1", videoId: "vid1", manifestSha256: AA };
  assert.deepEqual(decisionForRow(rowOfA, decisions), { kind: "approved", publishAt: B_TIME, package: { video: "V73", manifestSha256: AA, videoId: "vid1" } , source: "owner" }, "B keeps its date");
});

test("round 3 (b): the YouTube date shows on the slot whose current package names the video, not on a slot with only its upload row", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s1", rowOnly(B_TIME));
  h.progress.set("s2", uploaded(B_TIME));
  const plan = await get(h);
  assert.equal(slotOf(plan, "s1").youtubePublishAt, null);
  assert.equal(slotOf(plan, "s2").youtubePublishAt, B_TIME);
});

test("round 3 item 2: two counting approvals of one video number -- both slots are flagged duplicateVideo on the screen", async () => {
  const h = harness();
  await threeSlots(h);
  h.progress.set("s1", uploaded());
  h.progress.set("s2", uploaded());
  await approve(h, "s1");
  assert.equal(slotOf(await get(h), "s1").duplicateVideo, false, "one approval: nothing to flag");
  await approve(h, "s2");
  const plan = await get(h);
  assert.deepEqual([slotOf(plan, "s1").duplicateVideo, slotOf(plan, "s2").duplicateVideo, slotOf(plan, "s3").duplicateVideo], [true, true, false]);
});

test("round 3 item 3: slotDecisions reads progress once, for the live slots of every week (a past week is not asked)", async () => {
  const h = harness();
  await week(h); // s1 26.10, s2 27.10
  await h.service.save({ channelId: CH, weekStart: "2026-11-02", timeZone: "Asia/Tokyo", slots: [slot("n1", "2026-11-02", "15:00"), slot("n2", "2026-11-03", "15:00")] }, "factory");
  h.progressCalls.length = 0;
  await h.service.slotDecisions(CH);
  assert.deepEqual(h.progressCalls, [["n1", "n2", "s1", "s2"]]);
  h.clock.now = new Date("2026-11-01T00:00:00Z"); // the first week is past
  h.progressCalls.length = 0;
  await h.service.slotDecisions(CH);
  assert.deepEqual(h.progressCalls, [["n1", "n2"]]);
});

// BL-243 (WEEKLY_PUBLISHING_PLAN.md AC-WP-70): a slot whose only package names a video the sync found removed on YouTube. The
// progress (as the composition gives it, AC-WP-69): failed with video_deleted_on_youtube, the video id kept, no date.
const deletedProgress = (): PlanSlotProgress => ({
  status: "failed",
  code: "video_deleted_on_youtube",
  videoId: "vid73",
  publishAt: null,
  package: pkg({ video: "V73", problems: ["video_deleted_on_youtube"] }),
});

test("BL-243 AC-WP-70: a deleted video is nothing to approve; an earlier approval of it does not count; the slot stage keeps BL-225", async () => {
  for (const approvedWith of ["vid73", null]) {
    const h = harness();
    await week(h);
    h.progress.set("s1", { ...packaged({ video: "V73" }, approvedWith), publishAt: approvedWith ? "2026-10-26T06:00:00.000Z" : null });
    await approve(h, "s1");
    assert.equal(slotOf(await get(h), "s1").approval, "approved");
    assert.equal((await h.service.slotDecisions(CH)).get("s1")?.kind, "approved");

    h.progress.set("s1", deletedProgress());
    const s1 = slotOf(await get(h), "s1");
    assert.equal(s1.approval, "awaiting_package", `approved with ${approvedWith}`);
    assert.equal(s1.fingerprint, null);
    assert.equal(s1.status, "failed");
    assert.equal(s1.statusCode, "video_deleted_on_youtube");
    assert.equal(s1.videoId, "vid73");
    assert.equal(s1.youtubePublishAt, null);
    assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
    const error = await refusal(approve(h, "s1"));
    assert.ok(isDomainError(error) && error.code === "publishing_plan_slot_not_packaged");
  }

  // BL-267 (AC-WT-38): the `slot` stage part of this test is gone with the stage (no approval without a package any more).
});

test("BL-243 AC-WP-70: a vetoed slot whose video was deleted on YouTube can be removed (its video is not on YouTube)", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", deletedProgress());
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  const { removed } = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker");
  assert.deepEqual(removed, ["s1"]);
});

// BL-243 review (AC-WP-70): a deleted-only slot has nothing to approve, so no change after an approval is reported either, and the
// slot's release is not held back to the time of that old approval. Values by hand: s1 approved at 15:00 JST (06:00Z), the agent
// moves it to 12:00 JST (03:00Z); at 04:00Z the slot's own time has passed and nothing else holds it.
test("BL-243 AC-WP-70: a deleted-only slot shows no changedAfterApproval and is not held to the old approval's time", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged({ video: "V73" }, "vid73"));
  await approve(h, "s1");
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [slot("s1", "2026-10-26", "12:00"), slot("s2", "2026-10-27", "18:00")] }, "worker");
  assert.notEqual(slotOf(await get(h), "s1").changedAfterApproval, null, "a live package: the owner sees the change");
  h.progress.set("s1", deletedProgress());
  h.clock.now = new Date("2026-10-26T04:00:00Z");
  const s1 = slotOf(await get(h), "s1");
  assert.equal(s1.changedAfterApproval, null);
  assert.equal(s1.released, true);
});

// BL-243 review round 2, item 4 (AC-WP-77): save() counts an approval as the view does -- in the packaged stage only while it
// covers the slot's current package; a deleted video's package has none. So after the video is deleted the approved slot can be
// removed (no slot_approved), and retiming it unlocks nothing. With a live package both stay as BL-242 has them.
test("BL-243 AC-WP-77: after the video is deleted, the once-approved slot can be removed and a retime unlocks nothing", async () => {
  const live = harness();
  await week(live);
  live.progress.set("s1", packaged({ video: "V73" }, "vid73"));
  await approve(live, "s1");
  const retimedLive = await live.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "12:00")] }, "worker");
  assert.deepEqual(retimedLive.unlocked, ["s1"], "a live package: the change needs the owner again");
  const refusedLive = await refusal(live.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker"));
  assert.ok(isDomainError(refusedLive) && refusedLive.code === "validation_failed");
  assert.deepEqual(((refusedLive as { details?: { refused?: Array<{ slotId: string; reason: string }> } }).details?.refused ?? []).map((r) => [r.slotId, r.reason]), [["s1", "slot_approved"]]);

  const h = harness();
  await week(h);
  h.progress.set("s1", packaged({ video: "V73" }, "vid73"));
  await approve(h, "s1");
  h.progress.set("s1", deletedProgress());
  const retimed = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "12:00")] }, "worker");
  assert.deepEqual(retimed.unlocked, []);
  const { removed } = await h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker");
  assert.deepEqual(removed, ["s1"]);
});

// BL-243 review round 5, item 6 (AC-WP-77): save() reads the progress ONCE -- the read the returned view always needed (the channel's
// live slots, the ones removed and the ones sent) also serves the approval rule and the removals' check. Every save: one read.
test("BL-243 AC-WP-77: save() reads progress once, for the approval rule, the removals and the returned view", async () => {
  const h = harness();
  await week(h);
  const reads = () => h.progressCalls.length;
  let before = reads();
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s2", "2026-10-27", "19:00")] }, "worker");
  assert.equal(reads(), before + 1, "packaged, nothing approved");

  h.progress.set("s1", packaged({ video: "V73" }, "vid73"));
  await approve(h, "s1");
  before = reads();
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s2", "2026-10-27", "20:00")] }, "worker");
  assert.equal(reads(), before + 1, "packaged with a standing approval");

  // BL-267 (AC-WT-38): the slot-stage half of this test is gone with the stage.
});

// BL-243 review round 4, item 2 (AC-WP-77): the workspace is unavailable, so the progress holds no packages (flag
// packagesUnavailable). save() must not read that as "no approval counts": it keeps the older, stricter rule -- the approved slot
// stays unremovable (slot_approved) and a retime lists it in `unlocked`.
test("BL-243 AC-WP-77: with the package scan unavailable save() keeps the older rule (no approval silently dropped)", async () => {
  let unavailable = false;
  const h = harness({ packagesUnavailable: () => unavailable });
  await week(h);
  h.progress.set("s1", packaged({ video: "V73" }, "vid73"));
  await approve(h, "s1");
  unavailable = true;
  h.progress.delete("s1"); // no package known
  const error = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker"));
  assert.deepEqual(((error as { details?: { refused?: Array<{ slotId: string; reason: string }> } }).details?.refused ?? []).map((r) => [r.slotId, r.reason]), [["s1", "slot_approved"]]);
  const retimed = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("s1", "2026-10-26", "12:00")] }, "worker");
  assert.deepEqual(retimed.unlocked, ["s1"]);
});

// BL-243 review round 6 (AC-WP-83): the mark cleared after video_missing -- the progress row shows a plain failed plan change (not
// deleted), so the vetoed slot whose video is back on YouTube cannot be removed (slot_uploaded).
test("BL-243 AC-WP-83: a vetoed slot whose video reappeared after video_missing is refused slot_uploaded", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", { status: "failed", code: "plan_unscheduled_failed", videoId: "vid73", package: pkg({ video: "V73" }) });
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1" }] }, "u1");
  const error = await refusal(h.service.save({ channelId: CH, weekStart: WEEK, removeSlotIds: ["s1"] }, "worker"));
  assert.deepEqual(((error as { details?: { refused?: Array<{ slotId: string; reason: string }> } }).details?.refused ?? []).map((r) => [r.slotId, r.reason]), [["s1", "slot_uploaded"]]);
});

// BL-263 (SHORT_VIDEO_CODE_PLAN.md §6.5, AC-SC-14b; ADR 0071 §5): after V1 is recoded to S1 the slot's package names S1 with a new
// manifest SHA-256. An approval made with the uploaded video's id (V1, aa, vid1) still covers it -- the video id is the identity --
// when the progress says V1 was recoded to S1; one made before the upload (no video id) does not: the slot asks again.
test("BL-263 AC-SC-14b: an approval naming V1 + vid1 covers the recoded S1 package of vid1; a pre-upload approval or another id does not", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged({ video: "V1" }, "vid1"));
  await approve(h, "s1");
  const recoded = (over: Partial<PlanSlotProgress> = {}): PlanSlotProgress => ({ ...packaged({ video: "S1", manifestSha256: BB }, "vid1"), recodedFrom: ["V1"], ...over });
  h.progress.set("s1", recoded());
  assert.equal(slotOf(await get(h), "s1").approval, "approved");
  // Without the alias (the list unreadable) the changed package needs the owner again -- never a wrong "approved".
  h.progress.set("s1", { ...recoded(), recodedFrom: undefined });
  assert.equal(slotOf(await get(h), "s1").approval, "needs_approval");
  // Another video id is not covered, alias or not.
  h.progress.set("s1", { ...packaged({ video: "S1", manifestSha256: BB }, "vid2"), recodedFrom: ["V1"] });
  assert.equal(slotOf(await get(h), "s1").approval, "needs_approval");

  // s2: approved before the upload (no video id) -> after the recode the slot asks again.
  h.progress.set("s2", packaged({ video: "V2" }));
  await approve(h, "s2");
  h.progress.set("s2", { ...packaged({ video: "S2", manifestSha256: BB }, "vid2"), recodedFrom: ["V2"] });
  assert.equal(slotOf(await get(h), "s2").approval, "needs_approval");
});

// BL-263 AC-SC-14b (the plan schedule side): after V1/V2 are recoded to S1/S2 the upload rows carry the new manifest hash and the same
// video ids. The schedule's decision for each row changes no date: a released/scheduled S1 whose approval names vid1 stays approved at
// the same instant (nothing to set), and S2 -- approved before its upload, so the approval is not carried -- is pending (nothing done,
// its date on YouTube is unchanged).
test("BL-263 AC-SC-14b: the plan schedule sets or removes no date for a recoded video", async () => {
  const { desiredDate } = await import("@/lib/publishing/plan-schedule");
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged({ video: "V1" }, "vid1"));
  await approve(h, "s1");
  h.progress.set("s2", packaged({ video: "V2" }));
  await approve(h, "s2");
  const at1 = "2026-10-26T06:00:00.000Z";
  const at2 = "2026-10-27T09:00:00.000Z";
  h.progress.set("s1", { ...packaged({ video: "S1", manifestSha256: BB }, "vid1"), recodedFrom: ["V1"] });
  h.progress.set("s2", { ...packaged({ video: "S2", manifestSha256: BB }, "vid2"), recodedFrom: ["V2"] });
  const decisions = await h.service.slotDecisions(CH);
  assert.equal(decisions.get("s1")?.kind, "approved");
  assert.deepEqual(decisions.get("s2"), { kind: "pending" });
  const now = h.clock.now.getTime();
  const row1 = { slotId: "s1", videoId: "vid1", manifestSha256: BB, publishAt: at1, stepsJson: "{}" };
  const row2 = { slotId: "s2", videoId: "vid2", manifestSha256: BB, publishAt: at2, stepsJson: "{}" };
  assert.deepEqual(decisionForRow(row1, decisions as never)?.kind, "approved");
  assert.equal(desiredDate(row1, decisionForRow(row1, decisions as never), now), null, "the same date: nothing to write");
  assert.equal(desiredDate(row2, decisionForRow(row2, decisions as never), now), null, "pending: the date is left as it is");
});
