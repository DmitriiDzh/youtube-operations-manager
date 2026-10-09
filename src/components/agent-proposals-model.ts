import type { UiTextKey } from "@/lib/ui-text";

/** One proposal as the owner's list route returns it (`OwnerAgentProposal`). */
export type OwnerProposalView = {
  proposalId: string;
  source: "producer" | "system";
  kind: string;
  channelId: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  text: string;
  status: "pending" | "applied" | "rejected" | "failed";
  createdAt: string;
  decidedAt: string | null;
  rejectComment: string | null;
  applyError: string | null;
  doneAt: string | null;
  channelTitle: string | null;
  targetLabel: string | null;
  /** The entry's current newest upload, read live from the watchlist (retained data only); never stored on the proposal. */
  targetLatestUploadPublishedAt: string | null;
};

/**
 * BL-163 (FO-REQ-0014 §C7): what approving a proposal changes, in plain words -- a text key, its values, and the subject it is
 * about (the competitor's name, or the hypothesis statement). `targetLabel` is set only while the entry is on the watchlist, which
 * is how an add tells "start following an entry" from "add a new one".
 */
export function describeProposalAction(p: OwnerProposalView): { key: UiTextKey; values: Record<string, string>; subject: string | null } {
  const channel = p.channelTitle ?? p.channelId ?? "";
  const entry = p.targetLabel ?? (typeof p.payload.handleOrUrl === "string" ? p.payload.handleOrUrl : null) ?? p.targetId;
  switch (p.kind) {
    case "watchlist.add":
      return { key: p.targetLabel ? "agentProposals.action.follow" : "agentProposals.action.add", values: { channel }, subject: entry };
    case "watchlist.unfollow":
      return { key: "agentProposals.action.unfollow", values: { channel }, subject: entry };
    case "watchlist.pause":
      return { key: "agentProposals.action.pause", values: {}, subject: entry };
    case "watchlist.resume":
      return { key: "agentProposals.action.resume", values: {}, subject: entry };
    case "watchlist.delete":
      return { key: "agentProposals.action.delete", values: {}, subject: entry };
    case "hypothesis.add":
      return { key: "agentProposals.action.hypothesis", values: { channel }, subject: typeof p.payload.statement === "string" ? p.payload.statement : null };
    default:
      return { key: "agentProposals.action.unknown", values: { kind: p.kind }, subject: entry };
  }
}

/**
 * A system deletion proposal is worded by the interface (the stored `text` is the English record of it), so it reads in the owner's
 * language: the months setting at detection, and the entry's newest upload while the watchlist still holds it (null once it aged
 * out of the 30-day window).
 */
export function systemInactiveFacts(p: OwnerProposalView): { latestUploadPublishedAt: string | null; inactiveAfterMonths: number } | null {
  if (p.source !== "system" || p.kind !== "watchlist.delete") return null;
  const { inactiveAfterMonths } = p.payload;
  return typeof inactiveAfterMonths === "number" ? { latestUploadPublishedAt: p.targetLatestUploadPublishedAt, inactiveAfterMonths } : null;
}

/** A stored apply error is "CODE: message" when it came from a domain error; the code lets the interface translate it. */
export function parseApplyError(applyError: string): { error: string | null; message: string } {
  const match = /^([A-Za-z_]+): ([\s\S]*)$/.exec(applyError);
  return match ? { error: match[1], message: match[2] } : { error: null, message: applyError };
}

/** Decided proposals, most recently decided first (an old proposal that just failed must not sit at the bottom). */
export function sortDecided(rows: OwnerProposalView[]): OwnerProposalView[] {
  return [...rows].sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""));
}
