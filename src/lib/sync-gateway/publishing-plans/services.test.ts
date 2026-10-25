import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, slotKey, type PublishingPlanDecision, type PublishingPlanMeta, type PublishingPlanSlot, type PublishingPlansDocument } from "./contracts";
import { createPublishingPlansCore, emptyDocument } from "./services";

// BL-225 AC-WP-13 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 1, ADR 0051 §1): agents save on one computer, the owner decides on the
// other; after one sync cycle both computers hold the same plan, and two computers that each started the same week or saved
// different slots of it keep everything.

const CH = "UC-IdugmwWRvRo9-j0yK5AbA";
const WEEK = "2026-10-26";

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  return createPublishingPlansCore({ core: createAutomergeCore<PublishingPlansDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
}
type Computer = ReturnType<typeof computer>;

async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.mergeIncoming(CH, fromB);
  if (fromA) await b.mergeIncoming(CH, fromA);
}

const meta = (by: PublishingPlanMeta["createdBy"]): PublishingPlanMeta => ({ weekStart: WEEK, timeZone: "Asia/Tokyo", createdAt: "2026-10-25T07:06:00Z", createdBy: by, updatedAt: "2026-10-25T07:06:00Z", updatedBy: by });
const slot = (slotId: string, day: string, time: string): PublishingPlanSlot => ({
  weekStart: WEEK,
  slotId,
  date: day,
  publishAt: `${day}T${time}`,
  lengthHint: "≈ 3 ч",
  note: null,
  createdAt: "2026-10-25T07:06:00Z",
  updatedAt: "2026-10-25T07:06:00Z",
  updatedBy: "factory",
});
const decision = (id: string, slotId: string): PublishingPlanDecision => ({
  id,
  weekStart: WEEK,
  slotId,
  kind: "approved",
  contentHash: `h-${slotId}`,
  snapshot: { date: "2026-10-26", publishAt: "2026-10-26T18:00", lengthHint: null, note: null, timeZone: "Asia/Tokyo" },
  by: "owner",
  device: "Windows",
  at: "2026-10-25T07:40:00Z",
});

test("AC-WP-13: a plan saved on the Mac is on Windows after one cycle; the owner's approval on Windows reaches the Mac", async () => {
  const mac = computer();
  const windows = computer();
  assert.deepEqual(await windows.read(CH), { plans: {}, slots: {}, decisions: {} });
  await mac.savePlan(CH, { weekStart: WEEK, create: meta("factory"), updatedAt: "2026-10-25T07:06:00Z", updatedBy: "factory", upserts: [slot("s1", "2026-10-26", "18:00")], removes: [] });
  await cycle(mac, windows);
  const onWindows = await windows.read(CH);
  assert.equal(onWindows.plans[WEEK].timeZone, "Asia/Tokyo");
  assert.equal(onWindows.slots[slotKey(WEEK, "s1")].publishAt, "2026-10-26T18:00");
  await windows.addDecisions(CH, [decision("d1", "s1")]);
  await cycle(mac, windows);
  assert.deepEqual((await mac.read(CH)).decisions.d1, decision("d1", "s1"));
});

test("AC-WP-13: two computers that each start the same week and save different slots keep both slots", async () => {
  const mac = computer();
  const windows = computer();
  await mac.savePlan(CH, { weekStart: WEEK, create: meta("factory"), updatedAt: "2026-10-25T07:06:00Z", updatedBy: "factory", upserts: [slot("s1", "2026-10-26", "18:00")], removes: [] });
  await windows.savePlan(CH, { weekStart: WEEK, create: meta("worker"), updatedAt: "2026-10-25T07:07:00Z", updatedBy: "worker", upserts: [slot("s2", "2026-10-27", "18:00")], removes: [] });
  await cycle(mac, windows);
  for (const c of [mac, windows]) {
    const read = await c.read(CH);
    assert.deepEqual(Object.keys(read.slots).sort(), [slotKey(WEEK, "s1"), slotKey(WEEK, "s2")]);
    assert.ok(read.plans[WEEK]);
  }
});

test("AC-WP-13: approvals of different slots made on both computers at once are both kept; a removed slot is gone everywhere", async () => {
  const mac = computer();
  const windows = computer();
  await mac.savePlan(CH, { weekStart: WEEK, create: meta("factory"), updatedAt: "2026-10-25T07:06:00Z", updatedBy: "factory", upserts: [slot("s1", "2026-10-26", "18:00"), slot("s2", "2026-10-27", "18:00"), slot("s3", "2026-10-28", "18:00")], removes: [] });
  await cycle(mac, windows);
  await mac.addDecisions(CH, [decision("d-mac", "s1")]);
  await windows.addDecisions(CH, [decision("d-win", "s2")]);
  await mac.savePlan(CH, { weekStart: WEEK, create: null, updatedAt: "2026-10-25T08:00:00Z", updatedBy: "factory", upserts: [], removes: ["s3"] });
  await cycle(mac, windows);
  for (const c of [mac, windows]) {
    const read = await c.read(CH);
    assert.deepEqual(Object.keys(read.decisions).sort(), ["d-mac", "d-win"]);
    assert.deepEqual(Object.keys(read.slots).sort(), [slotKey(WEEK, "s1"), slotKey(WEEK, "s2")]);
  }
});
