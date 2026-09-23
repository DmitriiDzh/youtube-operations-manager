import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// Phase 7 -- Agent Operations Interface (see docs/AGENT_OPERATIONS_INTERFACE.md for the full
// design). Owner instruction, Telegram 2026-09-23 (verbatim 34-section spec): "This phase turns
// YouTube Operations Manager into the data, context, permissions and action control plane used
// by operational AI agents." Codex is the first client; the interface itself must stay
// agent-agnostic (no Codex-specific behavior baked into the contracts below).
//
// This module owns exactly: capability/version discovery (slice A) and the shared permission
// vocabulary every later slice (channel/video context, analytics wrapper, asset catalog, draft
// provenance, bulk localization integration) reuses. It never duplicates youtube-read-gateway,
// analytics, ai-localization, or changesets -- those remain the single owners of their own data;
// this module only re-exposes them through an agent-oriented, versioned surface.
// ---------------------------------------------------------------------------

/**
 * Four-tier permission model (owner spec §5). READ/DRAFT/APPROVE/EXECUTE are deliberately
 * distinct -- creating a draft never implies approval, and no code path anywhere in this module
 * (or any module it wraps) may collapse that distinction. Codex's actual GRANTED set today is
 * `GRANTED_PERMISSIONS` below (READ + DRAFT only) -- a hardcoded constant, not something any
 * request parameter can widen.
 */
export const PERMISSION_CLASSES = ["READ", "DRAFT", "APPROVE", "EXECUTE"] as const;
export type PermissionClass = (typeof PERMISSION_CLASSES)[number];

/**
 * The permission set actually granted to an operational agent today. READ + DRAFT only --
 * APPROVE/EXECUTE are never granted merely because an agent authored a proposal (owner spec §5:
 * "Do not grant APPROVE or EXECUTE merely because the agent created the proposal"; §31: "It must
 * NOT initially: approve its own proposals... directly mutate YouTube"). Changing this requires
 * its own explicit, separate, future owner decision -- never inferred from a clean review cycle,
 * a completed slice, or this module's own judgment (mirrors the `autonomous-dev-loop` skill's own
 * "never relaxed by this skill" boundary list).
 */
export const GRANTED_PERMISSIONS: readonly PermissionClass[] = ["READ", "DRAFT"] as const;

/**
 * Independently versioned from `package.json`'s product version -- the Agent API surface can
 * evolve (additively, per owner spec §4 "explicit versioning and backward-compatible evolution")
 * on a different cadence than the product itself. Bump the MINOR version when a new capability is
 * added; bump MAJOR only for a breaking change to an existing tool's contract (none is anticipated
 * in Phase 7's own additive slices).
 */
export const AGENT_API_VERSION = "0.1.0";

/**
 * One entry per capability an agent can actually call today -- never a speculative/planned entry
 * (owner spec §25: "Do not implement empty fake tools merely to fill this list"). `domain` groups
 * related capabilities for a caller scanning what's available without reading every id.
 */
export type AgentCapabilityDomain =
  | "system"
  | "channel_context"
  | "video_context"
  | "analytics"
  | "asset_catalog"
  | "localization_draft"
  | "content_proposal";

export type AgentCapabilityDescriptor = {
  id: string;
  domain: AgentCapabilityDomain;
  permission: PermissionClass;
  description: string;
};

/**
 * Data domains this interface can answer questions about right now. Grows exactly in step with
 * `AGENT_CAPABILITIES` below -- a domain is only listed once at least one real capability serves
 * it. `competitor_intelligence`/`experiment_history` are DELIBERATELY absent (owner spec §14/§20:
 * extension points only, Phase 9/10 not implemented) -- see `PLANNED_FUTURE_CAPABILITIES` for how
 * a caller distinguishes "not built yet" from "doesn't exist as a concept."
 */
export type AgentDataDomain =
  | "channel_metadata"
  | "video_metadata"
  | "channel_analytics"
  | "video_analytics";

/**
 * Capabilities named in the owner's own spec (§14) that this interface is designed to eventually
 * expose, once their underlying data domain exists (competitor/trend intelligence is Phase 9,
 * experiment history is Phase 10 -- neither implemented here). Returned by `get_capabilities` so
 * an agent can distinguish `CAPABILITY_NOT_AVAILABLE` ("this is a real, planned extension point,
 * not a typo or a hallucinated tool name") from a capability id that simply does not exist at
 * all. This is a plain, static, human-maintained list -- never inferred from `FUTURE_PHASES.md`
 * automatically, to avoid a stale doc silently changing agent-visible behavior.
 */
export const PLANNED_FUTURE_CAPABILITIES = [
  "query_market_intelligence",
  "query_competitors",
  "create_experiment_proposal",
] as const;
export type PlannedFutureCapability = (typeof PLANNED_FUTURE_CAPABILITIES)[number];

export type SystemCapabilities = {
  /** The product's own release version (`package.json`), for a human/agent comparing against
   * release notes -- not itself an authorization signal. */
  productVersion: string;
  /** This interface's own version (see `AGENT_API_VERSION`'s doc comment). */
  agentApiVersion: string;
  capabilities: AgentCapabilityDescriptor[];
  dataDomains: AgentDataDomain[];
  actionClasses: readonly PermissionClass[];
  /** What THIS caller/agent is actually granted today -- always a subset of `actionClasses`,
   * currently always equal to `GRANTED_PERMISSIONS`. Kept as its own field (not inferred from
   * `actionClasses`) so a future per-agent-identity permission model can populate it without
   * changing this shape. */
  grantedPermissions: readonly PermissionClass[];
  plannedFutureCapabilities: readonly PlannedFutureCapability[];
  schemaVersions: {
    /** `SCHEMA_CURRENT_VERSION` (`src/lib/db.ts`) -- the local SQLite schema version this
     * running instance is stamped at. An agent comparing this against a cached value can detect
     * "this instance was upgraded since I last looked," per owner spec §4's "relevant schema
     * versions." */
    app: number;
  };
};
