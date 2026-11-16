import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument, type PublishingPlansDocument } from "@/lib/sync-gateway/publishing-plans";
import { approvalNamesUpload } from "@/lib/publishing/slot-decision";
import { decisionForRow } from "@/lib/publishing/plan-schedule";
import { createPublishingPlansService } from "./services";
import { isDomainError, type PlanMediaReview, type PlanSlotProgress, type PlanView } from "./contracts";

// BL-267 date rule (WEEK_TEMPLATE_PLAN.md §3.4/§3.7/§3.8, AC-WT-14..22, 35..38, 42; ADR 0073 §2-§3; owner O1, O4, O10). Values by
// hand: the plan zone is Asia/Tokyo (UTC+9). Monday 2026-11-23 15:00Z = Tue 2026-11-24 00:00 JST (week of Mon 2026-11-23 local);
// Tue 2026-11-24 12:00Z = 21:00 JST the same day. The WWE template: long Mon/Wed/Fri 15:00Z, short daily 12:00Z. The clock stands at
// 2026-11-16 12:00Z, well before every slot.

const CH = "UC_wwe";
const WEEK = "2026-11-23";
const SHA = (c: string) => c.repeat(64);
const WWE = {
  format: "week-template/1",
  channelId: CH,
  horizonWeeks: 2,
  days: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, [{ kind: "short", publishTimeUtc: "12:00" }, ...(["mon", "wed", "fri"].includes(d) ? [{ kind: "long", publishTimeUtc: "15:00" }] : [])]])),
};

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  return createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore, emptyDocument }), store });
}

function harness() {
  const core = computer();
  const progress = new Map<string, PlanSlotProgress>();
  const clock = { now: new Date("2026-11-16T12:00:00Z") };
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async () => true,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async () => undefined,
    progress: async (_c, _w, ids) => ({ progress: new Map([...progress].filter(([id]) => ids.includes(id))), packagesUnavailable: false }),
  });
  return { core, service, progress, clock };
}

/** A package of `video` lasting `seconds`; `review` the owner's media review; uploaded with a video id when given. */
function pkg(video: string, seconds: number, review: PlanMediaReview, over: { manifest?: string; videoSha?: string; videoId?: string | null; publishAt?: string | null; problems?: string[] } = {}): PlanSlotProgress {
  const problems = over.problems ?? (review === "pending" || review === "unreadable" ? ["owner_review_pending"] : review === "returned" ? ["owner_review_returned"] : []);
  const uploaded = over.videoId != null;
  return {
    status: uploaded ? (over.publishAt ? "scheduled" : "packaged") : problems.length > 0 ? "built" : "packaged",
    code: null,
    videoId: over.videoId ?? null,
    publishAt: over.publishAt ?? null,
    package: { video, title: video, durationSeconds: seconds, languages: [], containsSyntheticMedia: false, thumbnailPath: null, testThumbnails: 0, problems: uploaded ? [] : problems, manifestSha256: over.manifest ?? SHA("a") },
    media: { videoSha256: over.videoSha ?? SHA("1"), sizeBytes: 1000, review },
  };
}

const slot = (slotId: string, date: string, time: string) => ({ slotId, date, publishAt: `${date}T${time}` });
const slotOf = (plan: PlanView, id: string) => plan.slots.find((s) => s.slotId === id)!;

async function setup(h: ReturnType<typeof harness>, slots: Array<ReturnType<typeof slot> & { replacesSlotId?: string }> = [slot("L", "2026-11-24", "00:00"), slot("S", "2026-11-24", "21:00")], template: unknown = WWE) {
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots }, "factory");
  if (template) await h.service.templateOwnerSave(CH, { template }, "u1");
}

test("AC-WT-14: gate on, matching slot, media approved -> approved by the template at the slot's instant", async () => {
  const h = harness();
  await setup(h);
  h.progress.set("L", pkg("V1", 600, "approved"));
  const d = (await h.service.slotDecisions(CH)).get("L");
  assert.deepEqual(d, { kind: "approved", publishAt: "2026-11-23T15:00:00.000Z", package: { video: "V1", manifestSha256: SHA("a"), videoId: null }, source: "template", media: { video: "V1", videoSha256: SHA("1"), sizeBytes: 1000 } });
  const view = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "L");
  assert.deepEqual([view.dating.source, view.dating.state], ["template", "will_date"]);
});

test("AC-WT-15: gate on, matching, media pending or returned -> pending (awaiting media review)", async () => {
  for (const review of ["pending", "returned", "unreadable"] as const) {
    const h = harness();
    await setup(h);
    h.progress.set("L", pkg("V1", 600, review));
    assert.deepEqual((await h.service.slotDecisions(CH)).get("L"), { kind: "pending" }, review);
    assert.equal(slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "L").dating.state, "awaiting_media_review", review);
  }
});

