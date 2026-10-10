import { DomainError, isDomainError, parseWithSchema, formatZodError, type DomainErrorCode } from "@/lib/shared-domain";

export type { DomainErrorCode };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * BL-163 (FO-REQ-0014 §C, `docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md` §2.C): changes the Producer (or the system)
 * proposes to the watchlist and the hypotheses list. A proposal changes nothing; the owner approves it in the Web UI, and only then
 * the change is made, through the same services the UI uses ("AI may propose. Human approves. System applies.", spec §26).
 *
 * Its own module (AGENTS.md §M): it depends on market-intelligence, market-assignments and decision-engine to apply a change, and
 * none of them depends on it.
 */
export const AGENT_PROPOSAL_KINDS = [
  "watchlist.add",
  "watchlist.unfollow",
  "watchlist.pause",
  "watchlist.resume",
  "watchlist.delete",
  "hypothesis.add",
  // BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md): a video of the channel into an arm of one of its experiments.
  "experiment.link_video",
] as const;
export type AgentProposalKind = (typeof AGENT_PROPOSAL_KINDS)[number];

export const AGENT_PROPOSAL_STATUSES = ["pending", "applied", "rejected", "failed"] as const;
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number];

export type AgentProposalSource = "producer" | "system";

/** A decided proposal leaves the store this long after the decision, or at once when its proposer marks it done (AC-PR-06). */
export const AGENT_PROPOSAL_KEEP_DAYS = 90;

export type AgentProposal = {
  proposalId: string;
  source: AgentProposalSource;
  kind: string;
  /** Our channel the proposal is for; null for a system proposal about the global watchlist. */
  channelId: string | null;
  /** The watchlist entry (a competitor's channel id) or the experiment it is about; null for a hypothesis. */
  targetId: string | null;
  payload: Record<string, unknown>;
  text: string;
  status: AgentProposalStatus;
  createdAt: string;
  decidedAt: string | null;
  rejectComment: string | null;
  applyError: string | null;
  doneAt: string | null;
};

/**
 * The owner's view adds names for the ids, so a card can say in plain words what will change, and the entry's current newest-upload
 * date (read live from the watchlist, which keeps it at most 30 days -- never stored on the proposal).
 */
export type OwnerAgentProposal = AgentProposal & {
  channelTitle: string | null;
  targetLabel: string | null;
  targetLatestUploadPublishedAt: string | null;
  decidedBy: string | null;
};
