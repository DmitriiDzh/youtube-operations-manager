# Stored "Suggested videos" sources per video and per channel week (BL-191, FO-REQ-0026)

**Status: IN PROGRESS** on `feature/fo-req-0026-suggested-sources`. Request: FO-REQ-0026 (Operator, relaying PRD-REQ-0013, 2026-10-15).
Owner go: Telegram 2026-10-15, msg 2824 («Да») on the assessment in msg 2823. Reply: DEV-RESP-0032.

## 1. Facts

- The query is BL-169's with another traffic source: `reports.query` with `dimensions=insightTrafficSourceDetail`,
  `filters=[video==<id>;]insightTrafficSourceType==RELATED_VIDEO`, `metrics=views,estimatedMinutesWatched`, `maxResults=25`,
  `sort=-views`. It returns one row per suggesting video: `[videoId, views, minutes]` (checked live 2026-10-10 while building BL-169,
  `VIDEO_SEARCH_TERMS_PLAN.md` §2 "Not in this step"). The same limits hold: `maxResults` and `sort` are required, 25 is the most, no
  day split.
- Only the top 25 per query exist, so every list is partial.
- The suggesting ids come back inside our own channel's Analytics report: Authorized Data (III.E.4.b), kept like the search terms.
  Titles and channels of other people's videos from Data API `videos.list` are another channel's data: at most 30 days (III.E.4.d).

## 2. Design

### One engine for both details (search terms and suggesting videos)

BL-169's planner, collection loop and read shaping move into `src/lib/analytics/traffic-source-details.ts`, parameterised by the traffic
source (`YT_SEARCH`, `RELATED_VIDEO`), the state subject prefixes and the store. `search-terms.ts` keeps its public names and result
shapes and becomes the `YT_SEARCH` configuration; its existing tests stay unchanged and must still pass. `suggested-sources.ts` is the
`RELATED_VIDEO` configuration plus the two additions below. No second copy of the scheduling rules.

### Schedule (exactly BL-169's)

- **Per video:** every synced video with a final publish date, window = its first 90 days (Pacific). First read once it has 7 days, then
  every 7 days while the window runs, once more on or after window end + 7. Each read replaces the video's stored rows.
- **Per channel week:** Monday–Sunday (Pacific), the last 13 complete weeks; each read once complete and once more on or after Sunday + 7.
- At most 100 queries per channel per run, weeks first, then videos least recently read first; the shared failure rules
  (`query-failure.ts`); state rows in `analytics_breakdown_state` under the subjects `suggested:<video id>` and
  `suggested-week:<Monday>`.
- Run after the search terms in `/api/analytics/auto-collect-all`, for the same channels, with the same reads switch, Analytics quota
  reserve and quota-history label.

### `source: ours | external`

Decided when the rows are read, not stored: `ours` when the suggesting id is a synced video of any channel connected to YT Manager on
this computer (Tropico and Japan both count), else `external`. A channel synced later turns its rows into `ours` without a re-read.
An `ours` row carries the title and channel from the local `videos` / `channels` tables (our own data).

### Titles of external videos (30 days)

- Table `suggested_video_titles` (`video_id` PK, `title`, `channel_id`, `channel_title`, `fetched_at`), classified `non_authorized`
  with the clock `fetched_at`: the existing retention purge deletes a row 30 days after it was fetched.
- Filled at the end of each collection run: the channel's stored external ids that have no title row are looked up with `videos.list`
  (`part=snippet`, 50 ids per call, at most 10 calls = 500 ids per run), through a new read-gateway function in `data-api.ts`. Only when
  the Data API background reserve allows (`isBackgroundReadAllowed("data")`); any failure ends the lookups of that run and never fails
  the collection (the ids stay, the titles come on a later run).
- On read, a title row older than 30 days is ignored even before the purge runs. An id YouTube does not return (deleted, private) gets
  no title.
- A stored row is never re-fetched only to refresh its title; after the purge, an id that is still in the stored rows is looked up again
  on the next run.

