> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 36. Video milestones: day-7 and day-28 retention and totals (BL-166, FO-REQ-0015 items 1 and 8)

Plan: `docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md` (AC-VM-01..08). Schema v75; v76 removes collected rows without a curve (see below).

- **Windows.** `milestoneWindow(publishedAt, M)` = the Pacific publish date .. +M-1 (inclusive); `isMilestoneDue` once today (Pacific) is at
  least `MILESTONE_LAG_DAYS` (reporting lag + 1 = 3) after the window end.
- **Collection** (`createVideoMilestoneServices.collectDueMilestones`, analytics core). `planDueMilestones` takes never-attempted milestones by
  window end, then retries whose `next_attempt_at` has passed, at most 25 per channel per run. Only videos with a final publish date
  (`hasFinalPublishDate`: public, not an upcoming premiere or stream) are planned -- while a video is private or scheduled, YouTube gives its
  owner the upload time as `publishedAt`. A stored row whose window differs from the one computed now counts as never attempted, and its
  attempts start again at 1 (both writes count attempts per window). Planning reads only key, window, status and retry time
  (`listVideoMilestoneStates`). Each costs two `queryChannelBreakdownReport`
  calls (gateway, `dimensions` optional): `elapsedVideoTimeRatio` with `audienceWatchRatio` and `relativeRetentionPerformance` (checked live 2026-10-10: adding `startedWatching`,
  `stoppedWatching`, `totalSegmentImpressions` makes YouTube answer with no rows, so the first build stored empty curves; v76 deletes those
  rows so they are collected again), and the four totals with no dimension, both
  `video==<id>` over the window. Only an error about the query counts an attempt (HTTP 400, 404, or a 403 whose reason is not about
  permissions, the project or the rate; `recordVideoMilestoneFailure`: retry after 24 h, `failed` at 3). Reads off, quota, sign-in, channel
  access, 401 and those system 403s stop the run with nothing recorded. No HTTP answer at all, 429 and 5xx stop it too, but
  `deferVideoMilestone` first puts that milestone back by 24 h without an attempt, so one video that keeps getting a 5xx cannot hold the
  channel's queue (it is then retried once a day, never marked `failed`). The core wraps it in the analytics
  quota context and `gateMilestoneCollection` (`isBackgroundReadAllowed("analytics")`). `/api/analytics/auto-collect-all` runs it after the daily rows for each channel whose collection
  did not fail, each in its own try/catch.
- **Storage.** `video_milestones` (primary key `video_id, milestone_days`): status, attempts, last error, next attempt, collected time, the
  four totals and `retention_json` (as returned, `[]` when none). Classified `authorized`; device-local (not in the snapshot, not synced).
- **Reads.** `listVideoMilestones` (channel scope, joins each row with the video's stored `durationSeconds`, drops rows whose video the
  channel does not have or whose window the video no longer has) backs `agent_get_video_milestones`. `producer_upload_milestones` is built by `createUploadMilestonesServices`
  (`src/lib/portfolio-overview/upload-milestones.ts`): published uploads by UTC date in the range, windows and the publish rule from the
  analytics helpers (passed in, so the module does not import analytics), stored totals of those videos (`listVideoMilestoneTotals`, only
  rows of the current window), and `getVideoWindowsReach` (`reach-reports`: one `listDaily` over the span of all
  windows, per-window `daysWithData`, summed impressions, `weightedCtr`), read in each channel's agent scope. A Reach figure is null unless
  Reach is `ready` and the window has a stored day; a failed Reach read gives `reachError` (its error code).

## 37. Stored traffic sources and devices per day (BL-168, FO-REQ-0015 item 2)

Plan: `docs/roadmap/plans/VIDEO_BREAKDOWNS_PLAN.md` (AC-VB-01..17). Schema v77.

