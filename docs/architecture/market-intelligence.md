> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 18. Market Intelligence (`src/lib/market-intelligence/`) — Phase 9, slices 1-4 + 9A-9E + 9G + 9H (parts A-C) + 9I

Owner instruction, Telegram 2026-09-26: an explicit assignment to research, plan, and begin
implementing Phase 9 (`docs/roadmap/FUTURE_PHASES.md` §5) as its own feature branch, superseding
§2a's Operational Validation Gate default ordering for Phase 9 specifically (see `FUTURE_PHASES.md`
§12). **Detailed design, slice breakdown, and acceptance criteria live in
`docs/roadmap/plans/PHASE_9_PLAN.md` and `docs/SYSTEM_MAP.md` §2.9v -- this section states only the
one architectural decision worth recording permanently here, not the full slice-by-slice detail.**

**The one new trust boundary this phase introduces:** every table this application had before Phase
9 implicitly assumes the operator owns the channel/video a row describes (`channels.id` is always a
channel `write-context.assertWriteChannel` could plausibly authorize a write against). Phase 9 is
the first phase whose entire purpose is data about a channel the operator does *not* own. Rather
than adding a nullable "is this owned?" flag to an existing table, this is enforced structurally:
`research_channels`/`research_evidence` are new, separate tables, never joined with
`channels`/`videos`, and a mechanical inventory test
(`src/lib/market-intelligence/write-path-inventory.test.ts`) fails the suite if any file in this
module ever references `write-context`/`assertWriteChannel`/`youtube-write-gateway`. This is the
same "enforce the invariant mechanically, not by convention" pattern already used for the read/write
gateways (§17's own reuse of `AGENTS.md` §G) and for `ai-connections`'/`shared-xlsx`'s own inventory
tests -- applied here to a new *data-ownership* boundary rather than a new *call-site* boundary.

The one real outbound YouTube call this phase makes (`getPublicChannelSnapshot`,
`src/lib/youtube-read-gateway/data-api.ts`) is a new function on the existing single read gateway
(`docs/decisions/0007-youtube-read-gateway.md`), never a new client or a direct `googleapis` import
-- confirming that gateway's own design already generalizes to reading an arbitrary, non-owned
channel's public data by explicit id, which this phase needed and which nothing before it had
exercised.

**Slice 4 (`docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`, 2026-09-26) -- agent-facing MCP/CLI
surface, fulfilling the two capability names `agent-operations` reserved since Phase 7
(`query_market_intelligence`/`query_competitors`).** Registered directly in `src/mcp/server.ts`/
`src/cli/video-metadata.ts` against `createMarketIntelligenceCore()`, deliberately **not** through
a new function in `agent-operations`'s own service layer the way slice C/K/L wrap `analytics`/
`comparable-content`/`asset-performance`. `PHASE_9_PLAN.md` §5's module-independence rule forbids
adding `market-intelligence` as a hard dependency of another module's *service* layer; keeping this
dependency confined to the MCP/CLI *interface* layer (which already imports every domain module's
own core factory directly, e.g. `analyticsCore`) avoids that without losing anything -- neither tool
needs slice C/K/L's richer "agent context" reshaping. `agent-operations`'s own `AGENT_CAPABILITIES`
still gains two entries under a new `market_intelligence` domain, following the same
"pre-existing tool, registered here for capability-discovery completeness" pattern already used for
`channel_context.list_channels`/`analytics.query_data_quality`.

**Slice 9A (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md`, 2026-09-26) -- structured, append-only
market snapshot model, the first slice of Phase 9's extended scope (Part II).** New
`market_channel_snapshots`/`market_video_snapshots` tables (SCHEMA_MIGRATIONS v23), FK'd to
`research_channels.id`. **Never upserted by any natural key** -- the central finding this slice's
own plan documents (§2/§10): unlike `video_metrics_daily`'s per-day upsert (correct for owned-
channel Analytics API data, which has a real "historical day" concept), `channels.list`/
`videos.list` return only the *current* cumulative count with no way to ask for a past day's value
-- every real observation must be its own newly-inserted row, or the exact history Phase 9's own
irreplaceability priority (spec §38, `PHASE_9_PLAN.md` §10) depends on would be silently
overwritten. `deleteResearchChannel` (`src/lib/db.ts`) was widened to cascade-delete both new
tables in the same transaction as `research_evidence`, closing the identical FK-ordering hazard
RISK-46 already taught this codebase the hard way.

**Derived metrics (delta, velocity) are pure functions computed at READ time** over raw snapshot
rows (`src/lib/market-intelligence/derived-metrics.ts`, styled after `src/lib/analytics/
staleness.ts`: zero I/O, `now` always an explicit argument) -- never a second, redundant stored
representation (spec §8's own "prefer retaining raw observations so formulas can evolve later").
`computeSnapshotVelocity` reports an explicit `insufficient_history`/`partial_window`/`full_window`
basis alongside its computed rate, rather than silently extrapolating over a span the real data
doesn't actually cover -- the same "expose limitations when history is incomplete" discipline
(spec §27) this slice's own `hiddenSubscriberCount` boolean column applies at the storage layer
(an explicit fact -- "YouTube hides this" -- kept structurally distinct from "we don't know").

**Deliberately narrower than the plan's own literal 9A text**, and explicitly recorded as such
(`PHASE_9_SLICE_9A_PLAN.md` §1): `market_video_snapshots` ships with a full schema and CRUD service
layer (`recordVideoSnapshot`/`listVideoSnapshots`) so 9B has something to write into and it is
independently testable now, but **no automatic collector writes to it yet** -- real video-
enumeration (walking a channel's uploads playlist, batching `videos.list`) is 9B's own named scope,
not silently pulled forward into this slice. `captureChannelSnapshot` (the one live YouTube call
this slice adds) reuses the identical `getPublicChannelSnapshot` read-gateway call `fetchPublicSnapshot`
(slice 3) already uses, but is a pure *addition* -- `fetchPublicSnapshot`'s own existing
`research_evidence` write path is completely untouched, proven by a dedicated test
(`AC-9A-10`, `services.test.ts`).

**Slice 9B (`docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md`, 2026-09-27) -- repeatable refresh, real
video collection, an operator-set quota budget, and a check-on-app-open scheduler.** Fills the gap
9A's own plan explicitly named: a data model and one manual/on-demand live action, with zero
automatic trigger. The one architectural decision worth recording permanently:

**A stricter, dedicated mark-then-run concurrency guard, not a reuse of Phase 8's own
`runAutoCollectionIfStale` pattern.** Direct inspection (before implementation, advisor review)
found that Phase 8's own auto-collection is actually mark-*after* -- it marks
`channels.analyticsLastAutoCollectedAt` only once collection finishes, and its own doc comment
explicitly accepts a rare double-collection race between two concurrent callers as a deliberate
tradeoff (Analytics quota is ample enough that a rare double-spend is harmless). That tradeoff does
not transfer here: this feature's daily budget is an operator-set number that can be small, so a
double-spend is a real correctness problem, not a rare harmless waste. This slice therefore adds its
own `research_channels.collection_claimed_at` column (nullable timestamp, same v24 migration as
`last_auto_collected_at`) and claims every eligible channel in ONE atomic
`UPDATE ... WHERE (stale) AND (unclaimed) ... RETURNING id` at the start of a run -- not
per-channel -- so two concurrent callers (two open dashboard tabs) can never together claim
overlapping channels, closing a race a per-channel-only claim would still leave open against a
run-scoped shared budget. A claim is released the moment its channel's attempt reaches any terminal
outcome; a claim older than 15 minutes is treated as an abandoned (crashed) attempt and may be
reclaimed, so a crash never permanently locks a channel out of future collection. This atomicity is
verified directly against the real libsql driver (`db.test.ts`), not assumed from SQLite's general
reputation.

Budget accounting is metered per real outbound call, not per assumed channel cost: the collector
tracks `remaining` across the whole run and, the moment a channel's next call can't be paid for,
writes exactly one `skipped_quota_limited` row for that channel (with whatever it honestly spent so
far, even 0) and releases every other still-claimed channel without its own row -- a deliberate
choice (found necessary by advisor review) to avoid writing one identical audit row per remaining
stale channel on every single dashboard mount once the budget merely runs short. A channel whose
most recent run failed within the last 24h is excluded from the next claim entirely, for the
symmetric reason: without this, a permanently broken (deleted/private) competitor channel would
spend at least one real unit on every mount, forever.

Video enumeration is deliberately capped to a channel's uploads playlist's first page only (a new
`listUploadsPlaylistFirstPageVideoIds`, exactly one `playlistItems.list` call, never paginates) --
an earlier drafted design widened the existing `listUploadsPlaylistVideoIds` with an `maxResults`
option instead, but advisor review found that would leave the real unit cost unobservable to the
caller whenever the first page came up short and a second page had to be fetched, silently
under-counting real spend. Capping by PAGE rather than by count makes the cost exactly and always 1
unit, deterministically -- consistent with this feature's own "never fabricate a unit-spend number"
requirement.

**Slice 9C (`docs/roadmap/plans/PHASE_9_SLICE_9C_PLAN.md`, 2026-09-27) -- search.list-based
discovery, minimal by design.** Full detail lives in the plan doc and `docs/SYSTEM_MAP.md` §2.9v;
the one architectural point worth recording here: `market_discovery_candidates` is a **lifecycle
table** (rediscovery refreshes `lastSeenAt` -- since Phase 13 also `title`/`reasonDiscovered`, restarting
their 30-day clock -- never duplicates a row or resets an operator-set `status`), architecturally unlike 9A/9B's append-only snapshot/run tables -- it is closer in shape
to `research_channels` itself than to `market_channel_snapshots`. Its own run-log
(`market_discovery_runs`) is a separate table from 9B's `market_intelligence_collection_runs`
(that one's `research_channel_id` is `NOT NULL` and FK'd to the watchlist, which a discovery run
-- not about any one watchlisted channel -- cannot satisfy). Originally both fed one shared daily
budget (owner decision 2); since Phase 13 slice 13.4 `search.list` has its own bucket (100 calls a day,
`countMarketDiscoverySearchesSince`) and `getMarketIntelligenceUnitsSpentSince` sums collection only.

**Discover rework (BL-145, 2026-10-07, owner msgs 1900/1904/1905; analysis `docs/roadmap/plans/RESEARCH_DISCOVER_ANALYSIS.md`).**
Two search modes. *By genre* (default, `discoverChannelsByGenre`, `POST /discover {mode:"genre", publishedWithinDays?}`):
one `search.list type=video videoCategoryId=10` (1 call of the 100-searches bucket, up to 50 videos, optionally only the
last 30/90/180/365 days), grouped by channel, most matches first; auto-generated "… - Topic" channels are left out (title
suffix -- YouTube has no API flag); each channel gets `match` (videos matched, their total views via one `videos.list`,
the query). *By channel name* is the original `discoverChannels`. Both then record each found channel's public counts
(`stats`: subscribers or hidden, videos, views, creation date, observed-at) with one `channels.list` per 50 (1 pool unit)
-- best effort, a failed lookup never fails the search. Schema v65 adds those columns; the 30-day purge blanks them with
the title; a re-found candidate drops its older counts/match before they are re-observed, so nothing older than its
`last_seen_at` is ever served. The lookups' pool units are recorded on the search's run row (`pool_units_spent`) and
count in the Research daily unit budget; with no room left they are skipped. Searches no longer require that budget to
be set (the search itself never spends it); a search is logged in the quota history as "Research search", and
`countsAgainstPool` (youtube-quota) keeps `search.list` out of every 10,000-unit pool total (Settings bar, quota
guard, quota history). An agent's research request is limited to 200
characters like the search; on approval the found candidates are assigned to the requesting channel (approve route).
Discover offers Track (= promote, reason pre-filled from the query), Ignore and Archive; the old "watching" status is
no longer offered. Known gap, not fixed here: `videos.batchGetStats` returns no duration, so video durations are empty
(BL-146).

**Slice 9D (`docs/roadmap/plans/PHASE_9_SLICE_9D_PLAN.md`, 2026-09-27) -- historical intelligence,
code-complete with no calling code yet (`historical-intelligence.ts`, mirroring 9A's own
`derived-metrics.ts` at that same stage).** The one architectural point worth recording here: every
comparison this file makes is **age-normalized by construction**, never a raw lifetime-view
comparison -- `ChannelVideoBaseline` and the video argument to `assessBreakout` both carry an
explicit `dayOffset`, and the function refuses the comparison outright when they don't match, rather
than silently comparing across mismatched ages. This closes a real defect advisor review found
before merge: an earlier draft computed a channel's baseline and a candidate breakout video from
raw, un-normalized total view counts, which made every old video look like a "breakout" purely by
having had more time to accumulate views -- a direct violation of spec §9's "avoid comparing old and
new videos only by total views" one level up, at the baseline-comparison layer rather than the
single-video layer the spec text names literally. `computeAgeNormalizedViews` additionally rejects a
snapshot that is merely the *closest available* candidate for a target day-offset when it falls
outside a tolerance window (`max(1 day, 25% of dayOffset)`), returning `insufficient_history` rather
than silently mislabeling, say, a day-30 snapshot as "day 7" data. Real service/API/UI wiring over
these functions, and live verification against real accumulated multi-day history, are both
out of scope here (BL-105) -- this slice ships only the pure comparison logic, hand-tested against
synthetic fixtures derived from the spec, not from the implementation.

**Slice 9E (`docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md`, 2026-09-27) -- manual/structural topic and
trend model, two parts.** Part A (`market_topics`/`market_topic_assignments`) is a plain manual
tagging layer: a topic is a name an operator declares by hand, assignable to either a watchlisted
channel or a bare video id, with no AI classification anywhere in this slice (an explicit exemption
from owner decision 3's AI-connection gating, since nothing here calls an AI provider at all).

Part B (`market_trend_candidates`/`market_trend_evidence`) is where spec §14's "do not allow
lifecycle labels to exist without supporting observable rules or evidence" becomes a structural,
not merely documented, constraint: `createTrendCandidate`'s own input schema requires an
`initialEvidence` object, so there is no code path in this module that can create a trend candidate
with zero evidence rows. The same discipline extends to status changes -- `updateTrendCandidateStatus`
requires a non-empty `reason`, which the service layer writes as a `"signal"`-type evidence row in
the exact same action as the status change (advisor review, before implementation: "every status
change should require a reason, written as a signal evidence row in the same action"), so a status
can never move without a corresponding entry in that trend candidate's own evidence history.
`lastObservedAt` is deliberately only ever moved by an evidence write (including the evidence row a
status change itself produces), never by a bare status mutation alone -- there is no code path that
advances `lastObservedAt` without also appending to the evidence trail that justifies it.
`market_topic_assignments.subjectId` deliberately carries no foreign key (a single column cannot
conditionally reference two different tables depending on `subjectType`, and a video has no
canonical single-row table to reference in the first place); `deleteMarketTopic` cascade-deletes its
own assignments but only detaches (`topicId` set `NULL`, never deletes) any trend candidate tagged
with the removed topic, since losing a label should never destroy an otherwise-independent trend
candidate's own evidence history.

**Slice 9I (`docs/roadmap/plans/PHASE_9_SLICE_9I_PLAN.md`, 2026-09-27) -- shared data-quality
vocabulary (owner spec §27), taken ahead of 9F/9G/9H per advisor review.** Code-complete, no calling
code yet (`data-quality.ts`, mirroring 9A's `derived-metrics.ts`/9D's `historical-intelligence.ts`
at that same stage). The one architectural point worth recording here: a new `DataQualityFlag` union
(`contracts.ts`) collapses several previously-independent, bespoke local shapes (9A's
`hiddenSubscriberCount` boolean, 9D's `basis` return value, 9B's `"skipped_quota_limited"` status,
9C's partial-progress-before-failure counts) into one name other code can pattern-match on, rather
than each module keeping its own ad-hoc vocabulary indefinitely. **A documented spec/API-capability
discrepancy, not a silent drop (`AGENTS.md` §A):** the union has seven entries, not the spec's
literal eight -- `deleted_video`/`private_video` are collapsed into one `video_no_longer_public`.
**Correction (2026-09-27, later the same day; the original claim below was overstated):** this
slice's own plan doc and an earlier version of this section both said the two were "verified" as
indistinguishable against the API's documented behavior. Re-checked directly: the official
`videos.list` docs do not describe per-id behavior for a multi-id request at all (confirmed by
fetching that page, not assumed), and `playlistItems.list` (the other call 9B's own collector makes)
has a `status.privacyStatus` field whose behavior for a since-deleted video is likewise undocumented
there. The premise that a private video is never visible to an unauthenticated/public caller is
solid (YouTube's own access model), but the stronger claim -- that this codebase's specific call
pattern genuinely cannot tell "deleted" from "private" -- is **not documented and not live-verified**
(would need a real API call against a known deleted vs. known private video id, which spends real
quota and was not authorized for this purpose). The seven-entry union and the `video_no_longer_public`
collapse stand as this module's own design choice either way (still the more honest option
absent a confirmed distinguishing signal), but the discrepancy note should say "undocumented,
unverified," not "verified." `MARKET_INTELLIGENCE_STALE_WINDOW_MS` moved from a private `services.ts`
constant to `contracts.ts` so this module's own staleness threshold and 9B's real
collection-staleness check share the exact same value, never two copies that could drift.

**Slice 9G, part A (`docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md`, 2026-09-27) -- agent read
surface, taken as a plain READ-class extension before the approval-integrity part B (advisor
review's explicit split).** `getWatchlistEntryContext` -- the single implementation both MCP's
`query_market_intelligence` and CLI's `agent market-intelligence` already shared -- gained
`channelSnapshots`/`videoSnapshots`/`topicAssignments` and a derived `dataQualityFlags`, additive to
its original `{channel, evidence}` shape. This is 9I's own first real caller, exactly as that
slice's plan anticipated. A new `agent_list_market_records` MCP tool/`agent market-records --kind
<kind>` CLI command covers topics/trend candidates/discovery candidates through one tool with a
`kind` discriminator rather than three separate ones (owner spec §28's own "prefer a small number
of powerful composable MCP tools"), as a thin fan-out over the module's own already-existing
`listTopics`/`listTrendCandidates`/`listDiscoveryCandidates` -- no new service logic. Both stay
global and unzoned, explicitly citing slice 4's own precedent rather than leaving the exemption
implicit (`docs/DEVELOPMENT_PLAYBOOK.md` §6.7 point 6 otherwise requires `assertActiveChannel`
channel-scoping for every MCP tool by default). One new, narrow `db.ts` read,
`getLatestMarketIntelligenceCollectionRunForChannel`, fills the one per-channel gap that table
never had (only the aggregate `getMarketIntelligenceUnitsSpentSince` sum existed) -- used to derive
`missing_snapshot`/`quota_limited` for that channel's own most recent collection attempt.
`AGENT_API_VERSION` bumped to `0.12.0` for the new capability; no `ZONED_CAPABILITIES` entry, since
READ-class tools in this codebase are never zoned.

**Slice 9G, part B (`docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md`, 2026-09-27) -- agent-
created research requests, this codebase's first agent-facing DRAFT-class capability with a real
approval gate (owner spec §29).** Two templates existed to choose from, and the choice matters: this
module's own `content-proposals` is deliberately write-once with no approval workflow at all (its
own contracts.ts doc comment says so explicitly), while `changesets` already has a full
`approvalStatus` model whose `approveChange`/`rejectChange` actions are, by direct inspection,
registered as neither an MCP tool nor a CLI command anywhere -- approval is reachable only through
the Web UI's own API routes. This slice copies that second shape, not the first: an agent may only
create a `market_research_requests` row (`status: "pending"`); moving it to `"approved"`/
`"rejected"` exists ONLY as a Web UI action, enforced not just by omission but mechanically -- a new
inventory test (`market-research-request-approval-inventory.test.ts`, styled after
`write-path-inventory.test.ts`) scans every source file under `src/mcp/**`, `src/cli/**`, and
`src/lib/agent-operations/**` and fails if any of them references the approve/reject actions by
name, with `src/app/api/**` (where the real routes live) the one deliberate exemption.

Approval is one atomic conditional transition (`UPDATE ... WHERE status='pending' ... RETURNING`,
the same shape `claimStaleResearchChannelsForCollection` already established in this module) --
proven against the real libsql driver with a literally-concurrent `Promise.all` pair, not only
against a fake store (RISK-70's own resolution already showed a fake store proves nothing about
real atomicity). `monitorDurationDays` (spec §29's own "Monitor for 30 days" example) is stored and
returned but never read by any code path that decides whether/when to run anything -- the concrete,
structural reason this cannot become the "unlimited collection jobs" the spec explicitly forbids:
there is no scheduler anywhere in this application for such a field to feed.

**The one design correction worth recording (advisor review, before implementation):** the first
draft of this slice ran its `discoverChannels`-equivalent quota/reads preconditions AFTER the
`pending -> approved` transition. Since the operator-set daily quota budget defaults to `null`
(never a hardcoded value, an explicit owner decision from Part II's own gating decisions), that
would have made the FIRST approval on any fresh install fail unconditionally and permanently, with
the request stuck in `execution_failed` and no path back to `pending`. The corrected design extracts
`discoverChannels`'s own upfront precondition check into a shared helper
(`assertDiscoveryPreconditions`) and calls it BEFORE the atomic transition -- a missing/exhausted
budget now leaves the request genuinely untouched (still `pending`), and the real `discoverChannels`
call afterward re-runs the same check anyway (cheap, intentional defense-in-depth against a race
between the two).

**Slice 9H, part A (`docs/roadmap/plans/PHASE_9_SLICE_9H_PART_A_PLAN.md`, 2026-09-27) -- Channels
intelligence view, the first real caller either `derived-metrics.ts` (9A) or `historical-
intelligence.ts` (9D) has had since they shipped.** Two new UI-only service actions compose EXISTING
reads/pure functions rather than extending any existing MCP/CLI-facing contract:
`getChannelIntelligenceSummary` calls `getWatchlistEntryContext` internally and layers computed
subscriber velocity, upload cadence (the same `computeSnapshotVelocity` call's `videoCount` field),
per-video breakout assessment, and an emerging-channel verdict on top; `listTrendCandidatesWithFreshness`/
`getTrendEvidenceSummary` do the same over `listTrendCandidates`/`getTrendEvidence` (the latter
renamed from `listTrendEvidence` once this same slice's own PHASE9-INV-02 widening flagged it as
sharing its db.ts counterpart's exact name -- see the module's own `write-path-inventory.test.ts`).

**The one architectural point worth recording is the breakout baseline's own methodology choice,
found necessary by advisor review before implementation:** each recent video is compared against a
**leave-one-out** baseline -- the median of every OTHER recent video's own age-normalized view count,
never including the video itself. Including a video in its own baseline biases the comparison exactly
when it matters most: with a small recent-video sample, a single genuine breakout can pull the
baseline itself upward, partially masking the very signal being measured. The concrete disagreement
this was pinned against (also this slice's test fixture): four videos with day-7 age-normalized views
`[10, 20, 30, 65]` -- leave-one-out gives the video at 65 a baseline of 20 (median of the other
three) and a ratio of 3.25 (a breakout, `>= BREAKOUT_RATIO_THRESHOLD`); include-self gives it a
baseline of 25 (median of all four) and a ratio of 2.6 (not a breakout). The cost of the more
defensible method is stated plainly, not hidden: leave-one-out needs `BREAKOUT_MIN_BASELINE_SAMPLE_SIZE`
(3) OTHER recent videos, i.e. 4 total, before ANY video can get a verdict at all.

`RECENT_VIDEO_WINDOW_DAYS` (180, not a narrower window) is itself a considered choice, not an
arbitrary round number: this application's only collection trigger is a dashboard page load
(`collect-if-stale`, gated to at most once per 24h per channel, no background scheduler exists;
since BL-139 it also waits until device sync has caught up, §23) --
a video's own day-7 age-normalized point only exists at all if a collection run happened to land
within `ageNormalizedTolerance(7)` (`max(1, 7*0.25)` = 1.75 days) of its 7-day mark. A monthly-or-
slower-uploading channel needs a wide `RECENT_VIDEO_WINDOW_DAYS` just to have a realistic chance at
the 4 qualifying videos leave-one-out requires; widening this window costs nothing, since a video
lacking a usable point simply reports `insufficient_history` (via `computeAgeNormalizedViews`) and is
excluded from every other video's baseline sample, never fabricated. The four named constants driving
all of this (`CHANNEL_VELOCITY_WINDOW_DAYS`, `CHANNEL_BASELINE_DAY_OFFSET`, `RECENT_VIDEO_WINDOW_DAYS`,
plus 9H's own new `TREND_EVIDENCE_FRESH_WINDOW_DAYS` for Trends) are exported from `services.ts` and
returned to the client inside `getChannelIntelligenceSummary`'s own `methodology` field, rather than
hardcoded a second time client-side where they could drift -- shown in the UI next to the figure each
one produced, since an unstated methodology is exactly the "opaque score" owner spec §11 forbids.

`getChannelIntelligenceSummary` deliberately does NOT return `getWatchlistEntryContext`'s own
`videoSnapshots` array -- an unbounded, append-only series (tracked as RISK-78, `docs/TECHNICAL_
DEBT.md`, since this is the first time anything renders it to a human rather than an agent
making one bounded MCP call) that must not ship over the network in full merely because the DOM
rendering of it is bounded. `latestSnapshotPerVideo` (one row per distinct video, computed
server-side) replaces it for the main view; a separate `getChannelVideoSnapshotHistory` action
(its own new route) serves one video's own full series on demand, filtering server-side before
returning so the bounded response, not just the bounded render, is the actual fix.

**Slice 9H, part B (`docs/roadmap/plans/PHASE_9_SLICE_9H_PART_B_PLAN.md`, 2026-09-27) -- Market
Overview, aggregating part A's own per-channel composition across the WHOLE watchlist.** A new
`getMarketOverview()` action calls `getChannelIntelligenceSummary` once per watchlisted channel and
folds the results into `breakoutVideos`/`emergingChannels` (filtered to `isBreakout`/`isEmerging`,
each entry tagged with its own `channelId`), alongside two watchlist-independent reads
(`listDiscoveryCandidates` filtered to `status: "new"`, and a direct passthrough of
`listTrendCandidatesWithFreshness`). No existing action's output schema changes -- the same
"compose, don't extend" precedent part A established.

Two findings from this slice's own pre-implementation advisor review are worth recording structurally,
since both are the kind of gap that is easy to reintroduce in a future aggregation over this same
data: (1) **a channel-level `DataQualityFlag` is not automatically a "collection warning"** --
`hidden_subscriber_count` is a property of the channel (the owner hides it on YouTube), not a
collection-freshness problem, so `getMarketOverview` narrows the flag set it surfaces here to exactly
`stale_observation`/`quota_limited`/`missing_snapshot`, never the full seven-value vocabulary. (2)
**"never observed" produces no flag at all from `assessObservationFreshness`/`assessSnapshotCompleteness`**
(both explicitly treat a `null` last-observation as outside their own scope) -- naively surfacing only
non-empty `dataQualityFlags` would show a never-collected channel (the realistic first-render state
on a fresh watchlist, before any real collection has run) as having zero warnings, a false all-clear
that is actively worse than showing nothing. `getMarketOverview` adds its own explicit
`neverObserved: true` case for a channel with zero channel snapshots, and separately reads
`getLatestMarketIntelligenceCollectionRunForChannel` directly (one extra, already-indexed read per
channel) to surface a `"failed"` latest run immediately -- not only once `stale_observation` would
eventually fire 24h later.

A channel removed from the watchlist between this action's own `listWatchlist()` call and the
per-channel `getChannelIntelligenceSummary` fetch that follows for it (a real race, since the Remove
button lives on this same Research tab) is caught narrowly by `DomainError` code
(`RESEARCH_CHANNEL_NOT_AVAILABLE` only) and skipped -- every other error propagates unchanged, never
the broad/bare-catch pattern RISK-19/21/33 already removed elsewhere in this codebase.

Trend freshness deliberately does NOT reuse 9I's `MARKET_INTELLIGENCE_STALE_WINDOW_MS`/the word
"stale" -- that constant means "a channel collection run hasn't happened in a day," a daily-cadence
concept, while a trend's own `lastObservedAt` only moves on a human timescale (evidence added
manually, or by a future structural detector); worse, `"stale"` already names one of
`TrendCandidateStatus`'s own five lifecycle values, so a `"growing"` trend showing a `"stale"`
freshness badge would visibly contradict itself in the same UI. A new, trend-specific
`TREND_EVIDENCE_FRESH_WINDOW_DAYS` (30, a named starting point, not a claimed-correct number) and
non-colliding wording ("evidence added recently" / "no recent evidence") were used instead.

Neither `listTrendCandidates` (the `agent_list_market_records` MCP tool's own underlying call, and its
CLI counterpart's) nor `getWatchlistEntryContext`'s own output schema were touched -- both wrapper
actions call the existing action and pair its result with newly-computed fields in a SEPARATE return
shape, confirmed by a dedicated test that the original action's own output is byte-for-byte unchanged.
Explicitly out of scope for this part, and why: an "Overview" tab (needs this part's own summary as a
building block first); a "Videos" tab (`market_video_snapshots` has no `title` column -- though
`getPublicVideoSnapshots` already fetches it from YouTube at zero extra quota cost and simply
discards it today, a separately-scoped schema change); an "Opportunities" tab (needs 9F's niche
candidates, which don't exist yet); wiring `detectDisappearedVideoIds` (9I) into any UI (its own doc
comment warns against a naive two-snapshot diff, real design work belonging with the Videos tab).

**Slice 9H, part C (`docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md`, 2026-09-27/28) -- Videos
tab, closing the schema gap part B's own entry named above.** Migration v28 adds
`market_video_snapshots.title` (nullable -- `NULL` for any snapshot taken before this column
existed, never backfilled or guessed from a later, possibly-since-changed title of the same video);
`runCollectionIfStale` (9B) now passes `title` through to `insertMarketVideoSnapshot`, at zero
additional YouTube quota cost (`getPublicVideoSnapshots` already fetched it). An empty-string title
(the read gateway's own fallback when YouTube's response omits `snippet.title`) is normalized to
`null` at capture time, so "not captured" has exactly one representation, never two.

**The one architectural point worth recording is a refactor, not a new mechanism:** the per-video,
age-normalized, leave-one-out breakout assessment 9H part A built inline inside
`getChannelIntelligenceSummary` is extracted into a shared helper, `computeRecentVideoBreakouts`
(`services.ts`, module scope) -- identical logic, now called by both that action (output schema and
behavior unchanged, pinned by its own pre-existing tests continuing to pass unmodified) and this
slice's new `getMarketVideosOverview`, which needed the same methodology per video across the WHOLE
watchlist rather than reimplementing a second, drifting copy of it.

`getMarketVideosOverview` deliberately calls `getWatchlistEntryContext` directly per watchlisted
channel, not `getChannelIntelligenceSummary` (unlike part B's `getMarketOverview`) -- that action
deliberately omits the full `videoSnapshots` array (RISK-78), and this slice genuinely needs each
video's own full snapshot series to compute a per-video view-count velocity (`computeSnapshotVelocity`,
9A, reused by feeding a video's own `viewCount` series into the same `subscriberCount`/`videoCount`-
shaped function part A's own `uploadCadence` field already reuses this way). Topic/format resolution
needed a new bulk read, `listMarketTopicAssignmentsBySubjectType(subjectType)` (`db.ts`) -- the
existing `listTopicsForSubject` takes one `subjectId` at a time, and calling it once per video across
a watchlist would have been a real N+1; `getWatchlistEntryContext`'s own `topicAssignments` field is
channel-subject-only by construction and could not have served this need either way.

Adding `title` to `marketVideoSnapshotSchema` additively widens `getWatchlistEntryContextOutputSchema`
(MCP `query_market_intelligence`/CLI `agent market-intelligence`'s own contract, since it already
embeds `videoSnapshots: z.array(marketVideoSnapshotSchema)`) -- a real agent-contract change, but
**not** an `AGENT_API_VERSION` bump: `src/lib/agent-operations/contracts.ts`'s own doc comment on
that constant explicitly excludes exactly this shape of change ("a new optional input/output field
an existing caller can simply ignore... not every field-level widening"), reserving MINOR bumps for
capability-discovery-relevant changes only. `getMarketVideosOverview` itself has no MCP/CLI surface.

**Research tab layout (BL-140, `docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md`, 2026-10-06).** The tab is a summary
line plus five always-mounted sub-tabs (`src/components/research-tab.tsx`: Inbox, Channels, Videos, Discover, Topics &
trends); the Overview panel is gone. The summary line (`GET /api/market-intelligence/summary`, polled) reads
`getResearchSummaryCounts`, which needs no video series. Whether a channel "needs attention" is one rule,
`classifyCollectionStatus` over `readCollectionState`'s flags, shared by the summary count, the Channels status and
`getMarketOverview`'s collection warnings, so a count and the list it links to always agree.
Lists that can grow are bounded on the server: Videos (`videos-overview?page=…`, R2) and Discover candidates
(`discovery-candidates?page=…&status=…`, R4) return one page; both keep their old unpaged response when `page` is
absent. Channels reads one row per watchlist channel from `getWatchlistTable` (`GET /api/market-intelligence/
watchlist-table`, R3) -- only observed values with their dates, a status from the same data-quality flags
`getMarketOverview` counts as warnings, no derived metric. Record details open in the shared `side-drawer.tsx`; the
per-record "visible to agents" chip editor lives only in a drawer, lists show a pill (`useMarketAssignments`/
`VisibleToPill` in `market-channel-assignment.tsx`, one read per record kind). Web routes only: no MCP tool, schema
or agent contract changed.

## 35. Watchlist hygiene and agent proposals (BL-163, FO-REQ-0014, ADR 0034 Amendment 1)

Plan: `docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md`. Schema v74.

**Activity and pause (market-intelligence).**
- Read model: `listLatestUploadDates` = `MAX(published_at)` of each entry's retained video snapshots (the 30-day window applies to API rows,
  so a paused entry's date fades). `watchlistActivityOf` derives `inactive` = known and older than `monthsBefore(now, N)`; N is the
  `market_intelligence_inactive_after_months` setting (default 6, 1-60). Every watchlist read carries the raw date, `inactive`, `pausedAt`
  and `pausedReason`; nothing is computed from another channel's statistics (III.E.4.h).
- Pause is stored state (`research_channels.paused_at`, `paused_reason` `inactive` | `owner`, `resumed_at`); inactivity only sets it.
  `claimStaleResearchChannelsForCollection` skips paused rows, so neither auto-collection nor an approved collection request collects them.
- Detector: `evaluateInactivity` runs before and after `collectStaleChannels` in `runCollectionIfStale` (and on demand; also when the
  refresh waits for the quota reserve, since it reads only stored data). A detector failure is logged and never fails the collection. It
  skips paused entries, unknown dates, active ones and entries the owner resumed while already inactive (`monthsBefore(resumedAt, N) >=
  newest upload`; a resume from an unrelated pause earlier does not shield), and for the rest calls `pauseInactiveResearchChannel`:
  one transaction that pauses only a still-unpaused row and inserts the system proposal `watchlist.delete` with `onConflictDoNothing` on the
  pending dedupe key (`watchlist.delete|<id>`), so two connections or two passes add one. The proposal stores N, not the upload date
  (another channel's API data may be kept 30 days at most, a proposal can wait longer); the owner's card reads the entry's current date
  from the watchlist. `monthsBefore` counts calendar months and clamps the day (Aug 31 minus 6 months is Feb 28).
- A paused entry has its own collection status `paused` (`classifyCollectionStatus`), which `isCollectionWarning` leaves out of the
  "needs attention" count and filter.
- `setResearchChannelPause` writes only a state change (a paused entry keeps its first reason; resuming stamps `resumed_at`).
  `deleteResearchChannel` also deletes the entry's `channel_record_assignments` rows and its pending proposals.

**Agent proposals (`src/lib/agent-proposals/`).**
- Store: `agent_proposals` (source `producer` | `system`, kind, `channel_id`, `target_id`, `payload_json`, `text`, status
  `pending | applied | rejected | failed`, `dedupe_key` with a unique index -- cleared when decided, so it binds only pending rows --,
  decision fields, `done_at`). In the device snapshot; `notApiData`.
- Services: `submitProducerProposal` checks the channel is connected, the payload per kind (strict zod), and the current state through
  the watchlist port (the entry exists and this channel follows it; pause needs an active entry, resume a paused one; add refuses an entry the
  channel already follows), then inserts; a pending duplicate is `AGENT_PROPOSAL_DUPLICATE`. `approveAgentProposal` checks (for a
  hypothesis) that the proposal's channel is the session's active channel -- `createHypothesis` requires it -- then claims (`decide` to
  `applied`, atomic on `status = pending`) and only then applies; a throw is stored as `failed` with its message (RISK-120 for a stop in
  between). Claim-first is what makes a double approve apply once, and keeps a deletion (which drops the entry's pending proposals) from
  dropping the proposal being applied. `rejectAgentProposal` requires a trimmed comment.
- Apply goes through public cores only: `market-intelligence` (`addToWatchlist` with `createdVia: "mcp"`, `setWatchlistPause`,
  `removeFromWatchlist`, `getWatchlistEntry`, `listWatchlist` for labels), `market-assignments` (`listAssignments` / `setAssignment` for
  follow and unfollow) and `decision-engine` (`createHypothesis`, `createdBy: "producer"`). None of them depends on this module (§M).
- Cleanup runs only on the gated writes (approve, reject, mark-done; never on a read, so nothing is deleted during a device handoff):
  decided rows that are done, or decided more than 90 days ago, are deleted. Reads leave such rows out without deleting them.
- Counts and lists: the inbox count is a SQL `COUNT` of pending rows; lists are capped (500 for the Producer and the owner's pending
  list, 200 newest decided for the owner).
- Late refusals that keep the proposal pending: an add whose channel is no longer connected (checked before the claim) and a
  hypothesis whose channel stopped being the active one between the check and the creation (the claim is reopened).
- Two entry points: `createAgentProposalSubmitCore` (wired into `ProducerSession.proposals` by the Producer session deps,
  `src/lib/producer-mcp-endpoint/session-deps.ts` since BL-166) and
  `createAgentProposalReviewCore` (the Web routes and the summary count). The approval inventory test pins that split.

