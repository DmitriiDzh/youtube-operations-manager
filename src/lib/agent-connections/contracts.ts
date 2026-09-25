import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- multi-agent responsibility zones.
//
// Slice 1 only: a registry of distinct agent connections (e.g. "claude"/"codex") and a
// per-capability zone-assignment table. Nothing in this module is wired into any MCP tool, CLI
// command, or Web UI yet -- registering a connection or assigning a zone here has zero effect on
// any request until slice 2's enforcement lands. This is deliberate: the data model does not
// depend on the still-open scope question (which mutating tools get zoned) recorded in the plan.
//
// Deliberately no secret/credential field on a connection -- this is a coordination guardrail
// between agent clients the project owner already configures both ends of (matching an
// `AGENT_CONNECTION_ID` env var in each client's own MCP launch config to a registered `id`
// here), never an authentication boundary. `AGENTS.md` §F's credential-handling rules govern real
// secrets (OAuth tokens, API keys); they do not apply to this identifier.
// ---------------------------------------------------------------------------

export type AgentConnection = {
  id: string;
  label: string;
  enabled: boolean;
  createdAt: string;
};

/**
 * `assignedConnectionId: null` means "open to any registered, enabled connection" -- there is
 * deliberately no separate "assigned to nobody, rejected for everyone" state; that is what never
 * creating (or deleting) the row already means. Zoned per capability id (e.g.
 * `"content_proposal.create_content_proposal"`), not per domain, so two DRAFT actions in the same
 * domain can be split between different connections if the owner ever wants that -- a future
 * enforcement layer (slice 2) owns what a "capability id" actually is (an `AGENT_CAPABILITIES`
 * entry id, an MCP tool name, or both); this module treats it as an opaque string and validates
 * nothing about it beyond shape, to stay decoupled from whichever tool registries end up zoned
 * (`AGENTS.md` §M).
 */
export type AgentCapabilityZone = {
  capabilityId: string;
  assignedConnectionId: string | null;
};
