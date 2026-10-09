# Stored traffic sources and devices per video and per channel (BL-168, FO-REQ-0015 item 2)

**Status: IN PROGRESS** on `feature/fo-req-0015-breakdowns`. Owner, Telegram 2026-10-10 (msg 2435, «Да, начинай»): FO-REQ-0015 step 3 in
the order of DEV-RESP-0018.

## 1. Facts (checked live 2026-10-10, Tropico Jazz, read-only probe)

- `reports.query` with `dimensions=day,insightTrafficSourceType` or `day,deviceType`, `metrics=views,estimatedMinutesWatched`:
  - **per video** (`filters=video==<id>`): rows returned, e.g. 136 traffic rows and 121 device rows for one video over 2026-08-01..10-07.
    The daily rows add up exactly to the video's total for the range (939 views in each of the three).
  - **per channel** (no filter): 418 traffic rows and 224 device rows. The traffic rows add up to 10,237 views against a channel
    total of 10,278 (0.4% less). YouTube computes it that way; the answer is not cut short (no round row count, and `sort` changes nothing).
  - Values seen: traffic `NO_LINK_OTHER`, `SUBSCRIBER`, `YT_CHANNEL`, `YT_SEARCH`, `RELATED_VIDEO`, `YT_OTHER_PAGE`, `PLAYLIST`, `EXT_URL`,
    `NOTIFICATION`; devices `DESKTOP`, `MOBILE`, `TV`, `TABLET`. Rows with 0 views do occur.
- `video` is a filter here, not a dimension: one query per video per breakdown (DEV-RESP-0018).
- Each query is 1 Analytics API unit, on the Analytics quota. Recent Analytics use on the Mac: 180–1,120 queries a day.
  This feature adds, in steady state, about 140–150 queries per channel a day at 0.8 uploads a day (some 70 due subjects, 2 queries
  each), at most 200 per channel per run (the cap of 100 subjects); the first collection of a channel's history is a one-time extra.
- Own-channel Analytics data is Authorized Data and may be kept as long as needed (III.E.4.b). Nothing derived is computed (III.E.4.h).

## 2. Design

### Subjects and days

- **Videos.** Every synced video with a final publish date (`hasFinalPublishDate`, the BL-166 rule: public, not an upcoming premiere or
  stream). Its window is its first **90 days**: the Pacific publish date .. +89. Old videos are included, so history fills once.
- **Channel.** The channel as a whole, with no end date. Its first collection starts 89 days before the latest day.
- **The latest day** is yesterday (Pacific), like the daily rows. A subject's range ends at the earlier of the latest day and its window end.
- **Breakdowns.** `traffic_source` (`day,insightTrafficSourceType`) and `device_type` (`day,deviceType`), both with `views` and
  `estimatedMinutesWatched`. So 2 queries per subject per collection.

### When a subject is collected

- **First time:** its whole range so far, one query per breakdown.
- **After that, once per Pacific day, while a new day exists** (the range end is later than what is stored). It reads from 6 days before
  the first new day (the day after the stored end) up to the range end. YouTube revises recent days, so the last 6 stored days are read
  again, and a gap left while the computer was off is filled. *(Review of BL-168: the first version started at the gap, so the provisional
  days just before it were never read again.)*
- **Final pass of a video:** its window has ended and its last collection was before window end + 7. One more collection on or after
  window end + 7 rereads the window's last 7 days. After that the video is never queried again.
- **Replacing rows.** Within the range read, the stored rows of that subject and breakdown are replaced by YouTube's answer, so a source that
  disappeared after a revision is gone too. Days outside the range are not touched. A zero-row answer is a valid collection: no rows,
  range recorded.

### Runs

- Runs after the milestones, for each channel whose Analytics collection did not fail (`/api/analytics/auto-collect-all`, after the response).
  Same "reads enabled" switch (inside the client), quota reserve (`isBackgroundReadAllowed("analytics")`) and quota-history label.
- **At most 100 subjects per channel per run (200 queries).** The channel goes first, then the due videos least recently read first (never
  read first, the newest publish date first among equals). A video left out is read first on the next run, so none is starved. A larger
  backlog finishes over the next runs. The batch is chosen in that order alone; inside it, subjects whose last attempt failed (`retry`,
  the channel too) run last, so one that keeps getting no answer, which ends its run, never stops the others of the batch from being read
  (second review; the milestones' rule), and a retry is still chosen by how long ago it was read, never shut out by a full batch (third
  review).
  - *Review of BL-168:* the first version had 50 subjects and a newest-first order. Every video inside its window is due every day, so a
    channel has about 70 due subjects at 0.8 uploads a day; Tropico Jazz already has 51 videos in their window. The oldest videos of the
    window were then left out every day and never got their last weeks or their final pass. The earlier estimate of "about 46 subjects a
    day" was wrong.
- **Failures use the milestone rules,** with the helper moved to its own file and shared, not copied:
  - reads off, quota, sign-in, channel access, 401 and system 403s stop the run with nothing recorded;
  - no answer, 429 and 5xx stop the run and put that subject back by a day without an attempt;
  - an error about the query (400, 404, another 403) counts an attempt: retry after 24 h, `failed` after 3, then never queried again.
    **The channel is never `failed`** (it has no end and no other way back): it is retried a day later, every time (review of BL-168).

### Storage (schema v77, device-local, `authorized`)

- `video_breakdown_daily`: key (video_id, breakdown, day, value), plus `channel_id`, `views`, `estimated_minutes_watched`.
- `channel_breakdown_daily`: key (channel_id, breakdown, day, value), plus the same two metrics.
- `analytics_breakdown_state`: key (channel_id, subject), where subject is `channel` or a video id. It holds `range_start`,
  `collected_through`, `collected_on` (Pacific date), `collected_at`, `status` (collected | retry | failed), `attempts`, `last_error`,
  `next_attempt_at`.
