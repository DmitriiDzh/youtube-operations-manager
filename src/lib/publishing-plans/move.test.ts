import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument, type PublishingPlansDocument } from "@/lib/sync-gateway/publishing-plans";
import { createPublishingPlansService, producerSurface } from "./services";
import { isDomainError, type PlanMoveYoutubePort, type PlanSlotProgress, type PlanView } from "./contracts";

// BL-267 moves (WEEK_TEMPLATE_PLAN.md §3.7, AC-WT-31..34, 44..46; ADR 0073 §5; owner TG 4630/4636: the owner and the Producer move any
// slot anywhere, a dated video's new date goes to YouTube at once, a move never gives a first date, keeps the id, crosses weeks).
// Values by hand: Asia/Tokyo is UTC+9. Slot L at Tue 2026-11-24 00:00 JST = Mon 2026-11-23 15:00Z (week 2026-11-23); the target
// Thu 2026-12-03 00:00 JST = Wed 2026-12-02 15:00Z (week 2026-11-30); an off-template target Thu 2026-12-03 18:00 JST = 09:00Z.

const CH = "UC_wwe";
const WEEK = "2026-11-23";
const NEXT = "2026-11-30";
const SHA = (c: string) => c.repeat(64);

function harness(youtube: { privacy?: string; publishAt?: string | null; row?: boolean } = {}) {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore, emptyDocument }), store });
  const progress = new Map<string, PlanSlotProgress>();
  const clock = { now: new Date("2026-11-16T12:00:00Z") };
  const yt = { privacy: youtube.privacy ?? "private", publishAt: youtube.publishAt === undefined ? "2026-11-23T15:00:00.000Z" : youtube.publishAt, row: youtube.row ?? true, writes: [] as string[], reads: 0 };
  const moveYoutube: PlanMoveYoutubePort = {
    precheck: async () => {
      yt.reads += 1;
      if (!yt.row) return { outcome: "refused", code: "publishing_plan_move_not_here", reason: "no row" };
      if (yt.privacy !== "private") return { outcome: "refused", code: "publishing_plan_already_published", reason: `video is ${yt.privacy}` };
      return yt.publishAt ? { outcome: "moves", youtubePublishAt: yt.publishAt } : { outcome: "plan_only", youtubePublishAt: null };
    },
    write: async (_c, _v, _s, at) => {
      yt.writes.push(at);
      yt.publishAt = at;
      return { result: "verified", publishAt: at };
    },
  };
  const audits: Array<Record<string, unknown>> = [];
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async () => true,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async (e) => void audits.push(e.detail),
    progress: async (_c, _w, ids) => ({ progress: new Map([...progress].filter(([id]) => ids.includes(id))), packagesUnavailable: false }),
    moveYoutube,
  });
  return { core, service, progress, clock, yt, audits, bytes };
}

const uploaded = (publishAt: string | null): PlanSlotProgress => ({
  status: publishAt ? "scheduled" : "packaged",
  code: null,
  videoId: "vid1",
  publishAt,
  package: { video: "V1", title: "V1", durationSeconds: 600, languages: [], containsSyntheticMedia: false, thumbnailPath: null, testThumbnails: 0, problems: [], manifestSha256: SHA("a") },
  media: { videoSha256: SHA("1"), sizeBytes: 1000, review: "approved" },
});
const slotOf = (plan: PlanView | null, id: string) => plan!.slots.find((s) => s.slotId === id)!;

async function setup(h: ReturnType<typeof harness>, publishAt: string | null = "2026-11-23T15:00:00.000Z") {
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [{ slotId: "L", date: "2026-11-24", publishAt: "2026-11-24T00:00" }] }, "factory");
  h.progress.set("L", uploaded(publishAt));
  return slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "L");
}

const moveInput = (contentHash: string, over: Record<string, unknown> = {}) => ({ slotId: "L", contentHash, toWeekStart: NEXT, date: "2026-12-03", publishAt: "2026-12-03T00:00", ...over });

