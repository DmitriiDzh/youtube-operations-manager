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
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.1) -- the Factory
 * Operator role's own agent token. Unlike a channel token (`src/lib/agent-tokens`) it is bound to NO
 * channel and NO Google identity: it carries no credentials at all. It is presented as a Bearer
 * credential on the factory MCP endpoint only; the operator issues it in Settings. Only its SHA-256
 * hash is stored, device-local.
 */

/** Distinct from the channel-token prefix (`ytom_ch_`), so each endpoint rejects the other's tokens
 * by prefix before any hash lookup, and a leaked token is identifiable in a secret scanner. */
export const FACTORY_AGENT_TOKEN_PREFIX = "ytom_fo_";

/** What a verified token grants: the role itself (there is nothing else to bind to). */
export type FactoryTokenBinding = { tokenId: string };

/** Operator-facing metadata -- never the token or its hash. */
export type FactoryTokenSummary = { tokenId: string; label: string | null; createdAt: string };

export type IssuedFactoryToken = FactoryTokenSummary & {
  /** Plaintext, returned exactly once at issue time and never retrievable again. */
  token: string;
};
