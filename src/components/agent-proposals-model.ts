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
