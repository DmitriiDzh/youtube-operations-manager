import { sameLanguage } from "@/lib/shared-language-baseline";

/**
 * BL-198: the one owner of "do two changes of one video aim at the same place" -- used by the send service (merging change sets)
 * and by `createBatch` (its defence-in-depth guard), so the two can never disagree.
 */
export type TargetedChange = { videoId: string; language?: string; field?: string; changeType?: string };

/**
 * Two changes that would make one of them win silently inside one row: same video, language and field, neither a delete.
 * A delete next to a modify of its language is NOT this -- PROJECT_SPEC §16 (2026-09-20) lets both land in one approved batch, the
 * delete applied last (`buildSafeLocalizationsPayload`).
 */
export function sameTarget(a: TargetedChange, b: TargetedChange): boolean {
  if (a.videoId !== b.videoId || !a.language || !b.language || !sameLanguage(a.language, b.language)) return false;
  if (a.changeType === "delete" || b.changeType === "delete") return false;
  return a.field === b.field;
}

/**
 * Two changes from DIFFERENT change sets that need the owner's choice before they share a row: the same target, or a delete of a
 * language next to any change of that language (merging would let the delete erase the other set's translation unasked).
 */
export function mergeCollision(a: TargetedChange, b: TargetedChange): boolean {
  if (a.videoId !== b.videoId || !a.language || !b.language || !sameLanguage(a.language, b.language)) return false;
  if (a.changeType === "delete" || b.changeType === "delete") return !(a.changeType === "delete" && b.changeType === "delete");
  return a.field === b.field;
}

/** The language part of a key: case and surrounding spaces do not matter (`sameLanguage`'s rule). */
export function languageKey(language: string | undefined): string {
  return (language ?? "").trim().toLowerCase();
}
