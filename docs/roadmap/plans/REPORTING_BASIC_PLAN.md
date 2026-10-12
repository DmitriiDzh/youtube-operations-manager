# Fresher daily analytics: Reporting basic reports + an evening re-collect (FO-REQ-0020, BL-181)

- **Status:** DRAFT 2026-10-13. Waiting for the owner's answers (§5, Telegram msg 2682).
  - Stage 1 item 5 (newest date returned) is BUILT on `feature/bl-181-reporting-freshness`. It needs no owner decision.
  - The rest waits for the owner.
- **Request:** FO-REQ-0020, from the Operator, 2026-10-12. The owner's "ok" is Telegram 1036; the queue was set in msgs 2660 and 2677.
- **Sources:**
  - the `dev` code (f785700, schema v86);
  - Google's Reporting docs (channel reports, dimensions, "Data and reports"), read 2026-10-13;
  - `docs/decisions/0014-*` and ARCHITECTURE §14.6, §14.8, §14.9, §14.13.

## 1. Findings that shape the design

- **Hard-coded to one report type.**
  - Reporting sync handles exactly `channel_reach_basic_a1`: it is hard-coded about 15 times in `reach-reports/services.ts`.
  - `importReachReport` writes only `channel_reach_daily`.
  - `getChannelReachCoverage` counts files of any type. A new type would therefore show reach as "ready".
- **The cross-computer exchange would drop the new types silently.**
  - `analytics-data-sync` ships every `reporting_report_files` row.
  - A peer imports each file through `importReachReport` with the reach rows only.
  - As a result, a `channel_basic_a3` file is recorded as imported with 0 rows, and the peer never downloads it itself.
  - The share file is `.strict()` with `formatVersion: 1`. A new key makes the whole file invalid for a peer that is not updated yet.
- **`analytics` and `reach-reports` may not import each other** (`module-independence.test.ts`). Merging the two sources needs a third layer, as `experiment-results` and the Producer session already do.
- **An evening run is refused today.**
  - `collectMetrics` throws `analytics_data_current` once the morning run covers its range. Dates in the lag window count as covered.
  - The single `analytics_sync_local_time` also drives `computeNextRefreshAt`, the weekly report and the catch-up plan.
- **Nothing records the newest date the Analytics API returned.**
  - `analytics_collection_runs` keeps only the requested range.
  - "Too recent" is computed from the clock (now − 2 days).
- **What Google documents for Reporting:**
  - **Columns (`channel_basic_a3`).** `date, channel_id, video_id, live_or_on_demand, subscribed_status, country_code` plus 28 metrics, including `views`, `engaged_views`, `red_views`, `watch_time_minutes`, `red_watch_time_minutes`, `average_view_duration_seconds/percentage`, `likes`, `dislikes`, `comments`, `shares`, `subscribers_gained/lost` and `videos_added/removed_to_playlists`.
  - **Columns (`channel_traffic_source_a3`).** The same dimensions plus `traffic_source_type` (an integer code) and `traffic_source_detail`, with 7 metrics.
  - **Anonymised rows.** These are rows with `country_code = ZZ`, a `NULL` detail, or an empty `video_id`/`channel_id` (deleted videos, or channel-level metrics). They must be summed into the totals.
  - **Historical data.** A new job gets the 30 days before its creation. The first daily report arrives within 48 h.
  - **Backfills.** A backfill has the same start/end and a newer `createTime`.
  - **Freshness.** Google does not document how fresh Reporting is compared with the Analytics API. This is the request's premise, and it must be measured.

## 2. Proposal: two stages

### Stage 1: collect and measure

1. **Report types as a table.**
   - A small registry (type id, job name, required columns, mapper, row table) replaces the hard-coded reach type.
   - Reach's behaviour is unchanged. Its coverage and state count reach files only.
2. **Two new jobs per connected channel**: `channel_basic_a3` and `channel_traffic_source_a3`.
   - They use the existing `ensureReportingJob` (one `jobs.list`) and the same scope, so no new consent is needed.
   - They need the owner's OK, as BL-114 did (§5, question 1).
3. **Storage, aggregated on import.** Countries are not needed (FO-REQ-0020 §3).
   - `channel_basic_daily (channel_id, date, video_id)` holds the summed counts. `video_id ""` is the channel-level and deleted-video remainder, so channel totals include it.
   - Average view duration is derived as watch time × 60 / views, never averaged per row.
   - `channel_traffic_source_daily (channel_id, date, video_id, traffic_source_type)` holds views and watch time.
   - Supersession works as for reach: the newest `createTime` for the same start/end wins, and the older rows are replaced in one batch.
   - Schema v87.
4. **Exchange between computers.**
   - The new types are left out of the shared file. Each computer downloads its own, as the BL-168 breakdowns already do.
   - Reach keeps its exchange.
   - No share-format change, so an old peer is not affected.
5. **Newest date returned.**
   - `analytics_collection_runs` gains `newest_video_date` and `newest_channel_date`, computed from the rows `collectMetrics` received.
   - It is device-local: not added to the shared runs, which are strict-format.
6. **Lag in the status read.**
   - For each Reporting type: the last file's `createTime` minus the end of its Pacific day.
   - For the Analytics API: the first time each date was returned. This becomes visible once item 5 is in.
7. **Evening re-collect.**
   - A second daily boundary (setting, default `22:05` local, can be turned off).
   - The open dashboard checks it every 5 minutes, not only on mount, so an open page catches it. No server timer is added.
   - The freshness gate lets a run through when the newest returned date is older than yesterday.
   - This adds about one Analytics query per video per channel each evening.

**Answers to the Operator's questions after stage 1:**
- Q2: Reporting does not show in the quota ledger, only in Cloud Monitoring.
- Q3: one week of lag numbers.
- Q1: a comparison of settled days, reach-style.

### Stage 2: provisional values, only if stage 1 shows a real gain

- A composition layer reads both modules. For a date the Analytics API has not returned but a basic file covers, it shows the Reporting values marked "provisional (Reporting, createTime)". This applies to the overview, the per-video daily tables, `agent_query_*` and the Producer reads.
- The Analytics API replaces them once it returns the date. This is our proposal for Q1, to be checked against the comparison.
- `getDataQualityReport`: such a date is "provisional", not "too recent".
- Agent and Producer API versions are bumped, additively.
- If the measured gain is small, stage 2 is dropped. This follows the request's own criterion 5.

## 3. Not in this plan

- Country breakdowns from Reporting.
- `channel_reach_combined_a1`.
- Replacing any Analytics API feature.

## 4. Acceptance (stage 1)

- Both channels have active basic and traffic-source jobs, 30 days imported, and reissues handled.
- Reach reads are unchanged: the same numbers, and the state counts only reach files.
- A peer on the old build is unaffected, and the new types never appear in the shared file.
- Every collection run records the newest dates returned.
- The status read shows the lag per type.
- With the dashboard open, a 22:05 boundary triggers one re-collect. It is not repeated before the next boundary.

## 5. Questions for the owner

1. May the app create the two new Reporting jobs per channel? This is read-only data with the same scope, a precedent from BL-114.
2. The two stages: measure for a week first, then decide on the provisional values. Agreed?
3. The evening re-collect: is a default of 22:05 local right? Is it enough that it runs while the dashboard is open, checked every 5 minutes, with no server timer?
