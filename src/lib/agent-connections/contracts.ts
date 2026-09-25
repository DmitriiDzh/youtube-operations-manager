import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-091 (docs/roadmap/plans/AGENT_ZONES_PLAN.md) -- multi-agent responsibility zones.
//
// A registry of distinct agent connections (e.g. "claude"/"codex") and a per-capability
// zone-assignment table. Wired into 6 MCP tools/CLI commands via `assertAgentAllowedForCapability`
// (slice 2, see services.ts) -- registering a connection or assigning a zone has real effect on
// those 6 actions once at least one connection is enabled; see that function's own doc comment for
// the exact fail-closed policy.
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
 * `assignedConnectionId: null` means "unassigned" -- rejected for EVERY connection once one or
 * more are enabled (see `services.ts`'s `assertAgentAllowedForCapability`), with no exception for
 * exactly one enabled connection: assignment is always an explicit, deliberate act, never an
 * implicit "the only connection gets it" default (the owner's own exclusivity rule -- an
 * unassigned zone must never be silently granted to anyone). Zoned per
 * capability id (e.g. `"content_proposal.create_content_proposal"`), not per domain, so two DRAFT
 * actions in the same domain can be split between different connections if the owner ever wants
 * that. `assertAgentAllowedForCapability` itself treats a capability id as a fully opaque string
 * (no interpretation, no validation beyond shape) -- what each id actually corresponds to (an
 * `AGENT_CAPABILITIES` entry id, an MCP tool name, or both) is determined by this file's own
 * `CAPABILITY_*` constants and their call sites, kept deliberately decoupled from whichever tool
 * registries end up zoned (`AGENTS.md` §M).
 */
export type AgentCapabilityZone = {
  capabilityId: string;
  assignedConnectionId: string | null;
};

// ---------------------------------------------------------------------------
// Single source of truth for exactly which 6 capabilities are wired to
// `assertAgentAllowedForCapability` (slice 2, owner-approved scope, Telegram 2026-09-25:
// "Согласен"). Consumed by src/mcp/server.ts, src/cli/video-metadata.ts (both reference the named
// constants below instead of retyping string literals) and agent-connections-manager.tsx (renders
// ZONED_CAPABILITIES directly) -- one owner for this list, per AGENTS.md §D, instead of the same
// 6 ids hand-copied at every call site. This module's own enforcement logic remains agnostic to
// this list (assertAgentAllowedForCapability never reads it) -- it exists only for consumers that
// need to know what is currently zoned.
// ---------------------------------------------------------------------------

export const CAPABILITY_CHANNEL_SYNC = "channel_sync";
export const CAPABILITY_CHANGESET_CREATE_FROM_IMPORT = "changeset_create_from_import";
export const CAPABILITY_AI_LOCALIZATION_GENERATE = "ai_localization_generate";
export const CAPABILITY_AI_LOCALIZATION_CREATE_CHANGE_SET = "ai_localization_create_change_set";
export const CAPABILITY_CONTENT_PROPOSAL_CREATE = "content_proposal.create_content_proposal";
export const CAPABILITY_CONTENT_PROPOSAL_REGISTER_ARTIFACT = "content_proposal.register_external_artifact";

/**
 * Shared by both MCP (`startMcpServer`, reads `process.env.AGENT_CONNECTION_ID` once at startup)
 * and CLI (`runCliCommand`, falls back to this after checking `--agentConnectionId`) -- a single,
 * directly unit-testable implementation for both. An empty string is never a real connection id.
 */
export function resolveAgentConnectionIdFromEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const ZONED_CAPABILITIES: ReadonlyArray<{ capabilityId: string; label: string; domain: string }> = [
  { capabilityId: CAPABILITY_CHANNEL_SYNC, label: "Sync channel from YouTube", domain: "Channel sync" },
  { capabilityId: CAPABILITY_CHANGESET_CREATE_FROM_IMPORT, label: "Create Change Set from XLSX import", domain: "Localization" },
  { capabilityId: CAPABILITY_AI_LOCALIZATION_GENERATE, label: "Generate AI localization proposals", domain: "Localization" },
  { capabilityId: CAPABILITY_AI_LOCALIZATION_CREATE_CHANGE_SET, label: "Create Change Set from AI generation", domain: "Localization" },
  { capabilityId: CAPABILITY_CONTENT_PROPOSAL_CREATE, label: "Create Content Proposal", domain: "Content proposals" },
  { capabilityId: CAPABILITY_CONTENT_PROPOSAL_REGISTER_ARTIFACT, label: "Register external artifact", domain: "Content proposals" },
];
