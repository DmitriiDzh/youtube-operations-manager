# Stored YouTube search terms per video and per channel week (BL-169, FO-REQ-0015 item 5)

**Status: DONE, merged into `dev` (merge 30ce7bc, owner Telegram msg 2480).** Branch `feature/fo-req-0015-search-terms`. Owner, Telegram 2026-10-10 (msg 2473, «Да»): FO-REQ-0015 step 4 in the order
of DEV-RESP-0018.

## 1. Facts (checked live 2026-10-10, both channels, read-only probe)

- `reports.query` with `dimensions=insightTrafficSourceDetail`, `filters=video==<id>;insightTrafficSourceType==YT_SEARCH`,
  `metrics=views,estimatedMinutesWatched` returns one row per search term: `[term, views, minutes]`.
  - `maxResults` and `sort` are **required**: without either, YouTube answers 400 "The query is not supported". `maxResults=25` works;
    `maxResults=50` gives a 500 (`FIELD_UNKNOWN_VALUE` on `max-results`). Both `sort=-views` and `sort=-estimatedMinutesWatched` work.
  - `day,insightTrafficSourceDetail` is refused (400): there is **no per-day split**. Each query gives totals for its whole range.
  - Without the `video==` part (only `insightTrafficSourceType==YT_SEARCH`) it returns the channel's terms (25 rows over 10 weeks).
- **YouTube names a term for only a small share of search views.** Here are the views from YouTube search (the `YT_SEARCH` row) and the
  views of the terms it returned:

  | Subject | Range | Search views | Views of returned terms |
  |---|---|---|---|
  | Rural Japan Music, 28 days | to 10-08 | 196 | 23, in 18 terms |
  | Rural Japan Music, 7 days | to 10-08 | 36 | 6 |
  | Tropico Jazz, 28 days | to 10-08 | 97 | 20, in 19 terms |
  | Tropico Jazz, 7 days | to 10-08 | 25 | 2 |
  | `Ck4cZ1fOOio` (Japan), since publish | 08-21..10-08 | 38 | 5, in 4 terms |
  | `7FOvukxZ3iM` (Tropico, most viewed), since publish | 08-30..10-08 | 9 | 3, in 3 terms |
  | `1ZI-SVv5Gnc` (Tropico), since publish | 09-26..10-08 | 6 | 1 |

  Most terms have 1 view, and the share stays about the same when the 25-row cap is not reached. The rest is simply not returned.
  Per video and per week there is almost nothing; the channel over a few weeks shows real words.
- Each query is 1 Analytics API unit. Own-channel Analytics data is Authorized Data and may be kept (III.E.4.b). Nothing derived is
  computed (III.E.4.h).

## 2. Design

### Per video (the item as asked)

- **Which videos:** the same as the stored breakdowns (BL-168): every synced video with a final publish date, window = its first 90 days
  (Pacific publish date .. +89). Old videos are read once for their whole window.
- **The query:** the video's terms for its window so far (window start .. the earlier of yesterday and the window end), top 25 by views.
  Since there is no day split, each read is a fresh total that **replaces** the video's stored terms.
- **When ("weekly"):**
  - While the window runs: the first read once the video has 7 days (yesterday ≥ window start + 6), then again whenever 7 days have passed
    since the last read.
  - Once the window has ended: one read on or after window end + 7 (YouTube revises recent days), unless the last read was already on or
    after that day. Then never again.
- One query per read, so about one query per video per week.

### Per channel, per week (added: the per-video data is nearly empty, see §1; approved by the owner, Telegram msg 2477, «1 ок, добавь недели»)

- **Weeks:** Monday–Sunday, Pacific dates, like the Analytics tab's weekly buckets. The last 13 complete weeks are considered; a week older
  than that which was never read is not read any more.
- **When:** a week is read once it is complete (its Sunday is yesterday or earlier), and once more on or after Sunday + 7 unless it was
  first read on or after that day. Then never again. So 13 queries at the first collection, then about 2 a week.
- Each week keeps its own top 25 (history is kept; summing weeks later gives a picture of any longer span).

### The request path

- Through the read gateway's existing `queryChannelBreakdownReport` (`youtube-read-gateway/analytics-api.ts`), which gains two optional
  parameters, `maxResults` and `sort` (required by YouTube for this report, §1), passed on by `analytics/adapters/youtube-api.ts`. No new
  `reports.query` call site.

### Runs

- After the breakdowns, for each channel whose Analytics collection did not fail (`/api/analytics/auto-collect-all`). Same reads switch,
  quota reserve (`isBackgroundReadAllowed("analytics")`) and quota-history label.
