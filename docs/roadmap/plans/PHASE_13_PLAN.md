# Phase 13: data sources and API-policy compliance for Research

**Recorded** 2026-10-01, at the owner's request (Telegram, msg 1125). The request, verbatim: *"Хорошо, опираясь на это
исследование составь план реализации и заведи это как новую фазу"* ("Good. Based on this research, draw up an
implementation plan and register it as a new phase"). It follows the sources research the owner asked for in
msg 1121 (full report with links: `PHASE_13_SOURCES_RESEARCH.md`).

**Status: assigned.** The owner assigned it (msg 1127): *"приступай к реализации фазы 13. Автономный режим. Я одобряю
только финальный мердж ветки в дев"* ("start implementing phase 13; autonomous mode; I only approve the final
merge of the branch into dev"). Branch `feature/phase-13-data-sources`.

**Decisions made:**
- **D1 = (a)** (msg 1129, verbatim *"(а) ок, храним не более 30 дней"*, "(a) ok, we keep it no more than 30 days").
  Competitor data that came from the API is kept for at most 30 days. Re-fetching fresh data via the API starts a
  new 30-day period for the new record (my reply, msg 1130).
- **D2** has no answer yet, so 13.10 is not being done.

**Facts checked against the official sources (2026-10-01) before implementation:**
- [revision history](https://developers.google.com/youtube/v3/revision_history), 2026-06-01:
  `search.list`/`videos.insert` moved to separate buckets.
- Same page, 2026-06-03: `videos.batchGetStats` costs "1 unit in its own granular quota bucket … default quota is
  10,000 units per day". The maximum number of IDs is not documented.
- Same page, 2026-08-27: "YouTube will count public views the moment a video begins to play".
- The daily quota resets at midnight Pacific Time. This comes from third-party sources: the official quota page
  doesn't state it.

## 1. Why

The research found three facts that change what the Research module (Phase 9) can do and how it stores
data. The first two I checked myself against the official pages on 2026-10-01.

1. **The YouTube API Developer Policies limit how long we may keep competitor data.**
   [developer-policies](https://developers.google.com/youtube/terms/developer-policies), verbatim:
   - III.E.4.b says only **Authorized Data** may be kept "for as long as is necessary". That covers statistics too,
     and it means data obtained with the user's own credentials, i.e. **our own channels**.
   - III.E.4.d: "API Clients may temporarily store limited amounts of **Non-Authorized Data** for as long as is
     necessary for the purposes of the API Client but **not longer than 30 calendar days**."
   - III.E.4.h: API Clients "must not … (ii) access or use API Data to **create new or derived data or metrics**."
   - III.E.2: aggregation only across channels of the same content owner. III.E.6: no scraping.

   Phase 9 keeps watchlist snapshots of other channels long term and computes velocity, age-normalized views,
   breakouts and spikes from them. That conflicts with III.E.4.d and probably with III.E.4.h. Recorded as RISK-92.
   The whole Google project is at stake, including the live YouTube writes.
2. **The quota model has changed.** [quota page](https://developers.google.com/youtube/v3/determine_quota_cost),
   updated 2026-09-15:
   - `search.list` now has **its own bucket of 100 calls a day, at 1 unit per call**.
   - Our code still charges 100 units per search against the shared 10k pool
     (`market-intelligence/services.ts` `SEARCH_LIST_UNIT_COST`), so its budget logic is wrong.
3. **There are cheap new sources.**
   - [`videos.batchGetStats`](https://developers.google.com/youtube/v3/docs/videos/batchGetStats): 1 unit,
     no auth for public videos.
   - RSS feeds of a channel's uploads: free, no quota.
   - The Wikipedia Pageviews API: free, no ToS risk.
   - The Google Trends API: official, alpha, by application.
   - Social Blade Business API: paid. Its history is the provider's own data, not something we keep from the
     YouTube API.

The research also found: since 2026-08-27 YouTube counts a view as soon as playback starts, so any series that
crosses that date has a break. And the Trending page is gone; only the Music, Movies and Gaming charts remain.

## 2. Goal

Research stays useful and complies with the YouTube API policies. It also spends less quota and gains trend
signals from sources other than YouTube.

## 3. Decisions for the owner

- **D1: how strictly to comply for competitor data.** This is a product decision; the agent does not make it.
  - (a) **Strict, recommended.**
    - Competitor snapshots older than 30 days are deleted. A refresh is a new snapshot taken through the API.
    - Derived scores built from competitor statistics are no longer shown. Only current values, plus history
      under 30 days with the time stated (III.E.4.f).
    - Long history stays only for our own channels.
  - (b) **Strict, plus third-party history.** As (a), with a long history of competitors bought from
    Social Blade (D2) as a separate, labelled source.
  - (c) **Leave as is and accept the risk.** Not recommended: it risks the Google project and therefore all
    writes to YouTube.
- **D2: paid Social Blade?** Yes/no and a monthly budget. This is an external paid service; it is never
  enabled without an explicit "yes".
- **D3, owner actions.**
  - Apply for the Google Trends API alpha.
  - If needed, request a quota extension for `search.list`.

  Both are done from the owner's own Google account; the agent does not do them.

## 4. Slices

Everything goes on one branch, `feature/phase-13-data-sources`, with one review cycle before the merge, as
in §K.1.

| Slice | What | Depends on |
|---|---|---|
| 13.1 | **Inventory and compliance map.** Every stored kind of data that came from the API, classified as Authorized (own channels) or Non-Authorized (others), with storage location, age and derived values. Maps to III.E.4.b/c/d/f/h. Documentation and a test that every Phase 9 table is classified. | — |
| 13.2 | **Retention per D1.** Delete or refresh Non-Authorized data at 30 days. This applies to `market_channel_snapshots`, `market_video_snapshots`, discovery candidates and evidence. Removal is visible: the UI shows "kept for 30 days per YouTube policy". The deletion runs as a scheduled server job, with a backup taken before the first one. | D1, 13.1 |
| 13.3 | **Derived metrics per D1.** Remove or hide velocity, breakout and spike scores built from competitor statistics. Keep everything for our own channels. Agent tools return only what is allowed. | D1, 13.1 |
| 13.4 | **The new quota model.** Search counts against its own 100-calls bucket at 1 unit. Gateway counters and Settings show the buckets separately. Fixes `SEARCH_LIST_UNIT_COST`. | — |
| 13.5 | *(Revised by review round 1: the RSS feed is the zero-quota FALLBACK of the uploads-playlist call. As the primary source it cut coverage from 50 videos to 15. Polling our own channels via RSS was dropped as unnecessary.)* **RSS feeds for new uploads.** Watchlist channels and our own channels are polled via RSS: no quota, no key. This is a new read-gateway category (single-gateway rule, `AGENTS.md` §G). | 13.2 (data is stored under the same rules) |
| 13.6 | *(Revised: a channel normally costs 2 pool units instead of 3: uploads playlist + `channels.list`. Statistics come from `batchGetStats`, whose documented response has no title, so titles come from the playlist.)* **`videos.batchGetStats`** for video statistics snapshots. A separate bucket, in the read gateway. | 13.4 |
| 13.7 | **Break in the view-count series at 2026-08-27.** Comparisons across that date are marked, and our-channel analytics treat it as a discontinuity. | — |
| 13.8 | **Wikipedia Pageviews as a topic signal.** Each topic can be linked to Wikipedia articles, with a daily series of article views. This is our own data, not YouTube data, so long history is allowed. A new gateway category with a descriptive User-Agent. | — |
| 13.9 | **The YouTube Music chart** (`chart=mostPopular`, `videoCategoryId=10`, by region): 1 unit. A current-only view, stored under the 13.2 rules. | 13.2 |
| 13.10 | *(only if D2 = yes)* **Social Blade as a separate source.** Its own module, encrypted key, monthly budget and a "third-party" label. It is never mixed with YouTube API data in one metric. | D2 |

Gate: no slice adds scraping, the unofficial pytrends library, or undocumented endpoints such as search
suggestions (research report §5).

## 5. Acceptance criteria (stated from the policies and the research, before the code; `AGENTS.md` §L)

- **AC-P13-01:** after the job runs, no Non-Authorized snapshot older than 30 days remains. Our own channels'
  data is untouched.
- **AC-P13-02:** under D1 (a) or (b), no screen and no agent tool shows a score derived from competitor
  statistics.
- **AC-P13-03:** a search uses 1 unit of the separate search bucket and leaves the 10k pool alone. Once 100 calls
  are used, discovery refuses with a clear message.
- **AC-P13-04:** RSS detects a new upload with no YouTube API call at all.
- **AC-P13-05:** every new external source goes through its own gateway category. The inventory tests forbid a
  bypass.
- **AC-P13-06:** a comparison across 2026-08-27 is marked as a break in the series.
- **AC-P13-07:** the 13.2 deletion runs only after a backup, and only on Non-Authorized data. A test proves our
  own channels' data survives.

## 6. Not in scope

- Agent recommendations for adding channels to or removing them from the watchlist (msg 1120). This is a separate
  proposal and is waiting for the owner's answer.
- TikTok (Research API is for researchers only), X, and Spotify popularity, which was removed in 2026.
- WebSub push. It needs a public callback, which a local app does not have.
