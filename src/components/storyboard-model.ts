import type { StoryboardComment, StoryboardCommentTarget, StoryboardKeyframe, StoryboardSegment, StoryboardVersion } from "@/lib/sync-gateway";
import type { StoryboardDetail, StoryboardState, StoryboardSummary, VersionDiff } from "@/lib/storyboards";
import type { UiTextKey } from "@/lib/ui-text";

// BL-184 stage 1 (FO-REQ-0024 §4 B2): the «Раскадровка» screen's rules, pure, so they are tested on their own -- the filmstrip's
// order, which comments belong to what, the pins on a keyframe, what changed against the version before, and when the owner may
// decide.

export type DetailComment = StoryboardDetail["comments"][number];

export const STATE_LABEL: Record<StoryboardState, UiTextKey> = {
  draft: "storyboards.state.draft",
  in_review: "storyboards.state.inReview",
  changes_requested: "storyboards.state.changesRequested",
  approved: "storyboards.state.approved",
};

export const STATE_TONE: Record<StoryboardState, string> = {
  draft: "bg-zinc-700/60 text-zinc-200",
  in_review: "bg-amber-500/20 text-amber-200",
  changes_requested: "bg-rose-500/20 text-rose-200",
  approved: "bg-emerald-500/20 text-emerald-200",
};

/** The list: what waits for the owner first, then what waits for the Operator, drafts, approved; newest activity first within. */
const STATE_ORDER: Record<StoryboardState, number> = { in_review: 0, changes_requested: 1, draft: 2, approved: 3 };
export function sortForOwner(list: readonly StoryboardSummary[]): StoryboardSummary[] {
  return [...list].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export type FilmstripItem =
  | { kind: "keyframe"; keyframe: StoryboardKeyframe; closing: boolean }
  | { kind: "segment"; segment: StoryboardSegment };

/** K0 -> [S1] -> K1 -> ... -> Kn, and with loop -> [the closing segment] -> K0 again (shown as the loop's return, not a new frame). */
export function filmstripOf(version: StoryboardVersion): FilmstripItem[] {
  const items: FilmstripItem[] = [];
  const segmentFrom = new Map(version.segments.map((s) => [`${s.fromKeyframeId}>${s.toKeyframeId}`, s]));
  version.keyframes.forEach((keyframe, i) => {
    items.push({ kind: "keyframe", keyframe, closing: false });
    const next = version.keyframes[i + 1] ?? (version.loop ? version.keyframes[0] : null);
    const segment = next ? segmentFrom.get(`${keyframe.id}>${next.id}`) : undefined;
    if (segment) items.push({ kind: "segment", segment });
  });
  if (version.loop && version.keyframes.length > 0) items.push({ kind: "keyframe", keyframe: version.keyframes[0], closing: true });
  return items;
}

/** One key per comment target: the storyboard, a keyframe, a segment or one prop cell. */
export function targetKey(target: StoryboardCommentTarget): string {
  switch (target.kind) {
    case "storyboard":
      return "storyboard";
    case "keyframe":
      return `keyframe:${target.keyframeId}`;
    case "segment":
      return `segment:${target.segmentId}`;
    case "prop":
      return `prop:${target.propId}:${target.keyframeId}`;
  }
}

/** The open comments per target, made on the version shown (the badges on the filmstrip and in the prop table). */
export function openCounts(comments: readonly DetailComment[], versionNumber: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) {
    if (c.state !== "open" || c.versionNumber !== versionNumber) continue;
    const key = targetKey(c.target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The comments to list for a selection: every comment on the target (any version, so a v1 remark stays visible on v2), newest
 * last; `null` = all of them. Open ones first when `openFirst`.
 */
export function commentsFor(comments: readonly DetailComment[], key: string | null, openFirst = true): DetailComment[] {
  const list = comments.filter((c) => key === null || targetKey(c.target) === key);
  return openFirst ? [...list].sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open")) : list;
}

export type KeyframePin = { commentId: string; number: number; region: { x: number; y: number; r: number }; state: StoryboardComment["state"] };

/** The pins on a keyframe of the version shown, numbered in the order they were made (a region belongs to that version's image). */
export function pinsOn(comments: readonly DetailComment[], keyframeId: string, versionNumber: number): KeyframePin[] {
  return comments
    .filter((c) => c.versionNumber === versionNumber && c.target.kind === "keyframe" && c.target.keyframeId === keyframeId && c.target.region)
    .map((c, i) => ({ commentId: c.id, number: i + 1, region: (c.target as { region: KeyframePin["region"] }).region, state: c.state }));
}

/** What changed against the version before, as sets the screen marks (a dot on a keyframe, a segment card, a prop cell). */
export function changedMarks(diff: VersionDiff | null): { keyframes: Set<string>; segments: Set<string>; cells: Set<string> } {
  return {
    keyframes: new Set([...(diff?.keyframesReplaced ?? []), ...(diff?.keyframesAdded ?? [])]),
    segments: new Set([...(diff?.segmentsChanged ?? []), ...(diff?.segmentsAdded ?? [])]),
    cells: new Set((diff?.propCellsChanged ?? []).map((c) => `${c.propId}|${c.keyframeId}`)),
  };
}

/** Whether the diff has anything to say (a version identical in content is never stored, but its notes may be all that changed). */
export function diffIsEmpty(diff: VersionDiff): boolean {
  return (
    diff.keyframesReplaced.length + diff.keyframesAdded.length + diff.keyframesRemoved.length + diff.segmentsChanged.length + diff.segmentsAdded.length + diff.segmentsRemoved.length + diff.propCellsChanged.length === 0 &&
    !diff.notesChanged
  );
}

/**
 * Whether «Запросить изменения» / «Одобрить эту версию» are offered for the version shown: only the latest, only once the Operator
 * has submitted it (ADR 0038 §2). The module refuses the rest anyway; this keeps the buttons honest.
 */
export function decisionsOffered(detail: Pick<StoryboardDetail, "latestVersion" | "submissions">, versionShown: number): boolean {
  return versionShown === detail.latestVersion && detail.submissions.some((s) => s.versionNumber === versionShown);
}

/** The image route of a keyframe of a version (this computer's copy). */
export function keyframeSrc(channelId: string, storyboardId: string, versionNumber: number, keyframeId: string): string {
  return `/api/channels/${encodeURIComponent(channelId)}/storyboards/${encodeURIComponent(storyboardId)}/keyframes/${versionNumber}/${encodeURIComponent(keyframeId)}`;
}
