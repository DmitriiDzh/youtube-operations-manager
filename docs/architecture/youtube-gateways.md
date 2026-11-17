> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 22. Architecture audit, 2026-10-01: documented rules that were implicit

This section comes from the independent architecture audit. The fixes are in
`docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md`. The points below are the audit's
low-severity divergences, recorded here as the actual rules rather than changed.

- **`expectedChannelId` optionality (A7).**
  - Required: `playlist_update/delete/add_videos/remove_videos` and the video-details writes.
  - Optional: `apply` and `playlist_create`. When omitted, it falls back to the stored selected
    channel (in an agent session, the bound channel).
  - Every write still passes `write-context.assertWriteChannel`: the live OAuth channel must equal
    the expected one, so the fallback fails closed rather than writing blindly.
- **"Analytics day" (A8).** YouTube Analytics reports days in Pacific time; `metricDate` is a
  Pacific calendar day.
  - `comparable-age` aligns on Pacific days.
  - The staleness / daily-collection boundary is a UTC time of a UTC day since 2026-10-13 (§14.6, "UTC times"); before, it
    used the operator's configured timezone.
  - The data-quality "too recent" cutoff (`ANALYTICS_REPORTING_LAG_DAYS`) is computed in UTC. It
    can therefore differ from a Pacific-day boundary by one day at the edges. This is acceptable
    for a "probably not yet reported" hint, but it is not an exact reporting-day computation.
- **GET routes with a local side effect (A6).**
  - `GET /api/youtube/channel-info` persists the resolved channel as the session user's selected
    channel (ADR 0004). Since BL-197 it does so from its 6 h live-channel memo too.
  - `GET /api/cloud-connection/callback` stores the Google Cloud grant: an OAuth redirect must be
    a GET.
  - Both write device-local state only, which is never part of a snapshot. They are therefore not
    behind the method-based mutation gate. The equivalent MCP/CLI selection actions are
    operator-only and gated.

## 24. Data sources and YouTube API policy compliance — Phase 13, branch `feature/phase-13-data-sources`

Plan, decisions and acceptance criteria: `docs/roadmap/plans/PHASE_13_PLAN.md`. Owner decision D1 = (a): competitor
data from the API is kept at most 30 days, and no metrics are derived from it.

