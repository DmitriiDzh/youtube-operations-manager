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

/**
 * BL-232 (language move, PRD-REQ-0043): a change set that deletes a language of a video AND changes another language of that same
 * video (`changesets.proposeLanguageMove`: delete `zh-Hans` + add `zh-CN` with the same text) is one unit. The delete sent without
 * the add would lose the text; the add sent without the delete would copy text that may be stale by the time the delete follows
 * (review of BL-232). Returns the changes in `selected` with a same-set, same-video change of the other kind (delete vs. not) that
 * is neither in `selected` nor already on YouTube. A set of deletes only, or of non-deletes only, has no such partners.
 */
export function unpairedMoveHalves<C extends { id: string; videoId: string; changeType?: string }>(
  selected: readonly C[],
  setChangesOf: (change: C) => ReadonlyArray<{ id: string; videoId: string; changeType?: string }>,
  alreadyOnYoutube: (partner: { id: string }) => boolean
): C[] {
  const selectedIds = new Set(selected.map((change) => change.id));
  return selected.filter((change) => {
    const isDelete = change.changeType === "delete";
    return setChangesOf(change).some(
      (partner) =>
        partner.videoId === change.videoId &&
        (partner.changeType === "delete") !== isDelete &&
        !selectedIds.has(partner.id) &&
        !alreadyOnYoutube(partner)
    );
  });
}
