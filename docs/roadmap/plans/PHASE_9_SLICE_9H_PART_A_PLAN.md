# Phase 9 slice 9H, part A — Channels intelligence view (+ closing Trends' own gaps)

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§30 ("Provide practical inspection UI") and `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9H
definition ("Overview/Channels/Videos/Trends/Opportunities — a natural extension of the already-
shipped 'Research' tab. Can usefully start as soon as 9A/9B produce real structured data ...
well before 9C-9F exist."). Taken next per advisor review, after the combined `/code-review high`
fix rounds landed: 9D's `historical-intelligence.ts` and 9A's `derived-metrics.ts` have shipped
since 2026-09-26/27 with **zero real callers** (both files' own doc comments say so explicitly) —
every day this UI doesn't exist is a day the irreplaceable history 9A/9B are now collecting has no
practical inspection surface at all, exactly the gap `docs/roadmap/plans/PHASE_9_SLICE_9I_PLAN.md`
§1 named 9H as the intended closer of.

## 1. Scope boundary

**In scope for this part:**

1. One new UI-facing service action, `getChannelIntelligenceSummary`, that composes
   `getWatchlistEntryContext`'s existing raw reads with 9A's `computeSnapshotVelocity` and 9D's
   `computeAgeNormalizedViews`/`computeChannelVideoBaseline`/`assessBreakout`/`assessEmergingChannel`
   — the first real caller either module has had since they shipped.
2. Extending `MarketResearchPanel` (the existing "Channels" watchlist UI) to render that summary:
   last observed, public scale indicators, upload cadence, recent relative performance, why watched
   (owner spec §30 "Channels" — all six fields), plus drill-down into the raw snapshot series (§30's
   closing "Support drill-down into raw evidence and observation history").
3. Closing four gaps in the ALREADY-SHIPPED `MarketTrendsPanel` (9E part B) against owner spec §30's
   "Trends" field list, found by re-checking it against that list as part of this slice (advisor
   review): `firstObservedAt` is computed and stored but never rendered (only `lastObservedAt` is);
   evidence is returned oldest-first and rendered in that same order, when "latest evidence" calls
   for newest-first; evidence rows are shown as one flat list with no distinction between
   "independent channels" and "representative videos"; there is no freshness judgment at all (a raw
   date, not a fresh/not-fresh label using wording that never collides with the `"stale"` lifecycle
   status — see §6).

**Explicitly out of scope, deferred to a later 9H part (named, not silently dropped):**

- **"Overview" tab** (new discoveries/breakout videos/emerging channels/trend candidates/active
  watchlists/stale-or-failed-collection-warnings, aggregated across every watchlist entry) — needs
  this part's own per-channel summary to exist first as a building block; a natural "part B".
- **"Videos" tab** (title/channel/publication date/public views/recent velocity/relative
  performance/topic-format, spec §30) — **not merely deferred for effort reasons**: `market_video_
  snapshots` has no `title` column at all (`src/lib/db.ts`'s own table definition), so this tab
  cannot show the one field owner spec §30 lists first for it without a schema change. Found during
  this slice's own research (advisor review): `getPublicVideoSnapshots`
  (`src/lib/youtube-read-gateway/data-api.ts:345`) already requests `part: ["snippet", "statistics"]`
  and its own `PublicVideoSnapshot` return type already carries `title` — but `runCollectionIfStale`
  (`src/lib/market-intelligence/services.ts:1351`) throws it away when calling
  `insertMarketVideoSnapshot`, which has no `title` parameter to receive it. Capturing it going
  forward would cost **zero additional quota** (the API call and its response already happen).
  Left as its own scoped follow-up (a new schema version, `insertMarketVideoSnapshot`'s own
  signature, and `runCollectionIfStale`'s call site all change together) rather than folded into
  this part.
- **"Opportunities" tab** — owner spec §30 lists "niche concept" first; niche candidates are 9F's own
  entity, and 9F is explicitly "the least-ready slice" per `PHASE_9_PLAN.md` §14 ("do not start it
  before [9C-9E's] data exists"). Cannot be built before 9F exists.
- Wiring `detectDisappearedVideoIds` (9I) — its own doc comment (`data-quality.ts` line 78) warns
  against feeding it two successive raw first-page enumerations without either re-checking each id
  via a real `videos.list` call or restricting the comparison window; that's real design work
  belonging with the Videos tab (which is the natural place a "no longer public" flag would surface
  per-video), not this part.
- Any MCP/CLI/agent-contract change. `getWatchlistEntryContext` (9G-a) is left completely untouched
  — see §3 below for why, and why that's a deliberate choice, not an oversight.

## 2. Owner spec §30 "Channels" field mapping (acceptance criteria, one row per field)

| Spec field | Source | Named constant/function |
|---|---|---|
| channel | `getWatchlistEntryContext`'s own `channel` (unchanged) | — |
| last observed | latest entry of `channelSnapshots` (already returned), `.observedAt` | — |
| public scale indicators | latest `channelSnapshots` entry's `subscriberCount`/`viewCount`/`videoCount` (already returned) | — |
| upload cadence | `videoCount` field of `computeSnapshotVelocity(channelSnapshots, CHANNEL_VELOCITY_WINDOW_DAYS, now)` | `CHANNEL_VELOCITY_WINDOW_DAYS = 7` |
| recent relative performance | `assessBreakout` per video in `videoSnapshots` published within `RECENT_VIDEO_WINDOW_DAYS`, against one LEAVE-ONE-OUT `computeChannelVideoBaseline` per video at `CHANNEL_BASELINE_DAY_OFFSET` (§4), plus `assessEmergingChannel` combining the breakout count with subscriber velocity | `RECENT_VIDEO_WINDOW_DAYS = 180`, `CHANNEL_BASELINE_DAY_OFFSET = 7` |
| why watched | `channel.reason` (already returned, already rendered today) | — |
| *(closing note)* drill-down into raw evidence/observation history | see §4a — bounded, not the raw unbounded arrays | — |

`CHANNEL_VELOCITY_WINDOW_DAYS` also IS the "upload cadence" window — 9A's `computeSnapshotVelocity`
returns `subscriberCount`/`viewCount`/`videoCount` velocities from one call over one window, so
"subscriber velocity" (already spec-relevant for §12 emerging-channel detection) and "upload
cadence" are the SAME function call's two different fields, not two separate computations.

All four constants are named, exported, and rendered next to their own figure in the UI (not just
used internally) — 9D's own doc comments explicitly leave `dayOffset`/the "recent" window/the
velocity window as the CALLER's choice (owner spec §10: "the caller decides what counts as
'recent'"), and a caller-chosen methodology that isn't shown to the reader is exactly the "opaque
score" spec §11 forbids for breakout detection specifically, and §10's "do not assume one universal
baseline formula" more generally.

**Why `RECENT_VIDEO_WINDOW_DAYS = 180`, not 90, and the eligibility rule this still doesn't remove
(found necessary by advisor review — a real, non-cosmetic limitation, stated here and next to the
constant in the UI, not hidden):** a video only gets a usable day-`CHANNEL_BASELINE_DAY_OFFSET` point
at all if a collection run happened to capture a snapshot within `ageNormalizedTolerance(7)` = `max(1,
7 * 0.25)` = **1.75 days** of its own 7-day mark (`historical-intelligence.ts`'s own tolerance
function) — i.e. between day 5.25 and day 8.75 after publish. Collection has exactly one trigger in
this codebase: `POST /api/market-intelligence/collect-if-stale`, fired from `dashboard/page.tsx` on
every dashboard page load, itself gated to at most once per 24h per channel
(`MARKET_INTELLIGENCE_STALE_WINDOW_MS`). There is no background scheduler. This means: **a video's
day-7 point exists only if the operator happened to open the dashboard at least once during that
~3.5-day window after the video published** — not something either constant here can guarantee. A
channel the operator checks in on only occasionally can permanently miss a video's own day-7 point,
independent of upload cadence. `RECENT_VIDEO_WINDOW_DAYS = 180` (vs. the first draft's 90) is chosen
specifically to give a monthly-or-slower uploader more candidate videos a real chance at 4+ qualifying
points (§4's leave-one-out minimum) despite this constraint — widening this window is free of
downside: a video that never got a usable day-7 snapshot simply reports `insufficient_history` via
`computeAgeNormalizedViews` and is excluded from the baseline, never fabricated, so admitting more
candidate videos can only add real signal, never introduce a wrong one. This does not remove the
underlying dependency on how often the operator opens the app; that limitation is stated in the UI
next to `RECENT_VIDEO_WINDOW_DAYS`, not solved by it.

## 3. Why a new service action, not extending `getWatchlistEntryContext` itself

`getWatchlistEntryContext` is 9G-a's own MCP/CLI agent read surface (`AGENT_API_VERSION`-versioned,
zoned as `market_intelligence.agent_list_market_records`'s sibling read tool). Two options were
considered:

1. **Extend its own output schema** with the new derived fields, so both the agent surface and this
   UI share one function. Rejected for this part: changing a public MCP/agent output contract is one
   of `AGENTS.md` §A's own explicit triggers for the full 7-document reading pass, and would need an
   `AGENT_API_VERSION` bump (the precedent every prior field addition to this exact function has
   followed) — appropriate for a slice that has actually decided agents should receive this
   computation too, not as a side effect of building a human UI.
2. **A new, UI-only service action** (`getChannelIntelligenceSummary`) that calls
   `getWatchlistEntryContext` internally (reusing its exact reads and its exact `dataQualityFlags`
   unchanged) and layers the new derived-metric computation on top, entirely inside `services.ts`
   (`AGENTS.md` §M: composition lives in the service layer, never in a route or a component).
   **Chosen.** Keeps this part additive-only: no contract change, no version bump, no new
   `ZONED_CAPABILITIES` entry, and the full 7-document read stays optional for a change this
   narrowly scoped (`AGENTS.md` §A's own carve-out for "a small, additive slice... that extends an
   established pattern"). An agent tool exposing the same computation remains straightforward to add
   later, as its own explicitly-assigned slice, calling the exact same new service action.

Naming note: **correction (advisor review) — the original claim here ("no `db.ts` export contains
'Intelligence' or 'Summary' today") was checked and found false**: `db.ts` has both
`getOAuthUserSummary` (contains "Summary") and several `market*Intelligence*` exports (e.g.
`marketIntelligenceCollectionRuns`, `getMarketIntelligenceDailyQuotaBudgetUnits`) — neither of those
words alone is actually what matters. The two real checks are: (1) no `db.ts` export is named
EXACTLY `getChannelIntelligenceSummary` (confirmed — none of the names above match), and (2) the
name contains neither `"market"` nor `"research"` as a substring, which is `PHASE9-INV-02`'s actual
derivation rule (`deriveForbiddenDbSymbols`, case-insensitive) — `"getChannelIntelligenceSummary"`
contains neither. Re-checked directly against `db.ts` after implementation, not assumed.

## 4. `getChannelIntelligenceSummary` — shape

```ts
async getChannelIntelligenceSummary(input: unknown): Promise<{
  channel: ResearchChannel;             // getWatchlistEntryContext's own `channel`, unchanged
  evidence: ResearchEvidence[];         // getWatchlistEntryContext's own `evidence`, unchanged
  channelSnapshots: MarketChannelSnapshot[]; // getWatchlistEntryContext's own, unchanged -- channel-level, not per-video, no multiplicative growth (§4a)
  topicAssignments: MarketTopicAssignment[]; // getWatchlistEntryContext's own, unchanged
  dataQualityFlags: DataQualityFlag[];       // getWatchlistEntryContext's own, unchanged
  subscriberVelocity: FieldVelocity;    // from computeSnapshotVelocity, CHANNEL_VELOCITY_WINDOW_DAYS
  uploadCadence: FieldVelocity;         // the SAME call's videoCount field -- see §2
  recentBreakoutVideos: BreakoutAssessment[]; // one per recent video with a snapshot, per-video LEAVE-ONE-OUT baseline -- see below
  emergingChannel: EmergingChannelAssessment; // recentBreakoutVideoCount computed from recentBreakoutVideos above
  latestSnapshotPerVideo: { videoId: string; observedAt: string; viewCount: number | null; likeCount: number | null; commentCount: number | null; publishedAt: string | null }[]; // §4a, bounded
}>
```

**This deliberately does NOT include `getWatchlistEntryContext`'s own `videoSnapshots` array** (found
necessary by advisor review, correcting this plan's own first draft): returning `context` whole would
still ship the full, unbounded append-only video-snapshot series over the network on every call, even
though §4a bounds what the DOM renders from it -- the growth simply moves from the page to the
response payload, which is not actually a fix. Every other `getWatchlistEntryContext` field above is
returned unchanged; only `videoSnapshots` is replaced by the two bounded views below.

`getWatchlistEntryContext` returns every timestamp as an ISO string (its own output schema's
contract), while `computeSnapshotVelocity`/`computeAgeNormalizedViews` take `Date`. This conversion
happens exactly ONCE, immediately after calling `getWatchlistEntryContext`, inside this new action —
never repeated ad hoc at each call site below.

**`recentBreakoutVideos` construction, and the baseline choice (found necessary by advisor review):**
group `context.videoSnapshots` by `videoId`; keep only videos with a non-null `publishedAt` inside
`RECENT_VIDEO_WINDOW_DAYS` of `now`; for each such video, call `computeAgeNormalizedViews` over that
video's own snapshot series at `[CHANNEL_BASELINE_DAY_OFFSET]` to get its own day-`CHANNEL_BASELINE_
DAY_OFFSET` point.

The baseline every video is compared against is **leave-one-out**, not "the median of all recent
videos including the one being assessed" — computed separately per video, from every OTHER recent
video's own point via `computeChannelVideoBaseline`. Chosen because including a video in its own
baseline biases the comparison exactly when it matters most: with a small recent-video sample, a
single real breakout can pull the baseline itself upward, partially masking the very signal being
measured (owner spec §10's "do not assume one universal baseline formula" extends to not silently
picking the one formula that under-counts real breakouts). The concrete, hand-computed disagreement
this pins (also the test fixture, §7): four recent videos with day-7 age-normalized views
`[10, 20, 30, 65]`, assessing the video at `65`:
- **Leave-one-out** (the chosen method): baseline = median of the other three = `median([10,20,30])
  = 20`; ratio = `65/20 = 3.25` → **is** a breakout (`>= BREAKOUT_RATIO_THRESHOLD`, 3).
- **Include-self** (rejected): baseline = median of all four = `median([10,20,30,65]) = 25`; ratio =
  `65/25 = 2.6` → **not** a breakout.

Consequence, stated plainly (and shown in the UI next to the constant, per §2's own transparency
requirement): leave-one-out needs `BREAKOUT_MIN_BASELINE_SAMPLE_SIZE` (3) OTHER recent videos to
produce any verdict at all for a given video, i.e. **4 recent videos minimum before any breakout can
be assessed**, one more than "include-self" would have required. This is treated as an honest cost
of the more defensible method, not a shortcoming to hide.

`emergingChannel` reuses the same `recentBreakoutVideos` result: `recentBreakoutVideoCount` is the
count of `isBreakout: true` entries, fed into `assessEmergingChannel` alongside `subscriberVelocity`.

A video with no `publishedAt` is excluded from `recentBreakoutVideos` entirely (never guessed).
**Correction (advisor review, post-implementation):** this section originally said such a video
"surfaces via the already-existing `dataQualityFlags` mechanism instead" -- `dataQualityFlags` is a
CHANNEL-level array with no per-video member of its 7-value vocabulary for this fact, and the
implementation never adds anything there for it. The video remains visible instead through
`latestSnapshotPerVideo` itself, whose own `publishedAt: string | null` field is `null` for exactly
this case -- an already-per-video, already-honest signal, not a new flag (still true to this
section's own "a new flag is NOT invented here").

## 4a. Bounding the drill-down (found necessary by advisor review)

`context.videoSnapshots` is an APPEND-ONLY series (every past collection run's snapshot for every
video the channel has ever had, per 9B's own design) — rendering it verbatim, as an earlier draft of
this plan proposed, makes an already-known-unbounded read (recorded now as `docs/TECHNICAL_DEBT.md`
RISK-78, since this is the first time anything renders it to a human rather than an agent making one
bounded MCP call) grow directly with page weight every time 9B collects again. This part bounds what
it actually renders instead of fixing the underlying query's own pagination (out of scope here, see
RISK-78):

- The main "Channels" drill-down shows **one row per distinct `videoId`** (`latestSnapshotPerVideo`,
  §4) — the single most recent snapshot for each video the channel has, not its full history.
  Naturally capped by how many distinct videos a channel's uploads-playlist enumeration has ever
  surfaced across every 9B run (bounded in practice, but not by a hard limit this action itself
  enforces — RISK-78 tracks the real fix).
- A further per-video expand (click a row) calls a SEPARATE new action/route,
  `getChannelVideoSnapshotHistory(researchChannelId, videoId)` (§4b) — not client-side filtering of an
  already-fetched full array (which would have required shipping that full array in the first place,
  exactly what §4 just removed). The response is bounded to one video's own snapshot count by
  filtering server-side before returning, even though the underlying `db.ts` read it filters from is
  still the same unbounded-at-the-query-level `listMarketVideoSnapshotsByChannel` RISK-78 tracks —
  this bounds what actually reaches the network, not the database read itself.
- `channelSnapshots` (channel-level, one row per collection run for the WHOLE channel, not per-video)
  is still returned in full as part of `getChannelIntelligenceSummary`'s own output (§4) — this series
  is not per-video and does not have the same multiplicative growth risk.

## 4b. New API routes

Both new actions get their own routes, in the injectable-handler factory shape
(`src/app/api/youtube/create-playlist/route.ts`'s pattern, already applied once this session to
`.../trend-candidates/[id]/evidence/route.ts` after that route's own missing-test gap caused a real
regression to ship undetected) — not the bare module-scope-`const core` shape most existing
market-intelligence routes still use:

- `GET /api/market-intelligence/channels/[channelId]/intelligence-summary` →
  `getChannelIntelligenceSummary`. Output validated with a new
  `getChannelIntelligenceSummaryOutputSchema` via `parseWithSchema`, matching every other action in
  this module.
- `GET /api/market-intelligence/channels/[channelId]/videos/[videoId]/snapshot-history` →
  `getChannelVideoSnapshotHistory`. Output validated with a new
  `getChannelVideoSnapshotHistoryOutputSchema`.

Both ship with their own `route.test.ts` from the start (injectable `core`, real
session/DomainError-mapping tests, mirroring the evidence route's own test file) — this module has
already shipped one real regression from a route with no test of its own this session; a new route
does not repeat that gap.
**Reminder for whoever runs these tests:** `node --test` on an explicit bracketed path
(`[channelId]`) reported 0 tests during this same session even though the file was real and correct
— always verify via the full `npm test` glob, never a direct bracketed path.

## 5. Data quality / "insufficient history" is the expected, honest first render

The real local database's Phase 9 tables are confirmed empty (`docs/TECHNICAL_DEBT.md` RISK-63's own
verification) and `marketIntelligenceDailyQuotaBudgetUnits` defaults to `null` (operator-set only,
no hardcoded default) — so the realistic FIRST render of this UI, on this machine, before the owner
sets a budget and 9B has run for real days, is "insufficient history" for velocity/breakout/emerging
everywhere. This is not a bug to hide: every 9A/9D function this slice calls already reports an
explicit `basis`/`reason` string for exactly this case (`AGENTS.md` §L: negative/boundary cases are
first-class, not an afterthought) — the UI renders that `basis`/`reason` text directly next to each
figure (e.g. "insufficient_history" for velocity, an `assessBreakout` result's own `reason` string)
rather than hiding the section or showing a bare `null`. `docs/roadmap/plans/PHASE_9_PLAN.md` §15's
own acceptance-criteria split applies here unchanged: code-complete against hand-derived fixtures is
this part's own deliverable; the live-data track (a real UI screenshot showing a genuine breakout
once real history exists) is **not** achievable yet and is not claimed as done.

## 6. Trends panel gap-closing (owner spec §30 "Trends")

Re-checked `MarketTrendsPanel` (9E part B) against the full field list, per advisor review:

| Spec field | Current state | Fix |
|---|---|---|
| trend | rendered (`title`) | — |
| lifecycle | rendered (`status`) | — |
| first seen | **stored (`firstObservedAt`) but never rendered** | render alongside the existing `lastObservedAt` line |
| latest evidence | **correction (advisor review): checked directly, not assumed — `db.ts`'s `listTrendEvidence` orders `asc(recordedAt)` (oldest first), and the component renders that order verbatim with no client-side reverse; an earlier draft of this plan wrongly claimed "most recent first"** | a new `getTrendEvidenceSummary` wrapper (below) returns evidence newest-first |
| independent channels | **not computed** — evidence rows are one flat list | `getTrendEvidenceSummary`'s own `independentChannelCount`: DISTINCT `referenceId` values among `evidenceType: "supporting_channel"` rows |
| representative videos | **not distinguished from other evidence** | evidence rows already carry `evidenceType`; the component groups/labels `supporting_video` rows under their own heading (a plain client-side `.filter()` on an already-typed, schema-guaranteed field -- no server logic needed, unlike the count above) |
| freshness | **not computed** — only a raw date | see below — a NEW, trend-specific freshness check, not 9I's collection-staleness one |

**`getTrendEvidenceSummary(trendCandidateId)` — a new, UI-only wrapper around `listTrendEvidence`**
(confirmed by grep to have zero MCP/CLI callers today, unlike `listTrendCandidates` above — safe to
change what its own caller receives without any contract concern): returns
`{ evidence: MarketTrendEvidence[] /* newest-first */, independentChannelCount: number }`. Reuses the
EXISTING `.../trend-candidates/[trendCandidateId]/evidence` GET route (already in factory shape from
this session's own earlier fix) — its handler now calls `getTrendEvidenceSummary` instead of
`listTrendEvidence` directly; `listTrendEvidence` itself, and its own ascending order, are otherwise
unchanged (still callable directly if a future agent surface ever needs it). Chosen over doing this
grouping/counting in the React component specifically because this repository has no component-level
tests (`docs/TECHNICAL_DEBT.md` RISK-05) — the deduplication logic in "independent channels" is real
enough to need a test that can actually run, which means it must live in `services.ts`, not the
component (`AGENTS.md` §M).

**Correction (advisor review): this plan's first draft was wrong on two points here, both blocking.**

1. It claimed `listTrendCandidates`/`getTrendCandidate` "have no MCP/CLI surface at all today,
   confirmed by grep" — **false, no grep was actually run.** `agent_list_market_records` (MCP,
   `src/mcp/server.ts:1539`) and its CLI counterpart (`src/cli/video-metadata.ts:912`) both call
   `marketIntelligenceCore.listTrendCandidates()` directly and return its result as-is (proven by
   this session's own `AC-9G-06b` test). So `MarketTrendCandidate`'s shared type/output schema is
   already an agent-facing contract — adding `freshness` directly to it is exactly the kind of
   contract change §3 already says this part must not make, for the identical reason §3 gives.
   **Fix:** freshness is computed by a NEW, UI-only wrapper, `listTrendCandidatesWithFreshness`,
   mirroring `getChannelIntelligenceSummary`'s own "compose, don't extend" shape from §3 — it calls
   the existing `listTrendCandidates()` internally and returns each candidate paired with its own
   computed freshness in a separate return shape (`listTrendCandidatesWithFreshnessOutputSchema`,
   validated via `parseWithSchema`), never touching `MarketTrendCandidate` or
   `listTrendCandidatesOutputSchema`. (Naming check: does not collide with db.ts's own
   `listMarketTrendCandidates`.) The existing `GET /api/market-intelligence/trend-candidates` route
   (currently bare module-scope-`const core`, per §4b's factory-shape precedent) is converted to the
   injectable factory shape and its GET handler switched to call this wrapper instead of
   `listTrendCandidates` directly, with its own `route.test.ts` added (its `POST` handler, and the
   route's own existing behavior otherwise, are unchanged).
2. It reused 9I's `assessObservationFreshness`/`MARKET_INTELLIGENCE_STALE_WINDOW_MS` (24 hours) —
   **wrong threshold and wrong word for this context.** That constant means "a channel collection run
   hasn't happened in a day," a daily-cadence concept; a trend's `lastObservedAt` only moves when
   evidence is added (manually, or by a future structural detector), which happens on a much longer,
   human timescale — almost every trend would read "stale" after one day, which is meaningless here.
   Worse, `"stale"` is also one of `TrendCandidateStatus`'s own five lifecycle values — a `"growing"`
   trend showing a `"stale"` freshness badge would visibly contradict itself in the same UI.
   **Fix:** a new, trend-specific named constant, `TREND_EVIDENCE_FRESH_WINDOW_DAYS = 30` (a named,
   adjustable starting point, exactly like `BREAKOUT_RATIO_THRESHOLD`'s own precedent — not claimed
   as a universally correct number), and wording that never says "stale": e.g. "Evidence added within
   30 days" vs. "No new evidence in 30+ days".

## 7. Test plan (`AGENTS.md` §L)

- Hand-computed fixtures for `getChannelIntelligenceSummary`: a channel with 2 channel-snapshots 8
  days apart (exercises `full_window` velocity), a channel with only 1 snapshot (`insufficient_
  history`), and the exact leave-one-out-vs-include-self disagreement fixture from §4
  (`[10, 20, 30, 65]`, day-7 age-normalized views) pinning the leave-one-out verdict (`isBreakout:
  true`, ratio `3.25`) — expected ratios/booleans computed by hand, never copied from a first run's
  output.
  Negative/boundary cases: zero videos with a `publishedAt` (empty `recentBreakoutVideos`, no
  crash); exactly 3 recent videos (every leave-one-out baseline sample size is 2, below
  `BREAKOUT_MIN_BASELINE_SAMPLE_SIZE`, so no video gets a breakout verdict — pins the "4 minimum"
  consequence from §4); a video whose only snapshot lands at day 30 (well outside
  `ageNormalizedTolerance(7)`'s ±1.75-day window) — its own point must be `insufficient_history` and
  it must NOT be counted toward any other video's leave-one-out baseline sample size (pins §2's
  eligibility-rule finding); a channel not on the watchlist (propagates
  `RESEARCH_CHANNEL_NOT_AVAILABLE`, matching `getWatchlistEntryContext`'s own existing behavior, not
  a new error shape).
- `latestSnapshotPerVideo` (§4): a fixture with 2 snapshots for the same `videoId` at different
  times asserts exactly one row for that video, holding the LATER snapshot's own values, and that
  `getChannelIntelligenceSummary`'s own output contains no `videoSnapshots` key at all.
- `getChannelVideoSnapshotHistory` (§4a/§4b): a fixture with snapshots for 2 different `videoId`s
  asserts the response contains only the requested video's own rows.
- Both new API routes (§4b): `route.test.ts` per route, in the same shape as the evidence route's own
  (injectable `core`, session/DomainError-mapping tests) — run and verified through the full
  `npm test` glob, not a direct bracketed-path `node --test` invocation.
- `listTrendCandidatesWithFreshness`: a service-level test with a hand-picked `now` proving the
  `TREND_EVIDENCE_FRESH_WINDOW_DAYS` boundary (just inside vs. just outside 30 days), and that its
  return shape is separate from — never merged into — `MarketTrendCandidate` itself. A second test
  asserts `listTrendCandidates`'s own existing MCP/CLI-facing output is byte-for-byte unchanged by
  this addition (guards the exact mistake this plan's own first draft almost made). Its own
  `route.test.ts` covers the converted `GET /api/market-intelligence/trend-candidates` handler.
- `getTrendEvidenceSummary`: a hand-constructed evidence array with duplicate `referenceId`s among
  `supporting_channel` rows proves `independentChannelCount` deduplicates (the actual point of the
  test, not just "the count is some number"), and that its `evidence` array is newest-first while
  `listTrendEvidence`'s own direct return stays ascending, unchanged, in the same test file.
- No MCP/CLI test changes for any new wrapper — this part adds no agent-facing surface (§3, and §6's
  correction).

## 8. Documentation

- `docs/TECHNICAL_DEBT.md`: add RISK-78 — `getWatchlistEntryContext`'s `videoSnapshots`/
  `channelSnapshots` reads (`listMarketVideoSnapshotsByChannel`/`listMarketChannelSnapshotsByChannel`
  in `db.ts`) have no pagination/limit at the query level; harmless while the only caller was a
  single bounded MCP/CLI call, but this part makes the same unbounded read load-bearing for a human
  clicking around a UI for the first time. This part's own §4a bounds what it RENDERS
  (latest-snapshot-per-video, one video's series at a time) without fixing the underlying query --
  tracked as its own follow-up, not silently accepted.
- `docs/SYSTEM_MAP.md` §2.9v: add this part's own bullet (the two new UI-facing wrappers, their
  read-only composition over 9A/9D/9I, no contract change to either wrapped action).
- `docs/ARCHITECTURE.md` §18: note `historical-intelligence.ts`/`derived-metrics.ts` now have a real
  caller, closing the "ships with zero callers" state both files' own doc comments described.
  `interfaces.md` gains the new `GET .../intelligence-summary` and `GET .../snapshot-history` API
  routes and records that `GET /api/market-intelligence/trend-candidates` now returns freshness
  alongside each candidate (Web UI only, no MCP/CLI contract change for any of the three wrappers).
- `docs/roadmap/plans/PHASE_9_PLAN.md` §14 is unaffected (still accurately describes 9H's overall
  scope; this document only records this part's own slice of it, per this project's own
  `docs/roadmap/plans/` convention of one file per part).
