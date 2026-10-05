# Phase 9 slice 9H, part B — Market Overview tab

Continues on the same branch (`AGENTS.md` §K.1, owner: "делаем всю фазу до конца в этой ветке").
Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md` §30 "Market Overview" (the one part of
9H `docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md` explicitly deferred as "part B", needing
part A's own per-channel summary as a building block — it now exists). Owner instruction to continue
this specific slice given directly in this session ("продолжай, вопросы разберем позже").

Owner spec §30 "Market Overview" lists exactly six items:

- new discoveries
- breakout videos
- emerging channels
- trend candidates
- active watchlists
- stale/failed collection warnings

## 1. Scope boundary

**In scope:** one new UI-facing service action, `getMarketOverview()`, aggregating across the WHOLE
watchlist (every part-A/9D/9I building block this slice reuses is already per-channel; this part's
only new work is the aggregation itself), one new API route, and one new UI component/section at the
top of the Research tab.

**Explicitly out of scope (named, not silently dropped):**

- **Videos tab** — still blocked on the same schema gap 9H part A found (`market_video_snapshots` has
  no `title` column); unaffected by this part.
- **Opportunities tab** — still depends on 9F (niche discovery) getting a UI caller, a separate slice.
- **9F's own UI caller** — not added here. "New discoveries" in this part's Overview means 9C's
  discovery candidates (`status: "new"`), not 9F's niche candidates — a different entity, already
  named distinctly in owner spec §30 ("Opportunities" vs. this section's "new discoveries").
- **Any MCP/CLI/agent-contract change.** `getMarketOverview` is UI-only, following part A's own §3
  precedent exactly (a new composing action, never an extension of an existing agent-facing output
  schema) — no `AGENT_API_VERSION` bump, no new `ZONED_CAPABILITIES` entry.
- **Any new DataQualityFlag value.** "Failed collection" is surfaced as a separate, explicit
  `latestRunStatus` field (§3 below), not shoehorned into the existing seven-value vocabulary — that
  vocabulary is `data-quality.ts`'s own closed, spec-derived set (§27), and a `"failed"` collection
  run is a `market_intelligence_collection_runs.status` fact, not a data-quality judgment about the
  channel's own data.
- **Batching/pagination of the per-channel aggregation loop.** See §4's own cost discussion — accepted
  as this part's own scope call, in the same spirit as 9H part A's already-accepted RISK-79 items.

## 2. Reused building blocks (no changes to any of these)

| Overview item | Source (unchanged) |
|---|---|
| new discoveries | `listDiscoveryCandidates()` (9C), filtered to `status === "new"` |
| breakout videos | `getChannelIntelligenceSummary`'s own `recentBreakoutVideos` (9H part A), called once per watchlisted channel, filtered to `isBreakout: true` |
| emerging channels | the SAME per-channel `getChannelIntelligenceSummary` call's `emergingChannel`, filtered to `isEmerging: true` |
| trend candidates | `listTrendCandidatesWithFreshness()` (9H part A) — returned as-is, no new filtering; already a complete list with freshness attached |
| active watchlists | `listWatchlist()` (Phase 9 slice 1) — just the count, `channels.length` |
| stale/failed collection warnings | the SAME per-channel call's own `dataQualityFlags`, narrowed to exactly `stale_observation`/`quota_limited`/`missing_snapshot` (§3a explains the narrowing), PLUS one direct `getLatestMarketIntelligenceCollectionRunForChannel` read per channel for `status === "failed"`, PLUS an explicit `neverObserved` case (§3b) |

No existing action's output schema changes. No new schema/migration. No new YouTube call of any
kind — every source above already reads only already-collected local rows.

## 3. Why a direct `"failed"` read, not a `DataQualityFlag`

`getWatchlistEntryContext` already fetches `latestRun` internally and derives `missing_snapshot`
(partial capture) and `quota_limited` (skipped) from it, but never a flag for `status === "failed"`
itself. A `"failed"` run's own real-world consequence (the channel's snapshot stays as old as it was
before the attempt) will usually — but not immediately — also trigger `stale_observation` once 24h
have passed. The gap this part closes: an operator opening the dashboard shortly after a failed
attempt (well inside the 24h freshness window) gets **no signal at all** today that anything went
wrong, even though owner spec §30 explicitly asks for "stale/failed collection warnings" as two
named concepts, not one. Rather than adding an eighth value to `data-quality.ts`'s own closed,
spec-derived vocabulary (§27 lists exactly seven; `"failed"` is not one of them and is not a data-
quality judgment about the channel's data — it is an audit fact about the last collection attempt),
`getMarketOverview` reads `getLatestMarketIntelligenceCollectionRunForChannel` directly (already an
existing, indexed, single-row-by-channel db.ts export — no new query) and reports `latestRunStatus`
as its own explicit field, separate from `dataQualityFlags`.

## 3a. Narrowing `dataQualityFlags` for the warnings section (found necessary by advisor review)

`getWatchlistEntryContext`'s `dataQualityFlags` is a 7-value CHANNEL-level vocabulary, and not every
value that can appear there is actually a "collection" problem. `hidden_subscriber_count` is a
property of the channel itself (the owner hides their subscriber count on YouTube) — a channel with
that flag and otherwise perfectly fresh, complete data would incorrectly and PERMANENTLY show up as
a "warning" if this section naively included any channel with a non-empty `dataQualityFlags` array,
exactly the naive rule an earlier draft of this plan proposed. `insufficient_history` (a per-breakout-
video basis, not surfaced in this channel-level array at all today) and `video_no_longer_public`/
`partial_discovery` (not produced by `getWatchlistEntryContext`'s current logic either) are likewise
not collection-freshness facts. `getMarketOverview` therefore filters to exactly three flag values —
`stale_observation`, `quota_limited`, `missing_snapshot` — when deciding whether a channel gets a
`collectionWarnings` row; `hidden_subscriber_count` (and any other flag outside this set) is ignored
for this purpose. A test asserts a channel whose ONLY flag is `hidden_subscriber_count` does not
appear in `collectionWarnings`.

## 3b. Never-observed channels (found necessary by advisor review)

A channel with zero snapshots and zero collection runs (the realistic FIRST-render state on the
owner's own machine today, per plan §8/RISK-63: every Phase 9 table is confirmed empty) produces
`assessObservationFreshness(null, now) === null` and `assessSnapshotCompleteness(null, null) ===
null` — i.e. **no flag at all**, since both functions treat "never observed" as outside their own
scope (by their own doc comments, `missing_snapshot` means "some of this run's videos yielded no
snapshot," not "this channel has never been touched"). Under the narrowed rule in §3a alone, a
never-collected channel would silently show zero warnings — a false all-clear that is actively worse
than showing nothing, since it looks identical to "checked and fine." `getMarketOverview` therefore
adds its own explicit check, done here rather than in `data-quality.ts` (this is a fact about
`channelSnapshots.length === 0`, already returned by `getChannelIntelligenceSummary`, not a new
`DataQualityFlag` value): any channel with an empty `channelSnapshots` array gets `neverObserved:
true` on its `collectionWarnings` row (added even if `dataQualityFlags`/`latestRunStatus` would
otherwise have produced no row at all).

## 4. `getMarketOverview` — shape and cost

```ts
async getMarketOverview(): Promise<{
  watchlistCount: number;
  newDiscoveries: MarketDiscoveryCandidate[];
  breakoutVideos: (BreakoutAssessment & { channelId: string })[];
  emergingChannels: EmergingChannelAssessment[]; // self-identifying via its own existing `researchChannelId` field -- no extra tagging needed, unlike breakoutVideos below
  trendCandidates: (MarketTrendCandidate & { freshness: "fresh" | "needs_attention" })[];
  collectionWarnings: {
    channelId: string;
    dataQualityFlags: ("stale_observation" | "quota_limited" | "missing_snapshot")[]; // narrowed per §3a -- never the full 7-value vocabulary
    latestRunStatus: "success" | "skipped_quota_limited" | "failed" | null;
    neverObserved: boolean; // §3b
  }[]; // a channel is a row here only if dataQualityFlags is non-empty, OR latestRunStatus === "failed", OR neverObserved is true -- never an all-false/empty-flags placeholder
}>
```

Sort order (deterministic, so tests can `deepEqual` the arrays without a separate sort step of their
own): `breakoutVideos` by `ratio` descending (nulls last), then `channelId`, then `videoId`;
`emergingChannels` and `collectionWarnings` by `channelId`. `newDiscoveries`/`trendCandidates` keep
whatever order their own underlying `listDiscoveryCandidates`/`listTrendCandidatesWithFreshness` call
already returns (both already deterministic via their own db.ts query — not re-sorted here).

Implementation: `const { channels } = await services.listWatchlist();`, then for each channel call
`services.getChannelIntelligenceSummary({ channelId: channel.channelId })` (reuses 9H part A's own
per-channel composition unchanged) plus one `deps.getLatestMarketIntelligenceCollectionRunForChannel`
read, and fold the results into the five arrays above. `newDiscoveries`/`trendCandidates` are single,
separate calls (`listDiscoveryCandidates`/`listTrendCandidatesWithFreshness`), not per-channel, and
are fetched regardless of watchlist size (§7 AC-1/AC-2 — they do not depend on the watchlist at all).

**Per-channel race (found necessary by advisor review):** a channel can be removed from the watchlist
(the Remove button is on this same Research tab) between this action's own `listWatchlist()` call and
the per-channel `getChannelIntelligenceSummary` call that follows for it, which would otherwise throw
`RESEARCH_CHANNEL_NOT_AVAILABLE` and 500 the WHOLE Overview over one already-stale row. The per-
channel loop catches ONLY a `DomainError` with `code: "RESEARCH_CHANNEL_NOT_AVAILABLE"` and skips that
one channel (excluded from every array, not a partial/null row); every other error (a genuine bug, a
different `DomainError`, a schema-validation failure) is rethrown unchanged and fails the whole
request — a narrow, code-checked catch, not the bare/broad catch pattern RISK-19/21/33 already
removed elsewhere in this codebase. A test simulates this race (a channel present in `listWatchlist`'s
own result but already gone by the time its own summary is fetched) and asserts the response still
succeeds with that channel simply absent from every array.

**Cost, stated plainly (an accepted scope call, not an oversight):** this is `N` full
`getChannelIntelligenceSummary` calls for `N` watchlisted channels, each already doing the same
per-channel work 9H part A's own Channels view does one-at-a-time — now done for the whole watchlist
in one request. For today's realistic watchlist sizes (a manually-curated, operator-added list — no
auto-discovery-driven growth per owner decision 4) this is the same shape of tradeoff already
accepted for RISK-79 (9H part A itself). `getMarketOverview` is fetched only when the Research tab's
Overview section is actually mounted (matching every other tab's own on-demand-fetch convention,
`AGENTS.md`-documented in `dashboard/page.tsx`), never on every dashboard page load — so this cost is
paid once per Research-tab visit, not once per app session. If watchlist size becomes large enough
for this to matter in practice, batching/parallelizing the per-channel calls (`Promise.all` — already
safe today since each is read-only) is the first, cheap follow-up; not done here since correctness,
not throughput, is this slice's own goal, and a premature `Promise.all` would only reorder work that
already completes in well under a second for realistic sizes.

## 5. New API route and schema

- `GET /api/market-intelligence/overview` → `getMarketOverview()`. Injectable-handler factory shape
  (part A's own `create-playlist/route.ts`-derived convention), its own `route.test.ts`.
- `getMarketOverviewOutputSchema` (schemas.ts, next to `getChannelIntelligenceSummaryOutputSchema`):
  reuses the already-local `marketDiscoveryCandidateSchema`/`breakoutAssessmentSchema`/
  `emergingChannelAssessmentSchema`/`marketTrendCandidateSchema` (all already defined in this same
  file); `collectionWarnings`' own `dataQualityFlags` field is a NEW, narrower
  `z.enum(["stale_observation", "quota_limited", "missing_snapshot"])` array (§3a) — not the full
  `dataQualityFlagSchema` — plus `latestRunStatus: z.enum(["success", "skipped_quota_limited",
  "failed"]).nullable()` and `neverObserved: z.boolean()` (§3b). `.strict()` throughout, matching this
  module's own convention. No input schema needed (no parameters, mirrors `listWatchlist`'s own
  no-input shape).

## 6. UI

New `market-overview-panel.tsx`, mounted first in the Research tab's existing stack (before
`MarketResearchPanel`), matching owner spec §30's own listing order ("Market Overview" first). Five
sections, reusing this project's existing conventions (`formatDisplayDateTime` for dates, the amber
pill-badge style `market-research-panel.tsx` already uses for `dataQualityFlags`, emerald text for a
breakout exactly like the Channels view already does):

- **Watchlist** — plain count ("N channels tracked").
- **New discoveries** — title, channelId, firstSeenAt; empty state: "No new discoveries — use
  Discover channels below." (points at the already-existing `MarketDiscoveryPanel` section further
  down the same tab, no real navigation needed since everything is one scrollable stack).
- **Breakout videos** — channelId, videoId, ratio/reason (reuses part A's own `reason` string
  verbatim — already human-readable, no new formatting logic).
- **Emerging channels** — channelId, reasons (joined list, reuses `EmergingChannelAssessment.reasons`
  verbatim).
- **Trend candidates** — title, status, freshness badge (reuses `MarketTrendsPanel`'s own freshness
  wording exactly. **Correction (advisor review, post-implementation):** this section originally
  guessed the exact phrasing part A introduced ("Evidence added within 30 days"/"No new evidence in
  30+ days") without checking the real shipped component -- `market-trends-panel.tsx` actually
  renders "evidence added recently"/"no recent evidence" for `fresh`/`needs_attention`, and that is
  the exact wording this part's own component reuses, not the guessed phrasing above).
- **Collection warnings** — channelId, narrowed flags (amber pills, same style as the Channels view),
  a distinct red pill for `latestRunStatus === "failed"` (visually distinguishable from the amber
  staleness/quota pills, since a hard failure is a different, more actionable severity than
  "just old"), and a neutral (not amber/red) pill "Never collected" when `neverObserved: true` — a
  channel that was simply added and not yet refreshed is not itself a problem the way a failure or
  staleness is, so it gets its own, less alarming visual treatment.

Every section's empty state renders a plain sentence, never an empty box with no explanation (this
project's existing convention, e.g. the Research tab's own "Auto-refresh is off" banner).

## 7. Acceptance criteria (drafted from the requirement, `AGENTS.md` §L, before implementation)

1. Empty watchlist (`listWatchlist()` returns zero channels): `getMarketOverview()` returns
   `watchlistCount: 0`, and `breakoutVideos`/`emergingChannels`/`collectionWarnings` all empty, with
   zero `getChannelIntelligenceSummary`/collection-run calls made (no crash iterating an empty list,
   no wasted read). `newDiscoveries`/`trendCandidates` are NOT asserted empty here — see AC-2, since
   neither depends on the watchlist at all (§4).
2. Empty watchlist PLUS one `status: "new"` discovery candidate already recorded (a candidate is
   never already on the watchlist by 9C's own rule, so this is a realistic, not contrived, state):
   `newDiscoveries` still contains that candidate — proves this array is never accidentally gated on
   watchlist size.
3. Discovery candidates fixture with one of each status (`new`/`watching`/`promoted`/`ignored`/
   `archived`): `newDiscoveries` contains exactly the one `status: "new"` candidate.
4. Breakout fixture reusing 9H part A's own hand-computed scenario (day-7 age-normalized views
   `[10, 20, 30, 65]` for 4 recent videos on one watchlisted channel, plus a second channel with only
   non-breakout videos): `breakoutVideos` contains exactly one entry — the `65`-view video, `ratio:
   3.25`, `isBreakout: true`, tagged with its own channel's `channelId` — and nothing from the second
   channel.
5. Emerging-channel fixture (hand-checked, per advisor review): channel A has day-7 age-normalized
   views `[10, 10, 10, 10, 100, 100]` across 6 recent videos. For each `100`, the other five values'
   median is `10`, ratio `10` → breakout; for each `10`, the other five (`[10,10,10,100,100]`)'s
   median is `10`, ratio `1` → not a breakout. Exactly 2 breakouts, meeting
   `EMERGING_MIN_BREAKOUT_VIDEOS` (2), combined with a positive `full_window`-basis subscriber
   velocity: channel A appears in `emergingChannels` with `isEmerging: true`, `recentBreakoutVideoCount:
   2`, non-empty `reasons`. Channel B (zero breakout videos, AND a non-positive-or-`insufficient_
   history` subscriber velocity — both conditions needed, since `assessEmergingChannel` treats
   positive current-basis velocity alone as already sufficient, §historical-intelligence.ts) does not
   appear in `emergingChannels` at all.
6. `trendCandidates`: for a fixed DB state, `getMarketOverview().trendCandidates` is asserted
   byte-for-byte identical to a direct `listTrendCandidatesWithFreshness()` call against the same
   state — a passthrough-identity property, not an independently-derived value (honestly stated as
   such, not disguised as a fresh computation).
7. A channel whose latest `market_intelligence_collection_runs` row has `status: "failed"`, with its
   channel snapshot still inside the 24h freshness window (no `stale_observation` flag would fire):
   appears in `collectionWarnings` with `latestRunStatus: "failed"` — pins the "immediate signal, not
   dependent on eventual staleness" requirement from §3.
8. A channel with a fresh snapshot, a `"success"` latest run, and no other narrowed quality flag:
   does **not** appear in `collectionWarnings` at all (never an empty-flags placeholder row).
9. A channel whose ONLY `dataQualityFlags` entry is `hidden_subscriber_count` (fresh snapshot,
   `"success"` latest run): does **not** appear in `collectionWarnings` — pins §3a's narrowing.
10. A channel that has never been collected at all (`channelSnapshots.length === 0`, `latestRun ===
    null`): appears in `collectionWarnings` with `neverObserved: true`, `latestRunStatus: null`, and
    only whatever narrowed flags (if any) `getWatchlistEntryContext` itself would already produce for
    that same state — pins §3b (never a silent, false all-clear).
11. Per-channel race: a channel present in `listWatchlist()`'s own result throws
    `RESEARCH_CHANNEL_NOT_AVAILABLE` when its own `getChannelIntelligenceSummary` is fetched (removed
    mid-request) — the response still succeeds, that channel is simply absent from every array, and a
    second, unrelated `DomainError`/thrown error from the same call is NOT swallowed (propagates and
    fails the request) — pins the narrow-catch requirement from §4.
12. New API route: a `route.test.ts` proving the real DB/DomainError-mapping shape (session handling,
    500-on-unexpected-error), matching every other route added this phase.

## 8. Live verification

No live YouTube call anywhere in this part (pure aggregation of already-collected local rows). Any
throwaway verification script runs with `NODE_TEST_CONTEXT=1` and prints
`getProductionAppPaths().dbPath` first, per `docs/TECHNICAL_DEBT.md` RISK-63's own established
convention — never touches the real local app-data database (currently schema v27, RISK-63 still
OPEN).

## 9. Documentation

- `docs/SYSTEM_MAP.md` §2.9v: append this part's own bullet (the new action/route/component, its
  read-only composition over 9C/9H-A/9G-a, no contract change to anything it wraps).
- `docs/ARCHITECTURE.md`/`docs/interfaces.md`: record the new `GET .../overview` route (Web UI only,
  no MCP/CLI contract).
- `docs/roadmap/plans/PHASE_9_PLAN.md` §14 unaffected (still accurately describes 9H's overall scope;
  this file records this part's own slice of it, per this project's own one-file-per-part convention).
