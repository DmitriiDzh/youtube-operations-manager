// Pure logic, zero I/O -- see docs/DEVELOPMENT_PLAYBOOK.md §6.2 ("Business rules,
// classification, validation logic that has no I/O -> pure functions, ideally in their
// own file", modeled on src/lib/changesets/diff.ts). This is Slice 2 ("SAFETY
// PREPARATION") of the approved Phase 5 implementation plan.
//
// Implements, from docs/acceptance/PHASE_5_ACCEPTANCE.md:
//   - AC-DEFAULTLANG-01/02 (checkDefaultLanguage)
//   - AC-CONFLICT-01 / AC-LEDGER-04 (detectPreWriteConflict) -- baseline-vs-FRESH, never
//     baseline-vs-last-synced-snapshot (that would silently regress to Phase 4's
//     RISK-03-affected behavior, see docs/TECHNICAL_DEBT.md RISK-03)
//   - AC-MERGE-01/02/03/04, AC-MULTI-01 (buildSafeLocalizationsPayload)

import { pickWritableSnippetFields } from "@/lib/youtube";

export type FreshVideoLocale = { title: string; description: string };

export type FreshVideoContext = {
  snippet: {
    title: string;
    description: string;
    defaultLanguage: string | null;
    [otherSnippetField: string]: unknown;
  };
  localizations: Record<string, FreshVideoLocale>;
};

export type PendingChange = {
  id: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
};

/**
 * AC-DEFAULTLANG-01/02 (DEC-OQ-2): a video with no resolvable defaultLanguage cannot be
 * safely written (there is no well-defined "primary" locale to reconcile snippet.title/
 * description against), and this check only ever blocks -- it never sets defaultLanguage
 * itself, anywhere, under any circumstance (that remains explicitly out of scope for
 * Phase 5 per DEC-OQ-2).
 */
export function checkDefaultLanguage(
  fresh: Pick<FreshVideoContext["snippet"], "defaultLanguage">
): { ok: true } | { ok: false; reason: string } {
  if (fresh.defaultLanguage && fresh.defaultLanguage.trim().length > 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "Video has no defaultLanguage set on YouTube; a safe localization write requires a resolvable primary locale. This is never set automatically -- resolve it manually before retrying.",
  };
}

/** Reads the CURRENT value of one (language, field) pair from a fresh fetch -- the
 * primary locale's title/description live on `snippet`, every other locale lives in
 * `localizations`. Exported for reuse by the §0.F reconciliation procedure
 * (classifyFreshStateAgainstAttempt below), which needs the identical "what does the
 * current remote value actually look like" reading as ordinary conflict detection --
 * one shared primitive, per architectural decision #4 (2026-09-17 plan approval), not two
 * separately-maintained implementations of the same read. */
export function readCurrentValue(fresh: FreshVideoContext, language: string, field: "title" | "description"): string {
  if (fresh.snippet.defaultLanguage && language === fresh.snippet.defaultLanguage) {
    return field === "title" ? fresh.snippet.title : fresh.snippet.description;
  }
  return fresh.localizations[language]?.[field] ?? "";
}

export type ConflictResult =
  | { status: "none" }
  | { status: "conflict"; conflictingChangeIds: string[] };

/**
 * §30/AC-CONFLICT-01/AC-LEDGER-04: for each change, compares its approval-time
 * `baselineValue` against the value read from a FRESH fetch (never a locally-cached
 * snapshot -- see readCurrentValue's caller contract). If any change's baseline no
 * longer matches the live remote value, the whole ledger row is CONFLICT (AC-MULTI-01
 * requires one consistent payload per video; a partial conflict cannot be silently
 * dropped and the rest applied).
 *
 * INV-5 (revised): this function, like the fresh fetch it consumes, reduces but does not
 * eliminate the risk of a race with a concurrent external edit -- it is not, and must
 * never be treated as, an atomic compare-and-swap. Post-write verification (Slice 3,
 * AC-CONFLICT-02) is the backstop for a race landing in the gap between this check and
 * the eventual write.
 */
