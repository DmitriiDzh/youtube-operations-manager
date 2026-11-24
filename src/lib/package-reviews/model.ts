import type { OwnerReviewState, PackageReviewDecision, PackageReviewsSnapshot, ReviewKey } from "./contracts";
import { wellFormedIssueActions, wellFormedReplies, wellFormedTimedComments } from "./timed-comments";

// BL-257 (ADR 0070 §1, §3, §4), BL-265 (ADR 0072 §1, §2, §6): pure rules. Which decision stands is derived from the decisions, never
// stored, so two computers' documents merge without a conflict and read the same answer.

const HEX64 = /^[a-f0-9]{64}$/;

/** A decision as the other computer's document carries it, or null when it is not the expected shape (never an approval). */
export function wellFormedDecision(value: unknown): PackageReviewDecision | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.manifestSha256 !== "string" || !HEX64.test(d.manifestSha256)) return null;
  if (d.kind !== "approved" && d.kind !== "returned" && d.kind !== "packaging_comment") return null;
  if (d.by !== "owner" || typeof d.at !== "string" || !Number.isFinite(Date.parse(d.at))) return null;
  if (d.thumbnailSha256 !== null && (typeof d.thumbnailSha256 !== "string" || !HEX64.test(d.thumbnailSha256))) return null;
  if ((d.kind === "returned" || d.kind === "packaging_comment") && (typeof d.comment !== "string" || d.comment.trim() === "")) return null;
  // BL-265: the media identity counts only whole -- a hash without a size (or a malformed one) is dropped, and the decision then
  // stands for its manifest only (stricter, never wider).
  // Owner TG 4817 (AC-TC-07): only an approval or a return carries timed comments; malformed ones are dropped, never the decision.
  const gate = d.kind === "approved" || d.kind === "returned";
  const timed = gate ? wellFormedTimedComments(d.timedComments) : [];
  // Owner TG 4846 (AC-IS-08): issue actions and the replies seen, the same way -- malformed entries dropped, never the decision.
  const actions = gate ? wellFormedIssueActions(d.issueActions) : [];
  const replies = gate ? wellFormedReplies(d.repliesSeen) : [];
  const media =
    typeof d.videoSha256 === "string" && HEX64.test(d.videoSha256) && typeof d.videoSizeBytes === "number" && Number.isSafeInteger(d.videoSizeBytes) && d.videoSizeBytes >= 0
      ? { videoSha256: d.videoSha256, videoSizeBytes: d.videoSizeBytes }
      : {};
  return {
    id: d.id,
    manifestSha256: d.manifestSha256,
    video: typeof d.video === "string" ? d.video : "",
    thumbnailSha256: d.thumbnailSha256 as string | null,
    kind: d.kind,
    comment: typeof d.comment === "string" ? d.comment : null,
    by: "owner",
    device: typeof d.device === "string" ? d.device : null,
    at: d.at,
    ...(typeof d.seq === "number" && Number.isSafeInteger(d.seq) && d.seq > 0 ? { seq: d.seq } : {}),
    // Owner TG 4584: a malformed `carriedFrom` is dropped, never a reason to refuse the decision (it only says where it came from).
    ...(typeof d.carriedFrom === "string" && HEX64.test(d.carriedFrom) ? { carriedFrom: d.carriedFrom } : {}),
    ...media,
    ...(timed.length > 0 ? { timedComments: timed } : {}),
    ...(actions.length > 0 ? { issueActions: actions } : {}),
    ...(replies.length > 0 ? { repliesSeen: replies } : {}),
  };
}

/** Review L1: the document's own order first (`seq`, immune to clock skew between computers), then the time, then the id. */
export const byTimeThenId = (a: PackageReviewDecision, b: PackageReviewDecision) => (a.seq ?? 0) - (b.seq ?? 0) || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);

/** BL-265: only an approval or a return decides the gate; a packaging comment never does (ADR 0072 §2). */
export const isGateDecision = (d: Pick<PackageReviewDecision, "kind">) => d.kind === "approved" || d.kind === "returned";

/** BL-265: a decision that names the mp4 it was made on (written by this build or later). */
export const isMediaKeyed = (d: Pick<PackageReviewDecision, "videoSha256" | "videoSizeBytes">) => typeof d.videoSha256 === "string" && typeof d.videoSizeBytes === "number";

