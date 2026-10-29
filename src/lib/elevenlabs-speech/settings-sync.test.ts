import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createMediaSettingsCore, ELEVENLABS_SETTINGS_KIND, emptyDocumentOf, type MediaSettingsDocument } from "@/lib/sync-gateway/media-settings";
import { DEFAULT_ELEVENLABS_SETTINGS, DomainError, type ElevenlabsSettings } from "./contracts";
import { changedSharedLimits, createElevenlabsSettingsSync } from "./settings-sync";

// BL-236 (owner, Telegram 2026-10-29, msg 3823: "как у других API, чтобы лимиты и расход был общий на все компьютеры"): the ElevenLabs
// character limits behave exactly as the Gemini limits (ADR 0039 / ADR 0030): a limit saved on one computer reaches the others; a
// limit set differently on two computers before they met is a conflict, never applied, until the owner picks one; local values
// saved before sharing seed the document; the switch and the output format never travel.

function documentDevice() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup" }) } as unknown as DiscardedDocumentBackupStore;
  return createMediaSettingsCore({ core: createAutomergeCore<MediaSettingsDocument>({ store, discardedBackupStore: backups, emptyDocument: () => emptyDocumentOf(ELEVENLABS_SETTINGS_KIND) }), store }, ELEVENLABS_SETTINGS_KIND);
}

function computer(initial: Partial<ElevenlabsSettings> = {}) {
  let settings: ElevenlabsSettings = { ...DEFAULT_ELEVENLABS_SETTINGS, ...initial };
  const shared = documentDevice();
  const sync = createElevenlabsSettingsSync({
    shared,
    getSettings: async () => settings,
    applyUpdate: async (patch) => {
      for (const value of Object.values(patch)) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new DomainError({ code: "validation_failed", message: "Invalid ElevenLabs settings" });
      }
      settings = { ...settings, ...patch };
      return settings;
    },
    clock: { now: () => new Date("2026-10-29T12:00:00Z") },
  });
  const save = async (patch: Partial<ElevenlabsSettings>) => {
    const before = settings;
    settings = { ...settings, ...patch };
    await shared.publishChanged(changedSharedLimits(before, settings) as Record<string, number>);
  };
  return { shared, sync, save, settings: () => settings };
}

async function exchange(a: ReturnType<typeof computer>, b: ReturnType<typeof computer>) {
  const fromA = await a.shared.exportBytes();
  const fromB = await b.shared.exportBytes();
  await b.shared.mergeIncoming(fromA);
  await a.shared.mergeIncoming(fromB);
}

test("AC-EL-SH-01: a character limit saved on one computer applies on the other; the switch and the output format never travel", async () => {
  const a = computer({ enabled: true, outputFormat: "pcm_24000" });
  const b = computer({ enabled: false });
  await a.sync.tick();
  await b.sync.tick();
  await exchange(a, b);
  await a.save({ maxCharsPerDay: 12_345, enabled: false, outputFormat: "mp3_44100_192" });
  await exchange(a, b);
  const status = await b.sync.tick();
  assert.equal(b.settings().maxCharsPerDay, 12_345);
  assert.equal(b.settings().enabled, false);
  assert.equal(b.settings().outputFormat, "mp3_44100_128", "B keeps its own format");
  assert.deepEqual(status.lastApplied?.fields, ["maxCharsPerDay"]);
  const values = (await b.shared.read()).values;
  assert.ok(!Object.hasOwn(values, "enabled") && !Object.hasOwn(values, "outputFormat"));
});

test("AC-EL-SH-02: values a computer saved before sharing seed the document and reach the other computer", async () => {
  const a = computer({ maxCharsPerMonth: 50_000 });
  await a.sync.tick();
  const b = computer();
  await b.shared.mergeIncoming(await a.shared.exportBytes()); // B (no document yet) receives A's
  await b.sync.tick();
  assert.equal(b.settings().maxCharsPerMonth, 50_000);
});

test("AC-EL-SH-03: set differently on both computers before they met is a conflict -- each keeps its own until the owner picks", async () => {
  const a = computer();
  const b = computer();
  await a.sync.tick();
  await b.sync.tick();
  await exchange(a, b);
  await a.save({ maxCharsPerMonth: 20_000 });
  await b.save({ maxCharsPerMonth: 40_000 });
  await exchange(a, b);
  const sa = await a.sync.tick();
  await b.sync.tick();
  assert.equal(a.settings().maxCharsPerMonth, 20_000);
  assert.equal(b.settings().maxCharsPerMonth, 40_000);
  assert.deepEqual(sa.conflicts.map((c) => [c.field, [...c.values].sort((x, y) => Number(x) - Number(y)), c.thisComputer]), [["maxCharsPerMonth", [20_000, 40_000], 20_000]]);
  await a.shared.resolveConflict({ field: "maxCharsPerMonth", value: 20_000 });
  await exchange(a, b);
  await b.sync.tick();
  assert.equal(b.settings().maxCharsPerMonth, 20_000);
  assert.deepEqual((await b.sync.tick()).conflicts, []);
});
