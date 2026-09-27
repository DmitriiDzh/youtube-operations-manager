# Phase 9 slice 9G — agent interface, part A: read surface

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§28 and `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9G definition, per `AGENTS.md` §L. Split into
two parts per advisor review: **part A (this doc) is a plain READ-class extension, no zoning
needed** (mirrors slice 4's own precedent: `query_market_intelligence`/`query_competitors` are
global, unzoned reads); **part B (DRAFT "create research request," spec §29) is approval-integrity
work requiring the full `AGENTS.md` §A seven-document reading pass and its own acceptance criteria
before any code, tracked separately, not started in this document.**

## 1. Scope boundary

Owner spec §28: "Provide a coherent tool set... Prefer a small number of powerful composable MCP
tools over many thin wrappers." Two changes, not one-tool-per-table:

1. **Extend `query_market_intelligence`'s existing single-channel output** (`getWatchlistEntryContext`,
   already the one call both the MCP tool and `agent market-intelligence` CLI command use) with the
   read surfaces 9A/9E/9I added since slice 4 shipped: channel/video snapshots, topic assignments,
   and derived `dataQualityFlags`. This is 9I's own first real caller (`data-quality.ts` shipped with
   none, by design).
2. **One new list tool with a `kind` discriminator** — `agent_list_market_records` — covering
   topics, trend candidates, and discovery candidates, rather than three separate tools.

Both stay global/unzoned, explicitly stating the precedent rather than leaving it implicit (found
necessary by advisor review: `docs/DEVELOPMENT_PLAYBOOK.md` §6.7 point 6 otherwise requires
`assertActiveChannel` channel-scoping for every MCP tool by default).

## 2. `getWatchlistEntryContext` output extension

Current shape: `{ channel, evidence }`. New shape (additive, backward-compatible for any caller
reading only the existing two fields):

```ts
{
  channel: ResearchChannel;
  evidence: ResearchEvidence[];
  channelSnapshots: MarketChannelSnapshot[];       // 9A, listMarketChannelSnapshotsByChannel
  videoSnapshots: MarketVideoSnapshot[];            // 9A, listMarketVideoSnapshotsByChannel
  topicAssignments: MarketTopicAssignment[];        // 9E part A, listTopicsForSubject("channel", channelId)
  dataQualityFlags: DataQualityFlag[];              // 9I, derived below
}
```

**`dataQualityFlags` derivation** (pure, computed in the service action itself from what was just
fetched — no new stored column):

- `assessObservationFreshness(latestChannelSnapshot?.observedAt ?? null, now)` — `"stale_observation"`
  or nothing. `latestChannelSnapshot` is the last element of `channelSnapshots` (already ordered
  newest-last by `listMarketChannelSnapshotsByChannel`, per its own existing contract).
- `toHiddenSubscriberCountFlag(latestChannelSnapshot.hiddenSubscriberCount)` — only when a snapshot
  exists at all.
- From the channel's own most recent collection run (new db.ts function, §3 below):
  `assessSnapshotCompleteness(run.videosRequested, run.videosReturned)` for `"missing_snapshot"`,
  and `run.status === "skipped_quota_limited"` maps directly to `"quota_limited"` (a plain literal
  check, not a new pure function — `assessDiscoveryRunQuality` is shaped for discovery runs
  specifically, whose `status` union is `"success" | "failed"`, not collection runs' three-way
  union).
- No snapshot and no collection run at all -> empty `dataQualityFlags` (a channel that was just
  added to the watchlist and never collected is a plain, unremarkable fact, not a quality problem to
  flag).

## 3. New db.ts function

`getLatestMarketIntelligenceCollectionRunForChannel(researchChannelId): Promise<StoredMarketIntelligenceCollectionRun | null>`
— the single most recent row (by `ranAt` desc, limit 1) for one channel. No such per-channel lookup
exists today (only the aggregate `getMarketIntelligenceUnitsSpentSince` sum) — a genuinely new,
narrow, additive read function, not a duplicate of anything existing.

## 4. `agent_list_market_records` (new MCP tool + `agent market-records` CLI command)

```ts
input: { kind: "topics" | "trend_candidates" | "discovery_candidates" }  // .strict(), discriminated
output:
  kind === "topics"               -> { kind: "topics", topics: MarketTopic[] }
  kind === "trend_candidates"     -> { kind: "trend_candidates", trendCandidates: MarketTrendCandidate[] }
  kind === "discovery_candidates" -> { kind: "discovery_candidates", candidates: MarketDiscoveryCandidate[] }