test("AC-WT-31: the owner moves an uploaded dated slot to next week: one change, same id, movedFrom, the YouTube date written at once", async () => {
  const h = harness();
  const shown = await setup(h);
  const changesBefore = Automerge.getAllChanges(Automerge.load<PublishingPlansDocument>(h.bytes.get(CH)!)).length;
  const result = await h.service.move(CH, moveInput(shown.contentHash), "owner", "u1");
  assert.equal(result.moved, true);
  assert.deepEqual(h.yt.writes, ["2026-12-02T15:00:00.000Z"]);
  assert.deepEqual(result.youtube, { effect: "moves", previous: "2026-11-23T15:00:00.000Z", result: "verified", publishAt: "2026-12-02T15:00:00.000Z" });
  const doc = Automerge.load<PublishingPlansDocument>(h.bytes.get(CH)!);
  assert.equal(Automerge.getAllChanges(doc).length, changesBefore + 1, "one Automerge change (no approval to revoke)");
  const snap = await h.core.read(CH);
  assert.deepEqual(Object.keys(snap.slots), [`${NEXT}:L`]);
  assert.deepEqual(snap.slots[`${NEXT}:L`].movedFrom, { weekStart: WEEK, publishAt: "2026-11-24T00:00", timeZone: "Asia/Tokyo", at: "2026-11-16T12:00:00.000Z", by: "owner" });
  assert.equal(snap.plans[NEXT].timeZone, "Asia/Tokyo", "the target plan is created in the source zone");
  assert.equal(slotOf(result.plan, "L").publishAtUtc, "2026-12-02T15:00:00.000Z");
  assert.equal(h.audits.at(-1)?.event, "publishing_plan.moved");
});

test("AC-WT-32: after a move the slot's decisions are found by slot id; an explicit approval is revoked", async () => {
  const h = harness();
  const shown = await setup(h);
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "L", contentHash: shown.contentHash }] }, "u1");
  const approved = slotOf((await h.service.get({ channelId: CH, weekStart: WEEK })).plan, "L");
  await h.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "L" }] }, "u1");
  await h.service.decide(CH, WEEK, { action: "restore", slots: [{ slotId: "L" }] }, "u1");
  await h.service.move(CH, moveInput(approved.contentHash), "owner", "u1");
  const moved = slotOf((await h.service.get({ channelId: CH, weekStart: NEXT })).plan, "L");
  assert.equal(moved.approval, "needs_approval", "the old approval is revoked");
  // The veto made in the old week is still read for the slot (by id): veto it again in the new week and restore -- one history.
  await h.service.decide(CH, NEXT, { action: "veto", slots: [{ slotId: "L" }] }, "u1");
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "vetoed");
});

test("AC-WT-33: vetoed, released, stale hash, public video, a date within 15 min, a target < 30 min ahead -- refused, nothing written", async () => {
  const code = async (h: ReturnType<typeof harness>, input: unknown) => (await h.service.move(CH, input, "owner", "u1").then(() => null, (e: unknown) => e)) as { code?: string; details?: { refused?: Array<{ reason: string }> } } | null;
  const check = async (h: ReturnType<typeof harness>) => {
    assert.deepEqual(h.yt.writes, []);
    assert.deepEqual(Object.keys((await h.core.read(CH)).slots), [`${WEEK}:L`]);
  };
  const vetoed = harness();
  const s1 = await setup(vetoed);
  await vetoed.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "L" }] }, "u1");
  assert.equal((await code(vetoed, moveInput(s1.contentHash)))?.code, "publishing_plan_slot_vetoed");
  await check(vetoed);
  const stale = harness();
  await setup(stale);
  assert.equal((await code(stale, moveInput(SHA("0"))))?.code, "publishing_plan_changed");
  await check(stale);
  const pub = harness({ privacy: "public" });
  const s3 = await setup(pub);
  assert.equal((await code(pub, moveInput(s3.contentHash)))?.code, "publishing_plan_already_published");
  await check(pub);
  const soon = harness();
  const s4 = await setup(soon);
  soon.clock.now = new Date("2026-11-23T14:50:00Z");
  assert.equal((await code(soon, moveInput(s4.contentHash)))?.code, "publishing_plan_slot_too_soon");
  await check(soon);
  const near = harness();
  const s5 = await setup(near);
  near.clock.now = new Date("2026-11-23T11:00:00Z"); // target 11:20Z is 20 min ahead
  const r = await code(near, moveInput(s5.contentHash, { toWeekStart: WEEK, date: "2026-11-23", publishAt: "2026-11-23T20:20" }));
  assert.deepEqual(r?.details?.refused?.map((x) => x.reason), ["in_past"]);
  await check(near);
  const released = harness();
  const s6 = await setup(released);
  released.clock.now = new Date("2026-11-23T15:00:00Z");
  assert.equal((await code(released, moveInput(s6.contentHash)))?.code, "publishing_plan_slot_past");
});