- **Subjects and ranges** (`src/lib/analytics/breakdowns.ts`). The channel (state subject `channel`) and each video with a final publish
  date (`hasFinalPublishDate`, shared with the milestones). A video's range is its window, `videoBreakdownWindow` = the Pacific publish date
  .. +89; the channel's range starts 89 days before the latest day of its first collection and has no end. The latest day is yesterday
  (Pacific); a range ends at the earlier of it and the window end.
- **Planning** (`planDueBreakdowns`, pure). A subject without a usable state (none, or one for another range start: the publish date moved)
  is read in full (`fresh`). Otherwise it is due while the range end is later than `collected_through`, reading from 6 days before the
  first new day (`collected_through` − 5: revisions, also of the provisional days before a gap); a video whose window has ended gets one
  final pass (window end − 6 .. window end) once today is window end + 7 and its last collection was before that, and is never planned
  again. `failed` subjects are skipped, `retry` ones wait for `next_attempt_at`. At most `MAX_BREAKDOWN_SUBJECTS_PER_RUN` (100): the
  channel first, then due videos by `collected_at` ascending (never collected first; newest publish date, then id, among equals), so a
  video left out by the cap heads the next run's queue (review of BL-168: a newest-first order with a cap of 50 starved the oldest videos
  of the window every day). The batch is cut by that order alone; inside it, subjects in `retry` (the channel included) run last: a
  deferred subject ends its run, so heading it, it would stop every run before the others were read (second review), while ordering all
  retries after all other due subjects before the cut would shut them out whenever more are due than the cap (third review).
- **Collection** (`collectDueBreakdowns`). Two `queryChannelBreakdownReport` calls per subject (`day,insightTrafficSourceType` and
  `day,deviceType`, `views` + `estimatedMinutesWatched`, `video==<id>` for a video), saved only when both answered.
  `saveCollectedAnalyticsBreakdown` deletes the subject's rows in from..to (all of them when `fresh`), inserts the answer (only days inside
  the range, one row per day and value) and marks the state collected (`collected_through`, `collected_on` = today Pacific, attempts 0), in
  one `database.batch`. Failures: `failureKind` (`query-failure.ts`, moved unchanged from `milestones.ts`): `stop` rethrows with nothing
  written; `defer` (`deferAnalyticsBreakdown`) puts the subject back by 24 h keeping its attempts and stored range, then rethrows; `attempt`
  (`recordAnalyticsBreakdownFailure`) counts consecutive failures, `failed` at 3 for a video; the channel is passed an unreachable maximum, so
  it is retried a day later forever. A state for another range start is reset by both. The core
  wraps it in the analytics quota context and `gateBreakdownCollection` (`isBackgroundReadAllowed("analytics")`); `/api/analytics/
  auto-collect-all` runs it after every channel's milestones, each channel in its own try/catch.
- **Storage.** `video_breakdown_daily` (key `video_id, breakdown, day, value`; `channel_id`, `views`, `estimated_minutes_watched`; index on
  `channel_id, video_id`), `channel_breakdown_daily` (key `channel_id, breakdown, day, value`), `analytics_breakdown_state` (key
  `channel_id, subject`). Classified `authorized`; device-local. Not in the `analytics-data` exchange: its file schema is strict at format
  version 1, so a new table would make a not-yet-updated peer reject every file.
- **Reads.** `listStoredBreakdowns` (channel scope) backs `agent_get_stored_breakdowns`: the channel (no `videoIds`) or the requested
  videos the channel has with a final publish date; rows only for a state of the current range start, inside `range_start ..
  collected_through` and the requested dates; `total` sums views and minutes per value (null only when every row had none), `day` lists
  rows; labels from `breakdown-labels.ts` (English).

## 38. Stored search terms per video and per channel week (BL-169, FO-REQ-0015 item 5)

Plan: `docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md` (AC-ST-01..16). Schema v78.

- **The report.** `insightTrafficSourceDetail` filtered to `video==<id>;insightTrafficSourceType==YT_SEARCH`, `views` +
  `estimatedMinutesWatched`, `maxResults=25`, `sort=-views` (YouTube refuses the report without either and gives a 500 above 25; no `day`
  split). It goes through the existing gateway function `queryChannelBreakdownReport`, which gained the two optional parameters.
