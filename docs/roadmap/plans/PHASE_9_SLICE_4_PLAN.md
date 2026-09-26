# Phase 9 slice 4 — agent-facing MCP/CLI read surface

Assigned 2026-09-26 (Telegram): "Создай план доработки фазы 9. Создай отдельную ветку. Приступай
к выполнению плану. Я одобрю уже финальный мердж в дев." This is the completion of the one item
`docs/roadmap/plans/PHASE_9_PLAN.md` §6 explicitly deferred from slices 1-3 ("only if slices 1-3
land cleanly with review budget remaining... otherwise explicitly deferred to its own follow-up
assignment") and §8 left as an open decision ("decided once slices 1-3 are done and reviewed").
Slices 1-3 are DONE (`docs/ROADMAP_STATUS.md`, merged `b83c9b2`) — this plan covers exactly slice 4
and nothing else.

## 1. Scope boundary (why not the extended Phase 9 spec)

The owner separately sent a much larger, 39-section extended description of Phase 9 the same day
slices 1-3 merged (`docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`, analyzed in
`PHASE_9_PLAN.md` Part II). That extended scope is **explicitly not authorized to start** until the
owner resolves 5 named decisions (`PHASE_9_PLAN.md` §12: background-collection scheduling, a
YouTube API quota budget, real-AI spend authorization, `search.list`-discovery authorization,
cross-device history transfer) — none of which this assignment's own instruction addresses. Part
II's own revised slice plan (§14) places an agent interface at **9G, sequenced after 9A-9F**, which
themselves depend on those 5 decisions.

This assignment is read as **Part I's own slice 4** instead: exposing the watchlist/evidence data
Part I's slices 1-3 already store, through the Agent Operations Interface (Phase 7) — no new table,
no new YouTube API call, no scheduling, no quota decision, nothing gated on Part II's open
questions. This is the "smallest safe implementation slice" available under this instruction
(`AGENTS.md` §C), consistent with `PHASE_9_PLAN.md` §6 item 4's own description of what slice 4 is.

## 2. Objective

Fulfil the two capability names `src/lib/agent-operations/contracts.ts`'s
`PLANNED_FUTURE_CAPABILITIES` already reserved for this — `query_market_intelligence` and
`query_competitors` — as real, read-only MCP tools with CLI parity, per `PHASE_9_PLAN.md` §1's own
instruction to use these exact names rather than inventing new ones.

## 3. Design decision: direct registration, not a new agent-operations service wrapper

Two ways this could be wired, both already precedented in this codebase:

- **(a)** New functions inside `createAgentOperationsServices` (like `queryChannelAnalytics`
  wrapping `analyticsCore`), requiring `ServiceDependencies` growth and composition-root wiring in
  `src/lib/agent-operations/index.ts`.
- **(b)** Direct registration in `src/mcp/server.ts`/`src/cli/video-metadata.ts` calling
  `createMarketIntelligenceCore()` directly (like `analytics_list`/`analytics_overview` call
  `analyticsCore` directly), with a plain `AGENT_CAPABILITIES` catalog entry documenting each as a
  "pre-existing tool, registered here for capability-discovery completeness" (the exact pattern
  already used for `channel_context.list_channels`, `analytics.query_data_quality`, etc.).

**Chosen: (b).** `PHASE_9_PLAN.md` §5's module-independence rule states "no existing... service...
may take a hard dependency on market-intelligence's... services" with the sole named exception of
"its own... MCP tool registrations." Option (a) would add `market-intelligence` as a new hard
dependency of `agent-operations`'s own service layer — option (b) keeps that dependency confined to
the MCP/CLI interface layer (`src/mcp/server.ts`, `src/cli/video-metadata.ts`), which already
directly imports every domain module's own core factory (`createAnalyticsCore`,
`createChannelSyncCore`, etc.) as its composition root. Both tools do a plain, no-transformation
(or single-merge) read — neither needs the richer "agent context" reshaping slice C/K/L's wrappers
provide, so nothing is lost by skipping the wrapper.

## 4. Name-to-behavior mapping

Both reserved names must resolve to *some* concrete, distinct, useful shape. Chosen mapping:

- **`query_competitors`** — plain roster: every entry currently on the research watchlist
  (`research_channels`), no evidence attached. Direct passthrough of the existing
  `listWatchlist()` service call — "who are we watching."
- **`query_market_intelligence`** — single-channel deep dive: one watchlisted channel's own record
  plus its full evidence history (`research_evidence`), given its `channelId`. Combines the
  existing `getWatchlistEntry`/`listEvidence` calls into one response — "what do we know about this
  one channel."

This mirrors the plan's own explicit fallback wording (`PHASE_9_PLAN.md` §6 item 4:
"`agent_list_research_channels`/`agent_get_research_channel_context`, or reusing
`query_market_intelligence`/`query_competitors` directly if their shape fits") — `query_competitors`
↔ the list shape, `query_market_intelligence` ↔ the single-channel context shape.

