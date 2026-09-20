import type {
  Change,
  ChangeConflictStatus,
  ChangeSetStatus,
  StoredVideoRecord,
} from "./contracts";

// YouTube Data API v3 `videos.update` / localizations constraints (verified against
// current official documentation): snippet.title <= 100 chars, snippet.description
// <= 5000 chars. Centralized here so import validation and any future write-payload
// builder share one source of truth (docs/PROJECT_SPEC.md §7/§19).
export const YOUTUBE_TITLE_MAX_LENGTH = 100;
export const YOUTUBE_DESCRIPTION_MAX_LENGTH = 5000;

// Loose BCP-47-ish check (language[-subtag]*), deliberately permissive: the app never
// hard-codes a fixed language list (docs/PROJECT_SPEC.md §13), this only rejects
// obviously malformed values (empty, whitespace, stray punctuation).
const LANGUAGE_CODE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

export function isValidLanguageCode(value: string): boolean {
  return LANGUAGE_CODE_PATTERN.test(value.trim());
}

/**
 * The single canonical read of "what does the locally-synchronized copy of this video
 * currently say for (language, field)" -- YouTube's `localizations` map never contains an
 * entry keyed by the video's own `defaultLanguage` (that language's title/description is
 * `snippet.title`/`description`, i.e. `video.title`/`video.description` on this synced
 * record); only a non-default language is ever looked up in `existingLocalizations`.
 * Previously duplicated (and each copy missing this defaultLanguage special-case) across
 * `changesets/import.ts`, `changesets/services.ts`, and `ai-localization/services.ts` --
 * a change targeting a video's default language was diffed against an empty string
 * instead of its real current value in all three (AGENTS.md §D: one implementation).
 */
export function currentRemoteValueFor(
  video: StoredVideoRecord,
  language: string,
  field: "title" | "description"
): string {
  if (video.defaultLanguage && language === video.defaultLanguage) {
    return field === "title" ? video.title : video.description;
  }
  return video.existingLocalizations[language]?.[field] ?? "";
}

/**
 * Classifies a proposed field value relative to the *current* synchronized remote
 * value (never the export-time baseline -- that is only used for conflict detection).
 * Deliberately returns the narrower "add"|"modify"|"unchanged" (not the full `ChangeType`
 * union, which also has "delete") -- deletion is a distinct, explicit user action
 * (`proposeLocalizationDeletion`), never something a value diff classifies into.
 */
export function classifyFieldChange(
  currentRemoteValue: string,
  proposedValue: string
): "add" | "modify" | "unchanged" {
  if (currentRemoteValue === proposedValue) return "unchanged";
  if (currentRemoteValue.trim().length === 0) return "add";
  return "modify";
}

/**
 * A conflict means YouTube's remote value has changed since the workbook was
 * exported (baselineValue = the remote_title/remote_description column captured at
 * export time) relative to what is currently synchronized (currentRemoteValue).
 * This is NOT a fresh YouTube check -- see docs/ARCHITECTURE.md Phase 4 section for
 * the documented staleness limitation of the local sync mirror.
 */
export function computeConflictStatus(
  baselineValue: string,
  currentRemoteValue: string
): ChangeConflictStatus {
  return baselineValue === currentRemoteValue ? "none" : "conflict";
}

type ChangeStatusInput = Pick<Change, "validationStatus" | "conflictStatus" | "approvalStatus">;

/**
 * Derives a ChangeSet's aggregate lifecycle status from its persisted changes.
 * Deterministic and pure: same input always yields the same status, per
 * docs/PROJECT_SPEC.md §12 ("State transitions must be deterministic and testable").
 * Only "actionable" changes (valid, non-conflicting) drive approved/rejected/
 * partially_approved; invalid/conflicting changes always keep a set "in_review"
 * until resolved, so bulk approval can never silently clear them.
 */
export function computeChangeSetStatus(changeList: ChangeStatusInput[]): ChangeSetStatus {
  if (changeList.length === 0) return "in_review";

  const actionable = changeList.filter(
    (c) => c.validationStatus === "valid" && c.conflictStatus === "none"
  );

  const blocked = changeList.some(
    (c) => c.validationStatus === "invalid" || c.conflictStatus === "conflict"
  );

  if (actionable.length === 0) {
    return "in_review";
  }

  const approvedCount = actionable.filter((c) => c.approvalStatus === "approved").length;
  const rejectedCount = actionable.filter((c) => c.approvalStatus === "rejected").length;
  const pendingCount = actionable.length - approvedCount - rejectedCount;

  if (blocked) return "in_review";

  if (pendingCount > 0) return "in_review";
  if (approvedCount > 0 && rejectedCount > 0) return "partially_approved";
  if (approvedCount > 0) return "approved";
  return "rejected";
}

/**
 * Recomputes a change's conflict status against the live synchronized remote value,
 * and -- critically -- invalidates a previously-approved change if it has newly
 * become conflicted (remote metadata changed after approval). This is the concrete
 * mechanism behind docs/PROJECT_SPEC.md §16's "an old approval must not authorize a
 * different payload": if the remote state an approval was based on has since moved,
 * the approval no longer applies and must be redone.
 */
export function revalidateChangeAgainstCurrentRemote(
  change: Change,
  currentRemoteValue: string | null
): Change {
  // `null` = the video (or its language entry) is no longer present in synchronized
  // data at all (e.g. video removed from channel-sync results). Treat conservatively
  // as a conflict rather than silently clearing it.
  const conflictStatus: ChangeConflictStatus =
    currentRemoteValue === null
      ? "conflict"
      : computeConflictStatus(change.baselineValue, currentRemoteValue);

  if (conflictStatus === change.conflictStatus) {
    return change;
  }

  const becameConflicted = conflictStatus === "conflict" && change.conflictStatus === "none";
  const shouldInvalidateApproval = becameConflicted && change.approvalStatus === "approved";

  return {
    ...change,
    conflictStatus,
    approvalStatus: shouldInvalidateApproval ? "pending" : change.approvalStatus,
    approvedValue: shouldInvalidateApproval ? null : change.approvedValue,
  };
}
