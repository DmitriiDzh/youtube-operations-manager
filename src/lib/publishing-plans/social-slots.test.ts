import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createPublishingPlansCore, emptyDocument } from "@/lib/sync-gateway/publishing-plans";
import type { PublishingPlansDocument } from "@/lib/sync-gateway";
import { createPublishingPlansService } from "./services";
import type { PlanProgressResult, PlanSlotPackage, PlanSlotProgress, PlanView } from "./contracts";

// BL-252 stage 2 seam test (ADR 0068 amendment 1, advisor 14.11): the real publishing-plans service with a clock. Cross-posting
// must still see an approved slot AT its time and minutes after (when `slotDecisions` already calls it pending), and must NOT see
// it approved once vetoed, when its package changed, or when the package scan is unreadable. By hand: Asia/Tokyo is UTC+9, so
// 15:00 JST on Monday 2026-10-26 is 06:00Z.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";
const WEEK = "2026-10-26";
const pkg = (manifestSha256: string): PlanSlotPackage => ({ video: "V64", title: "T", durationSeconds: 60, languages: [], containsSyntheticMedia: true, thumbnailPath: null, testThumbnails: 0, problems: [], manifestSha256 });

function harness() {
  const clock = { now: new Date("2026-10-25T07:00:00Z") };
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/b", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  const progress = new Map<string, PlanSlotProgress>();
  let unavailable = false;
  let n = 0;
  const service = createPublishingPlansService({
    store: core,
    isChannelConnected: async (c) => c === CH,
    deviceLabel: async () => "Mac",
    now: () => clock.now,
    randomId: () => `id${++n}`,
    withLock: (fn) => fn(),
    audit: async () => undefined,
    progress: async (_c, _w, ids): Promise<PlanProgressResult> => ({ progress: new Map([...progress].filter(([id]) => ids.includes(id))), packagesUnavailable: unavailable }),
  });
  return { service, clock, progress, setUnavailable: (v: boolean) => (unavailable = v) };
}

async function approvedSlot() {
  const h = harness();
  await h.service.save({ channelId: CH, weekStart: WEEK, timeZone: "Asia/Tokyo", slots: [{ slotId: "s1", date: "2026-10-26", publishAt: "2026-10-26T15:00", lengthHint: "≈ 1 мин" }] }, "factory");
  h.progress.set("s1", { status: "packaged", code: null, videoId: null, package: pkg("a".repeat(64)) });
  const plan: PlanView = (await h.service.get({ channelId: CH, weekStart: WEEK })).plan;
  await h.service.decide(CH, WEEK, { action: "approve", slots: [{ slotId: "s1", contentHash: plan.slots[0].contentHash }] }, "u1");
  return h;
}

test("before, at and 10 min after the slot's time the approved slot is seen approved with its manifest; slotDecisions is pending after", async () => {
  const h = await approvedSlot();
  for (const at of ["2026-10-25T07:00:00Z", "2026-10-26T06:00:00Z", "2026-10-26T06:10:00Z"]) {
    h.clock.now = new Date(at);
    const [s] = await h.service.socialSlotStates(CH);
    assert.equal(s.slotId, "s1", at);
    assert.equal(s.approved, true, at);
    assert.equal(s.package?.manifestSha256, "a".repeat(64), at);
    assert.equal(s.publishAtUtc, "2026-10-26T06:00:00.000Z");
    assert.equal(s.timeZone, "Asia/Tokyo");
    assert.equal(s.released, at !== "2026-10-25T07:00:00Z", at);
  }
  assert.equal((await h.service.slotDecisions(CH)).get("s1")?.kind, "pending");
});

test("not approved: once vetoed; once the package changed (a new manifest); when the package scan is unreadable; in the slot stage", async () => {
  const vetoed = await approvedSlot();
  const plan = (await vetoed.service.get({ channelId: CH, weekStart: WEEK })).plan;
  await vetoed.service.decide(CH, WEEK, { action: "veto", slots: [{ slotId: "s1", contentHash: plan.slots[0].contentHash }] }, "u1");
  const [v] = await vetoed.service.socialSlotStates(CH);
  assert.equal(v.approved, false);
  assert.equal(v.vetoed, true);
  assert.equal(v.package, null);

  const changed = await approvedSlot();
  changed.progress.set("s1", { status: "packaged", code: null, videoId: null, package: pkg("b".repeat(64)) });
  assert.equal((await changed.service.socialSlotStates(CH))[0].approved, false);

  const unreadable = await approvedSlot();
  unreadable.setUnavailable(true);
  assert.deepEqual(await unreadable.service.socialSlotStates(CH), []);

  const slotStage = await approvedSlot();
  await slotStage.service.setApprovalStage(CH, { stage: "slot" }, "u1");
  assert.deepEqual(await slotStage.service.socialSlotStates(CH), []);
});

test("slots more than 36 h in the past are not read", async () => {
  const h = await approvedSlot();
  h.clock.now = new Date("2026-10-27T18:01:00Z"); // 36 h 1 min after 06:00Z on the 26th
  assert.deepEqual(await h.service.socialSlotStates(CH), []);
});
