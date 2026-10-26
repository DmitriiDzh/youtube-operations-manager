import assert from "node:assert/strict";
import test from "node:test";
import { buildSafeLocalizationsPayload, checkDefaultLanguage, localeKeyFor, untitledTranslations, type FreshVideoContext } from "./index";

// BL-207 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §3, AC-LL-01): the shared merge as the live translations writer uses it --
// one title and one description change per language of the stored set. Expected values by hand from the plan and PROJECT_SPEC §21
// (keep every other locale, the snippet text untouched, nothing deleted). Batches' own cases stay in `batches/merge.test.ts`.

const fresh: FreshVideoContext = {
  snippet: { title: "T", description: "D", defaultLanguage: "en", tags: ["jazz"], categoryId: "10", channelId: "UC1", liveBroadcastContent: "live", defaultAudioLanguage: "en-US" },
  // YouTube also lists the default language itself (the mirror of the snippet).
  localizations: { en: { title: "T", description: "D" }, fr: { title: "Fo", description: "Fd" }, it: { title: "Io", description: "Id" } },
};

const setChanges = (set: Record<string, { title: string; description: string }>) =>
  Object.entries(set).flatMap(([language, value]) => [
    { language, field: "title" as const, proposedValue: value.title },
    { language, field: "description" as const, proposedValue: value.description },
  ]);

test("AC-LL-01: the set {de, fr} overwrites fr, adds de, keeps it, and leaves the snippet title/description as they were", () => {
  const payload = buildSafeLocalizationsPayload(fresh, setChanges({ de: { title: "Dt", description: "Dd" }, fr: { title: "Ft", description: "Fd2" } }));
  assert.deepEqual(payload.localizations, { fr: { title: "Ft", description: "Fd2" }, it: { title: "Io", description: "Id" }, de: { title: "Dt", description: "Dd" } });
  // Only the documented-writable snippet fields; no audio language unless the caller passes one.
  assert.deepEqual(payload.snippet, { title: "T", description: "D", tags: ["jazz"], categoryId: "10", defaultLanguage: "en" });
});

test("AC-LL-01: the caller's audio language is sent with the snippet (so videos.update does not reset it)", () => {
  const payload = buildSafeLocalizationsPayload(fresh, setChanges({ de: { title: "Dt", description: "Dd" } }), { defaultAudioLanguage: "en-US" });
  assert.equal(payload.snippet.defaultAudioLanguage, "en-US");
});

test("an existing key keeps its spelling: a set language pt-BR updates a stored pt-br entry, never a second key", () => {
  const withPt: FreshVideoContext = { ...fresh, localizations: { "pt-br": { title: "Po", description: "Pd" } } };
  assert.equal(localeKeyFor(withPt.localizations, "pt-BR"), "pt-br");
  assert.equal(localeKeyFor(withPt.localizations, "de"), null);
  const payload = buildSafeLocalizationsPayload(withPt, setChanges({ "pt-BR": { title: "Pt", description: "Pd2" } }));
  assert.deepEqual(payload.localizations, { "pt-br": { title: "Pt", description: "Pd2" } });
});

test("checkDefaultLanguage blocks a video without a default language (AC-LL-03's rule)", () => {
  assert.equal(checkDefaultLanguage({ defaultLanguage: null }).ok, false);
  assert.equal(checkDefaultLanguage({ defaultLanguage: "  " }).ok, false);
  assert.equal(checkDefaultLanguage({ defaultLanguage: "en" }).ok, true);
});

// BL-226: YouTube refuses a `videos.update` whose `localizations` hold a language with an empty title -- the whole write, every
// language of the video ("The request metadata is invalid.", live Rural Japan Music 2026-10-26, audit events 2456/2459: an approved
// `it` description sent while its over-long `it` title was rejected). Expected values by hand: a translation a write would leave
// without a title is named before anything is sent; a title already on the video, or arriving in the same changes, is enough.

const titleOf = (localizations: Record<string, { title: string; description: string }>, own: string) => ({
  isOwnLanguage: (language: string) => language.toLowerCase() === own.toLowerCase(),
  title: (language: string) => Object.entries(localizations).find(([key]) => key.toLowerCase() === language.toLowerCase())?.[1].title ?? "",
});

test("BL-226: a description for a language the video has no title in is a translation without a title", () => {
  const changes = [{ language: "de", field: "description" as const, proposedValue: "Dd" }];
  assert.deepEqual(untitledTranslations(titleOf(fresh.localizations, "en"), changes), ["de"]);
  assert.throws(() => buildSafeLocalizationsPayload(fresh, changes), /de/);
});

test("BL-226: a description alone is fine when the video already has a title in that language (the merge keeps it)", () => {
  const changes = [{ language: "fr", field: "description" as const, proposedValue: "Fd2" }];
  assert.deepEqual(untitledTranslations(titleOf(fresh.localizations, "en"), changes), []);
  assert.deepEqual(buildSafeLocalizationsPayload(fresh, changes).localizations.fr, { title: "Fo", description: "Fd2" });
});

test("BL-226: a title arriving with the description (any spelling of the language) is enough; a blank title is not", () => {
  const both = [
    { language: "pt-BR", field: "title" as const, proposedValue: "Pt" },
    { language: "pt-br", field: "description" as const, proposedValue: "Pd" },
  ];
  assert.deepEqual(untitledTranslations(titleOf(fresh.localizations, "en"), both), []);
  const blank = [
    { language: "de", field: "title" as const, proposedValue: "   " },
    { language: "de", field: "description" as const, proposedValue: "Dd" },
  ];
  assert.deepEqual(untitledTranslations(titleOf(fresh.localizations, "en"), blank), ["de"]);
  assert.throws(() => buildSafeLocalizationsPayload(fresh, blank), /de/);
});

test("BL-226: a title alone, a deleted language and the video's own language are not translations without a title", () => {
  const current = titleOf(fresh.localizations, "en");
  assert.deepEqual(untitledTranslations(current, [{ language: "de", field: "title", proposedValue: "Dt" }]), []);
  assert.deepEqual(
    untitledTranslations(current, [
      { language: "it", field: "description", proposedValue: "", changeType: "delete" },
      { language: "de", field: "description", proposedValue: "", changeType: "delete" },
      { language: "de", field: "description", proposedValue: "Dd" },
    ]),
    []
  );
  assert.deepEqual(untitledTranslations(current, [{ language: "EN", field: "description", proposedValue: "D2" }]), []);
});

test("BL-226: several languages without a title are each named once, in the order of the changes", () => {
  const changes = [
    { language: "ko", field: "description" as const, proposedValue: "K" },
    { language: "de", field: "description" as const, proposedValue: "D" },
    { language: "ko", field: "description" as const, proposedValue: "K2" },
  ];
  assert.deepEqual(untitledTranslations(titleOf(fresh.localizations, "en"), changes), ["ko", "de"]);
});
