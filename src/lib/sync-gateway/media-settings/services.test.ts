import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import type { MediaSettingsDocument } from "./contracts";
import { createMediaSettingsCore, emptyDocument } from "./services";

// BL-150 (docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md, AC-MS-01/05): the Setup settings are the same on every device;
// a field set to different values on both devices before they met is a conflict the owner decides; the same value written on
// both is not a conflict; the fallback GPU list keeps its order.

function device() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups: DiscardedDocumentBackupStore = { backup: async () => ({ path: "/backup" }) } as unknown as DiscardedDocumentBackupStore;
  const core = createMediaSettingsCore({ core: createAutomergeCore<MediaSettingsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  return core;
}

/** One sync both ways (each device merges the other's document). */
async function exchange(a: ReturnType<typeof device>, b: ReturnType<typeof device>) {
  const fromA = await a.exportBytes();
  const fromB = await b.exportBytes();
  await b.mergeIncoming(fromA);
  await a.mergeIncoming(fromB);
}

test("AC-MS-01: a value saved on A reaches B; the fallback list arrives whole and in order", async () => {
  const a = device();
  const b = device();
  await a.seedMissing({ maxUsdPerDay: 10, gpuFallbackIds: ["NVIDIA L4", "NVIDIA A40", "NVIDIA RTX A5000"] });
  await b.seedMissing({ maxUsdPerDay: 10, gpuFallbackIds: ["NVIDIA L4", "NVIDIA A40", "NVIDIA RTX A5000"] });
  await exchange(a, b);
  await a.publishChanged({ maxUsdPerDay: 25, gpuFallbackIds: ["NVIDIA A40", "NVIDIA L4"] });
  await exchange(a, b);
  const seen = await b.read();
  assert.equal(seen.values.maxUsdPerDay, 25);
  assert.deepEqual(seen.values.gpuFallbackIds, ["NVIDIA A40", "NVIDIA L4"]);
  assert.deepEqual(seen.conflicts, []);
});

test("two devices that each started the document on their own still merge (no divergent-lineage refusal)", async () => {
  const a = device();
  const b = device();
  await a.seedMissing({ idleMinutes: 10 });
  await b.seedMissing({ watchIntervalSeconds: 60 });
  await exchange(a, b);
  assert.deepEqual((await a.read()).values, { idleMinutes: 10, watchIntervalSeconds: 60 });
  assert.deepEqual((await b.read()).values, { idleMinutes: 10, watchIntervalSeconds: 60 });
});

test("AC-MS-05: identical values on both devices are no conflict; different values of one field are; different fields merge", async () => {
  const a = device();
  const b = device();
  await a.seedMissing({ maxUsdPerDay: 10, idleMinutes: 10, gpuFallbackIds: ["x", "y"] });
  await b.seedMissing({ maxUsdPerDay: 15, idleMinutes: 10, gpuFallbackIds: ["y", "x"] });
  await exchange(a, b);
  const { conflicts } = await a.read();
  assert.deepEqual(conflicts.map((c) => c.field).sort(), ["gpuFallbackIds", "maxUsdPerDay"]);
  const usd = conflicts.find((c) => c.field === "maxUsdPerDay");
  assert.deepEqual([...(usd?.values ?? [])].sort(), [10, 15]);
  assert.deepEqual((await b.read()).conflicts.map((c) => c.field).sort(), ["gpuFallbackIds", "maxUsdPerDay"]);
});

test("the owner's pick settles a conflict on every device; a value that was not in conflict is refused", async () => {
  const a = device();
  const b = device();
  await a.seedMissing({ maxUsdPerDay: 10 });
  await b.seedMissing({ maxUsdPerDay: 15 });
  await exchange(a, b);
  await assert.rejects(a.resolveConflict({ field: "maxUsdPerDay", value: 99 }), /not one of the conflicting values/);
  await a.resolveConflict({ field: "maxUsdPerDay", value: 15 });
  await exchange(a, b);
  for (const d of [a, b]) {
    const seen = await d.read();
    assert.equal(seen.values.maxUsdPerDay, 15);
    assert.deepEqual(seen.conflicts, []);
  }
  await assert.rejects(a.resolveConflict({ field: "maxUsdPerDay", value: 15 }), /no conflict/);
});

test("seeding never overwrites a shared value; publishing an unchanged value writes nothing (no echo)", async () => {
  const a = device();
  await a.seedMissing({ maxUsdPerDay: 10 });
  assert.deepEqual(await a.seedMissing({ maxUsdPerDay: 50, idleMinutes: 5 }), { changed: ["idleMinutes"] });
  assert.equal((await a.read()).values.maxUsdPerDay, 10);
  assert.deepEqual(await a.publishChanged({ maxUsdPerDay: 10, idleMinutes: 5 }), { changed: [] });
  assert.deepEqual(await a.publishChanged({ maxUsdPerDay: 12 }), { changed: ["maxUsdPerDay"] });
});