/**
 * The gate decision written for one manifest version: the LATEST owner approval or return (by seq, time, then id) made on exactly
 * this manifest -- he may change his mind. Used where the manifest itself is meant (the recode's carry, the Producer's wake files);
 * the gate uses `standingDecision`.
 */
export function latestOwnerDecision(manifestSha256: string, decisions: readonly unknown[]): PackageReviewDecision | null {
  const own = decisions.map(wellFormedDecision).filter((d): d is PackageReviewDecision => d !== null && isGateDecision(d) && d.manifestSha256 === manifestSha256);
  return own.sort(byTimeThenId).at(-1) ?? null;
}

/**
 * BL-265 (ADR 0072 §1): whether a decision is about this package. The same manifest bytes always are (they state the same mp4, and a
 * BL-257 decision has nothing else to go by). Otherwise only a media-keyed decision, and only for the same mp4 (`sha256` AND
 * `sizeBytes`) under the same video code -- or the package's code is the BL-263 recode alias of the decision's (`aliases`: V -> S).
 */
export function decisionCovers(d: PackageReviewDecision, key: ReviewKey, aliases: ReadonlyMap<string, string>): boolean {
  if (key.manifestSha256 !== null && d.manifestSha256 === key.manifestSha256) return true;
  if (!isMediaKeyed(d) || key.videoSha256 === null || key.videoSizeBytes === null || key.video === null) return false;
  if (d.videoSha256 !== key.videoSha256 || d.videoSizeBytes !== key.videoSizeBytes) return false;
  return d.video === key.video || (d.video !== "" && aliases.get(d.video) === key.video);
}

/**
 * BL-265: the owner's decision that stands for a package -- the latest approval or return (one order across media-keyed and
 * manifest-keyed decisions, so an older approval never beats a later return) among those that cover it; null when none does.
 */
export function standingDecision(state: Pick<OwnerReviewState, "decisions" | "aliases">, key: ReviewKey): PackageReviewDecision | null {
  let latest: PackageReviewDecision | null = null;
  for (const d of state.decisions) {
    if (!isGateDecision(d) || !decisionCovers(d, key, state.aliases)) continue;
    if (latest === null || byTimeThenId(latest, d) < 0) latest = d;
  }
  return latest;
}

/**
 * The gate's view of a channel (ADR 0070 §1): no document -- off; a document -- the owner's switch (never set: off); a document that
 * cannot be read (`"unreadable"`) -- on, with nothing approved (fail closed, AC-PR-07). `aliases`: the BL-263 recode aliases (V -> S)
 * as the composition layer read them; none known -- exact codes only.
 */
export function ownerReviewStateOf(snapshot: PackageReviewsSnapshot | "unreadable", aliases: ReadonlyMap<string, string> = new Map()): OwnerReviewState {
  if (snapshot === "unreadable") return { required: true, decisions: [], aliases };
  if (!snapshot.exists) return { required: false, decisions: [], aliases };
  const decisions = Object.values(snapshot.decisions ?? {})
    .map(wellFormedDecision)
    .filter((d): d is PackageReviewDecision => d !== null && isGateDecision(d))
    .sort(byTimeThenId);
  return { required: snapshot.required?.value === true, decisions, aliases };
}

export type OwnerReviewProblem = { code: "owner_review_pending" } | { code: "owner_review_returned"; params: { comment: string } };

/**
 * The gate for one package that is not uploaded and has no other problem (ADR 0072 §1): null -- it may be ready (the owner's standing
 * decision on this mp4 is an approval); otherwise the problem to add. A channel without the gate: null. A package whose manifest
 * states no `sha256` can only be covered by a BL-257 decision on that very manifest (a new one cannot be made, AC-MG-03).
 */
export function ownerReviewProblemOf(state: OwnerReviewState, key: ReviewKey): OwnerReviewProblem | null {
  if (!state.required) return null;
  const standing = standingDecision(state, key);
  if (standing?.kind === "approved") return null;
  if (standing?.kind === "returned") return { code: "owner_review_returned", params: { comment: standing.comment ?? "" } };
  return { code: "owner_review_pending" };
}