test("AC-WT-16 (O1): gate off, matching, ready package -> approved; a blocking problem -> pending", async () => {
  const h = harness();
  await setup(h);
  h.progress.set("L", pkg("V1", 600, "not_required"));
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "approved");
  h.progress.set("L", pkg("V1", 600, "not_required", { problems: ["thumbnail_missing"] }));
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "pending");
});

test("AC-WT-17/18/42: a packaging-only re-package keeps the date (media binding); another mp4 does not", () => {
  const decision = { kind: "approved" as const, publishAt: "2026-11-23T15:00:00.000Z", package: { video: "V1", manifestSha256: SHA("a"), videoId: null }, source: "template" as const, media: { video: "V1", videoSha256: SHA("1"), sizeBytes: 1000 } };
  assert.equal(approvalNamesUpload(decision, { manifestSha256: SHA("b"), videoId: null, media: { video: "V1", videoSha256: SHA("1"), sizeBytes: 1000 } }), true, "new manifest, same mp4");
  assert.equal(approvalNamesUpload(decision, { manifestSha256: SHA("b"), videoId: null, media: { video: "V1", videoSha256: SHA("2"), sizeBytes: 1000 } }), false, "another mp4");
  assert.equal(approvalNamesUpload(decision, { manifestSha256: SHA("b"), videoId: null }), false, "no media known: the manifest rule");
  const row = { slotId: "L", videoId: "vid1", manifestSha256: SHA("b"), packageJson: JSON.stringify({ video: "V1", videoSha256: SHA("1"), sizeBytes: 1000 }) };
  assert.equal(decisionForRow(row, new Map([["L", decision]]))?.kind, "approved");
  // An older explicit decision without media keeps the manifest rule.
  const { media: _m, ...older } = decision;
  void _m;
  assert.equal(decisionForRow(row, new Map([["L", { ...older, source: "owner" as const }]]))?.kind, "pending");
});

test("AC-WT-42: an explicit owner date made by this build survives a packaging-only re-package; another mp4 needs him again", async () => {
  const h = harness();
  await setup(h, [slot("X", "2026-11-25", "10:00")], null); // off any template
  h.progress.set("X", pkg("V2", 600, "approved"));
  const shown = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "X");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "X", contentHash: shown.contentHash }] }, "u1");
  h.progress.set("X", pkg("V2", 600, "approved", { manifest: SHA("b") }));
  const d = (await h.service.slotDecisions(CH)).get("X");
  assert.equal(d?.kind, "approved");
  assert.equal(d?.kind === "approved" && d.source, "owner");
  h.progress.set("X", pkg("V2", 600, "approved", { manifest: SHA("c"), videoSha: SHA("9") }));
  assert.equal((await h.service.slotDecisions(CH)).get("X")?.kind, "pending");
});

test("AC-WT-19/20: a veto beats a template match; restore brings it back; a withdrawn template dates nothing, explicit dates still count", async () => {
  const h = harness();
  await setup(h, [slot("L", "2026-11-24", "00:00"), slot("X", "2026-11-25", "10:00")]);
  h.progress.set("L", pkg("V1", 600, "not_required"));
  h.progress.set("X", pkg("V2", 600, "not_required", { videoSha: SHA("2") }));
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "L" }] }, "u1");
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "vetoed");
  await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "L" }] }, "u1");
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "approved");
  const x = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "X");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "X", contentHash: x.contentHash }] }, "u1");
  await h.service.templateOwnerWithdraw(CH, "u1");
  const after = await h.service.slotDecisions(CH);
  assert.deepEqual([after.get("L")?.kind, after.get("X")?.kind], ["pending", "approved"]);
});

test("AC-WT-21: removing the template entry of a dated slot leaves it pending (a pending slot is never undated)", async () => {
  const h = harness();
  await setup(h);
  h.progress.set("L", pkg("V1", 600, "not_required", { videoId: "vid1", publishAt: "2026-11-23T15:00:00.000Z" }));
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "approved");
  await h.service.templateOwnerSave(CH, { template: { ...WWE, days: { ...WWE.days, mon: [{ kind: "short", publishTimeUtc: "12:00" }] } } }, "u1");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("L"), { kind: "pending" });
  assert.equal(slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "L").dating.state, "off_template");
});

