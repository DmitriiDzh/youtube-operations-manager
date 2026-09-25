# PHASE_7_ACCEPTANCE.md

**Status: retroactive/incremental acceptance contract, started 2026-09-24, slice J section added 2026-09-25.** Owner spec §28 asks for a dedicated Phase 7 acceptance contract, produced before implementation. Slices A-I were implemented before this document existed; their acceptance criteria WERE derived from the spec per slice (each slice's own commit history and `docs/AGENT_OPERATIONS_INTERFACE.md` sections record this), just never consolidated into one document (`docs/AGENT_OPERATIONS_INTERFACE.md` §4i tracked this gap; §8-§9 below now close it retroactively for A-I, and fully for J's own new cross-cutting work). **This document covers slice K (§1-§4, implemented, independent-review cycle closed 4 rounds 3/4/4/0), slice L (§5-§7, implemented, independent-review cycle closed 4 rounds 5/1/1/0), and slice J (§8-§11, the final phase-wide security/integration review, §28's own scenario checklist plus fresh cross-cutting checks).**

This document is derived strictly from:

- The recovered verbatim owner spec, §10 ("Comparable-content context") — "For decisions such as localization or creative generation, provide tools to retrieve relevant comparable owned content... Possible filters: same channel; same content family; similar topic; similar duration; similar publication period; similar target audience; similar metadata pattern; historical performance threshold. Do not hard-code a single comparison algorithm. The first implementation may use explicit filters and simple ranking. Do not prematurely build embeddings/vector search unless actual use cases require it."
- Owner spec §9 ("The exact metrics must follow the ACTUAL data currently collected. Do not invent unavailable metrics") and §23/§24 (context size/efficiency, freshness) — inherited unchanged.
- `AGENTS.md` §D (reuse existing modules, one owner per capability), §F (channel-scoping is never automatic), §L (spec-derived, independent testing), §M (feature-module independence).
- The project owner's explicit assignment of BL-088 into this phase (Telegram, 2026-09-24: "Да, такие находки как BL 88 и 89 тоже включай в список тасков текущей 7 фазы").

---

## 1. Scope boundary — slice K (comparable-content context, owner spec §10)

**In scope:** an anchor-based `find_comparable_videos` capability over already-synced, already-collected local data only (no live YouTube call). Filters that map to real, currently-collected data: same channel (mandatory anchor), publication-date proximity, duration proximity (new: durationSeconds sync, see §2 below), and an age-aligned performance-metric threshold (reusing the existing Phase 8 comparable-age analytics logic, never a second implementation). An explicit, named `titleTokenOverlap` signal (shared significant words between titles) stands in for "similar topic" — explicit and inspectable, never called "topic similarity" as if it were semantic understanding, and never embeddings/vector search (explicitly forbidden by the spec's own text above).

**Out of scope (not implemented, not claimed as implemented):**

- "Same content family" / "similar target audience" / "similar metadata pattern" — no data source exists for any of these (no series/family taxonomy, no audience classification, no structured metadata beyond title/description/tags-that-don't-exist). Not approximated; the capability description states plainly that these three are unsupported rather than silently ignoring the spec text.
- Embeddings, vector search, or any ML-based similarity — explicitly forbidden by owner spec §10 itself for a first implementation.
- Any live YouTube API call — this capability reads only already-synced local data (channel/video mirror) and already-collected analytics (`video_metrics_daily`), matching every other read-only agent-operations capability's own convention.
- Any write of any kind — this is a pure READ capability.
- Slice L (performance ↔ asset linkage, owner spec §16) — separately assigned, separately scoped, tracked in its own section of this document once started.

## 2. New persisted data: `videos.durationSeconds`

Owner spec §10 lists "similar duration" as an explicit filter. No duration field is currently synced from YouTube (`videos` table has no duration column; `contentDetails` is not among the parts requested by the batched `videos.list` sync call). Implementing the filter honestly (never inventing data) requires adding this field to the existing sync path — not a new subsystem, an additive extension of the already-existing Studio-parity `viewCount`/`commentCount`/`likeCount` sync precedent (`SCHEMA_MIGRATIONS` version 4).

- AC-DUR-01: a fresh channel sync fetches `contentDetails.duration` (ISO-8601, e.g. `"PT10M30S"`) for every video alongside the fields already fetched, and persists it as `durationSeconds` (integer, nullable).
- AC-DUR-02: an ISO-8601 duration string is parsed to whole seconds correctly for every unit (`P`/`Y`/`M`/`D`/`T`/`H`/`M`/`S` combinations YouTube can plausibly return); an unparseable or absent value is stored as `null`, never `0` (owner spec §9's "never invent unavailable data" principle, already established for `viewCount`/`commentCount`/`likeCount`'s own nullable convention).
- AC-DUR-03: a `"P0D"`/all-zero duration (YouTube's placeholder for an in-progress live broadcast/premiere with no fixed length yet) is stored as `null`, never a literal `0`-second fact.
- AC-DUR-04: a targeted single-video field patch (`src/lib/video-details/`'s `refreshVideoFields`, which merges its edit forward onto the current stored row for every field it doesn't itself touch) copies the CURRENT stored `durationSeconds` forward unchanged — this edit path never fetches `contentDetails` itself, and must never silently clobber a previously-synced duration back to `null`.
- AC-DUR-05: schema initialization against a fresh (empty) database, an existing pre-migration database, and the pre-versioning-database re-apply path (`docs/DEVELOPMENT_PLAYBOOK.md` §6.11) all succeed and produce the expected column, mirroring the existing `view_count`/`comment_count`/`like_count` migration test coverage.
- AC-DUR-06: `videos` is not in `SNAPSHOT_TRANSFERRED_TABLES` (confirmed unchanged, not a new gap this slice introduces) — a device-handoff snapshot never carries video rows at all, so this new column has no device-handoff-specific transfer concern beyond what already applies to every other video column.

## 3. `find_comparable_videos` scenarios

- AC-CMP-01: given `{ channelId, anchorVideoId }` with no further filters, returns other videos from the SAME channel only, excluding the anchor itself from the results.
- AC-CMP-02: an `anchorVideoId` that does not belong to the requesting `channelId` (or does not exist) fails with a not-available error, never silently falling back to "no anchor" or leaking whether it exists on another channel.
- AC-CMP-03: a `publicationWindowDays` filter excludes candidates whose `publishedAt` falls outside the requested distance (in days) from the anchor's own `publishedAt`, in either direction.
- AC-CMP-04: a `durationToleranceSeconds` filter excludes candidates whose `durationSeconds` differs from the anchor's own `durationSeconds` by more than the tolerance; a candidate with `durationSeconds: null` is excluded from duration-filtered results (never treated as "0 duration" or "infinitely close"), and the response separately reports how many candidates were excluded for this reason (`excludedForMissingData.duration`) rather than silently shrinking the result set with no explanation. The ANCHOR itself having `durationSeconds: null` is a distinct scenario (there is no anchor value to compare anyone against at all) -- it fails the WHOLE request with `INVALID_CONTEXT_REQUEST` rather than silently excluding "the anchor" from its own result set (which wouldn't even make sense, since the anchor is never itself a candidate). This same precondition also applies to `sort: "durationProximity"` even without `durationToleranceSeconds` set, since sorting by a distance that can never be computed would otherwise silently produce an arbitrary order.
- AC-CMP-05: a `performanceThreshold` filter (a named metric from the existing `ANALYTICS_METRIC_NAMES`, a comparison operator, and a value) is evaluated AGE-ALIGNED — at the same number of days-since-publish for every candidate as for the anchor — reusing the existing Phase 8 comparable-age logic (`analytics_comparable_age`) rather than a second, parallel age-alignment implementation (`AGENTS.md` §D). The comparison day is the last day of CONTIGUOUS coverage the ANCHOR's own collected data reaches, counting from day 0 (`computeComparableAgeSeries`'s own documented behavior -- a single day the Analytics API silently omitted anywhere before that point collapses the comparison day to right before the gap, same as any other cumulative-series consumer of this shared logic) — never the anchor's current wall-clock age. Analytics collection intentionally never reaches "today" (`staleness.ts`'s own default collection range ends at yesterday), so picking "current age" as the comparison day would leave a recently-published anchor with no data at all yet, defeating the filter for exactly the query shape it exists for. A candidate with no analytics coverage at that day is excluded and counted in `excludedForMissingData.performance`, never silently given a `0`/failing value.
- AC-CMP-06: `sort` is an explicit enum (e.g. `publicationProximity`, `durationProximity`, `performanceMetric`, `titleTokenOverlap`) — never a single hard-coded "best match" ranking, per the spec's own "do not hard-code a single comparison algorithm" instruction. Each candidate's response row reports the raw comparison facts behind whichever sort was requested (date delta, duration values, the metric's value the anchor is compared against, or the actual shared title tokens) — never a single opaque similarity score.
- AC-CMP-07: `limit` is capped at a fixed maximum; a request that would exceed it returns `truncated: true` with the capped result set, never an unbounded response (owner spec §23).
- AC-CMP-08: the whole capability performs local reads only — no live YouTube API call, verified by a fake dependency set that throws if any YouTube-calling function is invoked.
- AC-CMP-09: `channelId` is checked against the caller's active channel at the MCP/CLI layer before the service is ever called, mirroring every other channel-scoped capability in this interface (`AGENTS.md` §F) — the service itself does no such check (consistent with this module's established convention).
- AC-CMP-10: the capability's own description explicitly states that "same content family," "similar target audience," and "similar metadata pattern" are NOT supported (no data source exists), rather than silently omitting them from the response with no explanation.

## 4. Deliberately not verified here

- Real YouTube OAuth/live API behavior for `contentDetails.duration` on an actual account (no live Google login available in this environment, `AGENTS.md` §G) — verified against this codebase's own parsing logic and documented ISO-8601 duration grammar only.
- A-I's backfilled scenarios (deferred to slice J per `docs/AGENT_OPERATIONS_INTERFACE.md` §4i).

---

## 5. Scope boundary — slice L (performance ↔ asset linkage, owner spec §16)

This section is derived strictly from the recovered verbatim owner spec, §16 ("Performance ↔ asset linkage"):

> A core requirement is to let the agent reason about historical creatives using performance data. The system should support questions such as: Which thumbnails were used by high-CTR videos? Which visual concepts repeatedly appeared in stronger-performing videos? Which duration/content combinations produced better watch time? Which production assets belonged to videos that underperformed? Which prior assets should be used as reference material for the next creative? Do not automatically infer causation. The interface should expose associations between: video → asset → metadata/version → analytics → experiment/outcome. The agent decides what hypotheses to draw.

Plus owner spec §9 ("never invent unavailable metrics," "every result must include metric definitions") and `AGENTS.md` §D (reuse, one owner per capability)/§M (feature-module independence, no reaching into `asset-catalog`'s own module for something it doesn't own).

**In scope:** a `list_asset_performance` capability joining the existing asset catalog (`creative_assets.linkedVideoId` — "this asset was used on this video," an operator/agent-asserted association `AGENTS.md` §F never verifies against YouTube) against each linked video's own already-collected performance data. Two kinds of performance are reported, never conflated:

- **Lifetime totals** (`viewCount`/`likeCount`/`commentCount`, already synced for every video since schema v4, plus `durationSeconds` from K0) — always present when known, explicitly labeled as lifetime, not age-fair (an older video has simply had more time to accumulate views than a newer one).
- **Age-aligned performance** (`performanceMetric` + a caller-supplied `dayOffset`, reusing `getCumulativeValueAtDayOffset` from `@/lib/analytics/comparable-age.ts` — the same shared helper slice K extracted, `AGENTS.md` §D) — only computed when both are explicitly requested. **The day offset is always caller-supplied, never auto-derived from wall-clock "now"** (the exact mistake independent review found and fixed in slice K, round 1 — deriving it from `now()` would make it null for most videos on any real, established channel, since day-0 collection coverage is the common failure mode this correction addresses generally, not just for a single "recently published" case).

This directly answers "which production assets belonged to videos that underperformed" and, as a proxy (grouping by `assetType`/`title`, which this capability does NOT itself do — that's left to the caller per "the agent decides what hypotheses to draw"), "which visual concepts repeatedly appeared in stronger-performing videos."

**Out of scope (not implemented, not claimed as implemented):**

- **"Which thumbnails were used by high-CTR videos"** — NOT supported. This application's own analytics collection (`ANALYTICS_METRIC_NAMES`, `src/lib/analytics/contracts.ts`) never fetches YouTube's `impressions`/`impressionClickThroughRate` metrics at all — there is no thumbnail-CTR data anywhere in this application to expose. Never approximated via `cardClickRate`/`annotationClickThroughRate` (in-video card/annotation clicks, an entirely different signal from thumbnail impressions on the watch/search page). Stated explicitly in the capability's own description, the same discipline slice K already applies to its own three unsupported filters.
- **"Which duration/content combinations produced better watch time"** — a video's own `estimatedMinutesWatched`/`durationSeconds` are both already exposed (the former as an age-aligned `performanceMetric` option, the latter as a lifetime fact), so an agent CAN compute this itself from the raw data this capability returns — but this capability does not itself group, bucket, or rank by duration/content combination. No pattern-mining of any kind is performed here (owner spec's own "the agent decides what hypotheses to draw").
- **`metadata/version` linkage** — `creative_assets.linkedVideoId` has no time range and is never independently verified: a thumbnail may have been swapped since the association was recorded, and nothing here can tell a caller which version of a video's metadata an asset actually corresponds to. Reported as a plain, current association only, with this limitation stated in the capability's own description — never silently implied to be temporally precise.
- **`experiment/outcome` linkage** — belongs to Phase 10 (the Experiment Engine, `docs/roadmap/FUTURE_PHASES.md`), which doesn't exist yet. No speculative schema or code for it here.
- **"Which prior assets should be used as reference material for the next creative"** — this is a forward-looking recommendation question, not a performance-linkage lookup; already partially reachable today via the existing `asset_catalog.list_assets`/`get_asset_context` capabilities (browsing the catalog directly), not something this new capability adds.
- **Content Proposal reference associations** (`content_proposal_artifacts`, a proposal's own `referenceAssetIds`/`referenceVideoIds`) are a DIFFERENT relationship — draft, unactioned reference/inspiration material a proposal cites, never "this asset was actually used on this video." This capability reads only `creative_assets.linkedVideoId`, never `content_proposal_artifacts` or any proposal field, to avoid conflating two structurally different kinds of association under one join.
- Any live YouTube API call, any write of any kind — this is a pure READ capability, same convention as every other read-only agent-operations capability.

## 6. `list_asset_performance` scenarios

- AC-PERF-01: given `{ channelId }` with no filters, returns every catalogued asset on that channel whose `linkedVideoId` resolves to an actually-synced video belonging to the SAME channel, each paired with that video's own facts (`videoId`, `title`, `publishedAt`) and lifetime counters (`viewCount`/`likeCount`/`commentCount`/`durationSeconds`, each independently `null` if never synced — never a fabricated `0`).
- AC-PERF-02: an asset with `linkedVideoId: null` (never linked to any video) is excluded from the returned list and counted separately in `excludedForMissingLink.unlinked` — never silently dropped with no explanation, never included with fabricated video facts.
- AC-PERF-03/04 (AMENDED during implementation, before any independent review ran -- see justification below): an asset whose `linkedVideoId` does not resolve to a video actually belonging to the requesting `channelId` -- whether because the video was never synced at all, or because it belongs to a different channel -- is excluded and counted in ONE combined counter, `excludedForMissingLink.linkedVideoNotOnChannel`, never leaked into the returned result either way.
  - **Original criteria (as first written, quoted verbatim for the record):** "AC-PERF-03: an asset whose `linkedVideoId` does not resolve to any locally-synced video... is excluded and counted in `excludedForMissingLink.videoNotSynced`." / "AC-PERF-04: an asset whose `linkedVideoId` resolves to a video belonging to a DIFFERENT channel... is excluded and counted in `excludedForMissingLink.videoOnOtherChannel` — never leaked across channels, and never silently conflated with 'not synced' (a distinguishable, honestly separate count)."
  - **Why amended (`AGENTS.md` §L requires a stated reason, not silent drift):** the criteria were written before implementation on the assumption that "not synced" and "on a different channel" are two independently observable facts. They are not, given how this capability actually reads video data: `listVideosByChannel(channelId)` is itself already channel-scoped (the real dependency, `listStoredVideosByChannel`, filters by `channelId` at the SQL layer, `src/lib/db.ts`) -- from inside this capability, a `linkedVideoId` that resolves to nothing in that list is structurally indistinguishable between "never synced anywhere" and "synced, but for a different channel." Implementing the original two-counter design against the REAL dependency would have shipped a field (`videoOnOtherChannel`) that could only ever read `0` in production (a test could still exercise it only by giving the test's own fake dependency a channel-scoping bug the real one doesn't have) -- caught by `advisor()` review before any independent-review round ran, not found by a round itself. Merging them is also consistent with the fact that asset registration itself (`asset-catalog`'s own `registerAsset`) already validates `linkedVideoId` against the same channel at write time, so a genuine cross-channel link is not expected to occur through normal use in the first place. `docs/AGENT_OPERATIONS_INTERFACE.md` §4h records the same reasoning in the design writeup.
- AC-PERF-05: `assetType` filters to exactly that catalogued asset type (the existing `ASSET_TYPES` enum, `asset-catalog/contracts.ts`) — omitted, every type is returned.
- AC-PERF-06: `performanceMetric` (one of the existing `CUMULATIVE_COMPARISON_METRIC_NAMES`) and `performanceDayOffset` (a plain caller-supplied integer, never derived from `now()`) must be given TOGETHER — one without the other is rejected as `validation_failed`. When both are given, each linked video's `ageAlignedPerformanceValue` is computed via the shared `getCumulativeValueAtDayOffset` helper (never a second implementation); a video with no contiguous coverage reaching that exact day gets `null`, honestly, never a fabricated value and never excluded from the list on this basis alone (this capability is a JOIN, not a FILTER — see §5's own scope statement; a `null` performance value is still a reportable row, not grounds for silent exclusion).
- AC-PERF-07: `credentialRef` is optional; if a caller requests `performanceMetric` without an explicit one, it is auto-resolved to the caller's own active local identity (the same MCP-layer pattern slice K already established, never left as a caller-visible validation failure).
- AC-PERF-08: `sort` is an explicit, named enum (`linkedVideoPublicationDate` default, `lifetimeViewCount`, `performanceMetric` — the last requiring `performanceMetric`/`performanceDayOffset` to also be set) — never a single hard-coded "best" ranking, matching slice K's own "do not hard-code a single comparison algorithm" convention applied here too even though owner spec §16 doesn't repeat that exact sentence for this section.
- AC-PERF-09: `limit` is silently clamped to a fixed maximum, `truncated: true` reported when clamped/exceeded — NEVER rejected as invalid (the exact mistake independent review found and fixed in slice K, round 3; this capability must not repeat it).
- AC-PERF-10: the whole capability performs local reads only — no live YouTube API call.
- AC-PERF-11: `channelId` is checked against the caller's active channel at the MCP/CLI layer before the service is ever called (the service itself does no such check), mirroring every other channel-scoped capability in this interface.
- AC-PERF-12: the capability's own description explicitly states that thumbnail-CTR/impressions-based questions, `metadata/version` linkage, and `experiment/outcome` linkage are NOT supported (§5's own scope boundary) — never silently omitted from the response with no explanation.

## 7. Deliberately not verified here (slice L)

- Real YouTube OAuth/live API behavior (no live Google login available in this environment, `AGENTS.md` §G).
- A-I's backfilled scenarios (deferred to slice J, unchanged from §4 above).

---

## 8. Slice J — independent security/integration review of the WHOLE phase (owner spec §28)

Unlike slices K/L's own acceptance sections above (each written before that slice's own
implementation, per `AGENTS.md` §L in its strictest form), slice J's own acceptance criteria are
**retroactive** for slices A-I -- those slices were implemented and independently reviewed before
this document existed at all (`docs/AGENT_OPERATIONS_INTERFACE.md` §4i's own tracked gap). This
section states that plainly rather than presenting a backfill as if it had the same evidentiary
weight as a criterion written before its own implementation: for A-I, "does a test cover this" is
verified against tests that already existed, not tests written from this checklist. For K/L
(already covered by their own §1-§7 sections above) and for J's own new work (the cross-cutting
checks in §10), the criteria below were derived from the spec text first, per the normal rule.

