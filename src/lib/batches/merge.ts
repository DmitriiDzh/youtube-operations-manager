// Pure logic, zero I/O -- see docs/DEVELOPMENT_PLAYBOOK.md §6.2 ("Business rules,
// classification, validation logic that has no I/O -> pure functions, ideally in their
// own file", modeled on src/lib/changesets/diff.ts). This is Slice 2 ("SAFETY
// PREPARATION") of the approved Phase 5 implementation plan.
//
// Implements, from docs/acceptance/PHASE_5_ACCEPTANCE.md:
//   - AC-CONFLICT-01 / AC-LEDGER-04 (detectPreWriteConflict) -- baseline-vs-FRESH, never
//     baseline-vs-last-synced-snapshot (that would silently regress to Phase 4's
//     RISK-03-affected behavior, see docs/TECHNICAL_DEBT.md RISK-03)
//   - AC-MERGE-01/02/03/04, AC-MULTI-01 (buildSafeLocalizationsPayload -- now in @/lib/shared-localization-merge, BL-207)

import { baselineValueStillHolds, readAgainstBaseline, sameLanguage, type VideoLanguageView } from "@/lib/shared-language-baseline";
import { localeKeyFor, type FreshVideoContext } from "@/lib/shared-localization-merge";

// BL-207 stage 1: the safe merge itself (checkDefaultLanguage, buildSafeLocalizationsPayload and their types) moved to
// `@/lib/shared-localization-merge`, shared with the live-broadcast translations writer -- re-exported here unchanged so every
// Batches caller and test keeps importing it from this file.
export {
  buildSafeLocalizationsPayload,
  checkDefaultLanguage,
  type FreshVideoContext,
  type FreshVideoLocale,
  type SafeLocalizationsPayload,
} from "@/lib/shared-localization-merge";

export type PendingChange = {
  id: string;
  language: string;
  field: "title" | "description";
  baselineValue: string;
  proposedValue: string;
  /**
   * Optional so every pre-existing caller/test that never deals in deletions keeps
   * compiling unchanged -- absent is treated identically to "add"/"modify"/"unchanged"
   * (i.e. an ordinary field write). Only `"delete"` changes buildSafeLocalizationsPayload's
   * behavior (`@/lib/shared-localization-merge`; docs/PROJECT_SPEC.md §16, 2026-09-20 deletion-policy update).
   */
  changeType?: "add" | "modify" | "unchanged" | "delete";
};

/** Reads the CURRENT value of one (language, field) pair from a fresh fetch -- the
 * primary locale's title/description live on `snippet`, every other locale lives in
 * `localizations`. Exported for reuse by the §0.F reconciliation procedure
 * (classifyFreshStateAgainstAttempt below), which needs the identical "what does the
 * current remote value actually look like" reading as ordinary conflict detection --
 * one shared primitive, per architectural decision #4 (2026-09-17 plan approval), not two
 * separately-maintained implementations of the same read. */
export function readCurrentValue(fresh: FreshVideoContext, language: string, field: "title" | "description"): string {
  // Language codes compare case-insensitively (BL-178 review M1, the shared rule in `@/lib/shared-language-baseline`).
  if (sameLanguage(language, fresh.snippet.defaultLanguage)) {
    return field === "title" ? fresh.snippet.title : fresh.snippet.description;
  }
  const key = localeKeyFor(fresh.localizations, language);
  return key ? fresh.localizations[key][field] : "";
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
export function detectPreWriteConflict(
  changes: PendingChange[],
  fresh: FreshVideoContext,
  options: { channelBaseline?: string | null } = {}
): ConflictResult {
  const conflicting = changes.filter((change) => !baselineHolds(change, fresh, options.channelBaseline ?? null));

  if (conflicting.length === 0) return { status: "none" };
  return { status: "conflict", conflictingChangeIds: conflicting.map((c) => c.id) };
}

/** The fresh fetch in the shape the shared language-baseline rule reads (`@/lib/shared-language-baseline`). */
export function toLanguageView(fresh: FreshVideoContext): VideoLanguageView {
  return { defaultLanguage: fresh.snippet.defaultLanguage, title: fresh.snippet.title, description: fresh.snippet.description, localizations: fresh.localizations };
}

/**
 * Whether a change's baseline still matches the fresh fetch. Without a channel baseline: the plain current value
 * (`readCurrentValue`). With one (BL-178, PROJECT_SPEC §14 2026-10-12), a video whose own language differs from it is read
 * aligned: a change in the old default language holds when its baseline is empty or the snippet text (made against YouTube's
 * mirror) -- both mean "no translation existed".
 */
function baselineHolds(change: PendingChange, fresh: FreshVideoContext, channelBaseline: string | null): boolean {
  if (!channelBaseline) return readCurrentValue(fresh, change.language, change.field) === change.baselineValue;
  const video = toLanguageView(fresh);
  return baselineValueStillHolds(video, readAgainstBaseline(video, channelBaseline), change);
}

/**
 * RISK-11 fix (2026-09-18, extended repository-wide 2026-09-18): re-exported from
 * `src/lib/youtube-write-gateway/index.ts`, the single canonical source, so every write path
 * (this module, `src/lib/video-metadata/services.ts`) shares one definition instead of three
 * independently-drifting copies. See that module's doc comment for the full rationale.
 */
export { WRITABLE_SNIPPET_FIELDS, pickWritableSnippetFields } from "@/lib/youtube-write-gateway";

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
  fresh: FreshVideoContext,
  options: { channelBaseline?: string | null } = {}
): ReconciliationReadClassification {
  const allMatchRequested = changes.every(
    (change) => readCurrentValue(fresh, change.language, change.field) === change.proposedValue
  );
  if (allMatchRequested) return "matches_requested";

  // An aligning write (BL-178) that did not land leaves the video in its old language: its rows still hold (see baselineHolds).
  const allMatchBaseline = changes.every((change) => baselineHolds(change, fresh, options.channelBaseline ?? null));
  if (allMatchBaseline) return "matches_baseline";

  return "diverged";
}