test("AC-WT-11 at the service: two shorts on one position -- the first created is dated, the other waits (position_taken)", async () => {
  const h = harness();
  await setup(h, [slot("S1", "2026-11-24", "21:00")]);
  h.clock.now = new Date("2026-11-16T12:05:00Z");
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("S2", "2026-11-24", "21:00")] }, "factory");
  h.progress.set("S1", pkg("S1", 60, "not_required"));
  h.progress.set("S2", pkg("S2", 60, "not_required", { videoSha: SHA("2") }));
  const d = await h.service.slotDecisions(CH);
  assert.deepEqual([d.get("S1")?.kind, d.get("S2")?.kind], ["approved", "pending"]);
  const view = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "S2");
  assert.deepEqual([view.dating.state, view.dating.heldBy], ["position_taken", "S1"]);
});

test("AC-WT-22: a released slot gets no new date", async () => {
  const h = harness();
  await setup(h);
  h.progress.set("L", pkg("V1", 600, "not_required"));
  h.clock.now = new Date("2026-11-23T15:00:00Z");
  assert.deepEqual((await h.service.slotDecisions(CH)).get("L"), { kind: "pending" });
});

test("AC-WT-35: an agent's save re-timing a slot whose video has a date is refused slot_dated; a note change is not", async () => {
  const h = harness();
  await setup(h);
  h.progress.set("L", pkg("V1", 600, "not_required", { videoId: "vid1", publishAt: "2026-11-23T15:00:00.000Z" }));
  const error = await h.service.save({ channelId: CH, weekStart: WEEK, slots: [slot("L", "2026-11-24", "01:00")] }, "worker").then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(error));
  assert.deepEqual((error.details as { refused: Array<{ reason: string }> }).refused.map((r) => r.reason), ["slot_dated"]);
  await h.service.save({ channelId: CH, weekStart: WEEK, slots: [{ ...slot("L", "2026-11-24", "00:00"), note: "n" }] }, "worker");
  const other = await h.service.save({ channelId: "UC_wwe", weekStart: "2026-11-30", timeZone: "Asia/Tokyo", slots: [slot("L", "2026-11-30", "10:00")] }, "worker").then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(other));
  assert.deepEqual((other.details as { refused: Array<{ reason: string }> }).refused.map((r) => r.reason), ["slot_id_in_other_week"]);
});

test("AC-WT-36 (O4): a slot with replacesSlotId on a free position is dated by the template while the replaced slot is live", async () => {
  const h = harness();
  await setup(h, [slot("A", "2026-11-25", "10:00"), { ...slot("B", "2026-11-24", "00:00"), replacesSlotId: "A" }]);
  h.progress.set("B", pkg("V3", 600, "not_required"));
  assert.equal((await h.service.slotDecisions(CH)).get("B")?.kind, "approved");
});

test("AC-WT-37 (O10): social posts follow the plan -- template-dated and explicit slots post, also 2 h after; removed entry, foreign date, veto do not", async () => {
  const h = harness();
  await setup(h, [slot("L", "2026-11-24", "00:00"), slot("X", "2026-11-25", "10:00"), slot("F", "2026-11-26", "00:00"), slot("V", "2026-11-28", "00:00")]);
  // Wed 2026-11-25 15:00Z = Thu 00:00 JST -- F is on the Wed long position; V on Fri 15:00Z.
  h.progress.set("L", pkg("V1", 600, "not_required", { videoId: "vid1", publishAt: "2026-11-23T15:00:00.000Z" }));
  h.progress.set("X", pkg("V2", 600, "not_required", { videoSha: SHA("2") }));
  h.progress.set("F", { ...pkg("V4", 600, "not_required", { videoSha: SHA("4"), videoId: "vid4", publishAt: "2026-11-25T18:00:00.000Z" }), foreignPublishAt: "2026-11-25T18:00:00.000Z" });
  h.progress.set("V", pkg("V5", 600, "not_required", { videoSha: SHA("5") }));
  const x = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "X");
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "X", contentHash: x.contentHash }] }, "u1");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "V" }] }, "u1");
  h.clock.now = new Date("2026-11-23T17:00:00Z"); // 2 h after L's time
  const states = new Map((await h.service.socialSlotStates(CH)).map((s) => [s.slotId, s]));
  assert.equal(states.get("L")?.approved, true);
  assert.equal(states.get("L")?.released, true);
  assert.deepEqual(states.get("L")?.package, { video: "V1", manifestSha256: SHA("a"), videoId: "vid1" });
  assert.equal(states.get("X")?.approved, true);
  assert.equal(states.get("F")?.approved, false, "foreign date");
  assert.equal(states.get("V")?.approved, false, "vetoed");
  await h.service.templateOwnerSave(CH, { template: { ...WWE, days: { ...WWE.days, mon: [{ kind: "short", publishTimeUtc: "12:00" }] } } }, "u1");
  assert.equal(new Map((await h.service.socialSlotStates(CH)).map((s) => [s.slotId, s])).get("L")?.approved, false, "entry removed");
});