- **At most 100 queries per channel per run.** Channel weeks first (newest first), then due videos least recently read first (never read
  first, newest publish date first among equals). Inside the batch, subjects whose last attempt failed run last. The BL-168 rules, so a
  backlog finishes over the next runs and nothing is starved.
- **Failures:** the shared `failureKind` rules. `stop` (reads off, quota, sign-in, 401, system 403) ends the run with nothing written;
  `defer` (no answer, 429, 5xx) puts the subject back 24 h and ends the run -- for a week, only the weeks of the run end and the videos
  are still read (review of BL-169: otherwise the 13 never-read weeks at the head of the batch, each getting no answer in turn, stopped 13
  runs in a row with no video read); `attempt` (400, 404, other 403) counts one try, retry after
  24 h, `failed` after 3. A channel week is finite, so it can be given up like a video.
- Steady state: about 70 videos in their window per channel, so some 10 queries a day per channel, plus 2 a week for the channel.

### Storage (schema v78, device-local, `authorized`)

- `video_search_terms`: key (video_id, term), plus `channel_id`, `views`, `estimated_minutes_watched`. Replaced as a whole on each read.
- `channel_search_terms_weekly`: key (channel_id, week_start, term), plus the same two metrics. Replaced per week on each read of that week.
- **No state table of its own** (changed while building, to share one owner of the attempt rules): the state rows live in BL-168's
  `analytics_breakdown_state` under the subject `search:<video id>` (a channel week: `search-week:<Monday>`). A video id never contains a
  colon, so they never collide with the breakdowns' subjects (`channel`, a video id), and `deferAnalyticsBreakdown` /
  `recordAnalyticsBreakdownFailure` are reused unchanged.
- Not shared between computers, like the milestones and breakdowns.

### Read tool `agent_get_stored_search_terms`

- **Input:** `{ channelId, videoIds? (1–20) }` for videos, or `{ channelId, startDate, endDate (≤ 92 days), groupBy?: "total" | "week" }`
  for the channel. The dates belong to the channel form only: dates together with `videoIds` are refused, and so is the channel form
  without dates.
- **Videos:** `{ videoId, publishedAt, window { start, end }, coverage { from, through, collectedAt } | null, status, lastError, terms }`.
  `terms` is `[{ term, views, estimatedMinutesWatched }]`, most views first. These are the terms of the whole stored range (window start ..
  `coverage.through`).
- **Channel:** the complete weeks lying fully inside startDate..endDate, each `{ weekStart, weekEnd, status, collectedAt, lastError }`.
  - `groupBy: "total"` (default): `terms` sums each term over the collected weeks (a sum of weekly top-25 lists).
  - `groupBy: "week"`: every week carries its own `terms`.
- The description says that YouTube names terms for only part of search views, and that the search total is the `YT_SEARCH` row of
  `agent_get_stored_breakdowns`.
- READ, local only. Agent API 3.10.0 → **3.11.0**, capability `analytics.query_stored_search_terms`. Producer: the same tool on its closed
  list, Producer API 1.3.0 → **1.4.0** (ADR 0034 Amendment 4).

### Not in this step

- The Analytics tab is unchanged.
- No search terms in `producer_upload_milestones`.
- Other traffic-source details are not stored. For example, `RELATED_VIDEO` returns the ids of the videos that suggested ours; it was
  checked live but not asked for.
- Experiment arms are step 5.

## 3. Acceptance criteria (fixed before the code)

The examples use Pacific dates. 2026-10-10 is a Saturday. Video V1 is published 2026-09-01T12:00:00Z, so its window is 2026-09-01..2026-11-29.

- **AC-ST-01 (first read).** At 2026-10-10T18:00:00Z, V1 is queried once with:
  - startDate 2026-09-01, endDate 2026-10-09;
  - `dimensions=insightTrafficSourceDetail`, `filters=video==V1;insightTrafficSourceType==YT_SEARCH`;
  - `metrics=views,estimatedMinutesWatched`, `maxResults=25`, `sort=-views`.

  Its state then records through 10-09, collected on 10-10.
- **AC-ST-02 (weekly).** After AC-ST-01:
  - From 2026-10-11 to 2026-10-16 V1 is not due.
  - At 2026-10-17T18:00:00Z it is read for 2026-09-01..2026-10-16.
  - A term stored before that the new answer lacks is gone, and the new answer's terms are stored.