- **Planning** (`planDueSearchTerms` in `src/lib/analytics/search-terms.ts`, pure). The breakdowns' videos and window
  (`hasFinalPublishDate`, `videoBreakdownWindow`). While the window runs, a video is due once yesterday ≥ window start + 6, then whenever
  today ≥ `collected_on` + 7; once the window has ended (window end ≤ yesterday), once today ≥ window end + 7 and its last read was before
  that. Each read covers window start .. min(yesterday, window end). `failed` skipped, `retry` waits; a state for another window start counts
  as never read. At most `MAX_SEARCH_TERM_QUERIES_PER_RUN` (100), least recently read first (never read first, newest publish date among
  equals), retries last inside the batch: the BL-168 queue. **Channel weeks** (owner, Telegram msg 2477: the per-video terms are nearly
  empty): `completeSearchTermWeeks(yesterday)` gives the Mondays of the last 13 Monday-Sunday weeks ending on or before yesterday; a week is
  due when never read, or when its last read was before Sunday + 7 and today is on or after it. Due weeks go first in the batch (newest
  first), then the videos.
- **Collection** (`collectDueSearchTerms`). One query per video (`video==<id>;insightTrafficSourceType==YT_SEARCH`) or week
  (`insightTrafficSourceType==YT_SEARCH`); `saveCollectedVideoSearchTerms` replaces all of the video's rows,
  `saveCollectedChannelSearchTermsWeek` the week's rows, each marking the state collected in one `database.batch`. State rows are
  `analytics_breakdown_state` rows with subject `search:<video id>` or `search-week:<Monday>` (a video id never has a colon), so `deferAnalyticsBreakdown` / `recordAnalyticsBreakdownFailure` and their rules are reused unchanged; the breakdown
  planner ignores these subjects. `failureKind` as for the breakdowns; failed at 3 attempts. A video's `defer` ends the run; a week's
  `defer` only skips the remaining weeks of the run and the videos are still read (review of BL-169: the 13 never-read weeks head every
  batch, so a channel-level report getting no answer ended 13 runs in a row with no video read, then one every Monday). Wrapped like the breakdowns
  (`gateSearchTermCollection`, analytics quota context); `/api/analytics/auto-collect-all` runs it after every channel's breakdowns.
- **Storage.** `video_search_terms` (key `video_id, term`; `channel_id`, `views`, `estimated_minutes_watched`; index on `channel_id,
  video_id`), `channel_search_terms_weekly` (key `channel_id, week_start, term`; the same two metrics). Classified `authorized`; device-local, not in the `analytics-data` exchange (same reason as §37).
- **Reads.** `listStoredSearchTerms` (channel scope) backs `agent_get_stored_search_terms`. With `videoIds`: the requested videos the
  channel has with a final publish date; terms only for a state of the current window start; most views first, then by term. With
  `startDate`/`endDate`: the Mondays from the first one on or after startDate whose Sunday is on or before the earlier of endDate and
  yesterday; each week's state (`not_collected` without one) and, for `week`, its terms; for `total`, each term summed over the weeks
  read (null only when every row had none). The input schema refuses dates with `videoIds` and the channel form without dates.

## 39. Experiment arms on videos (BL-170, FO-REQ-0015 item 3)

Plan: `docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md` (AC-EA-01..11). Schema v79.