/** One upload row of the channel on this computer, as the tried rule needs it (publishing supplies it, ADR 0072 §6). */
export type TriedRuleRow = {
  manifestSha256: string;
  video: string;
  /** The mp4's SHA-256 the row froze (BL-265: every new row whose manifest states one), else null (a row made before). */
  videoSha256: string | null;
  sizeBytes: number;
  status: string;
  videoId: string | null;
  createdAtMs: number;
};

export type MediaKey = { video: string; videoSha256: string; sizeBytes: number };

/**
 * BL-265 (ADR 0072 §6; amends ADR 0070 §5 and BL-264): what the automatic upload and the Producer's add may not take again. A row
 * that froze `videoSha256` makes its MEDIA tried (video, sha256, size), an older row its manifest hash; a package is tried when
 * either key is. The narrow exception (AC-PR-11), per key and only while the gate is on: the owner's standing decision for that key is
 * an approval, and every row of the key was cancelled before reaching YouTube (no video id) and made before that approval. A BL-257
 * approval of one of the rows' manifests counts for the key too, so the cancelled WWE rows stay excused.
 */
export function triedKeysOf(state: OwnerReviewState, rows: readonly TriedRuleRow[]): { manifests: Set<string>; media: MediaKey[] } {
  const byManifest = new Map<string, TriedRuleRow[]>();
  const byMedia = new Map<string, { key: MediaKey; rows: TriedRuleRow[] }>();
  for (const row of rows) {
    if (row.videoSha256 === null) {
      byManifest.set(row.manifestSha256, [...(byManifest.get(row.manifestSha256) ?? []), row]);
    } else {
      const id = `${row.video}\n${row.videoSha256}\n${row.sizeBytes}`;
      const entry = byMedia.get(id) ?? { key: { video: row.video, videoSha256: row.videoSha256, sizeBytes: row.sizeBytes }, rows: [] };
      entry.rows.push(row);
      byMedia.set(id, entry);
    }
  }
  const excused = (own: readonly TriedRuleRow[], approval: PackageReviewDecision | null) => {
    // Review L3: only while the channel reviews its packages (an approval left from before the gate was switched off excuses nothing).
    if (!state.required || approval?.kind !== "approved") return false;
    const approvedMs = Date.parse(approval.at);
    return own.every((row) => row.status === "cancelled" && row.videoId === null && row.createdAtMs < approvedMs);
  };
  const manifests = new Set<string>();
  for (const [sha, own] of byManifest) {
    const approval = standingDecision(state, { manifestSha256: sha, video: null, videoSha256: null, videoSizeBytes: null });
    if (!excused(own, approval)) manifests.add(sha);
  }
  const media: MediaKey[] = [];
  for (const { key, rows: own } of byMedia.values()) {
    // The latest decision among those covering the mp4 itself or any manifest its rows carried.
    let approval: PackageReviewDecision | null = null;
    for (const manifestSha256 of new Set(own.map((r) => r.manifestSha256))) {
      const candidate = standingDecision(state, { manifestSha256, video: key.video, videoSha256: key.videoSha256, videoSizeBytes: key.sizeBytes });
      if (candidate && (approval === null || byTimeThenId(approval, candidate) < 0)) approval = candidate;
    }
    if (!excused(own, approval)) media.push(key);
  }
  return { manifests, media };
}

/**
 * BL-257's exception by manifest hash only (AC-PR-11), for rows that froze no `videoSha256`: the manifest versions excused from the
 * tried rule. The same rule as `triedKeysOf`.
 */
export function triedExceptionsOf(state: OwnerReviewState, rows: ReadonlyArray<{ manifestSha256: string; status: string; videoId: string | null; createdAtMs: number }>): Set<string> {
  const { manifests } = triedKeysOf(
    state,
    rows.map((r) => ({ ...r, video: "", videoSha256: null, sizeBytes: 0 }))
  );
  return new Set([...new Set(rows.map((r) => r.manifestSha256))].filter((sha) => !manifests.has(sha)));
}

/** The package scan's gate port (structural: `publishing`'s `OwnerReviewGate`) built from a channel's state -- the rule stays here. */
export function reviewGateOf(state: OwnerReviewState) {
  return {
    required: state.required,
    problemOf: (key: ReviewKey) => ownerReviewProblemOf(state, key),
  };
}
