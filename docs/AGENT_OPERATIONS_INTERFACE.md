# Agent Operations Interface (Phase 7)

Authoritative technical design and status document for the versioned interface external
operational AI agents (first client: Codex) use to consume this application's data and propose
actions. Assigned by the project owner via Telegram, 2026-09-23 (a 34-section spec covering
objective, architecture, permissions, context model, analytics, asset catalog, bulk localization,
content proposals, audit, safety, and acceptance requirements). This document is the running
record of what that spec asked for and what actually exists, kept in sync with `src/lib/agent-operations/`
as each slice lands -- per `AGENTS.md` §H, never allowed to drift into a second, competing
description of the same interface.

**Scope boundary (`AGENTS.md` §B):** this document describes the TECHNICAL interface only --
contracts, permissions, tool schemas, error codes, data shapes. It never contains channel-specific
editorial guidance, SEO strategy, or operating instructions for how an agent should use this
interface toward a particular channel's goals -- that is Codex's own, separately-maintained
knowledge, outside this repository, exactly as `AGENTS.md` §B already requires for every other
agent-facing surface in this project.

## 1. Product objective (owner spec §1)

Give an external operational agent enough real, versioned, provenance-tagged context to make
useful decisions about owned YouTube channels: bulk localization, performance analysis using real
analytics, creative-asset history, and structured content proposals -- returned to this
application as DRAFT objects that still flow through the existing, unmodified human-approval and
write-safety pipeline. This application is never asked to own every production tool (web research,
image/video/audio generation remain the agent's own external tools) -- only to be the source of
truth, permission boundary, audit system, and safe execution layer (owner spec §2).

## 2. Core architectural principle

- This application: source of truth for owned-channel data, analytics store, operational history,
  channel strategy/profile store, asset/context catalog, permission boundary, audit system, safe
  execution layer.
- The operational agent: reasoning/research/creative-decision layer, proposal generator,
  orchestrator of external production tools. It must not become a second, unsynchronized copy of
  this application's data -- every context call re-reads current state from this application.
- **Reuse, never duplicate** (`AGENTS.md` §D): this interface wraps `youtube-read-gateway`,
  `analytics`, `ai-localization`, and `changesets` as they already exist. It introduces exactly one
  genuinely new subsystem across the whole phase -- the creative-asset catalog (slice D) -- because
  nothing resembling it exists anywhere in this codebase today (confirmed by inspection before
  design: zero `asset`-named files anywhere under `src/lib/`).

## 3. Permission model (owner spec §5)

Four permission classes, always this exact set (`PERMISSION_CLASSES`,
`src/lib/agent-operations/contracts.ts`):

| Class | Meaning |
|---|---|
| `READ` | inspect data/context |
| `DRAFT` | create proposals, drafts, experiments, or Change Sets |
| `APPROVE` | a distinct operation -- never implicitly granted by creating a draft |
| `EXECUTE` | performs an external mutation (e.g. a real YouTube write) |

**Codex's actual granted set today is `GRANTED_PERMISSIONS = ["READ", "DRAFT"]`** -- a hardcoded
constant, not a request parameter, not inferred from anything a slice implements. No code path in
this module, or in any module it wraps (`ai-localization`, `changesets`), can set a Change's
`approvalStatus` to anything but `"pending"` at creation. Widening this set is its own, separate,
explicit future owner decision (mirrors the `autonomous-dev-loop` skill's own "never relaxed by
this skill" boundary list) -- never inferred from a clean review cycle or a completed slice.

`get_capabilities`'s own `actionClasses` field reports the full 4-class vocabulary (so an agent can
tell "this system has an APPROVE concept, I just don't hold it" from "no such concept exists");
`grantedPermissions` reports the actual, narrower grant.

## 4. Versioned capability/version discovery (owner spec §4) -- IMPLEMENTED (slice A)

`get_capabilities` / MCP `agent_get_capabilities` / `GET /api/agent-operations/capabilities` (same
underlying `AgentOperationsCore.getSystemCapabilities()`, three transports, one implementation --
`AGENTS.md` §D) returns:

```
{
  productVersion: string;            // package.json's own version, read at call time
  agentApiVersion: string;           // this interface's own version -- see below
  capabilities: AgentCapabilityDescriptor[]; // only what is ACTUALLY reachable right now
  dataDomains: AgentDataDomain[];     // grows exactly in step with capabilities
  actionClasses: PermissionClass[];   // the full 4-class vocabulary, always ["READ","DRAFT","APPROVE","EXECUTE"]
  grantedPermissions: PermissionClass[]; // what THIS caller actually holds today -- always ["READ","DRAFT"]
  plannedFutureCapabilities: string[]; // named extension points not implemented yet (owner spec §14/§20)
  schemaVersions: { app: number };    // SCHEMA_CURRENT_VERSION, src/lib/db.ts
}
```

`AGENT_API_VERSION` is versioned independently of the product's own `package.json` version -- see
that constant's own doc comment in `src/lib/agent-operations/contracts.ts` for the exact bump rule
and current value (the single source of truth for both, not restated here). `capabilities` is a
literal,
human-maintained list (`AGENT_CAPABILITIES`, `src/lib/agent-operations/services.ts`) -- never
derived automatically from the MCP tool registry, since not every capability necessarily has an
MCP tool. An agent should call this first, before assuming any other tool exists, and use
`CAPABILITY_NOT_AVAILABLE` (§7 below) to distinguish "not built yet, but a real, named extension
point" (`plannedFutureCapabilities`) from a hallucinated/typo'd capability id.

## 4a. Channel/video context (owner spec §7/§8) -- IMPLEMENTED (slice B)

`get_channel_context` / MCP `agent_get_channel_context` and `get_video_context` / MCP
`agent_get_video_context` (`src/lib/agent-operations/services.ts`, one implementation, two
transports -- no HTTP route yet, `AGENTS.md` §D). Both read only already-synced local data
(`createChangeSetChannelStoreAdapter`, the same channel/video store `changesets`/`ai-localization`
already read) -- neither ever makes a live YouTube call.

`getChannelContext({ channelId })` returns `{ channelId, title, lastSyncedAt (ISO string, or
`null` if the channel has never been synced -- never fabricated), syncedVideoCount,
editorialProfile (the channel's saved editorial profile via `ai-localization`'s own
`getEditorialProfile`, or `null` if none was ever saved), trackedLanguages }`. Throws
`DATA_NOT_SYNCED` if `channelId` has no local record at all.

`getVideoContext({ channelId, videoId, include? })` returns `{ videoId, channelId,
includedSections, metadata?, localizations? }`. `include` selects which of `"metadata"` /
`"localizations"` to compute and return -- omitted, both sections are returned; a section not in
`include` is left `undefined` on the response object entirely (owner spec §23's token-efficiency
requirement), not returned as an empty placeholder. Throws `DATA_NOT_SYNCED` if `videoId` does not
belong to `channelId`'s synced video list (protects against a cross-channel `videoId` or a typo).

**Deliberate deviation from the owner spec's literal `get_video_context(videoId, options)`
signature:** this implementation requires an explicit `channelId` parameter too, so the channel-
scoping check below has something to check against without an extra lookup. Both MCP tools
resolve the caller's local active-user identity and call `channelAccessCore.assertActiveChannel`
against the requested `channelId` **before** calling into `agent-operations` at all (`src/mcp/
server.ts`'s `agentGetChannelContext`/`agentGetVideoContext` handlers) -- the service functions
themselves do no such check, mirroring the `ai-localization`/`changesets` convention already used
elsewhere in this codebase (schemas carry no `credentialRef`; the MCP/CLI layer enforces scoping).
CLI parity: `agent channel-context --channelId <UC...>` / `agent video-context --channelId <UC...>
--videoId <VIDEO_ID> [--include metadata,localizations]` (`docs/interfaces.md`).

## 4b. Analytics interface (owner spec §9) -- IMPLEMENTED (slice C)

`query_channel_analytics` / MCP `agent_query_channel_analytics` and `query_video_analytics` / MCP
`agent_query_video_analytics` (`src/lib/agent-operations/services.ts`). Owner spec §9: "Create
agent-oriented analytics queries rather than exposing raw database access... Every result must
include metric definitions, period, dimensional filters... data freshness... Provide raw-enough
structured data for independent agent reasoning."

Both are thin wrappers -- `queryChannelAnalytics` forwards its input unchanged into
`analyticsCore.getChannelOverview` (the existing `analytics_overview` capability, a **live**
YouTube Analytics API read that counts against that API's quota), and `queryVideoAnalytics`
forwards into `analyticsCore.listMetrics` (the existing `analytics_list` capability, a local read
only). Neither introduces a new metric, a new table, or a new YouTube call of its own (`AGENTS.md`
§D). Both responses add: `metricDefinitions` (one entry per metric name actually involved --
sourced from a static, human-written glossary in `services.ts` covering exactly the metric-name
literals `src/lib/analytics/contracts.ts` already defines, never an invented name -- owner spec §9:
"Do not invent unavailable metrics"), `period`/`filters` (echoing the request back explicitly), and
`freshness` (`{source, asOf, note}` -- `queryChannelAnalytics` states the live API's own known 1-2
day reporting lag; `queryVideoAnalytics` states this is a local snapshot and points the caller at
the existing `analytics_data_quality` capability for exact per-date coverage, rather than
recomputing that same report inline on every call). Raw rows/daily series are `FACT`; `currentTotals`/
`previousTotals` (sums over `daily`) are the first real `DERIVED METRIC` values this interface
returns -- see §5 below.

**Credential-threading design:** unlike `getChannelContext`/`getVideoContext` above (slice B's own
no-`credentialRef`, MCP/CLI-does-`assertActiveChannel` convention), these two schemas require a
REAL, already-resolved `credentialRef`, mirroring `src/lib/analytics/schemas.ts`'s own convention
exactly -- because they forward straight into `analyticsCore`, which needs and validates exactly
that shape, and already does its own internal `assertActiveChannel` check keyed off it
(`docs/decisions/0004-active-channel-read-scoping.md`). The MCP/CLI layer resolves the caller's
effective `credentialRef` (relaxing it to optional only for that layer's own input parse, via
`.partial({credentialRef: true})`) before calling `agentOperationsCore`, exactly like the
pre-existing `analytics_list`/`analytics_overview` MCP handlers already do for `analyticsCore`
itself -- this module adds no second, redundant channel-scoping check of its own for these two
capabilities. CLI parity: `agent channel-analytics --channelId <UC...> --startDate <YYYY-MM-DD>
--endDate <YYYY-MM-DD>` / `agent video-analytics --channelId <UC...> [--videoId <ID>] [--startDate
...] [--endDate ...] [--metricNames views,likes,...]` (`docs/interfaces.md`).

**Capability-discovery honesty (owner spec §28):** `get_capabilities` also registers every
already-implemented, already-MCP/CLI-exposed tool outside this module itself (`channel_list`,
`channel_video_list`, `ai_localization_generate`, `ai_localization_create_change_set`, and the
remaining `analytics_*` tools) in `AGENT_CAPABILITIES` (`src/lib/agent-operations/services.ts` --
the authoritative list; not recounted here), pointing at their real, pre-existing MCP tool names in
each entry's own description, alongside the two new `query_*_analytics` wrappers.

**Known limitation (inherited, not introduced by this slice):** `queryVideoAnalytics` inherits
`analytics_list`'s own existing lack of pagination/row limit -- an unfiltered call on a large,
long-running channel can return thousands of rows plus every metric definition (`analytics_list`'s
own schema comment already documents this same size caveat). Owner spec §23 asks for pagination
support; adding it is a change to the wrapped `analyticsCore.listMetrics` contract itself, not to
this thin wrapper, and is out of this slice's own scope -- tracked as a known gap for a future,
separately-assigned task, not fixed here.

## 4c. Creative asset catalog (owner spec §15/§25) -- IMPLEMENTED (slice D)

`list_assets` / MCP `agent_list_assets` and `get_asset_context` / MCP `agent_get_asset_context`
(`src/lib/agent-operations/services.ts`, delegating to a brand-new module,
`src/lib/asset-catalog/` -- a genuinely new subsystem, nothing pre-existing to reuse). A portable
metadata catalog for pre-existing production files: thumbnails, source images, scripts, prompts,
project files, etc. Owner spec §15: "Do not necessarily copy large binary files into API/MCP
responses. Expose metadata plus controlled file/resource handles." `referenceValue` is stored and
returned as an opaque string only -- this module never reads/fetches it (no filesystem/network
access of its own, so no path-traversal or unrelated-file-exposure surface).

Same channel-scoping convention as slice B (`getChannelContext`/`getVideoContext`): no
`credentialRef`, the MCP/CLI layer calls `channelAccessCore.assertActiveChannel` before invoking
either function -- there is no external API call here to defer to, unlike slice C.
`getAssetContext` reports the same `ASSET_NOT_AVAILABLE` error for a nonexistent `assetId` and one
that belongs to a different channel, never distinguishable (protects against probing which asset
ids exist for a channel the caller has no access to).

**Populated only by the operator-facing `asset register` CLI command** -- owner spec §25's
capability list names only `list_assets`/`get_asset_context` (READ) for this domain, not a
register/create capability, so registration is deliberately not exposed as an MCP tool or an
agent-operations capability in this slice (registering a NEWLY produced artifact, as opposed to
cataloguing a pre-existing one, is a separate, later concept -- slice G's
`register_external_artifact`). CLI: `asset register --channelId <UC...> --assetType <type>
--referenceKind <url|local_path|external_artifact_id> --referenceValue <value> [--title]
[--description] [--linkedVideoId] [--provenanceJson <json>]`; `agent list-assets --channelId
<UC...> [--videoId] [--assetType]`; `agent get-asset-context --channelId <UC...> --assetId <id>`
(`docs/interfaces.md`).

**Known limitation:** a registered asset stays device-local -- it does not travel with a device
snapshot/handoff (`docs/TECHNICAL_DEBT.md` RISK-52), the same accepted limitation
`video_metrics_daily` already has.

## 4d. Agent draft/proposal provenance (owner spec §22) -- PARTIAL (slice E; identity/version closed in slice F -- see §4e; "operation type" still not recorded, RISK-57)

`get_generation_provenance` / MCP `agent_get_generation_provenance` (`src/lib/agent-operations/`)
delegates to the ALREADY-EXISTING `ai-localization` provenance mechanism (a table recording, per
Change Set, the editorial-profile version and effective context used to generate it) -- this slice
adds no new storage of its own. It closes a real, previously-documented gap: this read had a
working HTTP route (`GET .../ai-localization/change-sets/[changeSetId]/provenance`) but no
MCP/CLI tool, explicitly scoped out of BL-078 and tracked as such in `docs/TECHNICAL_DEBT.md`
RISK-04's own history.

Response additionally carries `changeSetId`/`channelId`/`createdAt` (the real moment the Change
Set's provenance was recorded, traced through `DraftProvenance`'s own write path to confirm it is
not a later device's own projection/sync timestamp) -- fields the stored row already had but the
pre-existing `GenerationProvenance` return type dropped; widened additively as
`StoredGenerationProvenance` (`src/lib/ai-localization/contracts.ts`), a distinct type from
`GenerationProvenance` (which `generateProposals` also returns mid-preview, before any Change Set
exists, so it cannot carry those fields). Same slice-B channel-scoping/credentialRef convention as
`get_asset_context`; same `null`-for-both-"missing"-and-"wrong-channel" pattern the underlying
HTTP route already established.

**Why still PARTIAL:** owner spec §22 asks for full traceability -- "agent/client identity,"
"product/API version," and "operation type" on every agent-created object. Slice E's read wrapper
alone closed the MCP/CLI tool-surface gap but stamped nothing new; `profileVersion`/
`effectiveContext` remained supplied BY THE CALLER when creating the Change Set (an agent echoes
back its own `generateProposals` response), never independently attested by this server. Slice F
(see §4e) added server-stamped `createdVia`/`agentApiVersion` -- covering "agent/client identity"
and "product/API version," `docs/TECHNICAL_DEBT.md` RISK-54 is now RESOLVED for exactly that
narrower scope. The third element, "operation type" (e.g. distinguishing that this record came
from a Change-Set-creation call specifically, as opposed to some future different kind of
agent-created object), is still not recorded anywhere -- tracked as `docs/TECHNICAL_DEBT.md`
RISK-57.

## 4e. Bulk localization integration -- evidence, rationale, and identity stamping (owner spec §12/§13/§22) -- PARTIAL (slice F)

Widens the EXISTING `ai_localization_create_change_set` (MCP tool, CLI command, and Web route --
no new tool, no new agent-operations capability id, no `AGENT_API_VERSION` bump -- see that
constant's own doc comment, `src/lib/agent-operations/contracts.ts`, for why a purely additive
contract widening doesn't warrant one) so an agent can attach evidence/rationale to a Change
Set's proposals, and so every provenance record now attests which transport actually created it.
`ai_localization_generate` (the earlier, proposal-preview step) is untouched by this slice --
evidence/rationale/identity are recorded only at Change Set creation time, not at
proposal-generation time.

- **Evidence (owner spec §13):** `createChangeSetFromGenerationInputSchema` gained an optional
  `evidence: EvidenceReference[]` array (`src/lib/ai-localization/schemas.ts`) -- each item carries
  `url`, `retrievedAt`, `description`, `claimSupported`, `sourceType`
  (`external_research | channel_analytics | comparable_video | other`), and an optional `excerpt`.
  Caller-supplied, never independently verified by this server (same "AI proposes" discipline
  `AGENTS.md` §B/§G already apply to the title/description text itself) -- distinguishes research
  an agent performed OUTSIDE this application from figures the application already owned, per the
  owner spec's own explicit ask.
- **Rationale (owner spec §12):** an optional free-text `rationale` string, same caller-supplied,
  never-verified discipline.
- **Granularity (known, accepted limitation):** both are recorded once per Change Set, not per
  individual proposal within it -- `docs/TECHNICAL_DEBT.md` RISK-55 tracks this as a deliberate,
  coarser choice (reusing the existing per-Change-Set provenance row rather than a new per-Change
  table).
- **Identity stamping (owner spec §22, closes RISK-54):** `createChangeSetFromGeneration` takes a
  new, REQUIRED second parameter, `callOrigin: { createdVia: CreatedVia; agentApiVersion?: string
  | null }`. `CreatedVia` (`"mcp" | "cli" | "web_ui"`) is defined once in
  `src/lib/sync-gateway/change-drafts/contracts.ts` and re-exported through the `@/lib/sync-gateway`
  barrel and `ai-localization/contracts.ts` (`AGENTS.md` §D) -- every module that needs this
  vocabulary imports it, none retypes it. SERVER-STAMPED at each of its three call sites -- never
  taken from the request body, so it is an attestation, not a caller's claim. The MCP handler
  (`src/mcp/server.ts`) stamps `{ createdVia: "mcp", agentApiVersion: AGENT_API_VERSION }`; the
  CLI dispatch (`src/cli/video-metadata.ts`) stamps `{ createdVia: "cli", agentApiVersion: null
  }`; the pre-existing Web route now explicitly stamps `{ createdVia: "web_ui", agentApiVersion:
  null }` too. Deliberately no default value for this parameter -- a default of `"web_ui"` would
  silently mislabel any future call site that forgot to pass it, exactly the fail-open gap this
  field exists to prevent; `tsc` now enforces that every call site (including tests) states its
  own identity explicitly.
- **A provenance row is always recorded, unconditionally**, even when the caller echoes no
  `provenance`/`evidence`/`rationale` at all -- so identity is attested for every Change Set
  regardless of what else it carries.
- **Storage:** `DraftProvenance` (`src/lib/sync-gateway/change-drafts/contracts.ts`) and
  `ai_localization_generation_provenance` (SCHEMA_MIGRATIONS v16) gained four additive, nullable
  columns: `evidence_json`, `rationale`, `created_via`, `agent_api_version`. `createProvenance`'s
  own input schema (`src/lib/sync-gateway/change-drafts/schemas.ts`) keeps them optional so every
  pre-existing call site that predates this field keeps working unchanged.
- **Projection self-healing:** `projectToSql` re-projects the whole CRDT document, including
  every provenance entry, on every save -- so `setStoredGenerationProvenanceRow`
  (`src/lib/db.ts`) uses `onConflictDoUpdate`, not `onConflictDoNothing`, so that a pre-existing
  SQL row for a given provenance id (e.g. one written by an older app version/schema that
  predates these columns) always gets corrected by a later re-projection instead of being
  permanently frozen. This also requires normalizing `DraftProvenance`'s four new fields to
  `?? null` before writing (`upsertProvenance`) -- a genuinely pre-existing CRDT entry lacks
  those keys entirely (Automerge has no schema migration), reading as `undefined`, not `null`.
  Verified against real SQLite in
  `src/lib/sync-gateway/change-drafts/adapters/sql-projection.test.ts`, including a dedicated
  backward-compatibility test for an entry missing the keys.
- **Why PARTIAL:** RISK-55's per-Change-Set (not per-proposal) evidence granularity remains a
  known, documented gap relative to owner spec §12/§13's literal per-draft phrasing. Owner spec
  §12/§13 also describe `confidence` (explicitly never to be treated as a factual probability),
  `warnings`, an `expected objective`, and a `source-context revision/ID` as part of a proposal's
  own record -- this slice's research fork deliberately deferred all four (no `ReviewedProposal`/
  `GenerationResult` field carries them yet) rather than widen the proposal shape itself in the
  same pass as provenance/evidence; RISK-55 now also tracks this as part of the same open gap.

## 5. Context model (owner spec §6) -- design settled, mostly not yet implemented

Every context object this interface returns is meant to carry: entity identity, source, data
timestamp/freshness, provenance, scope/time range, owned-vs-public, and confidence/quality where
meaningful -- and to keep six classes of information visibly distinct rather than mixed silently:

`FACT` (directly observed stored data) / `DERIVED METRIC` (calculated from stored data) /
`HYPOTHESIS` (AI/analyst interpretation) / `DECISION` (an approved human/product decision) /
`ACTION` (an operation actually performed) / `OUTCOME` (a measured result).

Slice A's own `SystemCapabilities` shape is deliberately simple (instance metadata, not
channel/video data) and does not yet need this classification. Slice B (channel/video context,
IMPLEMENTED -- see §7) exposes only `FACT`-class data (directly observed, already-synced local
rows: title, sync timestamps, existing localizations, tracked languages, the saved editorial
profile) -- every field is either a raw stored value or a `null` standing for "never observed",
never a computed/interpreted one, so slice B's response shape does not yet need an explicit
per-field classification tag to keep those classes visibly distinct from each other. Slice C
(analytics, IMPLEMENTED -- see §4b/§7) is the first slice that actually mixes `FACT` and `DERIVED
METRIC` data in one response: raw daily/row-level data is `FACT`, `currentTotals`/`previousTotals`
(sums over that data) are `DERIVED METRIC` -- distinguished by field naming and by each field's own
doc comment in `src/lib/agent-operations/contracts.ts` (`ChannelAnalyticsContext`), not yet by an
explicit per-field machine-readable tag in the response shape itself (that finer-grained tagging,
if ever needed, remains a future refinement -- naming/doc-comment separation was judged sufficient
for this slice's actual two response shapes). Slice E (draft/proposal provenance -- see §4d) is
the first to actually touch `HYPOTHESIS`: `profileVersion`/`effectiveContext` are `FACT`
(what was actually recorded, verbatim); the proposals that generation produced are themselves
`HYPOTHESIS` (AI-authored, not yet human-reviewed) but are not part of THIS read's own response
shape (they live in the Change Set's own `Changes`, a separate existing read); the eventual human
approval of those Changes is a `DECISION`, entirely outside this capability's scope. No explicit
per-field tag added for this reason -- the same naming/doc-comment-only approach as slice C.
`ACTION`/`OUTCOME` remain unexercised by any slice so far.

## 6. Error vocabulary (owner spec §27) -- IMPLEMENTED

Added to the single, shared `DomainErrorCode` union (`src/lib/video-metadata/contracts.ts`, every
domain module's own error class already extends this) and to the shared HTTP status mapper
(`src/app/api/video-metadata/error-status.ts`) -- reused everywhere in this codebase, never a
second error-code enum:

| Code | HTTP | Meaning |
|---|---|---|
| `CAPABILITY_NOT_AVAILABLE` | 501 | a real, named capability (implemented or a `plannedFutureCapabilities` entry) that isn't reachable the way the caller tried |
| `DATA_NOT_SYNCED` | 409 | requested entity hasn't been locally synced yet |
| `ANALYTICS_STALE` | 409 | analytics data exists but is too old for the request's own freshness requirement |
| `CHANNEL_NOT_AUTHORIZED` | 403 | channel-scoping failure (distinct from the pre-existing `CHANNEL_NOT_ACTIVE`, which is about the *caller's* active-channel session state, not the agent-interface's own authorization check) |
| `ASSET_NOT_AVAILABLE` | 404 | a catalogued asset reference that can't currently be retrieved |
| `INVALID_CONTEXT_REQUEST` | 400 | a context request with an invalid shape/combination of options |
| `DRAFT_VALIDATION_FAILED` | 422 | a DRAFT object failed field-level validation |
| `APPROVAL_REQUIRED` | 403 | an operation that needs human approval was attempted without it |
| `EXECUTION_NOT_AUTHORIZED` | 403 | an EXECUTE-class operation attempted without that permission |

## 7. Implementation status by slice (owner spec §29's recommended order)

| Slice | Scope | Status |
|---|---|---|
| A | Contracts + capability/version discovery | **IMPLEMENTED** -- `src/lib/agent-operations/`, MCP `agent_get_capabilities`, CLI `agent capabilities`, `GET /api/agent-operations/capabilities` |
| B | Read-only channel/video context | **IMPLEMENTED** -- see §4a; MCP `agent_get_channel_context`/`agent_get_video_context`, CLI `agent channel-context`/`agent video-context`. No HTTP route yet. |
| C | Analytics interface (agent-oriented wrapper over `src/lib/analytics/`) | **IMPLEMENTED** -- see §4b; MCP `agent_query_channel_analytics`/`agent_query_video_analytics`, CLI `agent channel-analytics`/`agent video-analytics`. No HTTP route yet. |
| D | Asset catalog/context (new subsystem -- nothing to reuse) | **IMPLEMENTED** -- see §4c; MCP `agent_list_assets`/`agent_get_asset_context`, CLI `agent list-assets`/`agent get-asset-context`/`asset register`. No HTTP route yet. |
| E | Agent draft/proposal provenance | **PARTIAL** -- see §4d; MCP `agent_get_generation_provenance`, CLI `agent get-generation-provenance`. No HTTP route (reuses the pre-existing one). "Operation type" (owner spec §22) still not recorded (RISK-57). |
| F | Bulk localization integration -- evidence, rationale, identity stamping | **PARTIAL** -- see §4e; widens the existing `ai_localization_create_change_set` MCP tool, CLI command, and Web route (`ai_localization_generate` is untouched). Evidence/rationale are per-Change-Set, not per-proposal (RISK-55, known limitation). |
| G | Content Proposal / external artifact registration | PLANNED |
| H | Full MCP/API surface (ongoing -- each slice above adds its own tools as it lands) | IN PROGRESS |
| I | Codex operations-workspace template | PLANNED -- see `docs/CODEX_OPERATIONS_WORKSPACE.md` once slice I lands |
| J | Independent security/integration review | ONGOING per slice -- `docs/roadmap/BACKLOG.md`'s BL-079/BL-080/BL-081 (and later rows, as slices land) are the authoritative record of each slice's own review-cycle status; not restated here as a round tally, since that would just be a second, driftable copy of the same fact |

Deliberately **not** implemented in this phase (owner spec §14/§29): the competitor/trend
intelligence module (Phase 9) and the Experiment Engine (Phase 10). `plannedFutureCapabilities`
names their eventual extension points; no speculative schema or code for either exists yet.

## 8. Safety invariants this interface must never violate

- Never expose Google OAuth tokens, AI-provider API keys, encryption keys, raw credential records,
  unrestricted filesystem access, or unrestricted database access, to any agent-facing response.
- No new YouTube write path -- every mutation an agent's DRAFT eventually causes goes through the
  existing `youtube-write-gateway`/Change-Set/Batch pipeline, Gate B's live-write barrier included,
  unchanged.
- No code path may set a Change/ChangeSet's approval state to anything but `pending` at creation,
  regardless of which slice or capability created it.
- Channel scoping is never automatic -- every capability that takes a `channelId` must itself
  verify the request belongs to that channel (`AGENTS.md` §F), the same discipline every other
  channel-scoped module in this codebase already follows.
