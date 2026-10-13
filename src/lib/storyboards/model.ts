// BL-184 (ADR 0038 §2): what a storyboard is right now, worked out from what it holds -- never stored twice. Pure.
import type { StoryboardRecord, StoryboardVersion } from "@/lib/sync-gateway";

export type StoryboardState = "draft" | "in_review" | "changes_requested" | "approved";

export const latestVersionNumber = (record: Pick<StoryboardRecord, "versions">): number => Math.max(0, ...Object.keys(record.versions).map(Number));
export const latestVersion = (record: Pick<StoryboardRecord, "versions">): StoryboardVersion | null => record.versions[String(latestVersionNumber(record))] ?? null;

/**
 * The state of the latest version (FO-REQ-0024 B2/B3): draft until the Operator submits it; then the owner's newest decision on THAT
 * version (approved / changes requested), or in review without one. A decision on an older version never counts: a new version
 * puts the storyboard back in review (or draft, until submitted).
 */
export function storyboardState(record: Pick<StoryboardRecord, "versions" | "submissions" | "decisions">): StoryboardState {
  const latest = latestVersion(record);
  if (!latest) return "draft";
  // A submission or a decision counts only for the content it was made on (the version's hash): see `contentHash`.
  if (record.submissions[String(latest.number)]?.contentHash !== latest.contentHash) return "draft";
  const decisions = Object.values(record.decisions)
    .filter((d) => d.versionNumber === latest.number && d.contentHash === latest.contentHash)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  const last = decisions[decisions.length - 1];
  return last ? (last.kind === "approved" ? "approved" : "changes_requested") : "in_review";
}

/** The version a video may be made from: the latest, and only while it is approved (ADR 0038 §4). */
export function approvedVersion(record: StoryboardRecord): StoryboardVersion | null {
  return storyboardState(record) === "approved" ? latestVersion(record) : null;
}

export type VersionDiff = {
  keyframesReplaced: string[];
  keyframesAdded: string[];
  keyframesRemoved: string[];
  segmentsChanged: string[];
  segmentsAdded: string[];
  segmentsRemoved: string[];
  propCellsChanged: Array<{ propId: string; keyframeId: string }>;
  notesChanged: boolean;
  /** Independent review: every content change shows -- a caption or a parent edited on the same image, the order, the title, loop. */
  keyframesEdited: string[];
  orderChanged: boolean;
  titleChanged: boolean;
  loopChanged: boolean;
};

function sameSettings(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key]);
}

/** What changed from one version to the next (B3: "keyframes replaced, texts edited"), by ids. */
export function diffVersions(previous: StoryboardVersion, next: StoryboardVersion): VersionDiff {
  const prevK = new Map(previous.keyframes.map((k) => [k.id, k]));
  const nextK = new Map(next.keyframes.map((k) => [k.id, k]));
  const prevS = new Map(previous.segments.map((s) => [s.id, s]));
  const nextS = new Map(next.segments.map((s) => [s.id, s]));
  const prevP = new Map(previous.props.map((p) => [p.id, p]));
  const sameSegment = (a: StoryboardVersion["segments"][number], b: StoryboardVersion["segments"][number]) =>
    a.fromKeyframeId === b.fromKeyframeId &&
    a.toKeyframeId === b.toKeyframeId &&
    a.action === b.action &&
    a.durationSeconds === b.durationSeconds &&
    a.model === b.model &&
    a.estimateUsd === b.estimateUsd &&
    sameSettings(a.settings, b.settings);
  const propCellsChanged: VersionDiff["propCellsChanged"] = [];
  for (const prop of next.props) {
    for (const keyframe of next.keyframes) {
      const before = prevP.get(prop.id)?.cells[keyframe.id] ?? "";
      if ((prop.cells[keyframe.id] ?? "") !== before) propCellsChanged.push({ propId: prop.id, keyframeId: keyframe.id });
    }
  }
  return {
    keyframesReplaced: next.keyframes.filter((k) => prevK.has(k.id) && prevK.get(k.id)!.sha256 !== k.sha256).map((k) => k.id),
    keyframesAdded: next.keyframes.filter((k) => !prevK.has(k.id)).map((k) => k.id),
    keyframesRemoved: previous.keyframes.filter((k) => !nextK.has(k.id)).map((k) => k.id),
    segmentsChanged: next.segments.filter((s) => prevS.has(s.id) && !sameSegment(prevS.get(s.id)!, s)).map((s) => s.id),
    segmentsAdded: next.segments.filter((s) => !prevS.has(s.id)).map((s) => s.id),
    segmentsRemoved: previous.segments.filter((s) => !nextS.has(s.id)).map((s) => s.id),
    propCellsChanged,
    notesChanged: (previous.notes ?? "") !== (next.notes ?? ""),
    keyframesEdited: next.keyframes
      .filter((k) => {
        const before = prevK.get(k.id);
        return !!before && before.sha256 === k.sha256 && ((before.caption ?? null) !== (k.caption ?? null) || (before.parentKeyframeId ?? null) !== (k.parentKeyframeId ?? null));
      })
      .map((k) => k.id),
    orderChanged: (() => {
      const kept = (list: StoryboardVersion["keyframes"], other: Map<string, unknown>) => list.filter((k) => other.has(k.id)).map((k) => k.id).join("|");
      return kept(previous.keyframes, nextK) !== kept(next.keyframes, prevK);
    })(),
    titleChanged: previous.title !== next.title,
    loopChanged: previous.loop !== next.loop,
  };
}

/** For the prop table: a cell that differs from the same prop in the keyframe before it (the first keyframe never differs). */
export function changedPropCells(version: StoryboardVersion): Set<string> {
  const changed = new Set<string>();
  for (const prop of version.props) {
    for (let i = 1; i < version.keyframes.length; i += 1) {
      const here = prop.cells[version.keyframes[i].id] ?? "";
      const before = prop.cells[version.keyframes[i - 1].id] ?? "";
      if (here !== before) changed.add(`${prop.id}|${version.keyframes[i].id}`);
    }
  }
  return changed;
}
