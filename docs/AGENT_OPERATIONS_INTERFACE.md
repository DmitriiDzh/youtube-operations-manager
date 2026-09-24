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
for this slice's actual two response shapes). `HYPOTHESIS`/`DECISION`/`ACTION`/`OUTCOME` remain
unexercised until a later slice (E: draft/proposal provenance) actually produces that kind of data.

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
| D | Asset catalog/context (new subsystem -- nothing to reuse) | PLANNED |
| E | Agent draft/proposal provenance | PLANNED |
| F | Bulk localization integration (wraps `src/lib/ai-localization/`, already has MCP/CLI tools from BL-078 -- this slice is about context/evidence enrichment around that existing workflow, not a new persistence path) | PLANNED |
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