## 5. In scope

- Two new MCP tools, `query_market_intelligence` and `query_competitors`, registered directly in
  `src/mcp/server.ts`, calling `createMarketIntelligenceCore()` (no new wrapper module).
- CLI parity: `agent market-intelligence --channelId <UC...>` and `agent competitors` in
  `src/cli/video-metadata.ts`, mirroring the existing `agent channel-analytics`/`agent
  video-analytics` pattern (no `assertActiveChannel` — this data is global, not owned-channel
  scoped, same as `agent list-operations-files`).
- `AGENT_CAPABILITY_DOMAINS` gains `"market_intelligence"`; `AGENT_CAPABILITIES` gains two entries
  under it, `market_intelligence.query_market_intelligence`/`market_intelligence.query_competitors`,
  both `permission: "READ"`.
- `AGENT_DATA_DOMAINS` gains `"competitor_intelligence"` — the literal name
  `contracts.ts`'s own existing doc comment already reserved for this ("`competitor_intelligence`/
  `experiment_history` are DELIBERATELY absent... Phase 9/10 not implemented"); that comment is
  updated to say only `experiment_history` (Phase 10) remains absent.
- `PLANNED_FUTURE_CAPABILITIES` loses `"query_market_intelligence"`/`"query_competitors"`, keeping
  only `"create_experiment_proposal"` (Phase 10).
- `AGENT_API_VERSION` bumped `0.10.0` → `0.11.0` (minor — a capability-discovery-relevant addition,
  per that constant's own doc comment).
- Tests: `agent-operations/services.test.ts`'s AC-CAP-05 updated (3 planned → 1 remaining, with an
  explicit note on why — the requirement changed, not that the old test was wrong,
  `AGENTS.md` §L); new tests for the two MCP handlers (found channel / not-on-watchlist /
  validation-failed cases) and CLI parity.
- Docs: `docs/AGENT_OPERATIONS_INTERFACE.md` (new §4k + closing-paragraph update),
  `docs/interfaces.md` (MCP tool table), `docs/SYSTEM_MAP.md` line ~399 (remove "MCP/CLI-поверхность
  ... не реализовано"), `docs/ARCHITECTURE.md` §18 (note the new surface), `docs/ROADMAP_STATUS.md`/
  `docs/roadmap/BACKLOG.md` (new row once merged).

## 6. Explicitly out of scope

- Everything Part II gates on the 5 still-open owner decisions (§1 above) — no new table, no
  structured numeric snapshots, no discovery, no scheduling.
- Any write-shaped / DRAFT-class market-intelligence capability (e.g. an agent proposing a new
  watchlist entry) — `ZONED_CAPABILITIES` zoning is explicitly deferred in `PHASE_9_PLAN.md` §1
  until such a capability is actually built; this slice adds READ only.
- Pagination/filtering on `query_competitors` — the watchlist is expected to stay small for a
  single-operator local tool at this stage; add if it ever becomes a real problem.

## 7. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- `query_competitors` returns every `research_channels` row via the existing `listWatchlist()`
  shape, unmodified — a test with 0, 1, and 2+ watchlist entries proves the count matches exactly.
- `query_market_intelligence` requires `channelId`; omitting it is `validation_failed` before any
  store call. Given a `channelId` not on the watchlist, it fails with the existing
  `RESEARCH_CHANNEL_NOT_AVAILABLE` `DomainError` (from `getWatchlistEntry`), never a fabricated
  empty result.
- Given a watchlisted `channelId` with N evidence rows, `query_market_intelligence` returns exactly
  those N rows (via the existing `listEvidence` shape) alongside the channel's own record — a test
  with 0 and 2+ evidence rows proves both the "no evidence yet" and "multiple rows" cases are
  reported honestly, never coerced to a default.
- Neither tool accepts or requires a `credentialRef` (matches `listWatchlist`/`getWatchlistEntry`/
  `listEvidence`'s own signatures — no YouTube call is made by either).
- `market-intelligence`'s own `write-path-inventory.test.ts` continues to pass unmodified — this
  slice adds no new file to that module and changes no existing one.
- `get_capabilities`'s `plannedFutureCapabilities` output no longer includes
  `query_market_intelligence`/`query_competitors`, and its `capabilities` list includes both under
  domain `market_intelligence` — a test asserts both facts together (moving one without the other
  would leave the interface internally inconsistent).
- CLI `agent market-intelligence`/`agent competitors` produce the same JSON shape as their MCP
  counterparts for the same input (parity, matching every other `agent *` CLI command's own
  convention).

## 8. Where this is recorded

Outcome recorded in `docs/ROADMAP_STATUS.md` once merged (per `AGENTS.md` §H); this plan document
is left as-is afterward, a historical record of what was decided before implementation, not
rewritten to match the final result.
