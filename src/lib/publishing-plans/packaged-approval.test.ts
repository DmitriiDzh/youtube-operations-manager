import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument } from "@/lib/sync-gateway/publishing-plans";
import type { PublishingPlansDocument } from "@/lib/sync-gateway";
import { agentSurface, createPublishingPlansService, ownerSurface } from "./services";
import { isDomainError, type PlanAuditEntry, type PlanSlotPackage, type PlanSlotProgress, type PlanView } from "./contracts";

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

function harness() {
  const clock = { now: new Date("2026-10-25T07:00:00Z") };
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  const audits: PlanAuditEntry[] = [];
  // What the packages say of each slot; tests change it between reads.
  const progress = new Map<string, PlanSlotProgress>();
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async (channelId) => channelId === CH,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
    progress: async (_c, _w, ids) => new Map([...progress].filter(([id]) => ids.includes(id))),
  });
  return { service, audits, core, progress, clock };
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

test("AC-WP-50: a new document is in the packaged stage; the owner sets slot, then packaged -- each one audited change", async () => {
  const h = harness();
  await week(h);
  assert.equal((await h.service.ownerList(CH)).approvalStage, "packaged");
  assert.equal((await get(h)).approvalStage, "packaged");
  assert.equal((await h.core.read(CH)).approvalStage, undefined, "nothing is written for the default");

  assert.deepEqual(await h.service.setApprovalStage(CH, { stage: "slot" }, "u1"), { approvalStage: "slot", changed: true });
  assert.equal((await h.core.read(CH)).approvalStage, "slot");
  assert.equal((await get(h)).approvalStage, "slot");
  assert.deepEqual(await h.service.setApprovalStage(CH, { stage: "slot" }, "u1"), { approvalStage: "slot", changed: false }, "the same stage again writes nothing");
  assert.deepEqual(await h.service.setApprovalStage(CH, { stage: "packaged" }, "u1"), { approvalStage: "packaged", changed: true });
  assert.equal((await h.core.read(CH)).approvalStage, "packaged");

  const stageEvents = h.audits.filter((a) => a.detail.event === "publishing_plan.approval_stage");
  assert.deepEqual(
    stageEvents.map((a) => [a.weekStart, a.slotId, a.detail.from, a.detail.to, a.detail.by, a.detail.device]),
    [
      [null, null, "packaged", "slot", "u1", "Mac"],
      [null, null, "slot", "packaged", "u1", "Mac"],
    ]
  );
  // Only the two stages exist; an unknown one or an extra field is refused.
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
  assert.deepEqual(Object.keys(agentSurface(h.service)).sort(), ["get", "list", "save"]);
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
  // The week at once: one slot waiting refuses the whole call, the ready one is not approved either.
  h.progress.set("s2", packaged({ video: "V65", manifestSha256: BB }));
  const both = await get(h);
  const week2 = await refusal(h.service.decide(CH, WEEK, { action: "approve", slots: both.slots.map((s) => ({ slotId: s.slotId, contentHash: s.contentHash })) }, "u1"));
  assert.ok(isDomainError(week2) && week2.code === "publishing_plan_slot_not_packaged");
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

test("AC-WP-55: an approval made in the slot stage does not count in the packaged stage -- needs approval, the uploads' decision pending", async () => {
  const h = harness();
  await week(h);
  await h.service.setApprovalStage(CH, { stage: "slot" }, "u1");
  await approve(h, "s1");
  assert.equal(slotOf(await get(h), "s1").approval, "approved");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "approved", publishAt: "2026-10-26T06:00:00.000Z" });

  await h.service.setApprovalStage(CH, { stage: "packaged" }, "u1");
  h.progress.set("s1", packaged());
  const s1 = slotOf(await get(h), "s1");
  assert.equal(s1.approval, "needs_approval");
  assert.equal(s1.changedAfterApproval, null, "nothing changed: the old approval simply does not count here");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "pending" });
  // And the other way round: a packaged-stage approval does not count in the slot stage.
  await approve(h, "s1");
  await h.service.setApprovalStage(CH, { stage: "slot" }, "u1");
  assert.equal(slotOf(await get(h), "s1").approval, "approved", "its own slot-stage approval counts again");
});

test("AC-WP-56: the uploads' decision for an approved packaged slot names the fingerprint; a veto carries it too", async () => {
  const h = harness();
  await week(h);
  h.progress.set("s1", packaged());
  h.progress.set("s2", packaged({ video: "V65", manifestSha256: BB }, "vid65"));
  await approve(h, "s1");
  await approve(h, "s2");
  const decisions = await h.service.slotDecisions(CH);
  assert.deepEqual(decisions.get("s1"), { kind: "approved", publishAt: "2026-10-26T06:00:00.000Z", package: { video: "V64", manifestSha256: AA, videoId: null } });
  assert.deepEqual(decisions.get("s2"), { kind: "approved", publishAt: "2026-10-27T09:00:00.000Z", package: { video: "V65", manifestSha256: BB, videoId: "vid65" } });
  // The package changing does not change the uploads' word (they see no package): the date goes only to the approved manifest.
  h.progress.set("s1", packaged({ manifestSha256: BB }));
  assert.deepEqual((await h.service.slotDecisions(CH)).get("s1"), { kind: "approved", publishAt: "2026-10-26T06:00:00.000Z", package: { video: "V64", manifestSha256: AA, videoId: null } });
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