- **AC-ST-03 (first week).** A video published 2026-10-05T12:00:00Z:
  - is not due at 2026-10-10T18:00:00Z, because yesterday 10-09 < 10-11;
  - is due at 2026-10-12T18:00:00Z, read for 2026-10-05..2026-10-11.
- **AC-ST-04 (end of window).** V1, last read on 11-28 through 11-27:
  - is not due from 2026-11-29 to 2026-12-05;
  - is due on 2026-12-06, read for 2026-09-01..2026-11-29;
  - is never due again (12-07, 12-20).
- **AC-ST-05 (history).** A video published 2026-06-01T12:00:00Z is read once, at 2026-10-10, for 2026-06-01..2026-08-29, and never again.
- **AC-ST-06 (excluded).** These are never queried:
  - a private video;
  - an upcoming premiere;
  - a video without `publishedAt`;
  - a video published today.
- **AC-ST-07 (channel weeks, first run).** At 2026-10-10T18:00:00Z:
  - 13 channel queries are made, newest first: 2026-09-28..2026-10-04, then 2026-09-21..2026-09-27, down to 2026-07-06..2026-07-12.
  - Each query has `filters=insightTrafficSourceType==YT_SEARCH` (no video part), with the same metrics, `maxResults` and `sort` as above.
- **AC-ST-08 (channel weeks, later).** After AC-ST-07:
  - At 2026-10-11T18:00:00Z only week 09-28 is read again (its settled read on 10-11 = Sunday 10-04 + 7). Week 10-05 is not complete yet.
  - At 2026-10-12T18:00:00Z week 2026-10-05..2026-10-11 is read.
  - On 2026-10-13 nothing more is read for the channel.
  - On 2026-10-18 week 10-05 is read again, once.
- **AC-ST-09 (cap).** 120 never-read due videos and 13 weeks give two runs:
  - the first run, at 2026-10-10T18:00:00Z, makes 100 queries: the 13 weeks, then the 87 newest videos;
  - the next run, at 2026-10-10T20:00:00Z (the same Pacific day), reads the remaining 33.
- **AC-ST-10 (failures).**
  - A 400 counts attempt 1 and retries after 24 h. After 3 attempts the subject is `failed` and never queried again. This holds for a video
    and for a channel week.
  - A 503, a 429 or no answer puts that subject back 24 h with 0 attempts. For a video it stops the run; for a channel week it stops only
    the weeks of the run and the videos are still read. *(Changed by the review of BL-169: with "stops the run" for weeks too, the 13
    never-read weeks at the head of the batch, each getting no answer in turn, stopped 13 runs in a row with no video read.)*
  - Quota exhausted, reads switched off, sign-in errors, a 401 or a 403 `quotaExceeded` stop the run with nothing written.
- **AC-ST-11 (answer shape).**
  - An empty answer records the read with no terms.
  - A row with an empty term is skipped.
  - A term repeated in one answer keeps YouTube's last row.
- **AC-ST-12 (reads).**
  - V1 stored as `tropico 7` 2/0, `bossa nova cafe` 1/18 and `noir jazz` 1/0 is returned in that order (most views first, then by term),
    with coverage 2026-09-01..2026-10-09.
  - Channel weeks 09-21 (`latin jazz cafe` 2/0, `bossa nova` 1/5) and 09-28 (`bossa nova` 1/3, `cuban jazz` 1/8), read for
    2026-09-21..2026-10-04:
    - `total` gives `bossa nova` 2/8, `latin jazz cafe` 2/0, `cuban jazz` 1/8;
    - `week` gives each week with its own terms;
    - read for 2026-09-22..2026-10-04, only week 09-28 is returned;
    - a week inside the range that was never read is listed with status `not_collected` and no terms. A week older than the 13
      weeks that are collected stays `not_collected` for good, by design. The tool description says so.
  - Exactly 92 days is accepted. These are refused: 93 days, 2026-02-30, `videoIds` together with dates, the channel form without dates,
    and an inactive `channelId`. A video of another channel is not listed. All of this also holds through the Producer.
- **AC-ST-13 (reserve).** While the background reserve is not allowed, a run makes zero queries.
- **AC-ST-14 (independence).** A search-terms run that throws does not stop the next channel's milestones, breakdowns or search terms, and
  the same channel's breakdowns ran before it.
- **AC-ST-15 (contract).** Agent API 3.11.0 with capability `analytics.query_stored_search_terms`. Producer API 1.4.0 with the tool on its
  closed list.
- **AC-ST-16 (policy).** The new tables are classified `authorized` and are device-local (not in the device snapshot).