### Storage (schema v94, device-local)

- `video_suggested_sources`: key (video_id, source_video_id), plus `channel_id`, `views`, `estimated_minutes_watched`. Authorized.
- `channel_suggested_sources_weekly`: key (channel_id, week_start, source_video_id), plus the two metrics. Authorized.
- `suggested_video_titles`: as above, `non_authorized`.
- Not shared between computers, like the search terms (snapshot: accepted limitation RISK-52). Windows collects for itself once it has
  this build.

### Read tool `agent_get_stored_suggested_sources`

- **Input:** BL-169's two forms: `{ channelId, videoIds (1–20) }`, or `{ channelId, startDate, endDate (≤ 92 days), groupBy?: "total" | "week" }`.
- **Rows:** `{ videoId, views, estimatedMinutesWatched, source: "ours" | "external", title, channelId, channelTitle }`, most views first;
  the last three are `null` when not known (an external video without a fresh title row).
- **Videos:** `{ videoId, publishedAt, window, coverage, status, lastError, sources }`. **Channel:** the complete weeks inside the dates
  with `status`, `collectedAt`, `lastError`; `groupBy: "total"` sums each suggesting video over the collected weeks, `"week"` gives each
  week its own `sources`.
- The description says the lists are YouTube's top 25 per query (partial), and that the total of suggested views is the `RELATED_VIDEO`
  row of `agent_get_stored_breakdowns`.
- READ, local only. Agent API 3.17.0 → **3.18.0**, capability `analytics.query_stored_suggested_sources`. Producer: the same tool on its
  closed list, Producer API 1.8.0 → **1.9.0** (ADR 0034 Amendment 7).

### Not in this step

- No Web UI change (the Analytics tab stays live).
- No derived metrics about other channels.

## 3. Acceptance criteria (fixed before the code)

Pacific dates. 2026-10-16 is a Friday.

- **AC-SS-01 (query).** A due video V is read with `filters=video==V;insightTrafficSourceType==RELATED_VIDEO`, a week with
  `filters=insightTrafficSourceType==RELATED_VIDEO`, both with `dimensions=insightTrafficSourceDetail`,
  `metrics=views,estimatedMinutesWatched`, `maxResults=25`, `sort=-views`.
- **AC-SS-02 (schedule).** The BL-169 cases AC-ST-01…AC-ST-10 (videos, weeks, cap, failures) hold for the `suggested:` subjects (same
  dates, same results),
  and a search-term state never makes a suggested subject due or not due (and the reverse).
- **AC-SS-03 (search terms unchanged).** Every existing `search-terms*.test.ts` passes unchanged after the engine is shared.
- **AC-SS-04 (source).** With connected channels A and B: a row whose id is a synced video of B, read for A, is `ours` with B's title and
  channel; an unknown id is `external`.
- **AC-SS-05 (titles).** After a run that stored external ids X1…X60 with no title rows, `videos.list` is called twice (50 + 10 ids, in
  that order) and only for those ids; `ours` ids and ids with a title row are not looked up. A lookup failure leaves the run's result
  as it was (collected counts unchanged) and stores no titles.
- **AC-SS-06 (30 days).** A title row fetched 31 days before the read is not returned (the row comes with `title`, `channelId`,
  `channelTitle` null) and is deleted by the retention purge; one fetched 29 days before is returned.
- **AC-SS-07 (data reserve).** When the Data API background reserve is not allowed, no `videos.list` call is made; the Analytics part
  still runs.
- **AC-SS-08 (tool).** `agent_get_stored_suggested_sources` is listed on the channel endpoint and in `producer_get_capabilities`, READ,
  with the two forms; dates together with `videoIds` are refused; another channel's video is not listed.
- **AC-SS-09 (live, after merge, Mac).** Tropico weeks 2026-09-28…10-04 and 10-05…10-11 return rows with `source`; `kB8OuwCcgnM`
  returns rows once read on or after 2026-10-18.
