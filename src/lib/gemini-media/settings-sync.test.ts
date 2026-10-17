import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createMediaSettingsCore, emptyDocumentOf, GEMINI_SETTINGS_KIND, type MediaSettingsDocument } from "@/lib/sync-gateway/media-settings";
import { DEFAULT_GEMINI_MEDIA_SETTINGS, DomainError, type GeminiMediaSettings } from "./contracts";
import { changedSharedLimits, createGeminiSettingsSync } from "./settings-sync";

// BL-193 (owner msg 2867: the Gemini limits are shared; ADR 0039 with ADR 0030's rules): a limit saved on one computer reaches the
// others; a limit set differently on two computers before they met is a conflict -- never applied, each keeps its own until the
// owner picks one; the same value on both is not a conflict; the switch is never shared; a value the module refuses is held.

function documentDevice() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup" }) } as unknown as DiscardedDocumentBackupStore;
  return createMediaSettingsCore({ core: createAutomergeCore<MediaSettingsDocument>({ store, discardedBackupStore: backups, emptyDocument: () => emptyDocumentOf(GEMINI_SETTINGS_KIND) }), store }, GEMINI_SETTINGS_KIND);
}

/** One computer: its settings, the shared document, and the sync over them. `updateSettings` validates like the module does. */
function computer(initial: Partial<GeminiMediaSettings> = {}) {
  let settings: GeminiMediaSettings = { ...DEFAULT_GEMINI_MEDIA_SETTINGS, ...initial };
  const shared = documentDevice();
  const applied: Array<Record<string, unknown>> = [];
  const sync = createGeminiSettingsSync({
    shared,
    getSettings: async () => settings,
    applyUpdate: async (patch) => {
      applied.push(patch);
      for (const value of Object.values(patch)) {
        if (typeof value !== "number" || !(value > 0)) throw new DomainError({ code: "validation_failed", message: "Invalid Gemini settings" });
      }
      settings = { ...settings, ...patch };
      return settings;
    },
    clock: { now: () => new Date("2026-10-16T12:00:00Z") },
  });
  /** An owner's save on this computer: stored, then the limits it changed are published (as `index.ts` does). */
  const save = async (patch: Partial<GeminiMediaSettings>) => {
    const before = settings;
    settings = { ...settings, ...patch };
    await shared.publishChanged(changedSharedLimits(before, settings) as Record<string, number>);
  };
  return { shared, sync, save, applied, settings: () => settings };
}

async function exchange(a: ReturnType<typeof computer>, b: ReturnType<typeof computer>) {
  const fromA = await a.shared.exportBytes();
  const fromB = await b.shared.exportBytes();
  await b.shared.mergeIncoming(fromA);
  await a.shared.mergeIncoming(fromB);
}

test("a limit saved on one computer is applied on the other; the switch never travels", async () => {
  const a = computer({ enabled: true });
  const b = computer({ enabled: false });
  await a.sync.tick();
  await b.sync.tick();
  await exchange(a, b);
  await a.save({ maxUsdPerDay: 12, enabled: false });
  await exchange(a, b);
  const status = await b.sync.tick();
  assert.equal(b.settings().maxUsdPerDay, 12);
  assert.equal(b.settings().enabled, false, "B's own switch (off) is untouched");
  assert.equal(a.settings().enabled, false);
  assert.deepEqual(status.lastApplied?.fields, ["maxUsdPerDay"]);
  assert.deepEqual(status.conflicts, []);
  assert.ok(!(await b.shared.read()).values.hasOwnProperty("enabled"), "the switch is not in the shared document");
});

test("set differently on both computers before they met: a conflict, never applied, each keeps its own value", async () => {
  const a = computer({ maxUsdPerMonth: 50 });
  const b = computer({ maxUsdPerMonth: 50 });
  await a.sync.tick();
  await b.sync.tick();
  await exchange(a, b);
  await a.save({ maxUsdPerMonth: 30 });
  await b.save({ maxUsdPerMonth: 80 });
  await exchange(a, b);
  const sa = await a.sync.tick();
  const sb = await b.sync.tick();
  assert.equal(a.settings().maxUsdPerMonth, 30);
  assert.equal(b.settings().maxUsdPerMonth, 80);
  assert.deepEqual(sa.conflicts.map((c) => [c.field, [...c.values].sort(), c.thisComputer]), [["maxUsdPerMonth", [30, 80], 30]]);
  assert.deepEqual(sb.conflicts.map((c) => [c.field, c.thisComputer]), [["maxUsdPerMonth", 80]]);
  // Whichever value Automerge picks as the document's winner, the computer holding the other one lists it as held, not applied.
  assert.ok([...sa.pending, ...sb.pending].some((p) => p.field === "maxUsdPerMonth" && /waiting for your choice/.test(p.reason)));
  // The owner picks $30: it becomes the one value on both.
  await a.shared.resolveConflict({ field: "maxUsdPerMonth", value: 30 });
  await exchange(a, b);
  await b.sync.tick();
  assert.equal(b.settings().maxUsdPerMonth, 30);
  assert.deepEqual((await b.sync.tick()).conflicts, []);
});

test("the same value saved on both computers is not a conflict", async () => {
  const a = computer();
  const b = computer();
  await a.sync.tick();
  await b.sync.tick();
  await exchange(a, b);
  await a.save({ maxActiveJobs: 3 });
  await b.save({ maxActiveJobs: 3 });
  await exchange(a, b);
  assert.deepEqual((await a.sync.tick()).conflicts, []);
  assert.equal(b.settings().maxActiveJobs, 3);
});

test("a shared value the module refuses is held and not retried until the shared value changes", async () => {
  const b = computer({ maxUsdPerJob: 1 });
  await b.sync.tick();
  const a = computer({ maxUsdPerJob: 1 });
  await a.sync.tick();
  await exchange(a, b);
  await a.save({ maxUsdPerJob: -5 });
  await exchange(a, b);
  const first = await b.sync.tick();
  assert.equal(b.settings().maxUsdPerJob, 1);
  assert.match(first.pending.find((p) => p.field === "maxUsdPerJob")?.reason ?? "", /not applied/);
  const tries = b.applied.length;
  await b.sync.tick();
  assert.equal(b.applied.length, tries, "not retried while the shared value is the same");
  await a.save({ maxUsdPerJob: 2 });
  await exchange(a, b);
  await b.sync.tick();
  assert.equal(b.settings().maxUsdPerJob, 2);
});

test("changedSharedLimits lists only the limits a save changed, never the switch", () => {
  const before = { ...DEFAULT_GEMINI_MEDIA_SETTINGS };
  assert.deepEqual(changedSharedLimits(before, { ...before, enabled: true, maxUsdPerDay: 7 }), { maxUsdPerDay: 7 });
  assert.deepEqual(changedSharedLimits(before, { ...before }), {});
});