**Owner spec §28, quoted verbatim (recovered from this session's own pre-compaction transcript,
`docs/AGENT_OPERATIONS_INTERFACE.md` §7 row H's own note on how the full 34-section spec was
recovered):**

> 28. Acceptance-first implementation
>
> Before implementation, create a dedicated Phase 7 acceptance contract.
>
> Derive tests independently of implementation.
>
> Cover at least:
>
> • version/capability discovery;
> • channel isolation;
> • no development-repository dependency;
> • no direct DB access;
> • no secret exposure;
> • analytics queries;
> • video context;
> • context freshness;
> • asset catalog access;
> • controlled asset retrieval;
> • bulk localization context;
> • agent-created draft;
> • Change Set integration;
> • proposal provenance;
> • external evidence references;
>
> • unsupported future competitor capability;
> • structured errors;
> • token/context-efficient selective retrieval;
> • audit;
> • approval separation;
> • zero real YouTube writes during automated tests.
>
> Use mocks/isolated databases.
>
> Conduct adversarial review.

This is the only place in this repository the full text of owner spec §28 is recorded (the
34-section spec itself was never committed here -- `docs/AGENT_OPERATIONS_INTERFACE.md` §7 row H
already notes it lives only in this session's own transcript; whether to commit the full spec text
into this repository going forward is the project owner's own decision, not made here).

## 9. §28's 20 scenario categories, mapped against what actually exists

Each row: the category as named in §28, which slice/capability covers it, and whether an actual
test exercises it (checked by reading the real test file, not inferred from the capability's
existence).

| # | §28 category | Covered by | Test coverage |
|---|---|---|---|
| 1 | version/capability discovery | Slice A, `get_system_capabilities` | `agent-operations/services.test.ts` -- "getSystemCapabilities returns every field the spec requires" |
| 2 | channel isolation | B/C/D/E/F/G/G2/K/L (I is deliberately NOT channel-scoped, §4j) | See §10.1's own cross-slice table below -- checked freshly for J, not just per-slice |
| 3 | no development-repository dependency | `AGENTS.md` §B (dev/ops separation); `readProductVersion` reads `package.json` via `process.cwd()`, not this repo's source | See §10.5 below -- checked freshly for J |
| 4 | no direct DB access | `AGENTS.md` §D (single owner per capability); `agent-operations` never imports `@/lib/db` directly, only domain-service functions | See §10.4 below -- checked freshly for J |
| 5 | no secret exposure | `AGENTS.md` §F; `credentialRef`/tokens never included in any agent-facing response or error `details` | See §10.3 below -- checked freshly for J |
| 6 | analytics queries | Slice C, `query_channel_analytics`/`query_video_analytics` | `agent-operations/services.test.ts` -- multiple `queryChannelAnalytics`/`queryVideoAnalytics` tests |
| 7 | video context | Slice B, `get_video_context` | `agent-operations/services.test.ts` -- `getVideoContext` tests, including section-narrowing |
| 8 | context freshness | Slice C's `freshness` field, reused by K/L's own wrappers | `agent-operations/services.test.ts` -- freshness assertions in `queryChannelAnalytics`/`queryVideoAnalytics`/`findComparableVideos`/`listAssetPerformance` tests |
| 9 | asset catalog access | Slice D, `list_assets`/`get_asset_context` | `agent-operations/services.test.ts` -- `listAssets`/`getAssetContext` tests |
| 10 | controlled asset retrieval | Slice D/G2 -- `referenceKind` restricted, `local_path` never agent-reachable via `register_external_artifact` | `content-proposals/services.test.ts`, MCP/CLI tests -- "rejects referenceKind local_path" |
| 11 | bulk localization context | Slice F, widened `ai_localization_create_change_set` | `ai-localization/services.test.ts` -- Change-Set-from-generation tests |
| 12 | agent-created draft | Slice F/G -- every AI/agent-authored object starts as a draft, no auto-approve path | See §10.6 below (approval separation) -- checked freshly for J |
| 13 | Change Set integration | Slice F -- same persistence path as the pre-existing XLSX-import Change Set flow, `AGENTS.md` §D | `ai-localization/services.test.ts` |
| 14 | proposal provenance | Slice E, `get_generation_provenance` | `agent-operations/services.test.ts` -- `getGenerationProvenance` tests |
| 15 | external evidence references | Slice F/G -- `evidence` field on Change Set provenance and Content Proposals | `ai-localization/services.test.ts`, `content-proposals/services.test.ts` |
| 16 | unsupported future competitor capability | `plannedFutureCapabilities` in `get_system_capabilities` names Phase 9/10 extension points, no code exists for either | `agent-operations/services.test.ts` -- capabilities-list assertions include `plannedFutureCapabilities` |
| 17 | structured errors | Owner spec §27, `docs/AGENT_OPERATIONS_INTERFACE.md` §6 -- IMPLEMENTED | Every domain module's own `DomainError` tests; MCP `toolErrorResult`/CLI `serializeError` tests |
| 18 | token/context-efficient selective retrieval | Slice B's `include` param on `get_video_context`; K/L's `limit`/`truncated` | `agent-operations/services.test.ts` (`include`), `comparable-content`/`asset-performance` tests (`limit`/`truncated`) |
| 19 | audit | `createdVia`/`agentApiVersion` server-stamped on every agent-created write (slice E/F/G/G2) | `content-proposals/services.test.ts`, MCP/CLI tests asserting stamped identity |
| 20 | approval separation | "AI proposes, human approves" -- no code path anywhere marks an agent-authored proposal already-approved | See §10.6 below -- checked freshly for J |
| — | zero real YouTube writes during automated tests | Every test in this repository uses fakes/mocks for `youtube-write-gateway`/`youtube-read-gateway`; `AGENTS.md` §G's live-write barrier (`assertLiveWritesAuthorized`) additionally fails closed even if a test somehow reached a real call | See §10.7 below -- checked freshly for J |

## 10. Cross-cutting checks (slice J's own new work, not re-derived from any single slice's own review)

These checks were run fresh for slice J, each against the CURRENT, final state of the whole
interface (all of slices A-L), not re-trusted from any earlier per-slice review (each of which,
by construction, only ever looked at its own slice).

### 10.1 Channel isolation (§28 category 2)

Every `agent_*` MCP tool and `agent` CLI command that takes a `channelId`, checked for how
channel-scoping is actually enforced:

| MCP tool | CLI command | Takes channelId? | Channel-check mechanism | credentialRef source |
|---|---|---|---|---|
| `agent_get_capabilities` | `capabilities` | No | N/A (instance-level) | N/A |
| `agent_get_channel_context` | `channel-context` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_get_video_context` | `video-context` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_query_channel_analytics` | `channel-analytics` | Yes | Forwards to `analyticsCore.getChannelOverview`, checked internally | Caller-suppliable |
| `agent_query_video_analytics` | `video-analytics` | Yes | Forwards to `analyticsCore.listMetrics`, checked internally | Caller-suppliable |
| `agent_list_assets` | `list-assets` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_get_asset_context` | `get-asset-context` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_get_generation_provenance` | `get-generation-provenance` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_create_content_proposal` | `create-content-proposal` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_get_content_proposal` | `get-content-proposal` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_list_content_proposals` | `list-content-proposals` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_register_external_artifact` | `register-external-artifact` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_list_proposal_artifacts` | `list-proposal-artifacts` | Yes | Handler calls `assertActiveChannel` | Server-resolved only |
| `agent_list_operations_files` | `list-operations-files` | No | N/A (global workspace path, deliberate, §4j) | N/A |
| `agent_get_operations_file` | `get-operations-file` | No | N/A (deliberate) | N/A |
| `agent_find_comparable_videos` | `find-comparable-videos` | Yes | Handler calls `assertActiveChannel` | **Caller-suppliable**, drives the check itself |
| `agent_list_asset_performance` | `list-asset-performance` | Yes | Handler calls `assertActiveChannel` | **Caller-suppliable**, drives the check itself |

**Result: no gaps.** Every `channelId`-taking tool/command has a channel check, either directly or
via a domain function that performs the identical check internally. No tool/command takes
`channelId` with zero enforcement anywhere.

**Design asymmetry noted (not a gap, but worth recording explicitly):** three different trust
models for "whose identity drives the channel check" coexist across this one interface: B/D/E/G/G2
always resolve server-side only (ignore any caller-supplied `credentialRef` for the check itself);
C forwards a caller-suppliable `credentialRef` into a downstream check; K/L explicitly let a
caller-supplied `credentialRef` drive the check directly. This is a deliberate, not accidental,
difference (K/L's own design docs, §4g/§4h, state the reasoning), but three distinct models in one
interface is worth a single owner-facing note rather than silent variation -- flagged here, not
treated as something to unify without an explicit decision.

### 10.2 Capability parity (§28 category 1, re-run now that K/L exist)

Slice H verified this before K/L existed. Re-run for J: **24 `AGENT_CAPABILITIES` entries, zero
drift** in either direction -- every entry has both a registered MCP tool (or explicitly documented
pre-existing one) and a CLI command; every `agent_*`-prefixed MCP tool has a corresponding
`AGENT_CAPABILITIES` entry. Full table omitted here (see the slice J review notes); the count and
zero-drift result is the acceptance-relevant fact.

### 10.3 No secret exposure (§28 category 5)

**PASS.** `credentialRef` appears only in input schemas/internal call parameters across
`agent-operations/`, `comparable-content/`, `asset-performance/` -- never in an output schema.
Every `DomainError` `details` object across these modules carries only identifiers
(`channelId`/`videoId`/`anchorVideoId`/etc.), never tokens or paths. The shared `formatZodError`
helper emits only `{path, message, code}` from zod issues, never the raw invalid input, so even a
malformed-`credentialRef` validation error cannot leak a token value. `get_system_capabilities`'s
response is built only from static version/capability/permission/schema-version constants.

### 10.4 No direct DB access (§28 category 4)

**PASS for slices K/L; one pre-existing exception noted, not introduced by Phase 7.**
`comparable-content/` and `asset-performance/` have zero `@/lib/db` imports. `agent-operations/
index.ts` does import `getChannelTargetLanguages`/`SCHEMA_CURRENT_VERSION` directly from `@/lib/db`
-- `SCHEMA_CURRENT_VERSION` is a plain constant (no query), but `getChannelTargetLanguages` is a
real Drizzle query, called without a domain-service wrapper. This is a **pre-existing pattern from
slice B**, not something introduced later: its own inline comment states it reuses "the same
function `src/lib/localization/` itself reads" -- i.e. this one `db.ts` accessor is already treated
as a shared, cross-domain primitive elsewhere in this codebase, the same way `videos`/`channels`
table reads are. Not remediated here (out of scope for a retroactive review to redesign an
already-shipped, already-reviewed slice B decision); recorded so it isn't mistaken for a new gap.

### 10.5 No development-repository dependency (§28 category 3)

**PASS.** `readProductVersion()` (`agent-operations/index.ts`) reads `package.json` via
`process.cwd()` -- confirmed against `docs/decisions/0003-published-release-snapshots.md`'s own
allowlist that `package.json` is included in every `published/<version>/` release snapshot, so this
resolves identically in a released build, not just in this development checkout.
`operations-instructions/` (slice I) never hardcodes any path inside this repo -- its filesystem
adapter only ever operates on the operator-configured `operationsWorkspacePath`, which is the whole
point of that slice (pointing outside this repo, `AGENTS.md` §B).

### 10.6 Approval separation / agent-created draft (§28 categories 12, 20)

**PASS, all 5 sub-checks:**

1. **Content Proposals:** `content-proposals/contracts.ts` documents "create, get, list only. No
   update, no status field." Confirmed zero `approvalStatus`/`approve` fields anywhere in the
   module (create, and `registerExternalArtifact`, both write-once).
2. **AI Localization Change Sets:** the single shared `persistChangeSet` function (one creation
   path per `AGENTS.md` §D, used by XLSX import, AI-generated proposals, and any future source)
   hardcodes `approvalStatus: "pending"` as a literal, never derived from caller input. No alternate
   creation path exists.
3. **No approve/reject reachable via MCP or CLI at all:** grepped every `agent_*` MCP tool
   registration and every `agent` CLI command for `approve`/`reject` -- zero hits for an actual
   tool/command (only descriptive prose stating the opposite). Approval exists exclusively behind
   the Web UI's own HTTP routes -- not just unreachable from the `agent` namespace, unreachable
   from MCP/CLI entirely.
4. **YouTube write-gateway/Batches unreachable:** zero references to `youtube-write-gateway`/
   `batches`/`createBatch`/`batchCore` anywhere in `agent-operations/`, `content-proposals/`,
   `comparable-content/`, `asset-performance/`, `operations-instructions/`, or `ai-localization/`
   (excluding tests).
5. **Mutation-gate membership matches exactly between MCP and CLI:** MCP's
   `wrapMcpHandlersWithMutationGate` gates exactly `agentCreateContentProposal`,
   `agentRegisterExternalArtifact`, `aiLocalizationCreateChangeSet`; every other `agent_*` handler
   is ungated. CLI's `READ_ONLY_CLI_COMMANDS` set explicitly excludes the same three
   (`create-content-proposal`, `register-external-artifact`, `create-change-set`) and explicitly
   includes `find-comparable-videos`/`list-asset-performance` as read-only. Both surfaces agree
   exactly on which agent-reachable operations mutate local state.

### 10.7 Zero real YouTube writes during automated tests (§28's own final bullet)

**PASS.** Mechanically enforced project-wide, not just for this phase:
`youtube-write-gateway/gateway-inventory.test.ts` and `youtube-read-gateway/
read-gateway-inventory.test.ts` fail the whole suite if any file outside the two gateways imports
`googleapis` at runtime -- neither `agent-operations/`, `comparable-content/`, nor
`asset-performance/` does (confirmed in §10.4's own grep). Every test in this repository, including
every test added for slices K and L, injects fake/local dependencies -- none constructs a real
`googleapis` client. `AGENTS.md` §G's live-write barrier (`assertLiveWritesAuthorized`, Gate B)
additionally fails closed even if a test somehow reached a real write call, as a second, independent
layer.

### 10.8 RISK-59 (MCP `tools/list` rendering) -- RESOLVED during slice J

Built a real `createMcpServer({ connectionEnabled: true })` instance in this environment and called
the SDK's own `tools/list`-rendering code path directly against `agent_register_external_artifact`'s
real, registered, full `.superRefine`-based schema (empirical, not just reading SDK source). The
result is a complete, correct, non-degenerate JSON Schema -- every property, enum, and the correct
`required` array render exactly as expected; only the cross-field `.superRefine` constraint itself
is absent from the JSON Schema (expected -- JSON Schema has no native way to express it). See
`docs/TECHNICAL_DEBT.md` RISK-59 for the full writeup. No fix was needed.

## 11. Deliberately not verified here (slice J)

- **A live, end-to-end run of `find_comparable_videos`/`list_asset_performance` against a real,
  OAuth-synced YouTube channel.** No live Google login is available in this environment
  (`AGENTS.md` §G's own standing constraint, restated here rather than re-litigated). Attempted to
  verify what CAN be verified without one: confirmed the local dev database itself is healthy and
  the CLI's own auth/error path behaves correctly against an empty (no active user) local database.
  Did not seed fabricated, production-shaped rows (fake channels/videos/assets) directly into the
  local dev database to simulate a "real" run -- that would risk being mistaken for genuine synced
  data by whoever next uses this same local environment, and owner spec §28 itself only asks for
  "mocks/isolated databases" for the acceptance tests, not a live-data dry run. K0's own
  `contentDetails.duration` ISO-8601 parsing similarly remains verified only against this
  codebase's own parsing logic and the documented ISO-8601 grammar, not a real API response (already
  stated as a limitation in §4).
- **`docs/PROJECT_SPEC.md`'s own broader acceptance criteria** (this document covers Phase 7's own
  owner-spec-§28 contract specifically, not a re-verification of every earlier phase's own already-
  closed acceptance work).
