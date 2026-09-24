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
 * on a different cadence than the product itself. Bump the MINOR version once per slice/landing
 * that adds one or more capabilities (not once per individual capability item within that slice);
 * bump MAJOR only for a breaking change to an existing tool's contract (none is anticipated in
 * Phase 7's own additive slices).
 *
 * **Correction (slice C, 2026-09-24, found by independent advisor review):** slice B added two
 * capabilities (`channel_context.get_channel_context`/`video_context.get_video_context`) without
 * bumping this constant -- a real violation of this doc comment's own rule, left unnoticed through
 * four rounds of independent review of that slice (none of which happened to check this specific
 * invariant). Corrected here to `0.3.0`, covering both the missed slice-B bump and this slice's own
 * additions (four newly-registered pre-existing tools plus two new `query_*_analytics`
 * capabilities) as a single bump, consistent with the "once per slice" rule stated above.
 */
export const AGENT_API_VERSION = "0.3.0";

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

// ---------------------------------------------------------------------------
// Slice B -- read-only channel/video context (owner spec §7/§8). Wraps `changesets`' own
// channel/video store (the same local-sync mirror `ai-localization`/`changesets` already read)
// and `ai-localization`'s editorial-profile read -- introduces no new data, no new table, no new
// YouTube call. Analytics, comparable videos, experiment history, and creative assets are
// DELIBERATELY absent from these shapes (owner spec §8: "Allow the caller to request context
// sections instead of always returning everything") -- analytics is its own dedicated slice C
// wrapper; experiments/assets don't exist as subsystems yet (Phase 10 / slice D respectively).
// Never claim a section exists with empty/fabricated content -- omit the field entirely instead.
// ---------------------------------------------------------------------------

export type AgentEditorialProfileContext = {
  version: number;
  targetAudience: string | null;
  toneNotes: string | null;
  terminologyNotes: string | null;
  titleConstraints: string | null;
  descriptionConstraints: string | null;
  updatedAt: string;
};

export type ChannelContext = {
  channelId: string;
  title: string;
  /** ISO instant of the channel's last full sync (`channels.lastSyncedAt`), or `null` if it has
   * never been synced -- never fabricated as "now" or omitted silently. */
  lastSyncedAt: string | null;
  syncedVideoCount: number;
  /** `null` when the channel has never had one saved -- never a default/invented profile
   * (`AGENTS.md` §B: this repository never authors channel-specific editorial content). */
  editorialProfile: AgentEditorialProfileContext | null;
  /** The channel's own explicitly-tracked language list (`channels.target_languages_json`) --
   * NOT the union with languages that merely have real data (that richer view belongs to the
   * Web UI's own Languages tab, `src/lib/localization/`); this is the raw tracked-language
   * intent, kept simple for an agent-context payload. */
  trackedLanguages: string[];
};

export type AgentLocalizationEntry = {
  language: string;
  title: string;
  description: string;
};

export type VideoContextSection = "metadata" | "localizations";

export type VideoMetadataContext = {
  videoId: string;
  channelId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  /** ISO instant of this video's own last sync -- see `ChannelContext.lastSyncedAt`'s own note on
   * why this is never fabricated. */
  lastSyncedAt: string;
};

export type VideoContext = {
  videoId: string;
  channelId: string;
  /** Which sections were actually included, echoing the caller's own (possibly narrowed)
   * request back -- lets a caller confirm it got what it asked for, not a silently-different
   * default set. */
  includedSections: VideoContextSection[];
  metadata?: VideoMetadataContext;
  localizations?: AgentLocalizationEntry[];
};

// ---------------------------------------------------------------------------
// Slice C -- analytics interface (owner spec §9): "Create agent-oriented analytics queries rather
// than exposing raw database access... Every result must include metric definitions, period,
// dimensional filters, sample/coverage information where meaningful, data freshness." Wraps
// `src/lib/analytics/`'s own already-existing `getChannelOverview`/`listMetrics` service functions
// unchanged (AGENTS.md §D) -- this module adds no new metric collection, no new table, no new
// YouTube call of its own. "The exact metrics must follow the ACTUAL data currently collected. Do
// not invent unavailable metrics" (owner spec §9) -- `METRIC_DEFINITIONS` below covers exactly the
// metric-name literals `src/lib/analytics/contracts.ts` already defines (`ANALYTICS_METRIC_NAMES`/
// `CHANNEL_OVERVIEW_METRIC_NAMES`), never a name invented here.
// ---------------------------------------------------------------------------

export type MetricDefinition = {
  name: string;
  description: string;
  unit: "count" | "minutes" | "seconds" | "ratio" | "rate_percent";
};

/**
 * What this response can and cannot tell the caller about how current the underlying data is
 * (owner spec §24: "Expose timestamps and freshness... Do not silently trigger expensive or
 * quota-heavy refreshes on every context request"). Deliberately does NOT compute a precise
 * per-date coverage report inline (that would mean re-running `getDataQualityReport`'s own work on
 * every analytics query) -- `note` points the caller at the existing `analytics_data_quality`
 * tool/capability for that level of detail instead of duplicating it here.
 */
export type AnalyticsFreshness = {
  source: "live_youtube_analytics_api" | "local_collected_data";
  /** ISO instant this response was generated -- when `source` is the live API, this IS the
   * effective freshness (the call just happened); when `source` is a local read, this is only
   * "when we looked," not "when the data was collected" (see `note`). */
  asOf: string;
  note: string;
};

export type ChannelAnalyticsContext = {
  channelId: string;
  period: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string };
  metricDefinitions: MetricDefinition[];
  freshness: AnalyticsFreshness;
  /** FACT: one row per day, as collected/reported -- never zero-filled to hide a real gap beyond
   * what `getChannelOverview` itself already zero-fills (see that function's own doc comment). */
  daily: Array<{ date: string; views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number }>;
  /** DERIVED METRIC: a sum over `daily`, not a directly-observed value. */
  currentTotals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number };
  /** DERIVED METRIC, over the immediately-preceding period of equal length (see
   * `getChannelOverview`'s own `computePreviousPeriod`). */
  previousTotals: { views: number; estimatedMinutesWatched: number; subscribersGained: number; subscribersLost: number };
};

export type VideoAnalyticsContext = {
  channelId: string;
  period: { startDate: string | null; endDate: string | null };
  filters: { videoId: string | null; metricNames: string[] | null };
  metricDefinitions: MetricDefinition[];
  freshness: AnalyticsFreshness;
  /** FACT: raw already-collected rows, exactly as `analyticsCore.listMetrics` returns them --
   * never aggregated/derived here (an agent that needs a sum/average computes it itself from
   * these rows, per owner spec §9: "Provide raw-enough structured data for independent agent
   * reasoning. Do not only return pre-written human summaries"). */
  rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>;
};