- **Not shared between computers,** like the milestones. The `analytics-data` file format is strict at version 1, so adding tables would
  make the not-yet-updated Windows computer reject the Mac's files. Sharing would be its own item.

### Reads

- **Channel tool `agent_get_stored_breakdowns`:**
  - Input: `{ channelId, videoIds? (1–20), startDate, endDate (≤ 92 days), groupBy?: "total" (default) | "day" }`.
  - Without `videoIds` it returns the channel; with them, those videos.
  - Output per subject:
    - `coverage { from, through, collectedAt }`, or null when never collected, and `status` (collected | retry | failed | not_collected)
      with `lastError`;
    - `trafficSources` and `devices`, each row `{ day? , value, label, views, estimatedMinutesWatched }`, raw API value plus readable label;
    - `total` sums each value over the requested days that are stored (simple sums of own data).
  - A video of another channel, or one never synced, is not listed. READ, local only, Agent API 3.9.0 → **3.10.0**, capability
    `analytics.query_stored_breakdowns`.
- **Producer:** the same tool on its closed list (Producer API 1.2.0 → **1.3.0**, ADR 0034 Amendment 3). No new Producer-only tool.

### Not in this step

- The Analytics tab keeps reading its channel cards live. Storing is the ask, switching the UI is not.
- Only traffic sources and devices are stored at channel level, not age/gender, geography, subscribed status or content format.
- No traffic or device figures in `producer_upload_milestones`. The tool above, with the video ids, gives them.
- Search terms (item 5) are step 4.

## 3. Acceptance criteria (fixed before the code)

- **AC-VB-01** (window) A video published 2026-09-01T12:00:00Z has the window 2026-09-01..2026-11-29. One published 2026-09-01T03:00:00Z
  (Pacific 08-31 20:00) has 2026-08-31..2026-11-28.
- **AC-VB-02** (first run) At now 2026-10-10T18:00:00Z, that first video is queried for 2026-09-01..2026-10-09, once for each breakdown, and
  its state records through 10-09, collected on 10-10.
- **AC-VB-03** (once a day) At 2026-10-10T23:00:00Z (still 10-10 Pacific) the same channel makes zero queries.
- **AC-VB-04** (rolling reread) At 2026-10-11T18:00:00Z the video is read for 2026-10-04..2026-10-10.
  - A stored 10-05 `YT_SEARCH` row that YouTube no longer returns is deleted.
  - The stored 10-03 rows stay.
- **AC-VB-05** (gap) Last collected through 10-01, on 10-02. At 2026-10-11T18:00:00Z it is read for 2026-09-26..2026-10-10 (changed by
  the review: 6 days before the first missing day, 10-02).
- **AC-VB-06** (final pass) Window end 2026-11-29.
  - Collected on 11-30 through 11-29.
  - Not due on 12-01..12-05.
  - Due on 12-06 for 2026-11-23..2026-11-29.
  - Never due again (12-07, 12-20).
- **AC-VB-07** (history) A video published 2026-06-01T12:00:00Z, at now 2026-10-10, is read once for 2026-06-01..2026-08-29 and never again.
- **AC-VB-08** (excluded) A private video, an upcoming premiere and a video without `publishedAt` are never queried. A video published
  today (Pacific) is not due.
- **AC-VB-09** (channel)
  - First run at now 2026-10-10T18:00:00Z reads the channel for 2026-07-12..2026-10-09.
  - Next day it reads 2026-10-04..2026-10-10.
  - The channel is never finalized.
- **AC-VB-10** (cap) With 120 due videos never read, one run collects the channel and the 99 newest videos (200 queries). The next run
  collects the remaining 21. *(Changed by the review: the cap is 100.)* With more due videos than the cap every day, each video is read
  at least every ceil(due / free slots) days, and a video whose window ended still gets its final pass.
- **AC-VB-11** (failures)
  - A 400 counts attempt 1, retries after 24 h and is `failed` after 3. A 404 or a video's own 403 (`forbidden`) counts an attempt too.
  - The channel failing with a 400 on 5 days is still `retry` with 5 attempts and was tried on each day.
  - A 503, 429 or no answer stops the run and puts the subject back by 24 h with 0 attempts.
  - Quota, reads off, sign-in, 401 and a 403 `quotaExceeded` stop the run with nothing written.
- **AC-VB-12** (zero rows) An empty answer records the range as collected with no rows. It is not queried again that day.
- **AC-VB-13** (reads; exactly 92 days accepted, 93 and a date that does not exist such as 2026-02-30 refused, also through the Producer)
  - Stored traffic rows 10-01 `SUBSCRIBER` 18 views / 451 min and 10-02 `SUBSCRIBER` 2 / 30 give `total` `SUBSCRIBER` 20 / 481 for
    10-01..10-02, and 18 / 451 for 10-01 alone.
  - `groupBy: "day"` returns both rows as stored.
  - A video id of another channel is not in the answer.
  - An inactive `channelId` is refused.
- **AC-VB-14** (reserve) While the background reserve is not allowed, a run makes zero queries.
- **AC-VB-15** (independence) A breakdown run that throws does not stop the next channel's milestones or breakdowns, and the milestones
  of the same channel ran before it.
- **AC-VB-16** (contract) Agent API 3.10.0 with capability `analytics.query_stored_breakdowns`. Producer API 1.3.0 with the tool on its
  closed list.
- **AC-VB-17** (policy) The three tables are classified `authorized` and are device-local (not in the device snapshot).