export function detectPreWriteConflict(changes: PendingChange[], fresh: FreshVideoContext): ConflictResult {
  const conflicting = changes.filter(
    (change) => readCurrentValue(fresh, change.language, change.field) !== change.baselineValue
  );

  if (conflicting.length === 0) return { status: "none" };
  return { status: "conflict", conflictingChangeIds: conflicting.map((c) => c.id) };
}

export type SafeLocalizationsPayload = {
  snippet: Record<string, unknown>;
  localizations: Record<string, FreshVideoLocale>;
};

/**
 * RISK-11 fix (2026-09-18, extended repository-wide 2026-09-18): re-exported from
 * `src/lib/youtube.ts`, the single canonical source, so every write path (this module,
 * `src/lib/video-metadata/services.ts`) shares one definition instead of three
 * independently-drifting copies. See that module's doc comment for the full rationale.
 */
export { WRITABLE_SNIPPET_FIELDS, pickWritableSnippetFields } from "@/lib/youtube";

/**
 * AC-MERGE-01 (preserve untouched locales byte-for-byte), AC-MERGE-02 (built from the
 * FRESH fetch passed in, never a stale local mirror -- enforced by this function only
 * ever reading its `fresh` parameter, never touching any cache itself), AC-MERGE-03
 * (unrelated snippet fields like categoryId/tags/defaultAudioLanguage survive via the
 * explicit whitelist copy below), AC-MERGE-04 (caller's responsibility: only pass
 * already-approved, valid, non-conflicting changes in -- this function applies whatever
 * it is given), AC-MULTI-01 (multiple changes to one video merge into a single payload,
 * one call).
 */
export function buildSafeLocalizationsPayload(
  fresh: FreshVideoContext,
  changes: PendingChange[]
): SafeLocalizationsPayload {
  const snippet: Record<string, unknown> = pickWritableSnippetFields(fresh.snippet);

  const localizations: Record<string, FreshVideoLocale> = {};
  for (const [locale, value] of Object.entries(fresh.localizations)) {
    localizations[locale] = { ...value };
  }

  for (const change of changes) {
    if (fresh.snippet.defaultLanguage && change.language === fresh.snippet.defaultLanguage) {
      snippet[change.field] = change.proposedValue;
      continue;
    }

    const existingLocale = localizations[change.language] ?? { title: "", description: "" };
    localizations[change.language] = { ...existingLocale, [change.field]: change.proposedValue };
  }

  return { snippet, localizations };
}

// ---------------------------------------------------------------------------
// Slice 3 addition: §0.F reconciliation-read classification, built on the exact same
// readCurrentValue primitive detectPreWriteConflict uses above (architectural decision
// #4 -- one shared "read the live value" function; the reconciliation procedure and
// ordinary conflict detection are still separate operations with separate call sites and
// separate meanings, they just don't duplicate how a live value is read).
// ---------------------------------------------------------------------------

export type ReconciliationReadClassification = "matches_requested" | "matches_baseline" | "diverged";

/**
 * §0.F Step 1/2: classifies one fresh read against the changes an attempt was for.
 *   - "matches_requested": every changed field now shows its proposed value -- the goal
 *     state has been reached (§0.F's causation note: this is goal-state evidence, not
 *     proof this specific attempt caused it -- see AC-AUDIT-05, enforced by the caller).
 *   - "matches_baseline": every changed field still shows its pre-write baseline -- not
 *     proof of non-application (propagation lag is possible), just inconclusive evidence.
 *   - "diverged": neither -- a third-party edit or a partial/inconsistent state.
 */
export function classifyFreshStateAgainstAttempt(
  changes: PendingChange[],
  fresh: FreshVideoContext
): ReconciliationReadClassification {
  const allMatchRequested = changes.every(
    (change) => readCurrentValue(fresh, change.language, change.field) === change.proposedValue
  );
  if (allMatchRequested) return "matches_requested";

  const allMatchBaseline = changes.every(
    (change) => readCurrentValue(fresh, change.language, change.field) === change.baselineValue
  );
  if (allMatchBaseline) return "matches_baseline";

  return "diverged";
}
