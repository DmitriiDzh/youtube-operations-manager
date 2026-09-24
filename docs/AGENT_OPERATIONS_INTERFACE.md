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

## 4g. Comparable-content context (owner spec §10) -- NOT IMPLEMENTED, not previously tracked

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
`proposed` -- not assigned, not started; the smallest safe first slice would likely reuse
`youtube-read-gateway`'s already-synced local channel/video mirror plus simple metadata-field
filtering, no new data source.

## 4h. Performance ↔ asset linkage (owner spec §16) -- NOT IMPLEMENTED, not previously tracked

Found the same way as §4g, same date. The spec asks for the interface to expose associations
along `video → asset → metadata/version → analytics → experiment/outcome` so an agent can answer
questions like "which thumbnails were used by high-CTR videos" or "which visual concepts
repeatedly appeared in stronger-performing videos" -- explicitly leaving causal inference to the
agent, not the product. Today, `creative_assets.linkedVideoId` records a raw video association
(slice D), and `content_proposal_artifacts` records a proposal association (slice G2), but neither
is joined against `video_metrics_daily`/analytics anywhere in this interface -- an agent must
currently fetch a video's assets and its analytics separately and correlate them itself, with no
product-provided join. Tracked as `BL-089` (`docs/roadmap/BACKLOG.md`), `proposed` -- not
assigned, not started.

## 4i. Dedicated Phase 7 acceptance-contract document (owner spec §28) -- NOT PRODUCED

Owner spec §28 asks for "a dedicated Phase 7 acceptance contract" produced **before**
implementation, covering an explicit list of scenarios (version/capability discovery, channel
isolation, no dev-repo dependency, no direct DB access, no secret exposure, and more -- see the
recovered spec text). Every prior phase in this repository that reached this maturity got its own
`docs/acceptance/PHASE_N_ACCEPTANCE.md` (Phase 5, Phase 6, Phase 6 AI Connections, the
cross-platform pre-release work) -- Phase 7 has not. Acceptance criteria WERE derived from the
spec per slice, before each slice's own implementation (`AGENTS.md` §L's discipline was followed
throughout, and independent review cycles verified this repeatedly), so the substantive intent of
§28 was not skipped -- but no single, consolidated document exists recording that contract the way
`docs/acceptance/PHASE_6_ACCEPTANCE.md` does for Phase 6. Producing one retroactively (from the
now-recovered spec text plus the acceptance criteria already implicit in each slice's own test
suite) is appropriate work for slice J (independent security/integration review) or immediately
before the final `dev` merge, not urgent before slice I.

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
  `sizeBytes` (`null` for directories). Dotfiles/dot-directories are always excluded; files are
  further filtered to an extension allowlist (`.md`/`.txt`/`.json`/`.yaml`/`.yml`) -- directories
  are still listed for navigability regardless of what they contain.
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
