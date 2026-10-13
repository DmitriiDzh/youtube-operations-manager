import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, type ChannelLanguageSettingsDocument, type LanguageSettingValues } from "./contracts";
import { createChannelLanguageSettingsCore, emptyDocument } from "./services";

// BL-178 part B acceptance (docs/roadmap/plans/LOCALIZATION_BASELINE_PLAN.md §3.2/§4 B; FO-REQ-0022 §2; owner В3 "да", msg 2665):
// - the baseline set on computer 1 appears on computer 2 after one sync cycle;
// - different values saved on both computers are a conflict; Batches refuse until it is resolved; the owner's choice becomes
//   the value on both;
// Facts the expectations also come from: Windows had en/en while the Mac had nothing (an unset value must not conflict with a
// set one, or the Mac could never receive Windows' baseline); the tracked languages are a set of codes.

const CH = "UC_tropico";
const EMPTY: LanguageSettingValues = { defaultLanguage: null, defaultAudioLanguage: null, trackedLanguages: [] };

function computer(initial: Partial<LanguageSettingValues> = {}) {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  let local: LanguageSettingValues = { ...EMPTY, ...initial };
  const localWrites: Array<Partial<LanguageSettingValues>> = [];
  const core = createChannelLanguageSettingsCore({
    core: createAutomergeCore<ChannelLanguageSettingsDocument>({ store, discardedBackupStore: backups, emptyDocument }),
    store,
    local: {
      read: async () => ({ ...local, trackedLanguages: [...local.trackedLanguages] }),
      write: async (_channelId, patch) => {
        localWrites.push(patch);
        local = { ...local, ...patch };
      },
    },
  });
  return { core, local: () => local, localWrites };
}
type Computer = ReturnType<typeof computer>;

/** One sync cycle on both computers: each pushes its document (the runner exports first), then merges the other's. */
async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.core.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.core.mergeIncoming(CH, fromB);
  if (fromA) await b.core.mergeIncoming(CH, fromA);
}

test("B: the baseline and tracked languages saved on computer 1 appear on computer 2 after one cycle (its own copy updated)", async () => {
  const windows = computer();
  const mac = computer();
  await windows.core.save({ channelId: CH, defaultLanguage: "en", defaultAudioLanguage: "en", trackedLanguages: ["es", "pt-BR"] });
  await cycle(windows, mac);
  assert.deepEqual(mac.local(), { defaultLanguage: "en", defaultAudioLanguage: "en", trackedLanguages: ["es", "pt-BR"] });
  assert.deepEqual(await mac.core.listConflicts(CH), []);
  assert.deepEqual(await mac.core.conflictedBaselineFields(CH), []);
});

test("values set before this release reach the other computer; an unset value there is no conflict (the Mac had nothing)", async () => {
  const windows = computer({ defaultLanguage: "en", defaultAudioLanguage: "en" });
  const mac = computer();
  await cycle(windows, mac);
  assert.equal(mac.local().defaultLanguage, "en");
  assert.equal(mac.local().defaultAudioLanguage, "en");
  assert.deepEqual(await mac.core.listConflicts(CH), []);
  assert.deepEqual(await windows.core.listConflicts(CH), []);
});

test("B: different baselines on the two computers are a conflict; each keeps its own value; Batches see it until the choice", async () => {
  const windows = computer();
  const mac = computer();
  await windows.core.save({ channelId: CH, defaultLanguage: "en", defaultAudioLanguage: "en" });
  await mac.core.save({ channelId: CH, defaultLanguage: "es", defaultAudioLanguage: "en" });
  await cycle(windows, mac);
  for (const [c, mine] of [[windows, "en"], [mac, "es"]] as const) {
    assert.deepEqual(await c.core.conflictedBaselineFields(CH), ["defaultLanguage"]);
    const [conflict] = await c.core.listConflicts(CH);
    assert.equal(conflict.field, "defaultLanguage");
    assert.deepEqual([...conflict.values].sort(), ["en", "es"]);
    assert.equal(Object.keys(conflict.valuesByActor).length, 2, "one version per distinct value");
    assert.equal(conflict.thisComputer, mine);
    assert.equal(c.local().defaultLanguage, mine, "never replaced while undecided");
  }

  // The owner keeps the Windows value, choosing on the Mac; the next cycle settles both computers.
  const [conflict] = await mac.core.listConflicts(CH);
  const windowsActor = Object.entries(conflict.valuesByActor).find(([, v]) => v === "en")![0];
  await mac.core.resolveConflict({ channelId: CH, field: "defaultLanguage", winningActorId: windowsActor });
  assert.equal(mac.local().defaultLanguage, "en");
  await cycle(windows, mac);
  for (const c of [windows, mac]) {
    assert.deepEqual(await c.core.listConflicts(CH), []);
    assert.deepEqual(await c.core.conflictedBaselineFields(CH), []);
    assert.equal(c.local().defaultLanguage, "en");
  }
});

test("the same values on both computers are no conflict; tracked languages in another order are the same setting", async () => {
  const windows = computer({ defaultLanguage: "en", defaultAudioLanguage: "en", trackedLanguages: ["es", "pt-BR", "ru"] });
  const mac = computer({ defaultLanguage: "en", defaultAudioLanguage: "en", trackedLanguages: ["ru", "es", "pt-BR"] });
  await cycle(windows, mac);
  assert.deepEqual(await windows.core.listConflicts(CH), []);
  assert.deepEqual(await mac.core.listConflicts(CH), []);
});

