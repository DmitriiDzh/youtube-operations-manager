import type { OwnerReviewState, PackageReviewDecision, PackageReviewsSnapshot } from "./contracts";

// BL-257 (ADR 0070 §1, §3, §4): pure rules. Which decision stands is derived from the decisions, never stored, so two computers'
// documents merge without a conflict and read the same answer.

const HEX64 = /^[a-f0-9]{64}$/;

/** A decision as the other computer's document carries it, or null when it is not the expected shape (never an approval). */
export function wellFormedDecision(value: unknown): PackageReviewDecision | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.manifestSha256 !== "string" || !HEX64.test(d.manifestSha256)) return null;
  if (d.kind !== "approved" && d.kind !== "returned") return null;
  if (d.by !== "owner" || typeof d.at !== "string" || !Number.isFinite(Date.parse(d.at))) return null;
  if (d.thumbnailSha256 !== null && (typeof d.thumbnailSha256 !== "string" || !HEX64.test(d.thumbnailSha256))) return null;
  if (d.kind === "returned" && (typeof d.comment !== "string" || d.comment.trim() === "")) return null;
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
  };
}

const byTimeThenId = (a: PackageReviewDecision, b: PackageReviewDecision) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);

/** The decision that stands for one manifest version: the LATEST owner decision (by time, then id) -- he may change his mind. */
export function latestOwnerDecision(manifestSha256: string, decisions: readonly unknown[]): PackageReviewDecision | null {
  const own = decisions.map(wellFormedDecision).filter((d): d is PackageReviewDecision => d !== null && d.manifestSha256 === manifestSha256);
  return own.sort(byTimeThenId).at(-1) ?? null;
}

/**
 * The gate's view of a channel (ADR 0070 §1): no document -- off; a document -- the owner's switch (never set: off); a document that
 * cannot be read (`"unreadable"`) -- on, with nothing approved (fail closed, AC-PR-07).
 */
export function ownerReviewStateOf(snapshot: PackageReviewsSnapshot | "unreadable"): OwnerReviewState {
  const approved: OwnerReviewState["approved"] = new Map();
  const returned: OwnerReviewState["returned"] = new Map();
  if (snapshot === "unreadable") return { required: true, approved, returned };
  if (!snapshot.exists) return { required: false, approved, returned };
  const all = Object.values(snapshot.decisions ?? {});
  const manifests = new Set(all.map(wellFormedDecision).filter((d): d is PackageReviewDecision => d !== null).map((d) => d.manifestSha256));
  for (const sha of manifests) {
    const latest = latestOwnerDecision(sha, all);
    if (!latest) continue;
    if (latest.kind === "approved") approved.set(sha, { thumbnailSha256: latest.thumbnailSha256, at: latest.at });
    else returned.set(sha, latest.comment ?? "");
  }
  return { required: snapshot.required?.value === true, approved, returned };
}

/**
 * The gate for one package that is not uploaded and has no other problem (ADR 0070 §2-§3): null -- it may be ready (approved for
 * this manifest AND the thumbnail file still the approved one); otherwise the problem to add. A channel without the gate: null.
 */
export function ownerReviewProblemOf(
  state: OwnerReviewState,
  manifestSha256: string | null,
  thumbnailSha256: string | null
): { code: "owner_review_pending" } | { code: "owner_review_returned"; params: { comment: string } } | null {
  if (!state.required) return null;
  if (manifestSha256) {
    const approval = state.approved.get(manifestSha256);
    if (approval && approval.thumbnailSha256 !== null && thumbnailSha256 !== null && approval.thumbnailSha256 === thumbnailSha256) return null;
    const comment = state.returned.get(manifestSha256);
    if (comment !== undefined) return { code: "owner_review_returned", params: { comment } };
  }
  return { code: "owner_review_pending" };
}

/**
 * AC-PR-11 (narrowed, ADR 0070 §5): the manifest versions the automatic upload may take although they have upload rows here -- the
 * owner approved them in package review, and every row of theirs was cancelled before reaching YouTube (no video id) and was made
 * BEFORE that approval. A row made after the approval (a re-take the owner or the Producer cancelled again) keeps it tried, so the
 * automatic upload never re-queues a cancelled package tick after tick.
 */
export function triedExceptionsOf(
  state: OwnerReviewState,
  rows: ReadonlyArray<{ manifestSha256: string; status: string; videoId: string | null; createdAtMs: number }>
): Set<string> {
  const byManifest = new Map<string, typeof rows[number][]>();
  for (const row of rows) byManifest.set(row.manifestSha256, [...(byManifest.get(row.manifestSha256) ?? []), row]);
  const out = new Set<string>();
  for (const [sha, own] of byManifest) {
    const approval = state.approved.get(sha);
    if (!approval) continue;
    const approvedMs = Date.parse(approval.at);
    if (own.every((row) => row.status === "cancelled" && row.videoId === null && row.createdAtMs < approvedMs)) out.add(sha);
  }
  return out;
}

/** The package scan's gate port (structural: `publishing`'s `OwnerReviewGate`) built from a channel's state -- the rule stays here. */
export function reviewGateOf(state: OwnerReviewState) {
  return {
    required: state.required,
    needsThumbnailHash: (manifestSha256: string) => state.approved.has(manifestSha256),
    problemOf: (manifestSha256: string | null, thumbnailSha256: string | null) => ownerReviewProblemOf(state, manifestSha256, thumbnailSha256),
  };
}
