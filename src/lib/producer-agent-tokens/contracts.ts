export { DomainError, isDomainError } from "@/lib/shared-domain";
export type { RoleTokenBinding as ProducerTokenBinding, RoleTokenSummary as ProducerTokenSummary, IssuedRoleToken as IssuedProducerToken } from "@/lib/role-agent-tokens";

/**
 * BL-161 (FO-REQ-0012, `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md` §3) -- the read-only Producer role's own agent token. Like the
 * Factory Operator's token it is bound to NO channel and NO Google identity; it is presented as a Bearer credential on the
 * producer MCP endpoint only (`/api/mcp/producer`), which names a channel per call. Only its SHA-256 hash is stored.
 */

/** Distinct from `ytom_ch_` and `ytom_fo_`, so each endpoint rejects the others' tokens by prefix before any hash lookup. */
export const PRODUCER_AGENT_TOKEN_PREFIX = "ytom_pr_";