test("different tracked languages are a conflict, but not a baseline one: Batches do not refuse for it", async () => {
  const windows = computer({ defaultLanguage: "en", trackedLanguages: ["es", "pt-BR"] });
  const mac = computer({ defaultLanguage: "en", trackedLanguages: ["es"] });
  await cycle(windows, mac);
  assert.deepEqual((await mac.core.listConflicts(CH)).map((c) => c.field), ["trackedLanguages"]);
  assert.deepEqual(await mac.core.conflictedBaselineFields(CH), []);
  assert.deepEqual(mac.local().trackedLanguages, ["es"], "the Mac keeps its own list until the choice");
  assert.deepEqual(windows.local().trackedLanguages, ["es", "pt-BR"]);
});

test("a save of a conflicted field settles it on both computers", async () => {
  const windows = computer({ defaultLanguage: "en" });
  const mac = computer({ defaultLanguage: "es" });
  await cycle(windows, mac);
  assert.deepEqual(await mac.core.conflictedBaselineFields(CH), ["defaultLanguage"]);
  await mac.core.save({ channelId: CH, defaultLanguage: "en" });
  await cycle(windows, mac);
  for (const c of [windows, mac]) {
    assert.deepEqual(await c.core.listConflicts(CH), []);
    assert.equal(c.local().defaultLanguage, "en");
  }
});

test("a choice must name one of the conflicting versions; with no conflict there is nothing to choose", async () => {
  const windows = computer({ defaultLanguage: "en" });
  const mac = computer({ defaultLanguage: "es" });
  await cycle(windows, mac);
  await assert.rejects(mac.core.resolveConflict({ channelId: CH, field: "defaultLanguage", winningActorId: "00ff" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(mac.core.resolveConflict({ channelId: CH, field: "trackedLanguages", winningActorId: "00ff" }), (e: unknown) => isDomainError(e) && e.code === "not_found");
});

test("a value cleared by the owner after it was shared reaches the other computer as cleared", async () => {
  const windows = computer();
  const mac = computer();
  await windows.core.save({ channelId: CH, defaultLanguage: "en", defaultAudioLanguage: "en" });
  await cycle(windows, mac);
  await windows.core.save({ channelId: CH, defaultLanguage: "en", defaultAudioLanguage: null });
  await cycle(windows, mac);
  assert.deepEqual([mac.local().defaultLanguage, mac.local().defaultAudioLanguage], ["en", null]);
  assert.deepEqual(await mac.core.listConflicts(CH), []);
});

test("saving an unset value the document never had shares nothing (it must not conflict with a real value elsewhere)", async () => {
  const windows = computer({ defaultLanguage: "en", defaultAudioLanguage: "en" });
  const mac = computer();
  // The owner saves on the Mac before the first cycle: language set, audio left empty.
  await mac.core.save({ channelId: CH, defaultLanguage: "en", defaultAudioLanguage: null });
  await cycle(windows, mac);
  assert.deepEqual(await mac.core.listConflicts(CH), []);
  assert.equal(mac.local().defaultAudioLanguage, "en", "Windows' audio baseline arrives");
});

test("this computer's copy takes the saved value even when the document is unchanged", async () => {
  const mac = computer({ defaultLanguage: "es" });
  // Never shared yet; the owner clears it: nothing to share, but the local copy is cleared.
  await mac.core.save({ channelId: CH, defaultLanguage: null });
  assert.equal(mac.local().defaultLanguage, null);
});

// The media-settings independent-review finding, kept for this family: a merge that loaded the document before an owner's save
// must not write over that save.
test("an owner's save during a merge is kept (document operations run one at a time)", async () => {
  const windows = computer({ defaultLanguage: "en" });
  const mac = computer({ defaultLanguage: "en" });
  await cycle(windows, mac);
  await windows.core.save({ channelId: CH, trackedLanguages: ["es"] });
  const fromWindows = await windows.core.exportBytes(CH);
  await Promise.all([mac.core.mergeIncoming(CH, fromWindows), mac.core.save({ channelId: CH, defaultAudioLanguage: "en" })]);
  const { values } = await mac.core.read(CH);
  assert.equal(values.defaultAudioLanguage, "en");
  assert.deepEqual(values.trackedLanguages, ["es"]);
});

// Review item 2: a form that saves every field re-sends the value this computer already holds for a conflicted field. That is
// not the owner's choice and must not settle the conflict (otherwise the other computer silently adopts this one's value).
test("re-saving this computer's own value of a conflicted field does not settle the conflict; the other field still syncs", async () => {
  const windows = computer({ defaultLanguage: "en", defaultAudioLanguage: "en" });
  const mac = computer({ defaultLanguage: "es", defaultAudioLanguage: "en" });
  await cycle(windows, mac);
  assert.deepEqual(await mac.core.conflictedBaselineFields(CH), ["defaultLanguage"]);
  // The Languages panel sends both fields; the owner only changed the audio language.
  await mac.core.save({ channelId: CH, defaultLanguage: "es", defaultAudioLanguage: "fr" });
  await cycle(windows, mac);
  assert.deepEqual(await windows.core.conflictedBaselineFields(CH), ["defaultLanguage"], "still the owner's choice to make");
  assert.equal(windows.local().defaultLanguage, "en", "Windows keeps its own value");
  assert.equal(windows.local().defaultAudioLanguage, "fr", "the field the owner did change reaches Windows");
});