test("AC-WT-34: the Producer moves a dated slot off the template -- written at once, off_template with its date standing; dryRun writes nothing; works without a template", async () => {
  const h = harness();
  const shown = await setup(h);
  const producer = producerSurface(h.service);
  const real = await producer.move(CH, moveInput(shown.contentHash, { publishAt: "2026-12-03T18:00" }));
  assert.equal(real.dryRun, false, "no dryRun flag: a real move");
  assert.deepEqual(h.yt.writes, ["2026-12-03T09:00:00.000Z"]);
  assert.equal(h.audits.at(-1)?.actor, "producer");
  h.progress.set("L", uploaded("2026-12-03T09:00:00.000Z"));
  const view = slotOf((await h.service.get({ channelId: CH, weekStart: NEXT })).plan, "L");
  assert.equal(view.dating.state, "off_template");
  assert.equal((await h.service.slotDecisions(CH)).get("L")?.kind, "pending", "pending never removes the date");

  const g = harness();
  const s = await setup(g);
  const plan = await producerSurface(g.service).move(CH, { ...moveInput(s.contentHash), dryRun: true });
  assert.deepEqual([plan.dryRun, plan.youtube.effect, plan.to.publishAtUtc], [true, "moves", "2026-12-02T15:00:00.000Z"]);
  assert.deepEqual(g.yt.writes, []);
  assert.deepEqual(Object.keys((await g.core.read(CH)).slots), [`${WEEK}:L`]);
});

test("AC-WT-45: a move of an undated uploaded slot writes no YouTube date (D1)", async () => {
  const h = harness({ publishAt: null });
  const shown = await setup(h, null);
  const result = await h.service.move(CH, moveInput(shown.contentHash, { publishAt: "2026-12-03T18:00" }), "producer", "producer");
  assert.equal(result.moved, true);
  assert.equal(result.youtube.effect, "plan_only");
  assert.deepEqual(h.yt.writes, []);
});

test("AC-WT-46: a dated video with no finished upload row on this computer -> publishing_plan_move_not_here, nothing written", async () => {
  const h = harness({ row: false });
  const shown = await setup(h);
  const error = await h.service.move(CH, moveInput(shown.contentHash), "owner", "u1").then(() => null, (e: unknown) => e);
  assert.ok(isDomainError(error) && error.code === "publishing_plan_move_not_here");
  assert.deepEqual(Object.keys((await h.core.read(CH)).slots), [`${WEEK}:L`]);
});

test("a move to the same place with YouTube on another date retries the write (no plan change)", async () => {
  const h = harness({ publishAt: "2026-11-25T10:00:00.000Z" });
  const shown = await setup(h, "2026-11-25T10:00:00.000Z");
  const result = await h.service.move(CH, { slotId: "L", contentHash: shown.contentHash, toWeekStart: WEEK, date: "2026-11-24", publishAt: "2026-11-24T00:00" }, "owner", "u1");
  assert.equal(result.moved, false);
  assert.deepEqual(h.yt.writes, ["2026-11-23T15:00:00.000Z"]);
});
