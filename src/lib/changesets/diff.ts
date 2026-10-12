import { baselineValueStillHolds, currentValueIn, readAgainstBaseline, type VideoLanguageView } from "@/lib/shared-language-baseline";
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
 * currently say for (language, field)": the video's default language is `snippet.title`/
 * `description` (`video.title`/`video.description` here); any other language is its
 * `existingLocalizations` entry. YouTube also lists the default language in `localizations`,
 * equal to the snippet (the "mirror"; corrected 2026-10-12, BL-178 -- an earlier comment said such
 * an entry never exists). Previously duplicated across `changesets/import.ts`,
 * `changesets/services.ts` and `ai-localization/services.ts` (AGENTS.md §D: one implementation).
 *
 * BL-178 (PROJECT_SPEC §14, owner exception 2026-10-12): with a channel baseline, a video whose own
 * language differs from it is read as the baseline's original -- its old-language mirror is no
 * translation, so a row in that language is an `add` against nothing, never an edit of the original
 * (`@/lib/shared-language-baseline`, the same rule the Batch write uses).
 */
export function currentRemoteValueFor(
  video: StoredVideoRecord,
  language: string,
  field: "title" | "description",
  channelBaseline: string | null = null
): string {
  return readWithChannelBaseline(video, channelBaseline).current(language, field);
}

function toLanguageView(video: StoredVideoRecord): VideoLanguageView {
  return { defaultLanguage: video.defaultLanguage, title: video.title, description: video.description, localizations: video.existingLocalizations };
}

/**
 * A synced video read against its channel's language baseline (BL-178): `current` is the value a row compares with, `holds`
 * whether a row's baseline still matches (both row shapes for a re-labelled video: made against the mirror or against nothing),
 * `alignedFrom` the old language when the video is read aligned.
 */
export function readWithChannelBaseline(video: StoredVideoRecord, channelBaseline: string | null) {
  const raw = toLanguageView(video);
  const reading = readAgainstBaseline(raw, channelBaseline);
  const view = reading.kind === "aligned" ? reading.view : raw;
  return {
    current: (language: string, field: "title" | "description") => currentValueIn(view, language, field),
    holds: (change: { language: string; field: "title" | "description"; baselineValue: string }) => baselineValueStillHolds(raw, reading, change),
    alignedFrom: reading.kind === "aligned" ? reading.from : null,
  };
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
 * until resolved, so bulk approval can never silently clear them. A change the user
 * REJECTED is resolved whatever its validity/conflict state (a rejection never writes
 * anything, owner request 2026-10-04: a set whose every change was rejected stayed
 * "in_review" because some were conflicted): when every change is rejected the set is
 * "rejected", and rejected changes never block the other changes' verdict.
 */
export function computeChangeSetStatus(changeList: ChangeStatusInput[]): ChangeSetStatus {
  if (changeList.length === 0) return "in_review";
  if (changeList.every((c) => c.approvalStatus === "rejected")) return "rejected";

  const actionable = changeList.filter(
    (c) => c.validationStatus === "valid" && c.conflictStatus === "none"
  );

  const blocked = changeList.some(
    (c) => c.approvalStatus !== "rejected" && (c.validationStatus === "invalid" || c.conflictStatus === "conflict")
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
  currentRemoteValue: string | null,
  /** BL-178: whether the change's baseline still matches, by the channel-baseline rule (`readWithChannelBaseline().holds`). */
  baselineHolds?: boolean
): Change {
  // `null` = the video (or its language entry) is no longer present in synchronized
  // data at all (e.g. video removed from channel-sync results). Treat conservatively
  // as a conflict rather than silently clearing it.
  // A value that already equals what the change proposes is not a conflict: it is the change having taken effect (owner report 2026-10-04: after a
  // set was approved and sent, the next load compared the unchanged baseline with the now-live proposed value, called it a conflict and reset every
  // approval to pending -- the set fell back to "In progress" and, with pending changes, could never be purged). An approval is only invalidated when
  // the remote value moved to something ELSE than both the baseline and the proposal.
  const alreadyInEffect = currentRemoteValue !== null && currentRemoteValue === change.proposedValue;
  const conflictStatus: ChangeConflictStatus =
    currentRemoteValue === null
      ? "conflict"
      : alreadyInEffect
        ? "none"
        : baselineHolds !== undefined
          ? baselineHolds
            ? "none"
            : "conflict"
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