- **Storage.** `experiment_arm_videos` (key `experiment_id, video_id`; `arm`, `linked_by`, `linked_via` web_ui | producer_proposal,
  `linked_at`), FK to `experiments`, none to `videos` (the change-set link's informal-reference rule). In `SNAPSHOT_TRANSFERRED_TABLES` after
  `experiments`; classified as YT Manager's own data. Its db functions are fenced into the decision engine by PHASE10-INV-01.
- **Writes** (`decision-engine/services.ts`). `linkExperimentArmVideo` / `unlinkExperimentArmVideo` run the experiment guard (active
  channel), then `assertArmLinkAllowed`: the hypothesis has a channel, the status is in `EXPERIMENT_ARM_LINKABLE_STATUSES`, the video is
  one of `listChannelVideoIds(hypothesis channel)`, not linked yet, fewer than 50. `insertExperimentArmVideoIfEligible` /
  `deleteExperimentArmVideoIfEligible` re-check status, cap and repeat in one statement (`INSERT ... SELECT ... WHERE`, `DELETE ... WHERE
  EXISTS`); a lost race re-runs the checks to name the reason. The labels: 1-32 letters, digits, spaces, `_`, `-`, starting with a letter or
  digit (`experimentArmLabelSchema`). Only the Web routes and the Producer proposal's apply port call them (PHASE10-INV-02).
- **Producer proposal** (`agent-proposals`). Kind `experiment.link_video`, through an `ExperimentArmsPort`. On submit
  `checkExperimentArmVideoProposal` compares the proposal's channel with the hypothesis's (the Producer is in no channel scope then) and runs
  the same checks; dedupe key `kind|experimentId|videoId`, `targetId` = experiment. On approve the same pre-claim active-channel check and
  `reopen` path as `hypothesis.add`; a refusal at apply (concluded meanwhile, linked by the owner meanwhile) leaves it `failed`. The owner's
  card is labelled with the experiment's treatment (`describeExperiments`).
- **Reads.** The trail adds `arms` per experiment (`groupExperimentArms`: `control` first, then by label). `src/lib/experiment-results/`
  composes the decision engine's `getExperiment` / `listExperimentArms` with the channel sync's videos, analytics' `listVideoMilestones`
  and `listStoredBreakdowns` (one read per video over its day-28 window, summed per window by `sumBreakdownWindow`) and Reach's
  `getVideoWindowsReach`, following `portfolio-overview/upload-milestones.ts` (statuses `due`/`not_due` from `isMilestoneDue`). A video not
  published or no longer synced has no milestones. Reach is read per group of windows spanning at most 400 days (`groupReachWindows`,
  reach-reports' own range limit; review of BL-170: one read of every window was refused whole once an old control upload was linked); a
  failed group sets `reachError` and leaves its windows at 0 days, so with `reachError` set a 0-day window may not have been read. The MCP handler passes the session's
  credentials; every core checks the active channel itself.

## 40. Own-video comments (BL-171, FO-REQ-0015 item 7)

Plan: `docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md` (AC-VC-01..12). Schema v80.

- **Module.** `src/lib/video-comments/` (services, `adapters/store.ts`, `index.ts`), a feature module of its own (AGENTS.md §M): Data API
  reads through the read gateway's `getVideoCommentCounts` (`videos.list`, `part=statistics`, 50 ids per call) and `listOwnVideoComments`
  (`commentThreads.list`, `part=snippet`, 100 newest, `order=time`, `textFormat=plainText`; non-public threads skipped; `byChannelOwner`
  computed in the gateway from `authorChannelId`, which is not returned). The shared failure rules moved from `analytics/query-failure.ts`
  to `youtube-read-gateway/read-failure.ts` (re-exported by the old path); every `*_reads_disabled` code now stops a run.
- **Run** (`collectDueComments`). Skipped when `video_comment_channel_state.checked_on` is today (Pacific). Otherwise: the channel's
  synced non-private videos' fresh counts, then `planDueCommentReads` (never read with a count > 0; `collected`/`retry` when the count
  differs from `read_comment_count` or the read is 7+ Pacific days old while the video still has comments; `disabled`/`failed` only when it
  differs; a `retry` waits until the start of the next Pacific day (`nextYoutubeQuotaReset`); never
  read first, then `read_at` ascending, retries last inside the batch; at most 50). Each read: `saveVideoCommentsRead` replaces the
  video's rows and its state in one batch. A 403 `commentsDisabled` is saved as `disabled` with no rows. Otherwise `failureKind`: `stop`
  rethrows, `defer` records a retry without an attempt and rethrows, `attempt` counts one (`failed` at 3).
  `recordVideoCommentsFailure` keeps the last read's count, or this attempt's when there was no read, and this attempt's once `failed`,
  so a failed video waits for a new count. The day is marked only when the run got through. Gated by
  `isBackgroundReadAllowed("data")`, quota context `comment_collection`; `/api/analytics/auto-collect-all` runs it after the search terms
  (same channels).
- **Storage and retention.** `video_comments` (key `comment_id`; `video_id`, `channel_id`, times, `text`, `like_count`, `reply_count`,
  `by_channel_owner`, `fetched_at`). It is classified with the new kind `authorized_expiring` (III.E.4.c). `expiringTables()` (non-authorized
  + authorized-expiring) feeds every purge path: the live purge, the import-time purge and the backup scrub. `video_comment_state` and
  `video_comment_channel_state` are bookkeeping. All three are device-local.
- **Reads.** `listStoredComments` (channel scope) backs `agent_get_video_comments`: the requested videos of the channel, newest comments
  first (`limit`), with the state.

## 49. Stored "Suggested videos" sources per video and per channel week (BL-191, FO-REQ-0026)

Plan: `docs/roadmap/plans/SUGGESTED_SOURCES_PLAN.md` (AC-SS-01..09). Schema v94.

- **One engine for both details.** `src/lib/analytics/traffic-source-details.ts` owns what §38 described for the search terms: the planner
  (`planDueTrafficDetails`, pure), the collection loop (`collectDue`) with its failure rules, and the stored read (`listStored`), all
  parameterised by a `TrafficDetailSpec` (`sourceType`, the two state-subject prefixes, a label) and a store whose rows are
  `{ detail, views, estimatedMinutesWatched }`. `search-terms.ts` is the `YT_SEARCH` spec (`search:` / `search-week:`) and maps `detail` to
  `term`, keeping BL-169's exported names and shapes; its tests run unchanged. Each spec sees only its own subjects in
  `analytics_breakdown_state`, so the two schedules never affect each other.
- **The `RELATED_VIDEO` spec** (`suggested-sources.ts`, subjects `suggested:<video id>` / `suggested-week:<Monday>`): the same report with
  `insightTrafficSourceType==RELATED_VIDEO`; each row's detail is the suggesting video's id. `/api/analytics/auto-collect-all` runs
  `collectDueSuggestedSources` after every channel's search terms, gated by the Analytics background reserve like §38.
- **Titles of external videos.** After the Analytics part of a run (not after a run it stopped), the channel's stored ids
  (`listStoredSuggestedSourceIds`) minus our own videos (`listOwnVideosByIds`: the `videos` table, any channel) minus ids with a title row
  fetched in the last 30 days are looked up, at most 500 per run, only while `isBackgroundReadAllowed("data")`, with
  `getPublicVideoTitles` (read gateway, `videos.list part=snippet`, 50 ids per call). Every looked-up id is saved, with nulls when YouTube
  did not return it. Any error ends the lookups silently; the ids stay and are tried on a later run.
- **Storage.** `video_suggested_sources` (key `video_id, source_video_id`), `channel_suggested_sources_weekly` (key `channel_id,
  week_start, source_video_id`), both `authorized` (the ids are our channel's Analytics answer). `suggested_video_titles` (key `video_id`;
  `title`, `channel_id`, `channel_title`, `fetched_at`) is `non_authorized` with clock `fetched_at`, so `purgeExpiredApiData` deletes it
  after 30 days (live database, imports, backups). All three are device-local.
- **Reads.** `listStoredSuggestedSources` backs `agent_get_stored_suggested_sources`: the engine's read, then each row is classified --
  `ours` with the title and channel from `videos` / `channels`, else `external` with the title row only when fetched at or after now − 30
  days (so a row the purge has not reached yet is never served).

