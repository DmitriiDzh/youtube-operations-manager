import assert from "node:assert/strict";
import test from "node:test";
import { buildSafeLocalizationsPayload, checkDefaultLanguage, localeKeyFor, type FreshVideoContext } from "./index";

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
