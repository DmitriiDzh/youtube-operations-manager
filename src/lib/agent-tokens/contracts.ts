import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` slice 12.1) -- channel tokens. A token IS an
 * agent's identity and its channel binding at once (owner decision: one agent = one channel). The
 * operator issues it in Settings -> Channels; the agent presents it via `YTOM_AGENT_TOKEN` /
 * `--agentToken`. Only its SHA-256 hash is stored.
 */

/** Recognizable prefix so a leaked token is identifiable in a secret scanner / config review. */
export const AGENT_TOKEN_PREFIX = "ytom_ch_";

/** What a verified token grants: the bound channel and the Google identity recorded at issue. */
export type AgentTokenBinding = {
  tokenId: string;
  channelId: string;
  userId: string;
};

/** Operator-facing metadata -- never the token or its hash. */
export type AgentTokenSummary = {
  tokenId: string;
  channelId: string;
  label: string | null;
  createdAt: string;
};

export type IssuedAgentToken = AgentTokenSummary & {
  /** Plaintext, returned exactly once at issue time and never retrievable again. */
  token: string;
};
