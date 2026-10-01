# 0014. The YouTube Reporting API is a read-gateway child; creating a reporting job is not a YouTube write

- **Status:** Accepted, 2026-10-01.
- **Decided by:** the project owner (chat), BL-114. Extends `0007-youtube-read-gateway.md` (a new category
  child) and applies the boundary of `0005-youtube-write-gateway.md` (what counts as a write).

## Context

Thumbnail impressions and click-through rate are not available from the YouTube Analytics `reports.query`
endpoint the app already uses (live-verified, `src/lib/analytics/contracts.ts`). They exist only in the
YouTube Reporting API v1's Reach reports (`channel_reach_basic_a1`, `channel_reach_combined_a1`), a bulk
mechanism: the app creates a **job** for a report type, Google then generates one file per day, and the app
downloads the files.

Two questions needed an owner decision:

1. `jobs.create` / `jobs.delete` change state on Google's side. Does that make them a "write" that must go
   through `youtube-write-gateway` and Live writes (`AGENTS.md` §G)?
2. Where does the new API live, and under which toggle?

## Decision

- **A reporting job is not a YouTube write.** It is a data-collection subscription held by Google for the
  operator's own credentials. It changes nothing on the channel (metadata, playlists, privacy, localizations,
  captions). The write gateway's scope remains "mutates the channel's content".
- `src/lib/youtube-read-gateway/reporting-api.ts` is the third `googleapis`-backed child (after `data-api.ts`
  and `analytics-api.ts`), re-exported from the barrel. It owns every call: `reportTypes.list`, `jobs.list`,
  `jobs.create`, `jobs.reports.list` and the report-file download.
- It has its own **"Reporting reads"** toggle (`getReportingReadsEnabled`, on by default, persistent) and its own
  traffic category `reporting_reads`, checked in the client constructor (`createYoutubeReportingClient`) like the
  other categories. Live writes plays no part. It is a separate toggle from Analytics reads because it is a
  different Google API product with its own quota and failure modes (§G: one toggle per category).
- Job creation is **idempotent** (`ensureReportingJob`): an existing job for the report type is reused, never
  duplicated, because each job is a separate daily file stream.
- A report file is downloaded only from `https://youtubereporting.googleapis.com`; the operator's bearer token is
  never sent to any other host, because `downloadUrl` is taken from an API response.
- Scope is `yt-analytics.readonly`, already requested for Analytics (no new consent expected; confirmed against the
  live API, see BL-114).

## Consequences

- `read-gateway-inventory.test.ts` already covers this child (any runtime `googleapis` import outside the two
  gateways fails).
- `youtube-write-gateway/gateway-inventory.test.ts`'s write-call pattern does not list a `jobs` resource, and is
  deliberately not extended: this decision is that `jobs.create` is not a channel write. If a future Reporting
  call ever mutates channel content, it must go through the write gateway.
- Data kept from these reports is the operator's own channel's analytics: Authorized Data under YouTube API
  Services Developer Policies III.E.4.b ("Reporting API data ... for as long as is necessary"), see
  `src/lib/youtube-data-policy`.
- First files appear up to 48 hours after the job is created; Google backfills 30 days before creation, and keeps
  files 30 days (backfill) / 60 days (regular). The app must persist what it downloads.
