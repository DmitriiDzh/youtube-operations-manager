// ---------------------------------------------------------------------------
// Acceptance matrix (Step 1-2, docs/DEVELOPMENT_PLAYBOOK.md §6.14), fixed BEFORE writing
// merge.ts's implementation, directly from docs/acceptance/PHASE_5_ACCEPTANCE.md.
//
// AC-DEFAULTLANG-01/02: missing/null defaultLanguage blocks; a real defaultLanguage does
// not produce a false-positive block. Never sets defaultLanguage itself.
//
// AC-MERGE-01 (= official test §57): existingLocalizations {es, de, fr}, target adds
// pt-BR/title+description. Expected: es/de/fr survive byte-for-byte, pt-BR is added.
//
// AC-MERGE-03: unrelated snippet fields (categoryId, tags, defaultAudioLanguage) survive
// unchanged when only a localizations-level change is made.
//
// AC-MULTI-01: three changes to the same video (es/title, de/description, fr/title)
// merge into ONE payload; es/description, de/title, fr/description (untouched) survive.
//
// AC-CONFLICT-01 / AC-LEDGER-04: baseline "Cuban Jazz" vs fresh "Changed In Studio" ->
// CONFLICT. A change whose baseline still matches the fresh value -> "none".
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSafeLocalizationsPayload,
  checkDefaultLanguage,
  detectPreWriteConflict,
  type FreshVideoContext,
  type PendingChange,
} from "./merge";

test("AC-DEFAULTLANG-01: a null/missing defaultLanguage is rejected", () => {
  assert.equal(checkDefaultLanguage({ defaultLanguage: null }).ok, false);
  assert.equal(checkDefaultLanguage({ defaultLanguage: "" }).ok, false);
});

test("AC-DEFAULTLANG-02: a real defaultLanguage is accepted (no false positive)", () => {
  assert.equal(checkDefaultLanguage({ defaultLanguage: "en" }).ok, true);
});

test("AC-MERGE-01 (= official test §57): adding pt-BR preserves es/de/fr byte-for-byte", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Any", description: "Any", defaultLanguage: "en" },
    localizations: {
      es: { title: "Titulo ES", description: "Descripcion ES" },
      de: { title: "Titel DE", description: "Beschreibung DE" },
      fr: { title: "Titre FR", description: "Description FR" },
    },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "pt-BR", field: "title", baselineValue: "", proposedValue: "Titulo PT" },
    { id: "c2", language: "pt-BR", field: "description", baselineValue: "", proposedValue: "Descricao PT" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.deepEqual(result.localizations.es, { title: "Titulo ES", description: "Descripcion ES" });
  assert.deepEqual(result.localizations.de, { title: "Titel DE", description: "Beschreibung DE" });
  assert.deepEqual(result.localizations.fr, { title: "Titre FR", description: "Description FR" });
  assert.deepEqual(result.localizations["pt-BR"], { title: "Titulo PT", description: "Descricao PT" });
});

test("AC-MERGE-03: unrelated snippet fields survive a localizations-only change", () => {
  const fresh: FreshVideoContext = {
    snippet: {
      title: "Main Title",
      description: "Main Description",
      defaultLanguage: "en",
      categoryId: "10",
      tags: ["jazz", "cuba"],
      defaultAudioLanguage: "es",
    },
    localizations: { es: { title: "Titulo Old", description: "Desc Old" } },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "es", field: "title", baselineValue: "Titulo Old", proposedValue: "Titulo New" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.equal(result.snippet.categoryId, "10");
  assert.deepEqual(result.snippet.tags, ["jazz", "cuba"]);
  assert.equal(result.snippet.defaultAudioLanguage, "es");
  assert.equal(result.snippet.title, "Main Title");
  assert.equal(result.snippet.description, "Main Description");
});

test("AC-MULTI-01: three changes to one video merge into one payload, untouched fields survive", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "irrelevant", description: "irrelevant", defaultLanguage: "en" },
    localizations: {
      es: { title: "Antiguo ES", description: "Desc ES" },
      de: { title: "Titel DE", description: "Alte DE" },
      fr: { title: "Ancien FR", description: "Desc FR" },
    },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "es", field: "title", baselineValue: "Antiguo ES", proposedValue: "Nuevo ES" },
    { id: "c2", language: "de", field: "description", baselineValue: "Alte DE", proposedValue: "Neue DE" },
    { id: "c3", language: "fr", field: "title", baselineValue: "Ancien FR", proposedValue: "Nouveau FR" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.deepEqual(result.localizations.es, { title: "Nuevo ES", description: "Desc ES" });
  assert.deepEqual(result.localizations.de, { title: "Titel DE", description: "Neue DE" });
  assert.deepEqual(result.localizations.fr, { title: "Nouveau FR", description: "Desc FR" });
});

test("AC-CONFLICT-01 / AC-LEDGER-04: a baseline that no longer matches the fresh value is a conflict", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "x", description: "x", defaultLanguage: "en" },
    localizations: { es: { title: "Changed In Studio", description: "Desc" } },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "es", field: "title", baselineValue: "Cuban Jazz", proposedValue: "Nuevo Titulo" },
  ];

  const result = detectPreWriteConflict(changes, fresh);
  assert.equal(result.status, "conflict");
  assert.deepEqual((result as { conflictingChangeIds: string[] }).conflictingChangeIds, ["c1"]);
});

test("a baseline that still matches the fresh value is not a conflict", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "x", description: "x", defaultLanguage: "en" },
    localizations: { es: { title: "Cuban Jazz", description: "Desc" } },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "es", field: "title", baselineValue: "Cuban Jazz", proposedValue: "Nuevo Titulo" },
  ];

  const result = detectPreWriteConflict(changes, fresh);
  assert.equal(result.status, "none");
});

test("conflict detection reads the primary-locale value from snippet.title, not localizations, when language === defaultLanguage", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Current EN Title", description: "x", defaultLanguage: "en" },
    localizations: {},
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "en", field: "title", baselineValue: "Stale Baseline", proposedValue: "New" },
  ];

  const result = detectPreWriteConflict(changes, fresh);
  assert.equal(result.status, "conflict");
});
