# Video milestones: day-7 and day-28 retention and totals (BL-166, FO-REQ-0015 items 1 and 8)

**Status: BUILT on `feature/fo-req-0015-milestones`, waiting for the owner's merge decision.** Owner, Telegram 2026-10-09 (msgs 2380–2381): FO-REQ-0015 in the order of DEV-RESP-0018, step 2
after the quick fixes. Branch `feature/fo-req-0015-milestones`.

## 1. Facts (checked 2026-10-09)

- **Retention curve.** `reports.query` with dimension `elapsedVideoTimeRatio` returns 100 points (0.01 … 1.00), one video per query
  (`filters=video==<id>`), no `day`. The curve covers every view in startDate..endDate. Data arrives 48–72 h late.
  - Metrics: `audienceWatchRatio`, `relativeRetentionPerformance`, `startedWatching`, `stoppedWatching`, `totalSegmentImpressions`.
  - YT Manager already reads it live for the Web UI: `getVideoRetentionCurve`, through the gateway's `queryChannelBreakdownReport`.
- **Totals for a window** come from the same query without a dimension: `views`, `estimatedMinutesWatched`, `averageViewDuration`,
  `averageViewPercentage`, each as YouTube computes it for that window.
- **Cost.** Each query is 1 Analytics API unit, on the Analytics quota, not the Data API's 10,000.
- **Policy.** Own-channel Analytics data is Authorized Data and may be kept as long as needed (III.E.4.b). YT Manager computes no
  "retention at N seconds": that could count as a derived metric (III.E.4.h).

## 2. Design

- **Milestones.** For each synced video and each M in {7, 28}, the window runs from the video's publish date (Pacific calendar date,
  like the rest of Analytics) to publish date + M − 1. A milestone is **due** once today (Pacific) is at least 3 days after the window
  end (the reporting lag).
- **Collection.**
  - It runs inside the existing Analytics collection for each channel, after the daily rows: on the dashboard load for the active
    channel, and in the background for the others. Old videos are included, so history fills too.
  - Each due milestone costs 2 queries: the curve and the totals.
  - At most 25 milestones per channel per run (50 queries), oldest due first. A larger backlog finishes over the next runs.
  - It is subject to the same "reads enabled" switch and quota reserve as the Analytics auto-collection.
  - A failed query leaves that milestone uncollected, to be retried on a later run. One failure never stops the others.
  - **Added by the independent review (2026-10-10):** only public videos that are not upcoming premieres or streams are collected
    (while a video is private or scheduled, YouTube gives its owner the upload time as `publishedAt`). A stored milestone whose window no
    longer matches the publish date is collected again, attempts from 1, and is not returned until then. Only an error about the query
    itself (400, 404, a 403 not about permissions, project or rate) counts an attempt; reads off, quota, sign-in, 401 and system 403s
    stop the run with nothing recorded; no answer, 429 and 5xx stop it and put that milestone back by a day without an attempt (second
    review: otherwise one video with a lasting 5xx would hold the channel's queue).
- **Storage.** New table `video_milestones` (schema v75), primary key (video_id, milestone_days), with:
  - `channel_id`, `window_start`, `window_end`, `collected_at`;
  - `views`, `estimated_minutes_watched`, `average_view_duration`, `average_view_percentage`, each null when YouTube returned none;
  - `retention_json`: up to 100 points of the five metrics, as returned. `[]` when YouTube returned none, e.g. below its unpublished
    threshold.
  - It is classified `authorized` and is device-local: each computer collects its own channels' milestones.
- **Reads.**
  - Channel tool `agent_get_video_milestones` `{ channelId, videoIds? (≤50), milestone? (7|28) }` →
    `{ milestones: [{ videoId, milestoneDays, windowStart, windowEnd, collectedAt, durationSeconds, totals, retention }] }`.
    - `durationSeconds` is the video's stored length, so a reader can locate a time on the curve.
    - READ, channel-scoped, local only.
    - The Producer gets it too: closed list, READ.
  - Producer tool `producer_upload_milestones` `{ startDate, endDate }` (at most 92 days, uploads by UTC date like the portfolio overview)
    → for each connected channel, its uploads published in that range, each with:
    - its day-7 and day-28 totals;
    - Reach impressions and CTR over the same window, from stored `channel_reach_daily` rows (impressions summed; CTR = Σ(impressions ×
      ctr) / Σ impressions, simple math on own data; null when no Reach day is stored in the window);
    - no curves.
- **Versions.** `AGENT_API_VERSION` 3.8.0 → 3.9.0 (a new capability). Producer API 1.1.0 → 1.2.0.

## 3. Acceptance criteria (fixed before the code)

- **AC-VM-01** A video published 2026-09-01 (Pacific) has its day-7 window 09-01..09-07, due from 09-10, and its day-28 window
  09-01..09-28, due from 10-01. Neither is due a day earlier.
- **AC-VM-02** A due milestone is collected with 2 queries:
  - the curve: `elapsedVideoTimeRatio`, the five metrics, `video==<id>`, the window;
  - the totals: no dimension, the four metrics, the same filter and window.
  - The stored row holds exactly what was returned. A collected milestone is never queried again.
- **AC-VM-03** At most 25 milestones per channel per run, the oldest due first. The next run continues.
- **AC-VM-04** A failed query leaves its milestone uncollected; the next one is still attempted. With reads off or the quota reserve
  reached, nothing is queried.
- **AC-VM-05** An empty answer is stored as collected with `retention: []` and null totals (not re-queried every run).
- **AC-VM-06** `agent_get_video_milestones` returns only the session channel's videos and only stored data. A video of another channel
  behaves like an unknown one.
- **AC-VM-07** For each connected channel, `producer_upload_milestones` lists the uploads in the date range with day-7 and day-28
  totals, null where not collected yet. Reach is summed over the same window, null without data. It makes no live call.
- **AC-VM-08** `video_milestones` is classified in the data-policy contracts. It is not in the device snapshot.

## 4. Out of scope (later steps or owner decision)

- Sharing milestones between computers through the analytics data sync (BL-151): each computer collects its own for now.
- Per-video traffic sources and devices (step 3), search terms (step 4), experiment arms (step 5), comments (step 6).
- Retrying a `failed` milestone: after 3 failed attempts it is never queried again, and there is no reset yet (owner decision if needed).
