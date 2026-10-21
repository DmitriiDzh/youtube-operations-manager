// BL-207 stage 1 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2): the safe per-language title/description merge -- keep every
// other locale, send the whole writable snippet, block a video without a defaultLanguage. Pure, no I/O. Shared by `batches`
// (Change Set writes) and the live-broadcast translations writer (`live-localizations`, ADR 0045), so both apply one rule
// (AGENTS.md §D/§M). Moved unchanged from `batches/merge.ts`, which re-exports it; Batches-only types stay there.
//
// Implements, from docs/acceptance/PHASE_5_ACCEPTANCE.md:
//   - AC-DEFAULTLANG-01/02 (checkDefaultLanguage)
//   - AC-MERGE-01/02/03/04, AC-MULTI-01 (buildSafeLocalizationsPayload)

import { sameLanguage } from "@/lib/shared-language-baseline";
import { pickWritableSnippetFields } from "@/lib/youtube-write-gateway";

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

/**
 * One approved per-language field value to merge. Batches' `PendingChange` (which also carries its id and baseline) is
 * structurally one of these.
 */
export type LocalizationFieldChange = {
  language: string;
  field: "title" | "description";
  proposedValue: string;
  /**
   * Optional so every pre-existing caller/test that never deals in deletions keeps
   * compiling unchanged -- absent is treated identically to "add"/"modify"/"unchanged"
   * (i.e. an ordinary field write). Only `"delete"` changes buildSafeLocalizationsPayload's
   * behavior below (docs/PROJECT_SPEC.md §16, 2026-09-20 deletion-policy update).
   */
  changeType?: "add" | "modify" | "unchanged" | "delete";
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

/** The existing `localizations` key for a language, matched case-insensitively (`pt-br` finds `pt-BR`); `null` when none. */
export function localeKeyFor(localizations: Record<string, FreshVideoLocale>, language: string): string | null {
  return Object.keys(localizations).find((key) => sameLanguage(key, language)) ?? null;
}

export type SafeLocalizationsPayload = {
  /**
   * ALWAYS present. `videos.update` rejects a request that adds/changes `localizations` without
   * `snippet.defaultLanguage` in the same call ("trying to add localized video details without
   * specifying the default language", live Japan Music batch 2026-10-02: 25/41 rejected when
   * the snippet was omitted). The snippet part replaces the stored snippet wholesale, so it is
   * the full documented-writable set (`pickWritableSnippetFields`) from the FRESH fetch --
   * `defaultAudioLanguage` is sent only when the caller passes one.
   */
  snippet: Record<string, unknown>;
  localizations: Record<string, FreshVideoLocale>;
};

/**
 * AC-MERGE-01 (preserve untouched locales byte-for-byte), AC-MERGE-02 (built from the
 * FRESH fetch passed in, never a stale local mirror -- enforced by this function only
 * ever reading its `fresh` parameter, never touching any cache itself), AC-MERGE-03
 * (unrelated snippet fields like categoryId/tags survive via the
 * explicit whitelist copy below), AC-MERGE-04 (caller's responsibility: only pass
 * already-approved, valid, non-conflicting changes in -- this function applies whatever
 * it is given), AC-MULTI-01 (multiple changes to one video merge into a single payload,
 * one call).
 */
export function buildSafeLocalizationsPayload<Change extends LocalizationFieldChange>(
  fresh: FreshVideoContext,
  changes: readonly Change[],
  options: { defaultAudioLanguage?: string | null } = {}
): SafeLocalizationsPayload {
  const snippet: Record<string, unknown> = pickWritableSnippetFields(fresh.snippet);
  // Sent only when the caller passes it (Batches: the channel baseline's value) -- never the video's own echoed blindly
  // (e.g. `zxx`).
  if (options.defaultAudioLanguage) snippet.defaultAudioLanguage = options.defaultAudioLanguage;

  // The video's default language is represented by `snippet.title`/`description`, never by
  // a `localizations` entry -- if `fresh.localizations` defensively contains a stale entry
  // keyed by the same code as `defaultLanguage` anyway, carrying it forward here would leave
  // it out of sync with whatever this function writes into `snippet` below, producing an
  // internally-inconsistent single write that post-write verification cannot detect (both
  // read via the same default-language-aware `readCurrentValue`).
  const localizations: Record<string, FreshVideoLocale> = {};
  for (const [locale, value] of Object.entries(fresh.localizations)) {
    if (sameLanguage(locale, fresh.snippet.defaultLanguage)) continue;
    localizations[locale] = { ...value };
  }

  // Delete-type changes are applied AFTER every other change below, not inline here --
  // this makes removal win regardless of processing order if a "delete" and a "modify"
  // for the same locale both land in one approved batch (a modify writing into
  // `localizations[change.language]` first must not "resurrect" a locale a delete in
  // the same set is meant to remove entirely). See docs/PROJECT_SPEC.md §16's
  // 2026-09-20 update: a queued deletion always takes priority over a queued edit of
  // the same target within the same approved set.
  const languagesToDelete = new Set<string>();

  for (const change of changes) {
    if (change.changeType === "delete") {
      // Defense-in-depth: src/lib/changesets/services.ts's proposeLocalizationDeletion
      // already refuses to create this change at propose time (it is the primary
      // guard). Reaching here means that guard was bypassed somehow -- the video's
      // defaultLanguage title/description live on `snippet`, never in `localizations`,
      // so silently proceeding would blank the video's real title/description instead
      // of removing a localization. Fail closed rather than merge a payload that could
      // destroy real data.
      if (sameLanguage(change.language, fresh.snippet.defaultLanguage)) {
        throw new Error(
          `Refusing to merge a "delete" change for language "${change.language}": it is this video's own defaultLanguage, so deleting it would blank the real snippet title/description instead of removing a localization.`
        );
      }
      languagesToDelete.add(localeKeyFor(localizations, change.language) ?? change.language);
      continue;
    }

    if (sameLanguage(change.language, fresh.snippet.defaultLanguage)) {
      snippet[change.field] = change.proposedValue;
      continue;
    }

    // An existing entry keeps its key's spelling (a row `pt-br` updates `pt-BR`, never adds a second key).
    const key = localeKeyFor(localizations, change.language) ?? change.language;
    const existingLocale = localizations[key] ?? { title: "", description: "" };
    localizations[key] = { ...existingLocale, [change.field]: change.proposedValue };
  }

  for (const language of languagesToDelete) {
    delete localizations[language];
  }

  return { snippet, localizations };
}
