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
returns -- see §5 below. From Phase 13 `queryChannelAnalytics` also returns `viewCountingChangeInComparison`
(boolean, an additive field): true when the current and previous periods straddle YouTube's 2026-08-27
view-counting change, so the two totals are not like-for-like.

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

**Directly populated only by the operator-facing `asset register` CLI command** -- owner spec §25's
capability list names only `list_assets`/`get_asset_context` (READ) for this domain, not a
register/create capability, so `asset register` itself is deliberately not exposed as an MCP tool
or an agent-operations capability in this slice (registering a NEWLY produced artifact, as opposed
to cataloguing a pre-existing one, is a separate, later concept -- slice G's
`register_external_artifact`, §4f below, now IMPLEMENTED: an indirect, agent-callable way to
populate this same catalog, tied to a Content Proposal and restricted to `referenceKind`
`url`/`external_artifact_id` -- `local_path` remains reachable only via this direct, operator-only
command). CLI: `asset register --channelId <UC...> --assetType <type>
--referenceKind <url|local_path|external_artifact_id> --referenceValue <value> [--title]
[--description] [--linkedVideoId] [--provenanceJson <json>]`; `agent list-assets --channelId
<UC...> [--videoId] [--assetType]`; `agent get-asset-context --channelId <UC...> --assetId <id>`
(`docs/interfaces.md`).

**Known limitation:** a registered asset stays device-local -- it does not travel with a device
snapshot/handoff (`docs/TECHNICAL_DEBT.md` RISK-52), the same accepted limitation
`video_metrics_daily` already has.

## 4d. Agent draft/proposal provenance (owner spec §22) -- PARTIAL (slice E; identity/version closed in slice F -- see §4e; "originating task" still not recorded, RISK-57)

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
"product/API version," "operation type," and "originating task" on every agent-created object.
Slice E's read wrapper alone closed the MCP/CLI tool-surface gap but stamped nothing new;
`profileVersion`/`effectiveContext` remained supplied BY THE CALLER when creating the Change Set
(an agent echoes back its own `generateProposals` response), never independently attested by this
server. Slice F (see §4e) added server-stamped `createdVia`/`agentApiVersion` -- covering
"agent/client identity" and "product/API version," `docs/TECHNICAL_DEBT.md` RISK-54 is now
RESOLVED for exactly that narrower scope. "Operation type" is now structurally addressed too
(slice G added a second, distinct table for a second kind of agent-created object -- which table
a `createdVia`/`agentApiVersion` pair lives on already distinguishes the operation, per
`docs/TECHNICAL_DEBT.md` RISK-57's own updated reasoning). "Originating task" remains genuinely
unrecorded -- no capability in this interface stamps a `taskId`, and owner spec §21's "Agent task
model" has not been scheduled in any slice so far; tracked as the remaining open half of RISK-57.

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
  | null }`. `CreatedVia` (`"mcp" | "cli" | "web_ui"`) is defined once in the dependency-free
  `src/lib/shared-provenance/` module (see §4f -- extracted there since slice G's own
  `content-proposals` module needs the identical vocabulary and neither module may depend on the
  other) and re-exported through `ai-localization/contracts.ts` (`AGENTS.md` §D) -- every module
  that needs this vocabulary imports it, none retypes it. SERVER-STAMPED at each of its three call sites -- never
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

## 4f. Content Proposal / external artifact registration (owner spec §18/§19/§20) -- CLOSED (slice G)

New module `src/lib/content-proposals/` (contracts/schemas/services/adapters/index -- §6.2 pattern),
new `content_proposals` table (SCHEMA_MIGRATIONS v17). A Content Proposal is a structured,
agent-authored (or human-authored) idea for a piece of content, per owner spec §18 -- "the
application does not need to generate every resulting asset. Codex or external tools may create
the content." This module owns exactly the proposal RECORD; it never generates, fetches, or
produces content itself (no media pipeline, no YouTube write).

- **Write-once by design:** create, get, list only -- no update, no status field, no approval
  workflow. The owner spec describes no review/approval process for proposals (unlike Change
  Sets); inventing one would be scope creep (`AGENTS.md` §C). A proposal is simply a DRAFT object;
  `GRANTED_PERMISSIONS` remains `["READ","DRAFT"]`.
- **Fields (owner spec §18):** `objective`/`topicConcept`/`rationale` are dedicated, bounded
  free-text columns. `evidence` reuses the exact `EvidenceReference` shape from slice F (owner
  spec §13), now defined once in `src/lib/shared-provenance/` (see below). The remaining,
  heterogeneous field list (proposed title/thumbnail/visual/audio direction, duration,
  publication hypothesis, localization strategy, experiment design, expected metrics, required
  production outputs) is collapsed into one bounded, `.strict()`-validated `brief` object rather
  than ~10 speculative dedicated columns, since none of them is queried structurally anywhere in
  this codebase yet. `referenceVideoIds`/`referenceAssetIds` are each validated, at creation
  time, to actually belong to the requesting channel (`AGENTS.md` §F) -- against the existing
  channel/video sync mirror and against `asset-catalog`'s own channel-scoped `getAssetContext`
  (`AGENTS.md` §D -- never a second, parallel asset-ownership check).
- **Identity stamping (owner spec §22):** `createContentProposal` takes the same required,
  no-default `callOrigin` parameter as `ai-localization`'s `createChangeSetFromGeneration` (slice
  F) -- `createdVia`/`agentApiVersion`, SERVER-STAMPED at the MCP/CLI call site, never
  caller-supplied. Unlike `ai_localization_generation_provenance`, `content_proposals.created_via`
  is `NOT NULL` from creation: this is a brand-new table with no pre-existing rows created before
  this field existed, so there is no backward-compatibility case to accommodate.
- **Shared vocabulary extraction (`AGENTS.md` §M):** `CreatedVia`/`EvidenceReference` (and their
  zod schemas) are defined once in a dependency-free `src/lib/shared-provenance/` module, imported
  by both `ai-localization` and `content-proposals` -- neither domain module depends on the other.
  `AgentCapabilityDomain`/`AgentDataDomain`/`PermissionClass`/`PlannedFutureCapability` are const
  arrays in `agent-operations/contracts.ts`, with `agent-operations/schemas.ts` deriving its
  `z.enum(...)` calls from them instead of hardcoding a second copy (RISK-53, `docs/TECHNICAL_DEBT.md`,
  RESOLVED).
- **New agent-operations capabilities:** `content_proposal.create_content_proposal` (DRAFT),
  `content_proposal.get_content_proposal`/`content_proposal.list_content_proposals` (READ).
  MCP `agent_create_content_proposal`/`agent_get_content_proposal`/`agent_list_content_proposals`,
  CLI `agent create-content-proposal`/`agent get-content-proposal`/`agent list-content-proposals`
  -- no HTTP route (matches slices B-F's own MCP/CLI-first precedent). `create` mutates local
  state (a new proposal row), gated by the same device-availability/recovery-mode check as
  `ai_localization_create_change_set`; `get`/`list` are pure local reads, ungated.
  `AGENT_API_VERSION` bumped to `0.6.0` (new capability ids, per that constant's own policy).
- **Storage:** not in `SNAPSHOT_TRANSFERRED_TABLES` -- same accepted, device-local limitation
  `creative_assets` already has (`docs/TECHNICAL_DEBT.md` RISK-52, note widened to cover this
  table too).
- **§20 (Experiment context, deferred to Phase 10) compatibility:** satisfied without building
  anything -- a proposal's own stable `proposalId` is the link target the artifact-return path
  (below) actually uses. `referenceAssetIds` is the other direction -- a proposal pointing at
  pre-existing, already-catalogued assets it references, not the produced-artifact link.

**External artifact registration (owner spec §19, slice G2):** "a lightweight way for external
agent workflows to return created artifacts to the system." New `content_proposal_artifacts` link
table (SCHEMA_MIGRATIONS v18: `id`/`proposal_id`/`asset_id`/`created_at`/`created_via`/
`agent_api_version`, FKs into both `content_proposals` and `creative_assets`), owned by
`content-proposals` itself, not a new column on `creative_assets` (`AGENTS.md` §M -- asset-catalog's
own schema/code stays untouched by a feature it doesn't depend on). The actual asset row is created
via asset-catalog's own pre-existing `registerAsset` (`AGENTS.md` §D -- never a second, parallel
asset-insert path); `content-proposals` only owns the link.

- **`registerExternalArtifact(input, callOrigin)`:** validates the proposal belongs to the
  requesting channel, delegates asset creation to `assetCatalogCore.registerAsset`, inserts the
  link row, and returns the hydrated `ProposalArtifactLink` (`linkId`/`proposalId`/`channelId`/
  `asset`/`createdAt`/`createdVia`/`agentApiVersion`). Same required, no-default `callOrigin`
  pattern as `createContentProposal`/`createChangeSetFromGeneration`.
- **`referenceKind` restricted to `url`/`external_artifact_id` only for agent-callable
  registration** (`AGENT_ARTIFACT_REFERENCE_KINDS`) -- never `local_path` (owner spec §17: "the
  agent should receive only explicitly cataloged/authorized assets"; an agent that could register
  its own `local_path` would be self-authorizing filesystem access). The pre-existing,
  human-operator-only `asset register` CLI command is untouched and keeps `local_path` available.
  **The enum alone is only a label** -- `registerExternalArtifactInputSchema` additionally
  `.superRefine`s that a `"url"`-labeled `referenceValue` is an actual, parseable http(s) URL
  (rejects a filesystem path or `file://` URI); found missing by an independent review round
  (RISK-58, `docs/TECHNICAL_DEBT.md`, `url` half RESOLVED) and fixed the same slice.
  `"external_artifact_id"` remains intentionally opaque -- no structural validation beyond
  non-empty, since this application never resolves it; RISK-58's `external_artifact_id` half
  stays deliberately OPEN as a documented limitation, not an oversight.
