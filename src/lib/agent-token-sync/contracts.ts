/**
 * BL-160 (owner, Telegram 2026-10-09, msg 2200; plan docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §2, ADR 0033): every agent token --
 * a channel's, the Factory Operator's, the Producer's -- is accepted on every device without an import, and a revocation reaches
 * every device. Each device publishes the tokens it knows (hashes only) through the `agent-tokens` sync family; this module owns
 * the rules that turn those reports into this device's token rows. It is shared by the three token modules and owned by none of
 * them (AGENTS.md §M); verification itself stays in each token module and reads only this device's tables.
 */

export type AgentTokenRole = "channel" | "factory" | "producer";

/** A token as this module sees it: never the token, only its SHA-256 and what it is for. */
export type AgentTokenRecord = {
  hash: string;
  role: AgentTokenRole;
  /** A channel token's channel; null for a role token. */
  channelId: string | null;
  /** The Google account a channel token was issued under (`users.id`, Google's `sub`); null for a role token. */
  userId: string | null;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

/** What this device must change so its tables match the shared decision. */
export type AgentTokenSyncPlan = {
  revoke: Array<{ role: AgentTokenRole; hash: string; revokedAt: Date }>;
  insert: AgentTokenRecord[];
  /** Peer records left out, with the reason (logged; never applied). */
  ignored: Array<{ hash: string; reason: "conflicts_with_local" | "peers_disagree" }>;
};
