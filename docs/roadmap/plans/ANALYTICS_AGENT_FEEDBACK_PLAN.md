# Analytics: agent feedback of 2026-10-03 — analysis and correction plan (BL-118)

Source: first MCP test by a project agent (Rural Japan Music, product 0.1.1, schema 41, READ+DRAFT), report
`2026-10-03-analytics-coverage-and-missing-metrics`, forwarded by the owner (Telegram, 2026-10-03: "Проанализируй его и предложи план
корректировок"). **This is an analysis and a plan, not an implementation** (`AGENTS.md` §C).

## 1. Verdict per finding (checked against the code)

| # | Agent's finding | Verdict | Root cause in the code |
|---|---|---|---|
| 1 | Per-video data starts 2026-09-14; the first 32 days have none | **Real, partly by design** | Auto-collection only ever fetches the last 7 days (`AUTO_COLLECTION_RANGE_DAYS`); nothing backfills older history. Manual "Collect now" (Analytics → raw data) already accepts any date range, **but** `collectMetrics` refuses every manual call (`analytics_data_current`) once today's collection has run, whatever range is asked — so a backfill is blocked on any day the auto-run already happened. The agent has no collect capability (READ+DRAFT; collection is an operator action). Collection asks each video for the whole range, not from its own publish date. |
| 2a | Impressions / CTR not collected, no capability exposes them | **Built, but invisible to the agent** | BL-114 collects them (Reporting API Reach report; first real files expected ~2026-10-03 21:06 UTC) and the MCP tool `agent_query_channel_reach` exists. `agent_get_capabilities` is a literal, human-maintained inventory (`agent-operations/services.ts`) and has **no entry** for it — a real documentation drift. |
| 2b | Average view duration / percentage viewed, traffic source | **Partly there** | `averageViewDuration` and `averageViewPercentage` are in `ANALYTICS_METRIC_NAMES` (per-video collection). Traffic-source breakdown exists in the Content tab (BL-093) but **no MCP tool exposes it**. |
| 3 | No channel creation date; `analytics_data_quality` lists 256 dates incl. pre-channel | **Real** | The `channels` table has no creation date (`snippet.publishedAt` from `channels.list` is not stored); data quality has no notion of "before the channel existed". |
| 4 | "Covered" semantics (2026-10-01 covered but absent live) | **Real ambiguity** | By design "covered" = a successful collection run's requested window contained the date, not "rows exist" (YouTube omits zero-activity days). So a date inside YouTube's reporting lag (~2-3 days) can be "covered" with no rows; the next rolling 7-day auto-run fills it. The tool does not say so. |
| 5 | `previousTotals` is 0 for a period before the channel existed | **Real** | Computed by summing rows; an empty previous period reads as zero. |
| 6 | Weekly/aggregated granularity | **Reasonable, small** | Channel analytics returns daily rows only. |

## 2. Plan (slices, one branch per `AGENTS.md` §K.1)

**Slice A — make what exists visible (no schema change).**
- Add the missing capability entries (`analytics.query_channel_reach`, and the breakdown tool of slice D) and a **test that fails when a
  registered agent MCP tool has no capability entry**, so the inventory cannot drift again.
- `analytics_data_quality`: document "covered" in the tool description and result (`coveredMeans: "a collection run completed for the
  date; a day can be covered with no rows"`), and add `coveredWithoutData` (covered dates with no stored row) and `provisionalDates`
  (dates within the reporting lag, still expected to change).

**Slice B — channel start date (schema).**
- Store `channels.published_at` (YouTube `snippet.publishedAt`) at channel sync (existing rows fill on their next sync).
- Expose `channelStartDate` in `agent_get_channel_context` and `analytics_data_quality`; dates before it are reported as
  `notApplicableDates` / compact ranges (`uncoveredRanges`, not 256 single dates) instead of `uncovered`.
- `previousTotals`: `null` plus `previousPeriodPredatesChannel` (or `previousPeriodPartial` when the channel started inside it).

**Slice C — backfill (the owner decision below).**
- `collectMetrics`: a manual call is refused only when **every date it asks for is already covered**; a range that contains uncovered
  dates is allowed even after today's auto-run (new data costs no more than the same queries).
- Per-video start = max(range start, the video's own publish date).
- Operator: a "Backfill history" action in Analytics (range = channel start → yesterday, in chunks, with the shared progress overlay),
  and an automatic one-time backfill the first time a channel has videos but no coverage before its earliest video's publish date.
  Cost estimate: one Analytics-API unit per video per chunk (about 80 units for 80 videos), logged in the quota history (BL-117).
- Retest from the report: `analytics_data_quality` from the channel start shows no uncovered dates; a video published before
  2026-09-14 returns day-0 data.

**Slice D — more reads for the agent.**
- MCP tool for the traffic-source (and device) breakdown the Content tab already computes (read-only, local/live per the existing function).
- `granularity: day | week | month` for `agent_query_channel_analytics` (server-side aggregation: additive metrics are summed; ratio
  metrics are recomputed from their parts or omitted, never averaged blindly; weeks start Monday).

**Slice E — channel-level analytics from the local database (owner's observation, Telegram 2026-10-03).** Per-video daily metrics are
stored (`video_metrics_daily`) and the agent's per-video and data-quality tools read them locally. **Channel-level** totals are not
stored: `agent_query_channel_analytics` (`analytics_overview`) is a LIVE Analytics API read on every call (quota, 1-2 day lag). Add a
local table of channel-level daily rows (filled by the same collection and backfill), make the agent tool read the local rows, and call
the API only for dates not stored yet or on an explicit refresh. This also makes `previousTotals`, weekly granularity and the
reporting-lag handling work offline and removes the agent's quota use for repeat questions.

## 3. Owner decisions

1. **Slice C gate relaxation** (recommended yes): allow a manual collection whose range contains uncovered dates even after today's
   auto-collection. It changes a deliberate invariant ("a manual call is refused once today's real collection happened").
2. **Automatic first-time backfill** (recommended yes) versus operator-triggered only.
3. Slice E (local channel-level rows) after C, or together with C (recommended: together, since both change what collection stores).
4. Order: A and B first (cheap, remove the confusion), then C, then D — or C first because it unblocks the agent's per-video work.

## 4. Not changed / open

- Impressions/CTR themselves depend on Google's first Reach files (RISK-95), expected ~2026-10-03 21:06 UTC.
- The agent keeps READ+DRAFT only; collection and backfill stay operator actions.