- **`listProposalArtifacts(input)`:** validates proposal ownership, lists links, hydrates each via
  `assetCatalogCore.getAssetContext`; silently drops a link whose asset is somehow missing rather
  than fabricating one (matches asset-catalog's own JSON-tolerance discipline).
- **New agent-operations capabilities:** `content_proposal.register_external_artifact` (DRAFT),
  `content_proposal.list_proposal_artifacts` (READ). MCP `agent_register_external_artifact`/
  `agent_list_proposal_artifacts`, CLI `agent register-external-artifact`/
  `agent list-proposal-artifacts` -- no HTTP route, same MCP/CLI-first precedent. `register`
  mutates local state (a new asset row plus a new link row), gated like `create-content-proposal`;
  `list` is a pure local read, ungated. `AGENT_API_VERSION` bumped to `0.7.0`.
- **Non-atomic multi-write (RISK-56 pattern):** the asset insert and the link insert are two
  separate writes, not one transaction -- same already-accepted risk class first noted for
  Change-Set-plus-provenance in slice F, not a new RISK entry.
- **Storage:** `content_proposal_artifacts` is likewise not in `SNAPSHOT_TRANSFERRED_TABLES`
  (RISK-52, same device-local limitation).
- Evidence/rationale (proposal-level, from slice G1) inherit the same per-object (not per-field),
  never-independently-verified caveats already documented for slice F; this remains an accepted,
  unchanged limitation, not something slice G2 needed to revisit.

## 4g. Comparable-content context (owner spec §10) -- IMPLEMENTED (slice K)

Found 2026-09-24 when the full 34-section owner spec text was recovered from this session's own
pre-compaction transcript to independently verify slice H (it had never been re-derived from the
verbatim spec before -- this document's own citations had never referenced §10 at all, and no
slice, backlog row, or `docs/TECHNICAL_DEBT.md` entry mentioned it either). The spec asks for a
`find_comparable_videos(...)` capability with filters (same channel, same content family, similar
topic/duration/publication period/target audience/metadata pattern, historical performance
threshold), explicitly NOT requiring embeddings/vector search for a first implementation ("simple
filters and ranking" is enough). This is distinct from the already-implemented
`analytics_comparable_age`/`agent_query_channel_analytics` (Phase 8), which compares videos at
equivalent days-since-publish but does not let a caller search for topically/structurally similar
videos by the broader filter set §10 describes. Tracked as `BL-088` (`docs/roadmap/BACKLOG.md`),
**assigned into this phase by the owner, Telegram 2026-09-24** ("Да, такие находки как BL 88 и 89
тоже включай в список тасков текущей 7 фазы").

**Split into two commits, per `advisor()`'s explicit guidance:**

- **K0 (duration sync).** Honestly implementing the spec's "similar duration" filter needs each
  video's actual runtime, which this application never synced before. Added `videos.durationSeconds`
  (schema v19, nullable, additive -- same `isDuplicateColumnError`-tolerant `ALTER TABLE` pattern as
  the existing v4 view/comment/like-count columns) and a new `parseIso8601DurationToSeconds` parser
  in `youtube-read-gateway/data-api.ts` (`videos.list`'s `part` now also requests `contentDetails`).
  `"P0D"`/`"PT0S"` (YouTube's live-broadcast placeholder) parse to `null`, never a fabricated `0`.
  `video-details/adapters/store.ts`'s `refreshVideoFields` (a targeted single-field patch that must
  merge every untouched field forward) was extended to carry `durationSeconds` forward too --
  otherwise every unrelated metadata edit would have silently clobbered a previously-synced duration
  back to `null` (caught by `advisor()` before any test found it).
- **K1 (the query engine).** New module `src/lib/comparable-content/` (`contracts.ts`/`schemas.ts`/
  `services.ts`/`index.ts`), anchor-based: `{channelId, anchorVideoId, credentialRef?,
  publicationWindowDays?, durationToleranceSeconds?, performanceMetric?, performanceThreshold?, sort,
  limit?}` → `{anchorVideoId, candidates[], excludedForMissingData, truncated}`. Reuses, never
  duplicates (`AGENTS.md` §D): `createChangeSetChannelStoreAdapter().listVideosByChannel` for the
  local video mirror, `createAnalyticsCore().listMetrics` for local performance rows (only invoked
  when `performanceMetric` is actually requested, so the common title/date/duration-only case never
  needs a `credentialRef`), and `computeComparableAgeSeries`/`diffCalendarDays`/
  `toPacificCalendarDate` from `@/lib/analytics/comparable-age.ts` for age-aligned (days-since-publish,
  capped at 365) performance comparison -- never a live YouTube call, never a second age-alignment
  implementation. **Explicitly does NOT support** "same content family," "similar target audience,"
  or "similar metadata pattern" -- no data source for any of those exists in this application, and
  this capability states that plainly in its own description rather than silently approximating it.
  Title similarity is reported only as `sharedTitleTokens` (a literal lowercase word-overlap set
  after a tiny English stopword list) -- never framed as topic/semantic similarity, never an
  embedding model (owner spec §10 explicitly rules out embeddings for a first implementation).
  Wired into `agent-operations` (`comparable_content.find_comparable_videos`, `AGENT_API_VERSION`
  → `0.9.0`), MCP `agent_find_comparable_videos`, and CLI `agent find-comparable-videos` -- all
  channel-scoped (`assertActiveChannel`), all read-only/ungated, following the exact same pattern as
  every earlier slice's own wrapper. `AGENT_CAPABILITY_DOMAINS` gained `comparable_content`; no new
  `AGENT_DATA_DOMAINS` entry was needed (reuses the existing `video_metadata`/`video_analytics`
  domains). An anchor that does not belong to the requesting channel (or does not exist) fails with
  `DATA_NOT_SYNCED` -- the same code slice B's `getVideoContext` already uses for "videoId not found
  in this channel," not a bespoke code for this one capability.

  **Four fixes made across two rounds of `advisor()` review, before this slice's own
  independent-review cycle:**
  - The response also carries an `anchor` block (the anchor's own title/publishedAt/durationSeconds,
    and its own `performanceMetricValue` at the same comparison day) and `performanceAlignment`
    (`{ metricName, dayOffset } | null`) -- without these, a caller could see each candidate's
    *distance* from the anchor but never the anchor's own facts to interpret that distance against,
    which this slice's own AC-CMP-06 ("report the raw comparison facts") calls for.
  - The agent-operations WRAPPER (not the `comparable-content` domain module itself, which stays
    reusable/self-contained) additionally enriches that raw result with `metricDefinitions`/
    `freshness` -- `null` unless `performanceMetric` was requested -- mirroring exactly how
    `queryVideoAnalytics` already enriches its own wrapped capability's raw result (owner spec §9:
    "every result must include metric definitions"). New `findComparableVideosContextOutputSchema`/
    `FindComparableVideosContext` in `agent-operations/schemas.ts`; the raw, unenriched
    `FindComparableVideosResult` stays `comparable-content`'s own, unchanged type.
  - **The MCP SDK, not just this module's own handler, validates a tool call's arguments against
    whatever `inputSchema` was registered -- before the handler function ever runs**
    (`McpServer.validateToolInput` → `executeToolHandler`, `@modelcontextprotocol/sdk`'s own
    `server/mcp.js`). Registering the FULL, refined `findComparableVideosInputSchema` (whose own
    refinement requires `credentialRef` when `performanceMetric` is set) meant the SDK itself could
    reject a real call requesting `performanceMetric` without an explicit `credentialRef`, before
    the handler's own resolve-then-inject logic (below) ever got a chance to run -- undetected by
    this slice's own handler-level tests, which call the handler function directly and bypass the
    SDK entirely. Fixed the same way `agent_query_channel_analytics`/`agent_query_video_analytics`
    already handle their own (unconditionally required) `credentialRef` field: registered a
    separate, relaxed SDK-facing schema (`findComparableVideosSdkInputSchema`, exported from
    `comparable-content/schemas.ts` as `findComparableVideosBaseObjectSchema` -- the plain object
    before the cross-field refinements) for `server.registerTool`'s own `inputSchema`, while the
    handler and the domain service both still validate against the FULL refined schema -- so no
    business rule is weakened, only deferred past the SDK's own pre-handler validation. Verified
    with a test that calls the REAL registered tool's own `inputSchema.safeParse(...)`, not just
    the handler, to prove the SDK-level gap is actually closed.
  - `credentialRef` is optional in the domain schema (only actually used when `performanceMetric`
    is requested), but the MCP handler used to validate the raw caller input directly against the
    full schema -- so a caller requesting `performanceMetric` without an explicit `credentialRef`
    would still have hit `validation_failed` inside the handler even once the SDK-level gap above
    was closed. Fixed: the MCP handler now resolves `credentialRef` (caller-supplied, else the
    local active identity -- the same cheap, non-network resolution every other channel-scoped
    handler already does for its own `assertActiveChannel` check) and injects it into the input
    *before* schema validation, so the schema's own "performanceMetric requires credentialRef"
    refinement is always satisfiable without the caller having to know or supply one. **This
    capability deliberately lets an explicitly caller-supplied `credentialRef` govern the
    `assertActiveChannel` identity check too** (not just downstream forwarding) -- the same
    convention `agent_query_channel_analytics`/`agent_query_video_analytics` and every CLI
    `--userId`/`--accessToken` flag already establish for "which locally-stored identity is this
    call acting as," consistent with this application's own documented no-per-user-ownership-
    boundary security model (`docs/TECHNICAL_DEBT.md`), not a new escalation. The CLI never had the
    validation-ordering bug (it already resolves and conditionally forwards `credentialRef` itself,
    before calling the schema-validating service) but gained its own fix: `--performanceThresholdOperator`/
    `--performanceThresholdValue` must be given together, rejected as `validation_failed` otherwise
    (previously silently applied no threshold if only one was given).

  **Independent-review cycle: IN PROGRESS, 2 rounds so far, findings 3/4 (not yet closed --
  round 2 found 4 issues, not zero; a round only counts as closing the cycle when it finds
  literally nothing, per this project's own established convention, e.g. slice I's 3/1/1/0).**
  Round 1 found 3 real
  issues in commit 79c3697 (fixed in 71033f7):
  - **(bug, high)** `ageAlignmentDays` was derived from wall-clock `now()` instead of the anchor's
    own actually-collected data. Analytics collection intentionally never reaches "today"
    (`staleness.ts`'s own default collection range ends at yesterday), and
    `computeComparableAgeSeries` stops a cumulative series dead at the first missing day counting
    from day 0 -- so for a recently-published anchor (the most natural real query: "how is my new
    video doing against similar recent ones"), picking "current age" as the comparison day would
    almost always land on a day nobody has data for yet, making `anchor.performanceMetricValue`
    null and excluding most/all candidates for exactly the scenario this filter exists for. Fixed:
    the comparison day is now the LAST DAY OF CONTIGUOUS COVERAGE the anchor's own data actually
    reaches (from `computeComparableAgeSeries`'s own `cumulativePoints`, run once against the
    anchor's own rows before scoring any candidate), capped at 365 days and at the anchor's real
    elapsed age as a safety bound -- degrading to day 0 if the anchor has no CONTIGUOUS coverage
    reaching day 0 at all (which covers both "no data yet" for a brand-new anchor AND "has real
    data at later days, but day 0 itself was never collected" for an OLD anchor published before
    regular collection began for its channel -- `analytics_comparable_age`'s own tool description
    already documents this same situation as a normal, expected data-coverage limitation, not an
    error), never an arbitrary later day nobody has data for either.
  - **(bug, medium)** `sort: "durationProximity"` without `durationToleranceSeconds` didn't guard
    against the anchor having an unknown `durationSeconds` -- every candidate's own
    `durationDistanceSeconds ?? Infinity` comparator input became `Infinity - Infinity = NaN`
    (which `Array.prototype.sort` treats as "leave in place," not a shuffle, but still never
    actually sorts by duration while claiming to). Fixed: the same `INVALID_CONTEXT_REQUEST`
    precondition already applied to `durationToleranceSeconds` now also applies whenever
    `sort === "durationProximity"`.
  - **(gap, medium)** `tokenizeTitle` split titles on ASCII-only `[^a-z0-9]+`, silently producing
    zero tokens for non-Latin titles (Cyrillic, etc.) -- undocumented, and a realistic case given
    this application's own localization focus. Fixed: Unicode-aware split (`/[^\p{L}\p{N}]+/u`).
    CJK-style scripts with no whitespace between words remain an accepted, out-of-scope limitation
    of this deliberately tiny heuristic (never framed as an NLP engine).

  Round 2 re-verified all three round-1 fixes by hand-tracing the corrected logic against
  `comparable-age.ts`'s actual documented semantics (not just re-running the tests) and confirmed
  none introduced a new bug, but still found 4 real (lower-severity) issues of its own -- fixed in
  the same pass, not deferred: a missing test combination (`durationProximity` sort with the
  anchor's own duration known but a mix of known/unknown candidate durations); a doc-drift finding
  (this section had not yet been updated to record round 1's own 3 fixes, an `AGENTS.md` §H gap);
  and 2 wording nits (the "furthest day the anchor's data reaches" phrasing was tightened to say
  "last day of CONTIGUOUS coverage from day 0," since a single Analytics-API-omitted day earlier in
  the series collapses the comparison day to before that gap -- `comparable-age.ts`'s own existing,
  documented behavior, not a new bug; and a comment correcting that `Array.prototype.sort` treats a
  `NaN` comparator result as "leave in place," not a shuffle). `npm test` 1320/1320, tsc/lint/build
  clean through both rounds.

  **Round 3, findings 4, fixed in the same pass (not yet closed -- a round only closes the cycle
  when it finds zero):** specifically checked an anchor published before regular collection began
  for its channel (a realistic, likely common case on an existing channel, distinct from round 1's
  "recently published anchor" scenario). **Verdict: this behavior is CORRECT, no code fix needed.**
  `performanceThreshold` is an ABSOLUTE `{operator, value}` comparison, never relative to the
  anchor's own value -- unlike `durationToleranceSeconds` (a *relative*, anchor-distance-based
  filter, which is why an anchor with unknown `durationSeconds` correctly fails the WHOLE request),
  a `null` anchor performance value never poisons candidate filtering: each candidate is
  independently evaluated and its own exclusion, if any, is still honestly counted in
  `excludedForMissingData.performance`. This is the same accepted, pre-existing limitation
  `analytics_comparable_age`'s own tool description already documents for this exact situation
  (AGENTS.md §D: reused, not reimplemented). Round 3 did find 4 real issues elsewhere, all fixed:
  - **(bug, medium)** A caller-supplied `limit` above `MAX_COMPARABLE_VIDEOS_LIMIT` was REJECTED by
    the schema as `validation_failed` -- contradicting this capability's own documented "never an
    unbounded response, always silently capped with `truncated: true`" contract (AC-CMP-07,
    `contracts.ts`'s own `limit` doc comment). Fixed: the schema no longer bounds `limit` at all;
    the service clamps it to `MAX_COMPARABLE_VIDEOS_LIMIT` instead of rejecting it.
  - **(gap, low -- robustness)** `toPacificCalendarDate` throws a plain `Error` on a malformed
    `publishedAt`; `videos.published_at` is `NOT NULL` but not empty-string-constrained, so a
    theoretical (never observed) malformed row anywhere on the channel would crash the WHOLE
    request via a generic, untyped error. Fixed: the anchor's own malformed `publishedAt` now fails
    with a clear `INVALID_CONTEXT_REQUEST` (it's load-bearing for every comparison); a candidate's
    own malformed `publishedAt` is silently excluded from the comparison instead (it's not
    load-bearing for anyone else's).
  - **(gap, medium -- doc drift, again)** Round 2's own wording fix ("last day of CONTIGUOUS
    coverage from day 0") hadn't propagated to every doc comment describing the same fallback
    (`contracts.ts`'s `ComparableVideoCandidate`/`FindComparableVideosAnchor` doc comments still
    said "no data at all yet," a narrower condition than what actually triggers it -- an OLD anchor
    can have plenty of real data at LATER days and still hit this exact path). Fixed everywhere
    this doc comment recurs, plus this section.
  - **(nit)** `FindComparableVideosAnchor.performanceMetricValue`'s own doc comment said candidates
    are "compared against" the anchor's value, implying it participates in filter math -- corrected
    to state plainly it's informational/contextual only (see the absolute-threshold point above).
  Also added tests for two previously-uncovered boundary/combination scenarios (`durationProximity`
  with a mix of known/unknown candidate durations; exact-boundary `durationToleranceSeconds`/
  `performanceThreshold` values) and the two malformed-`publishedAt` scenarios above. `npm test`
  1326/1326, tsc/lint/build clean.

  **Round 4: zero issues found -- cycle closed 2026-09-25.** A genuinely adversarial pass
  re-verifying every prior round's fix by hand (not by re-reading the fix commits' own claims):
  re-traced the `limit` clamp end-to-end (60 real candidates, requested limit 1000 -> clamped to 50,
  `truncated: true`), confirmed the malformed-`publishedAt` candidate-skip introduces no bookkeeping
  inconsistency elsewhere, grepped for any remaining stale "no data at all yet"/"furthest day"
  wording (none found -- the one hedged, hedge-qualified instance and one informal test-title string
  left were judged accurate/harmless), and gave the three call-surface layers (MCP, CLI,
  agent-operations wrapper) a fresh, independent pass rather than trusting rounds 1-3's mostly-core-
  logic focus. Also independently re-verified K0/K1's interaction (duration parsing, snapshot
  exclusion, migration coverage). 311/311 in the four affected test files, `npm test` 1326/1326,
  tsc/lint/build clean. **Independent-review cycle for slice K: 4 rounds, findings 3/4/4/0, closed.**

## 4h. Performance ↔ asset linkage (owner spec §16) -- IMPLEMENTED (slice L)

Found the same way as §4g, same date. The spec asks for the interface to expose associations
along `video → asset → metadata/version → analytics → experiment/outcome` so an agent can answer
questions like "which thumbnails were used by high-CTR videos," "which visual concepts repeatedly
appeared in stronger-performing videos," "which duration/content combinations produced better
watch time," "which production assets belonged to videos that underperformed," and "which prior
assets should be used as reference material for the next creative" -- explicitly leaving causal
inference to the agent, not the product. Tracked as `BL-089` (`docs/roadmap/BACKLOG.md`),
**assigned alongside BL-088, same owner instruction**. Acceptance criteria (`docs/acceptance/
PHASE_7_ACCEPTANCE.md` §5-§7, AC-PERF-01..12) were written before implementation, per `AGENTS.md`
§L, incorporating slice K's own two hard-won lessons (round 1: never derive a comparison day from
wall-clock `now`; round 3: `limit` is always silently clamped, never rejected) from the start.

**Design, `src/lib/asset-performance/` (contracts/schemas/services/index, §6.2 pattern):**

- **New capability** `asset_performance.list_asset_performance` -- a JOIN, not a filter, of the
  existing asset catalog (`creative_assets.linkedVideoId` -- an operator/agent-asserted "this
  asset was used on this video" association, never verified against YouTube and carrying no time
  range) against each linked video's own already-collected performance data. Reuses, never
  duplicates (`AGENTS.md` §D): `assetCatalogCore.listAssets` for the catalog read,
  `createChangeSetChannelStoreAdapter().listVideosByChannel` for video facts/lifetime counters (the
  same store adapter slice K already reads), `analyticsCore.listMetrics` for local analytics rows
  (only when `performanceMetric`/`performanceDayOffset` are both requested), and
  `getCumulativeValueAtDayOffset` (extracted from slice K's own local closure into
  `analytics/comparable-age.ts` as its own commit first, confirming K's 26 tests passed unchanged,
  before slice L was built on it -- AGENTS.md §D: shared logic gets one owner, never a second copy).
- **Two kinds of performance, never conflated:** LIFETIME totals (`viewCount`/`likeCount`/
  `commentCount`/`durationSeconds`, plus `lifetimeCountersAsOf` from `videos.lastSyncedAt` --
  always present when known, explicitly NOT age-fair) and an OPTIONAL age-aligned value
  (`performanceMetric` + a REQUIRED, caller-supplied `performanceDayOffset` -- never derived from
  `now`, applying slice K round 1's lesson from the start rather than rediscovering the same bug).
  A video published before regular collection began for its channel (real data at later days, no
  day-0 coverage) correctly gets `ageAlignedPerformanceValue: null` while its row and lifetime
  counters stay intact -- this is a JOIN field, never grounds for exclusion.
- **Two exclusion reasons, not three:** `excludedForMissingLink: { unlinked,
  linkedVideoNotOnChannel }`. An earlier design considered a third, more specific
  "video on a different channel" reason (mirroring slice K's own `excludedForMissingData`
  granularity) -- caught by `advisor()` review before the review cycle started: the real
  `listVideosByChannel(channelId)` dependency is already channel-scoped at the SQL layer, so
  "never synced" and "belongs to a different channel" are structurally indistinguishable from
  inside this capability, and asset registration itself already validates `linkedVideoId` against
  the same channel at write time (`asset-catalog`'s own `registerAsset`) -- a genuine cross-channel
  link should not normally occur. The capability still re-checks `channelId` explicitly as
  defense-in-depth (`AGENTS.md` §F: channel-context validation is never automatic), just counts
  both failure shapes under one honest bucket instead of a field that would always read `0` in
  production. `docs/acceptance/PHASE_7_ACCEPTANCE.md`'s own AC-PERF-03/04 were AMENDED to record
  this (found by slice L's own independent-review round 1 as an `AGENTS.md` §L process gap: the
  acceptance doc had not been updated to match, even though the code and this section already had)
  -- the amendment quotes the original two-counter criteria verbatim alongside the stated reason,
  per §L's "changing a previously-approved acceptance test requires explicit justification" rule.
- **Out of scope, stated explicitly in the capability's own description** (never silently
  approximated): thumbnail-CTR/impressions-based questions (this application's own analytics
  collection never fetches YouTube's `impressions`/`impressionClickThroughRate` metrics at all --
  never approximated via `cardClickRate`/`annotationClickThroughRate`, an unrelated signal);
  `metadata/version` linkage (no temporal precision on `linkedVideoId`); `experiment/outcome`
  linkage (Phase 10, doesn't exist yet); Content Proposal reference associations
  (`content_proposal_artifacts`/a proposal's own `referenceAssetIds`/`referenceVideoIds`) -- a
  structurally DIFFERENT relationship (draft, unactioned reference/inspiration material, never
  "this asset was actually used on this video") this capability deliberately never reads.
- Wired into `agent-operations` (`AGENT_API_VERSION` → `0.10.0`, new `asset_performance` capability
  domain, same `metricDefinitions`/`freshness` enrichment convention as slice K's own wrapper), MCP
  `agent_list_asset_performance`, CLI `agent list-asset-performance` -- channel-scoped
  (`assertActiveChannel`), read-only/ungated, same credentialRef resolve-then-inject-then-validate
  pattern and SDK-facing relaxed-schema registration (`listAssetPerformanceSdkInputSchema`) as
  slice K, applying that lesson from the start rather than needing a round to rediscover it.

  **Independent-review cycle: 4 rounds, findings 5/1/1/0, closed 2026-09-25.** Notably, all 4
  findings across rounds 1-3 were documentation staleness, never a functional bug -- round 1 found
  the AC-PERF-03/04 acceptance-doc drift and a doc-comment inaccuracy plus a sort-mode
  test-coverage gap (fixed, commit `92d7ecc`); round 2 found `docs/roadmap/BACKLOG.md`/
  `docs/SYSTEM_MAP.md` still claiming the cycle "not yet started" after round 1 had already run
  (fixed, commit `07ac8fb`); round 3 found a THIRD copy of that same stale claim, this time in
  this document's own §7 status table row for slice L (fixed, commit `ba4ee2c`) -- while also
  running a fresh functional pass (truncation counting, `assetType`+`performanceMetric`
  interaction, CLI numeric parsing, timezone handling) that found nothing wrong. Round 4 did an
  exhaustive repo-wide sweep for any remaining stale copy of the round-tally claim (found none) and
  a further adversarial functional pass -- a hand-derived combined `assetType`+`performanceMetric`+
  `performanceDayOffset`+`sort`+`limit` scenario run against the real service (not just the
  existing test suite), CLI numeric-parsing edge cases, `credentialRef` handling under malformed
  inputs, and the real (non-fake) dependency wiring's field-for-field shape compatibility -- and
  found zero issues, closing the cycle at the same 4-round shape as slice K's own closure
  (3/4/4/0).

## 4i. Dedicated Phase 7 acceptance-contract document (owner spec §28) -- CLOSED (slice J, 2026-09-25)

Owner spec §28 asks for "a dedicated Phase 7 acceptance contract" produced **before**
implementation, covering an explicit list of scenarios (version/capability discovery, channel
isolation, no dev-repo dependency, no direct DB access, no secret exposure, and more). Slices A-I
were implemented and independently reviewed before `docs/acceptance/PHASE_7_ACCEPTANCE.md` existed
-- acceptance criteria WERE derived from the spec per slice at the time (`AGENTS.md` §L's discipline
was followed throughout), just never consolidated into one document. Slice J closed this gap
retroactively: `docs/acceptance/PHASE_7_ACCEPTANCE.md` §8-§9 quotes owner spec §28 verbatim and maps
every one of its 20 named scenario categories to the slice/capability that covers it and the actual
test that exercises it -- explicitly marked as a **retroactive** backfill for A-I (weaker evidentiary
standing than a criterion written before its own implementation, and the document says so plainly),
while §10's cross-cutting checks (channel isolation across every tool, capability parity re-run with
K/L included, secrets, DB access, dev-repo dependency, approval separation, zero live writes in
tests) were derived fresh for J itself, not backfilled from anything. See §7's row J below and
`docs/acceptance/PHASE_7_ACCEPTANCE.md` §8-§11 for the full result.

## 4j. Codex operations-workspace path surfacing (owner spec §3/§30) -- IMPLEMENTED (slice I)

Owner spec §3 originally asked for a full "operations-workspace" example/template (an
`AGENTS.md`, connection config, permitted capabilities, expected agent behavior, task-output/
temporary-asset folders). The project owner narrowed this scope explicitly (Telegram,
2026-09-24): "Как вести канал будет сложено в папке вне данного репозитория, но мы можем в
настройках указать путь где они находятся. Чтобы эта информация попала к подключенному агенту и
не попадала при этом в наш репозиторий" -- operating/editorial instructions for the connected
agent live in a folder OUTSIDE this repository (never generated, templated, or committed here,
`AGENTS.md` §B); this application's Settings tab stores a path to that folder, and its contents
are surfaced to the connected agent via MCP/CLI on request. Slice I's actual scope is therefore
limited to that path-configuration/surfacing mechanism, never an operations-workspace template or
editorial-guideline document of its own.

- **New module `src/lib/operations-instructions/`** (contracts/schemas/services/adapters/index --
  §6.2 pattern). Not channel-scoped -- one global, operator-configured path, unlike every other
  domain module in this interface.
- **Setting:** `operationsWorkspacePath` (`src/lib/db.ts`'s `getOperationsWorkspacePath`/
  `setOperationsWorkspacePath`, reusing the existing generic `appSettings` key-value table -- no
  new schema/migration needed). `null`/empty both mean "not configured." **Settable ONLY through
  `POST /api/settings`** -- no `agent`-namespaced MCP tool or CLI command can set or change it
  (owner spec §17's `local_path` self-authorization concern, applied here: an agent that could
  choose its own instructions directory would be authorizing its own filesystem access, exactly
  the reasoning already established for asset registration in slice G2).
- **Set-time validation (`validateOperationsWorkspacePath`, called from the Settings route):**
  rejects a non-absolute path, a path that doesn't exist or isn't a directory, and -- the
  RISK-07-motivated check -- a path that equals, is inside, or is an ANCESTOR of this
  application's own app-data directory (an ancestor would expose the app-data directory, which
  holds plaintext OAuth tokens, underneath the configured workspace). Verified live in a browser:
  a relative path is rejected ("path must be absolute"), and the real macOS app-data directory
  (`~/Library/Application Support/YouTubeOperationsManager`) is rejected as overlapping.
- **Read-time re-validation, independent of the set-time check:** every `listOperationsFiles`/
  `getOperationsFile` call re-resolves the configured path via `realpath` and re-runs the SAME
  appDataDir-overlap check, because the directory could be re-symlinked to something unsafe at any
  point after being validated and saved. Proven by a dedicated test that configures a symlink,
  validates it once, then repoints the underlying real target at the app-data directory and
  confirms the NEXT read is rejected -- set-time validation alone would have missed this.
- **`listOperationsFiles(input)`:** returns `{ configured: false }` (never a silently empty list)
  when unconfigured; otherwise walks the configured directory (depth-capped at 6, file-count
  capped at 300, reporting `truncated: true` if either cap was hit), returning each entry's
  path (POSIX-normalized, relative to the workspace root -- the absolute base path itself is
  never returned, since it would leak host filesystem layout/username), `isDirectory`, and
  `sizeBytes` (`null` for directories). Dotfiles/dot-directories are always excluded (checked
  against every segment of the RESOLVED real path, not just each entry's own basename -- a
  symlink resolving into the middle of a dotted ancestor, e.g. `docs -> .hidden/sub`, is excluded
  too, not only a symlink whose own immediate target is itself dotted); files are further
  filtered to an extension allowlist (`.md`/`.txt`/`.json`/`.yaml`/`.yml`) -- directories are
  still listed for navigability regardless of what they contain. **The depth/file-count caps are
  cost bounds on the recursive walk, not an access-control guarantee** -- `getOperationsFile` has
  no matching depth/count limit of its own (it resolves and validates one exact path directly),
  so a file beyond `list`'s caps that a caller already knows the exact path to (from a source
  outside this listing) can still be read by `get`; `truncated: true` honestly signals list's own
  incompleteness, it does not imply anything is actually hidden from `get`.
- **`getOperationsFile({ path })`:** returns `{ configured: false }` when unconfigured; otherwise
  requires the given relative path to survive BOTH a cheap syntactic pre-check (no `..` segments,
  not absolute, no control characters) AND the authoritative `realpath`-plus-`path.relative`
  containment check against the real, current workspace root -- a naive `startsWith` prefix check
  was deliberately avoided (it would wrongly accept a sibling directory like `/x/instr-evil`
  against a configured `/x/instr`). A path that fails either check gets the exact same
  `OPERATIONS_FILE_NOT_AVAILABLE` error as a genuinely nonexistent file -- never distinguishable,
  to avoid confirming what does or doesn't exist outside the workspace. Content is capped at
  200,000 bytes per file (`truncated: true` if the real file is larger).
- **Symlink handling, verified with real temporary directories and real symlinks (not mocked
  `fs`):** a symlink that stays inside the workspace is followed and its content returned
  normally; a symlink escaping the workspace (or resolving into the app-data directory) is
  rejected for `getOperationsFile`, and silently skipped (never surfaced as an error, matching
  this module's own "never fabricate" discipline) when encountered during `listOperationsFiles`.
  An independent review round found and fixed a narrower bypass: a symlink whose VISIBLE name has
  an allowed extension (e.g. `notes.md`) could still resolve to a dotfile or disallowed-extension
  REAL target while staying inside the workspace (e.g. `notes.md -> .secret-config`) -- the
  dotfile/extension exclusion only ever checked the requested/visible name, never what the
  symlink actually resolves to. Both `listOperationsFiles` and `getOperationsFile` now also
  re-check the RESOLVED path's own basename/segments after `realpath`, not just the caller-visible
  one. Containment itself was never affected by this (the resolved target still had to be inside
  the workspace) -- this closed a same-workspace disclosure gap, not an escape. A LATER review
  round found `listOperationsFiles`'s own dot-exclusion check was still incomplete even after that
  fix: it only inspected each resolved entry's immediate basename, not every segment between the
  workspace root and that entry -- so a symlink resolving into the MIDDLE of a dotted ancestor
  (e.g. `docs -> .hidden/sub`, whose own basename `sub` isn't itself dotted) still disclosed that
  dotted directory's filenames/sizes (metadata only -- `getOperationsFile` already correctly
  rejected reading them, since it checked every segment from the start). Fixed by making
  `listOperationsFiles` check every segment too, matching `getOperationsFile`'s existing logic.
- **Root-caused, then eliminated as a bug CLASS, not just patched again.** Three independent
  review rounds each found a real gap in this exact area, and all three had the same underlying
  cause: `listOperationsFiles`'s `walk()` and `getOperationsFile` each carried their own,
  separately-evolving copy of the admissibility logic (containment, dot-segment exclusion,
  extension allowlist), so every fix to one silently left the other behind. Refactored to a single
  shared `classifyEntry(realBase, visibleRelPath, realPath)` predicate both functions call --
  there is now exactly one place this logic can drift out of sync with itself. Also added, as part
  of the same refactor: a symlink-cycle guard in `walk()` (an ancestor-chain check, not a
  whole-walk "ever visited" set -- the latter would wrongly treat two unrelated symlinks pointing
  at the SAME real directory as a false cycle, dropping the second one). A dedicated invariant
  test now asserts, over one fixture combining every case all three rounds found individually,
  that every file `listOperationsFiles` returns is also readable via `getOperationsFile` and that
  every excluded case is rejected identically by both.
- **New agent-operations capabilities:** `operations_workspace.list_files` (READ),
  `operations_workspace.get_file` (READ) -- both READ, since listing/reading never mutates
  anything. MCP `agent_list_operations_files`/`agent_get_operations_file`, CLI
  `agent list-operations-files`/`agent get-operations-file` -- no HTTP route (MCP/CLI-first, same
  precedent as every other slice). Neither is channel-scoped: no `channelId`/`assertActiveChannel`
  check, mirroring `agent_get_capabilities`'s own instance-level pattern. Neither is gated by the
  device-availability/recovery-mode check -- both are pure filesystem reads. `AGENT_API_VERSION`
  bumped to `0.8.0`.
- **Settings UI:** a new "Codex operations workspace" card (AI Agent sub-tab, next to MCP
  connection), a single text input plus Save button, following the exact pattern already
  established for the Analytics auto-collection settings card. Verified live in a browser
  end-to-end: a real directory could be saved, its one real file was then actually listed and
  read back through the CLI (`agent list-operations-files`/`agent get-operations-file`), an
  invalid (relative) path was rejected with a clear inline error, a path overlapping the real
  app-data directory was rejected, and clearing the field back to empty worked.

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
Slice G (Content Proposal -- see §4f) is the first WRITE capability to carry `HYPOTHESIS`-class
fields on its own record, not just a read of one: `publicationHypothesis`/`expectedMetrics`
(inside `brief`) are the agent's own prediction, never a server-verified fact -- same
naming/doc-comment-only classification as above (the field names themselves signal "hypothesis,"
per their own doc comment in `content-proposals/contracts.ts`). `ACTION`/`OUTCOME` remain
unexercised by any slice so far.

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
| `CONTENT_PROPOSAL_NOT_AVAILABLE` | 404 | a Content Proposal reference that doesn't exist, or belongs to another channel |
| `INVALID_CONTEXT_REQUEST` | 400 | a context request with an invalid shape/combination of options |
| `DRAFT_VALIDATION_FAILED` | 422 | a DRAFT object failed field-level validation |
| `APPROVAL_REQUIRED` | 403 | an operation that needs human approval was attempted without it |
| `EXECUTION_NOT_AUTHORIZED` | 403 | an EXECUTE-class operation attempted without that permission |
| `AGENT_TOKEN_INVALID` | 401 | Phase 12: missing/unknown/revoked agent token, a token whose channel is no longer connected to its identity, or agent access switched off (MCP connection). One indistinguishable code. |
| `AGENT_SESSION_OPERATOR_ONLY` | 403 | Phase 12: an operator-only action (identity/selection switching, `auth *`, `asset register`, operations workspace) attempted in a channel-bound agent session. |
| `AGENT_SESSION_CREDENTIAL_OVERRIDE` | 403 | Phase 12: an agent session supplied its own `credentialRef`/`--userId`/`--accessToken`. |
| ~~`AGENT_ZONE_VIOLATION`~~ | -- | Retired with BL-091 capability zones (`docs/decisions/0011-retire-agent-capability-zones.md`); never thrown any more. |

**Device-gate codes (outside `DomainErrorCode`, from `src/lib/device-mutation-gate`).**
- **`operation_lock_held` (409) is transient and retryable.** It means an export, import or
  migration is running. Since automatic device sync (ADR 0012), the app exports about once a
  minute while there are unpublished changes, and each export holds the lock for about a second.
  An agent should retry a refused mutation after a short wait. Reads are never refused. Since the
  same change, an MCP/CLI process also starts normally while an export runs.
- **`device_in_recovery_mode` (423) is not retryable.** It persists until the unresolved YouTube
  write is reconciled.

## 7. Implementation status by slice (owner spec §29's recommended order)

| Slice | Scope | Status |
|---|---|---|
| A | Contracts + capability/version discovery | **IMPLEMENTED** -- `src/lib/agent-operations/`, MCP `agent_get_capabilities`, CLI `agent capabilities`, `GET /api/agent-operations/capabilities` |
| B | Read-only channel/video context | **IMPLEMENTED** -- see §4a; MCP `agent_get_channel_context`/`agent_get_video_context`, CLI `agent channel-context`/`agent video-context`. No HTTP route yet. |
| C | Analytics interface (agent-oriented wrapper over `src/lib/analytics/`) | **IMPLEMENTED** -- see §4b; MCP `agent_query_channel_analytics`/`agent_query_video_analytics`, CLI `agent channel-analytics`/`agent video-analytics`. No HTTP route yet. |
| D | Asset catalog/context (new subsystem -- nothing to reuse) | **IMPLEMENTED** -- see §4c; MCP `agent_list_assets`/`agent_get_asset_context`, CLI `agent list-assets`/`agent get-asset-context`/`asset register`. No HTTP route yet. |
| E | Agent draft/proposal provenance | **PARTIAL** -- see §4d; MCP `agent_get_generation_provenance`, CLI `agent get-generation-provenance`. No HTTP route (reuses the pre-existing one). "Originating task" (owner spec §22) still not recorded (RISK-57). |
| F | Bulk localization integration -- evidence, rationale, identity stamping | **PARTIAL** -- see §4e; widens the existing `ai_localization_create_change_set` MCP tool, CLI command, and Web route (`ai_localization_generate` is untouched). Evidence/rationale are per-Change-Set, not per-proposal (RISK-55, known limitation). |
| G | Content Proposal / external artifact registration | **CLOSED** -- see §4f; new `src/lib/content-proposals/` module, `content_proposals`/`content_proposal_artifacts` tables. Proposal create/get/list and external-artifact register/list both implemented. |
| H | Full MCP/API surface (ongoing -- each slice above adds its own tools as it lands) | **VERIFIED, against the recovered verbatim spec, 2026-09-24.** Cross-checked that every `AGENT_CAPABILITIES` entry points at an actually-registered MCP tool and that every `agent_*` MCP tool has CLI parity -- zero drift. The initial capability set (owner spec §25) is fully present. The session's original verbatim spec text (34 numbered sections, sent over Telegram 2026-09-23) is not stored anywhere in this repository -- it was recovered from this session's own pre-compaction transcript to check the sections this document had never previously cited, rather than trusting citation coverage alone. That recheck found two real, previously-untracked gaps outside slice H's own scope -- §4g/§4h below (owner spec §10/§16, `BL-088`/`BL-089`) -- and one process gap, §4i (owner spec §28, no dedicated Phase 7 acceptance-contract document). Every other previously-uncited section (§3, §8, §11, §20, §21, §22, §23, §24, §26, §29-33) was confirmed either already implemented, already tracked as a known gap, or deliberately narrowed/overridden by a later, explicit owner instruction (§3/§30, slice I). |
| I | Codex operations-workspace path surfacing | **IMPLEMENTED** -- see §4j; owner decision, Telegram 2026-09-24, narrowed this slice to a path-configuration/surfacing mechanism only (never an operations-workspace template or editorial-guideline document committed here, per `AGENTS.md` §B). New `src/lib/operations-instructions/` module, Settings-only `operationsWorkspacePath` setting, MCP `agent_list_operations_files`/`agent_get_operations_file`, CLI `agent list-operations-files`/`agent get-operations-file`. `AGENT_API_VERSION` → `0.8.0`. |
| K | Comparable-content context (`find_comparable_videos`, owner spec §10) | **IMPLEMENTED, independent-review cycle closed (4 rounds, findings 3/4/4/0)** -- see §4g; found by the slice-H spec recovery, 2026-09-24, then explicitly assigned into this phase by the owner the same day ("Да, такие находки как BL 88 и 89 тоже включай в список тасков текущей 7 фазы", Telegram). New `src/lib/comparable-content/` module (K1) plus `videos.durationSeconds` sync (K0, schema v19). MCP `agent_find_comparable_videos`, CLI `agent find-comparable-videos`. `AGENT_API_VERSION` → `0.9.0`. `BL-088`. |
| L | Performance ↔ asset linkage (owner spec §16) | **IMPLEMENTED, independent-review cycle closed (4 rounds, findings 5/1/1/0)** -- see §4h; found and assigned the same way and same day as slice K. New `src/lib/asset-performance/` module. MCP `agent_list_asset_performance`, CLI `agent list-asset-performance`. `AGENT_API_VERSION` → `0.10.0`. `BL-089`. |
| J | Independent security/integration review | **Per-slice review cycles: covered by each slice's own `docs/roadmap/BACKLOG.md` row (BL-079 onward through BL-089) -- not restated here as a round tally.** Slice J's own NEW, phase-wide work (owner spec §28's acceptance contract, backfilled for A-I plus fresh cross-cutting checks for the assembled whole) is done -- see §4i and `docs/acceptance/PHASE_7_ACCEPTANCE.md` §8-§11, `BL-090`. Remaining before this phase can be considered fully closed: the owner's own explicit "yes, merge" approval (`AGENTS.md` §K.2) -- never inferred from a clean review, and never granted by this document. |

Deliberately **not** implemented in this phase (owner spec §14/§29): the Experiment Engine
(Phase 10) and the competitor/trend intelligence extension point -- both later implemented as
their own separate phases' own follow-up assignments, not part of this phase's own owner-spec
slices. `query_market_intelligence`/`query_competitors` landed 2026-09-26 as Phase 9's own slice
4 (§4k below); `create_experiment_proposal` landed 2026-09-29 as Phase 10's own slice 2 (§4l
below) -- `plannedFutureCapabilities` now names `create_hypothesis` instead, a NEW reservation (not
from the original owner spec §14 list) derived from `FUTURE_PHASES.md` §6's own "Agent
integration" paragraph ("propose hypotheses") during slice 2's own scoping -- flagged for the
project owner's awareness, since reserving a new agent-visible capability name is itself worth
their explicit confirmation even though it changes no behavior on its own.

## 4k. Market intelligence query surface (Phase 9 slice 4, `docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`) -- IMPLEMENTED

Not one of this document's own owner-spec slices (A-L above) -- Phase 9's own follow-up assignment,
which happens to fulfil two capability names this interface reserved back in slice A
(`PLANNED_FUTURE_CAPABILITIES`). Full design/data-model detail lives in
`docs/roadmap/plans/PHASE_9_PLAN.md`/`docs/ARCHITECTURE.md` §18 -- this section records only how it
plugs into this interface.

- **`query_competitors`** (MCP)/`agent competitors` (CLI) -- every channel on the research
  watchlist (`channelId`, `handleOrUrl`, `reason`, `addedAt`), no evidence attached. Since BL-163 each
  entry also carries `latestUploadPublishedAt` (raw, null when unknown), `inactive`, `pausedAt` and
  `pausedReason` (as `query_market_overview`; additive, no version bump).
- **`query_market_intelligence`** (MCP)/`agent market-intelligence --channelId <UC...>` (CLI) -- one
  watchlisted channel's own record plus its evidence history (Phase 13: another channel's API-sourced rows
  only within the last 30 days, operator-entered rows at any age); `RESEARCH_CHANNEL_NOT_AVAILABLE`
  if the given `channelId` isn't on the watchlist.
- Both registered directly in `src/mcp/server.ts`/`src/cli/video-metadata.ts` against
  `createMarketIntelligenceCore()` -- **not** a new function in this module's own service layer,
  unlike slice C/K/L's wrappers over `analytics`/`comparable-content`/`asset-performance`. See
  `docs/ARCHITECTURE.md` §18's own note on why (module-independence, `PHASE_9_PLAN.md` §5).
  `AGENT_CAPABILITIES` still gained two entries (`market_intelligence.query_competitors`/
  `market_intelligence.query_market_intelligence`, domain `market_intelligence`, both READ) for
  capability-discovery completeness -- the same pattern already used for
  `channel_context.list_channels`/`analytics.query_data_quality`.
- Global data, never channel-scoped (research data describes channels the operator does not
  necessarily own) -- no `channelId`/active-channel check on either, matching
  `operations_workspace.list_files`'s own precedent. Neither accepts `credentialRef` -- neither
  makes a live YouTube call.
- `AGENT_DATA_DOMAINS` gained `competitor_intelligence` (the literal name this module's own
  contracts already reserved for it). `AGENT_API_VERSION` → `0.11.0`.


**Phase 13 (2026-10-01, YouTube API Developer Policies III.E.4.d/h, owner decision D1 = a):**
- Watchlist channels are someone else's (Non-Authorized) data.
- `subscriberVelocity`, `uploadCadence` and per-video `velocity` now return `{ value: null, basis:
  "withheld_by_policy" }`.
- `recentBreakoutVideos`, `breakoutVideos` and `emergingChannels` are always empty, and
  `emergingChannel.reasons` states the policy.
- Raw snapshots are still returned, each with its time.
  - API-sourced snapshots and "Fetch public snapshot" evidence are returned only for the last 30 days, and older
    ones are deleted.
  - Operator-entered snapshots and evidence are returned at any age and never deleted.
- The response shapes are unchanged, so `AGENT_API_VERSION` is unchanged.

## 4l. Decision-engine agent surface (Phase 10 slice 2, `docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md`) -- IMPLEMENTED

Fulfils the `create_experiment_proposal` name this interface reserved since Phase 7 (§14, kept
exactly as reserved, never renamed). Full design lives in the slice's own plan doc; this section
records only how it plugs into this interface.

- **`agent_list_hypotheses`** (MCP)/`agent list-hypotheses` (CLI, `READ`) -- every hypothesis
  visible to the caller, channel-filtered by `decision-engine`'s own service layer.
- **`agent_get_hypothesis_trail`** (MCP)/`agent get-hypothesis-trail --hypothesisId <id>` (CLI,
  `READ`) -- one hypothesis plus every experiment against it, each with its own outcomes, in one
  call (owner spec §25's "few composable tools" rule) -- `HYPOTHESIS_NOT_FOUND` for an unknown id.
- **`create_experiment_proposal`** (MCP)/`agent create-experiment-proposal` (CLI, `DRAFT`) --
  creates an experiment against an already-existing hypothesis, always `status:"proposed"`; no
  field or tool lets an agent set any other status. Gated the same way as
  `market_intelligence.agent_create_market_research_request`.
- Deliberately NOT reachable via MCP/CLI, mechanically verified
  (`decision-engine-agent-approval-inventory.test.ts`, `PHASE10-INV-02`): creating a hypothesis
  from scratch, any experiment status transition, and recording an outcome -- all Web-UI-only.
  `PLANNED_FUTURE_CAPABILITIES` now names `create_hypothesis` instead (agent-created hypotheses,
  deliberately deferred to its own future slice).
- `AGENT_CAPABILITY_DOMAINS` gained `decision_engine`; `AGENT_DATA_DOMAINS` gained
  `experiment_history` (the literal name already reserved for it). `AGENT_API_VERSION` → `0.14.0`.

## 4m. Channel workspace path (Phase 11, `docs/roadmap/plans/PHASE_11_PLAN.md`) -- IMPLEMENTED

This implements `docs/roadmap/FUTURE_PHASES.md` §11's narrowed scope: one local
production-workspace path per linked channel, per device. This product's own responsibility
ends at the path string.

- **`agent_get_channel_workspace {channelId}`** (MCP)/`agent channel-workspace --channelId
  <UC...>` (CLI, `READ`, capability `channel_workspace.get_channel_workspace`). It uses the
  same active-channel scoping as `agent_get_channel_context`.
  - It returns `{ configured: true, path }` exactly as stored, or `{ configured: false }`, never
    an empty-string path.
  - It never touches anything at or under the path: no listing, no reading, no re-validation. The
    only file it reads is this app's own bootstrap config, for the `deviceId`, and it never
    creates that file. A folder
    moved or deleted since it was set still reads back as stored. The agent checks it with its
    own tools.
- **Set only by the operator:** Settings → Channels → the per-row "Production workspace folder"
  field (`PUT /api/channel-workspaces`).
  - At set time the path must be absolute, exist, be a directory, and not overlap the app-data
    directory. This reuses slice I's check, now shared as `src/lib/local-path-validation/`.
  - No MCP tool or CLI command can set or clear the path. This is mechanically tested: the read
    schema is `.strict()`, the registry holds exactly one `*workspace*` tool, and `parseArgs`
    rejects any setter command.
- **Device-local:** the table is `channel_workspaces`, keyed `(device_id, channel_id)` on the
  bootstrap `deviceId`. It is excluded from `SNAPSHOT_TRANSFERRED_TABLES` and from
  `sync-gateway` on purpose. It is not a RISK-52-style omission.
- **Deliberate posture difference from slice I (§4j):** `operations-instructions` never
  exposes its absolute base path, because that leaks host layout and the username. This
  capability's whole deliverable *is* the absolute path, handed to an agent authorized for
  that channel. The owner asked for this explicitly (FUTURE_PHASES §11), and the exposure is
  limited by active-channel scoping.
- `AGENT_CAPABILITY_DOMAINS` gained `channel_workspace`, and `AGENT_DATA_DOMAINS` gained
  `channel_workspace_path`. `AGENT_API_VERSION` → `0.15.0`.
- The global operations workspace (§4j) is unchanged.

## 4n. Channel-bound agent sessions (Phase 12, `docs/roadmap/plans/PHASE_12_PLAN.md`) -- IMPLEMENTED

This is a breaking change to this interface, so `AGENT_API_VERSION` → `1.0.0`. Every agent
session is bound to exactly one channel by an operator-issued channel token. **Since
`docs/decisions/0013-in-app-http-mcp-transport.md` (`AGENT_API_VERSION` → `2.0.0`) the token is a Bearer
credential on the app's own MCP endpoint (`POST /api/mcp`); stdio MCP and the CLI agent mode are removed.**

- **Enforcement at two choke points** (`src/lib/agent-session`), not in each handler. In a bound
  process:
  - the "selected channel" is the bound channel, and writes to it are no-ops;
  - credentials are always the token's recorded identity, and caller `credentialRef` /
    `--userId` / `--accessToken` are rejected.

  Every existing `assertActiveChannel` / write-context check therefore enforces the binding
  unchanged. `list` / `transcript` / `preview` / `channel_sync`, which bypass
  `assertActiveChannel`, are confined in their core wiring.
- **Surface.** Only tools and commands classified `bound` are registered or accepted. The
  classification tables are checked against the real registries by inventory tests.
  Operator-only: identity/selection switching, `auth *`, `asset register`, and the
  operations-workspace tools (§4j; owner decision D2: channel folders only). The
  `operations_workspace` capabilities are therefore hidden from `agent_get_capabilities` in an
  agent session.
- **Market intelligence (§4k)** returns only records the operator assigned to the agent's channel.
  A record not assigned to it behaves as nonexistent. An agent-created research request is owned
  by its channel.
- **Decision engine (§4l):** channel-less hypotheses are invisible to agents.
- **Capability zones (BL-091) are retired** (`docs/decisions/0011-retire-agent-capability-zones.md`).
  There is no `AGENT_CONNECTION_ID` any more.
- **Migration for an existing client:** issue a token in Settings → Channels, point the client at the
  app's MCP URL with that token as a Bearer credential (no launch command, no project path), drop
  `AGENT_CONNECTION_ID`, and stop passing `credentialRef`. Setup: `docs/AGENT_ISOLATION_SETUP.md`.

## 4o. Collection requests (ADR 0021) -- IMPLEMENTED; `AGENT_API_VERSION` 3.2.0

MINOR bump 3.1.0 -> 3.2.0: three new capabilities in `market_intelligence`. `agent_create_collection_request` (`DRAFT`, channel-bound, passes the
device mutation gate) stores a pending request with a local upper-bound estimate in YouTube quota units (not model tokens); it makes no YouTube call
and has no `force`. `agent_get_collection_request` and `agent_get_collection_limits` are `READ`. The agent can neither approve nor run nor reject a
request (Web only, mechanically fenced); an approved request runs the REGULAR collection for its channels (24 h stale window, 24 h failure pause,
daily budget). Channels collected or failed within 24 h are reported `not_needed`; a channel with an open request is `alreadyRequested`. A request is
a request may end `done` with every channel `skipped_*` (read the per-channel results); incremental estimate about 2, at most 5 units; owned by the creating agent's channel (assignment kind `collection_request`); another request behaves as nonexistent. Contract: `docs/interfaces.md`.

## 4p. Logical paths (BL-129, ADR 0022) -- IMPLEMENTED; `AGENT_API_VERSION` 3.3.0

MINOR bump 3.2.0 -> 3.3.0: two new `READ` capabilities in the new `logical_paths` domain (data domain `logical_path_values`). `agent_list_logical_paths` and
`agent_get_logical_path { name }` return the operator-configured named folders that are visible to every agent (for example a shared registry folder), with THIS
device's value. They are not channel-scoped (the registry is instance-wide), `bound`, local, with no filesystem access: the string is returned exactly as stored.
`configured: false` / `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE` means no folder is set on this computer (never an empty path). A path the operator reserved for another
role, and an unknown name, both fail with `LOGICAL_PATH_NOT_FOUND`, indistinguishably. No agent tool can create, set or delete a path. The Factory Operator is a
different role on a different endpoint with its own tools and its own version: see `docs/interfaces.md` ("Factory Operator MCP endpoint") and ADR 0022; none of
its tools appears in this interface, and none of the channel tools is callable on that endpoint.

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

## 4q. Remote media generation (Phase 14 slice 5, `docs/roadmap/plans/PHASE_14_PLAN.md` §2.7) -- IMPLEMENTED; `AGENT_API_VERSION` 3.4.0

MINOR bump 3.3.0 -> 3.4.0 (`dev`'s 3.3.0 is Factory Operator access, §4p; this one bump carries all of Phase 14 -- the seven tools below and the slice 6 fields, ADR 0023 amendment 1): several sessions may be open and run at once (each its own pod);
`agent_request_media_session` no longer returns `media_session_conflict` for another open session. `agent_get_media_limits` adds
`openSessions` (this channel's non-terminal sessions, oldest first), `maxConcurrentSessions` and `activeSessionCount` (device-wide);
`openSession` (= the first of `openSessions`) and `deviceHasOpenSession` (informational) stay. `media_session_conflict` now comes only
from a human's approve (the concurrency limit, or a model pull holding the volume) -- the request then stays `pending`.


Seven capabilities in the new `media_generation` domain (`src/lib/media-generation/`, registered directly in
`src/mcp/server.ts`, AGENTS.md §M). READ: `agent_list_media_templates`, `agent_get_media_session`, `agent_get_media_limits`,
`agent_get_media_job` (BL-144: plus an optional live `progress` from ComfyUI's own execution events while this device watches a generating job -- node N of M, steps, percent, never estimated). DRAFT (channel-bound, mutation-gated): `agent_request_media_session`, `agent_create_media_job`,
`agent_cancel_media_job`. Model: the agent REQUESTS a session (one RunPod GPU pod running ComfyUI, caps `maxMinutes`/`maxUsd`; a local
estimate = saved GPU price × minutes / 60, no RunPod call); a human approves/starts/stops it in Production → Sessions (Web-only, fenced by
`session-approval-inventory.test.ts` from `src/mcp`, `src/cli`, `src/lib/agent-operations`); while it is `running` the agent submits jobs
against operator-imported workflow templates (parameters validated before any ComfyUI call); outputs are pulled to
`<channel workspace>/99 Data Exchange/From YTM/media/<jobId>/`, registered in the asset catalog with provenance, and deleted from the
server volume. A final job's folder ends with `manifest.json` (FO-REQ-0002: job, template, params, device, every delivered file with
`bytes`/`sha256`, missing outputs); `done` is only reached once it is on disk. On another device (folder synced by a file-sync tool) the
folder is complete when the manifest exists AND every listed file is present with its `bytes`. BL-132 (Agent API 3.5.0, ADR 0025): templates carry
`source` (`factory` = from the factory template registry, the same id and version on every device; `owner` = imported locally) and `models`; a
parameter of type `image`/`audio`/`video` is an INPUT FILE named by a path relative to the workspace's `99 Data Exchange/Sent to YTM/`, checked and
uploaded for that job before the prompt is submitted (`media_input_unavailable` otherwise), listed in the job's `inputs[]`, removed from the server
after the job ends; the agent's own file is never deleted. BL-135 (Agent API 3.6.0): the agent may END its own session
(`agent_release_media_session`: withdraw a pending request or stop its pod) and may request one with `releaseWhenDone`, which the watcher stops
one minute after the last job; since 3.7.0 a request without the flag takes the owner's setting (on by default), so pass `false` to keep
the pod between bursts. It still cannot approve or start one. Several sessions may run at once (3.4.0); a session/job of another channel is reported as not found. The watcher terminates the pod on
idle / minutes / USD; every job submit or poll counts as activity. Contract: `docs/interfaces.md`.

**Generation plans (BL-143 phase 3, Agent API 3.8.0):**
- `agent_list_generation_plans` / `agent_get_generation_plan` show the Factory Operator's plans for this channel, read-only:
  - stages and waves (with the owner's notes);
  - items, without job params;
  - the derived progress and notices;
  - for one plan, its events. These include the owner's listening verdicts (rating out of 10, reasons, time markers, note);
    job error texts are left out.
- An agent cannot create, change, run or close a plan. Contract: `docs/interfaces.md`.

**Video milestones (BL-166, Agent API 3.9.0, `docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md`):**
- `agent_get_video_milestones` (capability `analytics.query_video_milestones`, READ) returns the stored day-7 and day-28 milestones of the
  channel's own videos: the window totals and the 100-point retention curve as YouTube returned them, with the video's stored length.
- Collected in the background with the Analytics collection (2 Analytics API queries per milestone, at most 25 per channel per run); a local
  read, never a live call. Each computer collects the milestones of the channels connected on it. Contract: `docs/interfaces.md`.

**Stored traffic sources and devices (BL-168, Agent API 3.10.0, `docs/roadmap/plans/VIDEO_BREAKDOWNS_PLAN.md`):**
- `agent_get_stored_breakdowns` (capability `analytics.query_stored_breakdowns`, READ) returns views and watch minutes per traffic source
  type and per device type, per day as YouTube returned them, for the channel as a whole or for up to 20 of its videos (each video's first
  90 days), summed over a date range or listed by day, with the stored coverage of each.
- Collected in the background with the Analytics collection, once a day (2 Analytics API queries per subject, at most 100 subjects per
  channel per run); a local read, never a live call. Each computer collects the channels connected on it. Contract: `docs/interfaces.md`.
