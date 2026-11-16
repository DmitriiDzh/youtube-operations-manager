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

test("review #3 (ADR 0073 §3 'a veto wins over both'): a template date never outranks the owner's standing veto of the same video", async () => {
  const h = harness();
  // X off the template carries V5 (uploaded as vid5); the owner vetoes X (the veto names V5's package, vid5).
  await setup(h, [slot("L", "2026-11-24", "00:00"), slot("X", "2026-11-25", "10:00")]);
  h.progress.set("X", pkg("V5", 600, "not_required", { videoSha: SHA("5"), videoId: "vid5" }));
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "X" }] }, "u1");
  // An agent re-points V5's manifest to L, on a template position: L would be template-dated naming vid5.
  h.progress.delete("X");
  h.progress.set("L", pkg("V5", 600, "not_required", { videoSha: SHA("5"), videoId: "vid5" }));
  const decisions = await h.service.slotDecisions(CH);
  assert.equal(decisions.get("L")?.kind, "pending", "the template date loses to the veto naming the same video");
  assert.equal(decisions.get("X")?.kind, "vetoed");
  assert.equal(decisionForRow({ slotId: "X", videoId: "vid5", manifestSha256: SHA("a") }, decisions)?.kind, "vetoed", "the video's row keeps no date");
  // Restored: the template dates it again.
  await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "X" }] }, "u1");
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "approved");
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
  // Owner msg 4640 («соц сети дублируют»; this assertion was `false` before): the entry went, but L's video keeps this computer's own
  // date at L's time (a pending slot's date is never removed), so it still goes out on YouTube -- and the social networks duplicate it.
  assert.equal(new Map((await h.service.socialSlotStates(CH)).map((s) => [s.slotId, s])).get("L")?.approved, true, "entry removed, own date kept");
  // Without a date on YouTube, an undated slot posts nothing.
  h.progress.set("L", pkg("V1", 600, "not_required", { videoId: "vid1" }));
  assert.equal(new Map((await h.service.socialSlotStates(CH)).map((s) => [s.slotId, s])).get("L")?.approved, false, "entry removed, no date");
});

test("owner msg 4640: a video moved outside the template posts to the social networks at its new time (own date); a foreign date does not", async () => {
  const h = harness();
  // X: Wed 2026-11-25 10:00 JST = 01:00Z, no template position; its video carries this computer's own date at that time (a move).
  await setup(h, [slot("X", "2026-11-25", "10:00")]);
  h.progress.set("X", pkg("V2", 600, "not_required", { videoSha: SHA("2"), videoId: "vid2", publishAt: "2026-11-25T01:00:00.000Z" }));
  h.clock.now = new Date("2026-11-25T00:00:00Z");
  const x = (await h.service.socialSlotStates(CH)).find((s) => s.slotId === "X");
  assert.equal(slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "X").dating.source, null, "off the template");
  assert.equal(x?.approved, true);
  // The same date set elsewhere (Studio): foreign -- nothing posts.
  h.progress.set("X", { ...pkg("V2", 600, "not_required", { videoSha: SHA("2"), videoId: "vid2", publishAt: "2026-11-25T01:00:00.000Z" }), foreignPublishAt: "2026-11-25T01:00:00.000Z" });
  assert.equal((await h.service.socialSlotStates(CH)).find((s) => s.slotId === "X")?.approved, false);
  // A different own date than the slot's time: nothing posts at the slot's time.
  h.progress.set("X", pkg("V2", 600, "not_required", { videoSha: SHA("2"), videoId: "vid2", publishAt: "2026-11-25T03:00:00.000Z" }));
  assert.equal((await h.service.socialSlotStates(CH)).find((s) => s.slotId === "X")?.approved, false);
});

test("AC-WT-35 (zone change): a save changing only the plan's zone re-times dated slots -> slot_dated", async () => {
  const h = harness();
  await setup(h);
  h.progress.set("L", pkg("V1", 600, "not_required", { videoId: "vid1", publishAt: "2026-11-23T15:00:00.000Z" }));
  const error = await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Europe/Moscow" }, "worker").then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(error));
  assert.deepEqual((error.details as { refused: Array<{ slotId: string; reason: string }> }).refused.map((r) => [r.slotId, r.reason]), [["L", "slot_dated"]]);
});

test("AC-WT-28 (effect): applying a template lists the slots it starts or stops dating; nothing is written", async () => {
  const h = harness();
  await setup(h, [slot("L", "2026-11-24", "00:00"), slot("X", "2026-11-25", "10:00")]);
  h.progress.set("L", pkg("V1", 600, "not_required"));
  h.progress.set("X", pkg("V2", 600, "not_required", { videoSha: SHA("2") }));
  // X is Wed 2026-11-25 01:00Z: a template with a long at Wed 01:00Z dates X; Monday's long entry removed stops dating L.
  const next = { ...WWE, days: { ...WWE.days, mon: [{ kind: "short", publishTimeUtc: "12:00" }], wed: [{ kind: "long", publishTimeUtc: "01:00" }] } };
  const before = JSON.stringify(await h.core.read(CH));
  const effect = await h.service.templateEffect(CH, { template: next });
  assert.deepEqual(effect.gain.map((s) => s.slotId), ["X"]);
  assert.deepEqual(effect.lose.map((s) => s.slotId), ["L"]);
  assert.equal(JSON.stringify(await h.core.read(CH)), before);
});

test("plan §3.8: a template-dated slot needs nothing from the owner; a ready off-template one does (the badge)", async () => {
  const h = harness();
  await setup(h, [slot("L", "2026-11-24", "00:00"), slot("X", "2026-11-25", "10:00")]);
  h.progress.set("L", pkg("V1", 600, "not_required"));
  h.progress.set("X", pkg("V2", 600, "not_required", { videoSha: SHA("2") }));
  const plan = (await h.service.get({ channelId: CH, weekStart: WEEK })).plan;
  assert.deepEqual(plan.counts, { slots: 2, approved: 1, needsApproval: 1, vetoed: 0 });
  assert.equal((await h.service.ownerList(CH)).waiting, 1);
});