```

Delegates to the market-intelligence core's own already-existing `listTopics`/`listTrendCandidates`/
`listDiscoveryCandidates` — no new service logic, purely a thin MCP/CLI-layer fan-out (mirrors
`agent_list_assets`'s own "thin interface wrapper over an existing service action" shape). Global,
unzoned, same as `query_competitors`/`query_market_intelligence`.

## 5. Agent capability registration

- `AGENT_CAPABILITIES` (`src/lib/agent-operations/services.ts`): one new entry,
  `market_intelligence.agent_list_market_records`, `permission: "READ"`, domain
  `market_intelligence` (already exists, no new domain needed).
- `AGENT_API_VERSION` (`src/lib/agent-operations/contracts.ts`): minor bump (new capability added).
- No `ZONED_CAPABILITIES` entry — READ-class tools are not zoned in this codebase (mirrors
  `query_market_intelligence`/`query_competitors`'s own precedent, neither of which has one).

## 6. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- **AC-9G-01:** `getWatchlistEntryContext` for a channel with one channel snapshot
  (`hiddenSubscriberCount: true`) and no collection run returns `dataQualityFlags` containing
  exactly `["hidden_subscriber_count"]` (order: freshness check first, then hidden-count, then
  run-derived — deterministic, not set-ordering-dependent).
- **AC-9G-02:** a channel snapshot older than `MARKET_INTELLIGENCE_STALE_WINDOW_MS` produces
  `"stale_observation"` in `dataQualityFlags`; a fresh one does not.
- **AC-9G-03:** a channel with zero snapshots and zero collection runs returns `dataQualityFlags: []`,
  never a fabricated flag for "no data yet."
- **AC-9G-04:** a channel whose most recent collection run has `videosRequested: 5, videosReturned: 3`
  produces `"missing_snapshot"`; `status: "skipped_quota_limited"` produces `"quota_limited"`; both
  can appear together in one run's flags.
- **AC-9G-05:** `channelSnapshots`/`videoSnapshots`/`topicAssignments` in the output exactly match
  what `listMarketChannelSnapshotsByChannel`/`listMarketVideoSnapshotsByChannel`/`listTopicsForSubject`
  independently return for the same channel (round-trip, not re-derived).
- **AC-9G-06:** `agent_list_market_records` with `kind: "topics"` returns exactly `listTopics()`'s
  own result wrapped with `kind`; same for `trend_candidates`/`discovery_candidates`.
- **AC-9G-07:** `agent_list_market_records` rejects an unknown `kind` value as `validation_failed`,
  before calling any service action.
- **AC-9G-08:** `agent_list_market_records`/the extended `query_market_intelligence` are never
  blocked by the operation lock (read-only, mirrors every other agent-facing READ tool's own test).
- **AC-9G-09:** CLI parity — `agent market-records --kind topics` returns the same JSON envelope
  shape the MCP tool returns.

## 7. Explicitly out of scope for this document (9G part B, separately planned)

The DRAFT "create research request" capability (spec §29), its approval gate, `ZONED_CAPABILITIES`
entry, and the real `discoverChannels` trigger on approval — full `AGENTS.md` §A reading pass and
its own acceptance criteria required first, per advisor review's explicit split.