- **Classification, 13.1** (`src/lib/youtube-data-policy/contracts.ts`). Every table is classified once against
  the [Developer Policies](https://developers.google.com/youtube/terms/developer-policies), and a test fails on an
  unclassified table. The classes:
  - `authorized`: our own channels (III.E.4.b/c);
  - `non_authorized`: other people's channels (III.E.4.d), with its clock column and the condition that selects
    API-sourced rows (an exact list of the sources collection writes);
  - `not_api_data`: anything that is not YouTube API data.
- **Retention, 13.2** (`purgeExpiredApiData`, `runRetentionOnce`). Revised by review round 1:
  - It runs on a dedicated connection.
  - Snapshot rows are selected by the exact API sources, not a prefix.
  - Research evidence written from the API ("Fetch public snapshot") also expires. Other evidence sources are
    free text typed by the operator and are kept.
  - For a discovery candidate the operator has decided on, the title and reason are blanked instead of the row
    being deleted. A re-seen candidate refreshes its title along with its clock.
  - In the same transaction, a device that was in sync has its sync fingerprint re-baselined by
    compare-and-set. Every computer applies the same expiry, so it is not a local change to publish.
  - Owner decisions (msg 1139):
    - **An import never brings expired rows back.** The import purges inside its own merge transaction, before
      the lineage fingerprint (`purgeExpiredApiDataWithinTransaction`).
    - **Backups are scrubbed by the same rule on every run** (`scrubBackupFile` over `backups/migrations/*.db`,
      with `secure_delete`, then a best-effort VACUUM). Files are not deleted.
    - **Device sync removes this device's own sync-folder snapshots older than 30 days on every tick**, except
      the lineage head.
  - Reads (`listMarket*SnapshotsByChannel`, `listResearchEvidenceByChannel`, discovery candidates in
    `market-intelligence`) hide or redact expired API rows even before the purge has run. An MCP start runs the purge once. The AI decision engine's evidence descriptions carry no
    competitor values.
  - What is deleted: API-sourced rows of `non_authorized` tables older than 30 days, plus the market assignments
    pointing at deleted discovery candidates. Manual observations are kept. It runs in one transaction.
  - When: from `src/instrumentation.ts`, a minute after boot and then every 6 h. It is skipped under the operation
    lock or in recovery mode. The check is repeated inside the purge's own write transaction, so an
    export/import/migration that started first pauses it.
  - Backup: a full backup (`backups/migrations/pre-api-retention-*.db`) is taken before the very first purge.
  - Refresh: re-fetching through the daily collection is what keeps current values (a new row starts a new 30
    days).
- **No derived metrics, 13.3.** In `market-intelligence`, velocity, breakout and emerging-channel values built
  from watchlist snapshots are withheld. The fields stay in the responses, as part of the agent contract, but
  carry no value: velocity has `basis: "withheld_by_policy"`, breakout lists are empty, and `emergingChannel` gives
  a reason that cites III.E.4.h. The raw observations, each with its time (III.E.4.f), are still returned. The pure
  functions in `derived-metrics.ts` and `historical-intelligence.ts` remain for our own channels.
- **Quota model, 13.4** (`src/lib/youtube-quota`, a pure leaf).
  - The quota day starts at midnight Pacific time.
  - `search.list` has its own bucket of 100 calls a day at 1 unit, counted by `countMarketDiscoverySearchesSince`
    (one discovery-run row equals one call).
  - The shared unit budget (`getMarketIntelligenceUnitsSpentSince`) counts collection runs only.
- **Collection sources, 13.5/13.6, as revised by review round 1.**
  - Ids, titles and publish times come from the uploads playlist's first page: 1 pool unit, up to 50 videos.
  - The RSS feed (`youtube-read-gateway/feed.ts`, the newest ~15, no quota, with its own toggle and counter) is
    only the fallback when that call fails, for example when the pool is exhausted.
  - Statistics come from `videos.batchGetStats`, 1 unit of its own bucket. Its documented response carries only
    `snippet.publishTime`, no title. `videos.list` (1 pool unit) is the fallback.
  - A channel normally costs 2 pool units. The worst case, 3, is unchanged, and so is the budget pre-commit.
  - A test pins every snapshot `source` collection writes to the purge's exact API-source list.
- **View-counting break, 13.7.** `YOUTUBE_VIEW_COUNTING_CHANGED_ON = "2026-08-27"` (Data API revision history).
  The channel overview returns `viewCountingChangeInComparison`, and the UI warns that the views delta is not
  like-for-like.
- **Wikipedia interest, 13.8.** Wikimedia data is CC0, not YouTube data, so it can be kept and summarized.
  - `src/lib/wikipedia-gateway` is the only path to the Wikimedia Pageviews API. It has a toggle, the
    `wikipedia_reads` counter and a descriptive User-Agent, and an inventory test enforces it.
  - `src/lib/wikipedia-signals` is its own module (§M). It links articles to topics, using a foreign key onto
    `market_topics` with ON DELETE CASCADE as the existence check, so it never reads market-intelligence tables.
  - It collects only the missing days, up to yesterday and at most 90 days back, every 6 h, and shows 30-day sums.
  - Schema v37: `topic_wikipedia_articles` travels with handoff; `wikipedia_pageviews_daily` is a device-local
    cache.
- **Music chart, 13.9.** `chart=mostPopular`, `videoCategoryId=10`, by region, at 1 unit. It is current-only: an
  in-memory cache for 30 minutes, never persisted.
- **Not exposed to agents yet:** the Wikipedia signals and the Music chart. That depends on the separate
  agent-recommendations proposal.

