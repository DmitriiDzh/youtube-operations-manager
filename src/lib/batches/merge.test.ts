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

test("RISK-11: documented read-only snippet fields are never echoed back into the write payload, even though the fresh fetch legitimately returns them", () => {
  // Fixture shape matches a real videos.list(part=snippet) response, per
  // developers.google.com/youtube/v3/docs/videos (verified 2026-09-18): publishedAt,
  // channelId, channelTitle, thumbnails, liveBroadcastContent, and localized are ALL
  // documented read-only sub-properties of snippet -- none may be sent back on write.
  const fresh: FreshVideoContext = {
    snippet: {
      title: "Main Title",
      description: "Main Description",
      defaultLanguage: "en",
      categoryId: "10",
      tags: ["jazz", "cuba"],
      defaultAudioLanguage: "es",
      publishedAt: "2026-01-01T00:00:00.000Z",
      channelId: "UC_TEST",
      channelTitle: "Tropico Jazz",
      thumbnails: { default: { url: "https://example.com/v1.jpg" } },
      liveBroadcastContent: "none",
      localized: { title: "Main Title", description: "Main Description" },
    },
    localizations: {},
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "en", field: "description", baselineValue: "Main Description", proposedValue: "New Description" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  for (const readOnlyField of ["publishedAt", "channelId", "channelTitle", "thumbnails", "liveBroadcastContent", "localized"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.snippet, readOnlyField),
      false,
      `read-only field "${readOnlyField}" must never appear in the write payload`
    );
  }
  // Writable fields still survive -- this is a whitelist, not a wholesale strip.
  assert.equal(result.snippet.title, "Main Title");
  assert.equal(result.snippet.description, "New Description");
  assert.equal(result.snippet.categoryId, "10");
  assert.deepEqual(result.snippet.tags, ["jazz", "cuba"]);
  assert.equal(result.snippet.defaultAudioLanguage, "es");
  assert.equal(result.snippet.defaultLanguage, "en");
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

// (independent review, second cycle): if fresh.localizations defensively contains a stale
// entry keyed by the same code as defaultLanguage, a change targeting the default language
// must not leave that stale entry in the payload alongside the updated snippet field --
// buildSafeLocalizationsPayload previously copied it forward verbatim and never touched it.
// ---------------------------------------------------------------------------
// Deletion feature (docs/PROJECT_SPEC.md §16, 2026-09-20 update). Acceptance fixed
// before implementation, per the advisor-reviewed scope for this slice:
//   - a delete-only change removes the target locale entirely, others survive
//     byte-for-byte;
//   - a delete for a locale that is ALSO modified in the same approved set wins,
//     regardless of which order the two changes appear in the input array (delete
//     is a terminal outcome, not just "the last write wins");
//   - a delete targeting the video's own defaultLanguage is refused even at merge
//     time (defense-in-depth; the primary refusal is at propose time in
//     src/lib/changesets/services.ts's proposeLocalizationDeletion) -- this must
//     fail closed (throw), never silently blank snippet.title/description;
//   - conflict detection (baseline vs fresh) is unaffected by changeType -- an
//     empty baseline that still matches an empty current value is "none", not a
//     false-positive conflict.
// ---------------------------------------------------------------------------

test("a delete-only change removes the target locale entirely; other locales survive byte-for-byte", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Main", description: "Main Desc", defaultLanguage: "en" },
    localizations: {
      es: { title: "Titulo ES", description: "Descripcion ES" },
      de: { title: "Titel DE", description: "Beschreibung DE" },
    },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "es", field: "title", baselineValue: "Titulo ES", proposedValue: "", changeType: "delete" },
    { id: "c2", language: "es", field: "description", baselineValue: "Descripcion ES", proposedValue: "", changeType: "delete" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.equal(Object.prototype.hasOwnProperty.call(result.localizations, "es"), false);
  assert.deepEqual(result.localizations.de, { title: "Titel DE", description: "Beschreibung DE" });
});

test("delete wins over a same-locale modify in the same approved set, regardless of array order (delete first)", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Main", description: "Main Desc", defaultLanguage: "en" },
    localizations: { es: { title: "Titulo ES", description: "Descripcion ES" } },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "es", field: "title", baselineValue: "Titulo ES", proposedValue: "", changeType: "delete" },
    { id: "c2", language: "es", field: "description", baselineValue: "Descripcion ES", proposedValue: "", changeType: "delete" },
    { id: "c3", language: "es", field: "title", baselineValue: "Titulo ES", proposedValue: "Sneaky Modify", changeType: "modify" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.equal(Object.prototype.hasOwnProperty.call(result.localizations, "es"), false);
});

test("delete wins over a same-locale modify in the same approved set, regardless of array order (modify first)", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Main", description: "Main Desc", defaultLanguage: "en" },
    localizations: { es: { title: "Titulo ES", description: "Descripcion ES" } },
  };
  const changes: PendingChange[] = [
    { id: "c3", language: "es", field: "title", baselineValue: "Titulo ES", proposedValue: "Sneaky Modify", changeType: "modify" },
    { id: "c1", language: "es", field: "title", baselineValue: "Titulo ES", proposedValue: "", changeType: "delete" },
    { id: "c2", language: "es", field: "description", baselineValue: "Descripcion ES", proposedValue: "", changeType: "delete" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.equal(Object.prototype.hasOwnProperty.call(result.localizations, "es"), false);
});

test("buildSafeLocalizationsPayload refuses (throws) a delete change targeting the video's own defaultLanguage, defense-in-depth", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Main", description: "Main Desc", defaultLanguage: "en" },
    localizations: {},
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "en", field: "title", baselineValue: "Main", proposedValue: "", changeType: "delete" },
  ];

  assert.throws(() => buildSafeLocalizationsPayload(fresh, changes));
});

test("a PendingChange with no changeType behaves exactly like an ordinary field write (backward compatibility)", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Main", description: "Main Desc", defaultLanguage: "en" },
    localizations: { es: { title: "Old", description: "Old Desc" } },
  };
  const changes: PendingChange[] = [{ id: "c1", language: "es", field: "title", baselineValue: "Old", proposedValue: "New" }];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.deepEqual(result.localizations.es, { title: "New", description: "Old Desc" });
});

test("empty-string-baseline edge case: a language never localized (empty baseline) that is still absent from the fresh fetch is not a false-positive conflict", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "x", description: "x", defaultLanguage: "en" },
    localizations: {},
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "pt-BR", field: "title", baselineValue: "", proposedValue: "Titulo PT", changeType: "add" },
  ];

  const result = detectPreWriteConflict(changes, fresh);
  assert.equal(result.status, "none");
});

test("buildSafeLocalizationsPayload never carries a stale localizations entry for the default language forward", () => {
  const fresh: FreshVideoContext = {
    snippet: { title: "Old EN Title", description: "Old EN Description", defaultLanguage: "en" },
    localizations: {
      en: { title: "Stale EN Title", description: "Stale EN Description" },
      es: { title: "Titulo ES", description: "Descripcion ES" },
    },
  };
  const changes: PendingChange[] = [
    { id: "c1", language: "en", field: "title", baselineValue: "Old EN Title", proposedValue: "New EN Title" },
  ];

  const result = buildSafeLocalizationsPayload(fresh, changes);

  assert.equal(result.snippet.title, "New EN Title");
  assert.equal(Object.prototype.hasOwnProperty.call(result.localizations, "en"), false);
  assert.deepEqual(result.localizations.es, { title: "Titulo ES", description: "Descripcion ES" });
});
