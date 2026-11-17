> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 14. Phase 8 (Intelligence Foundation) — foundation + 4 follow-up slices, all merged

### 14.1 Status

Assigned 2026-09-22 (Telegram, project owner: "Приступить к полной реализации фазы 8"). The
original foundation work landed on `feature/phase-8-intelligence-foundation`, merged into `dev` in
`6f75ccf` (owner approval per `AGENTS.md` §K.2) — see `docs/ROADMAP_STATUS.md`'s BL-055..BL-059
rows for the full merge history; this subsection's own wording below predates that merge and is
kept for its historical detail, not as a claim about current branch state. `docs/roadmap/plans/PHASE_8_PLAN.md`
§6 slice 2
(the additive `video_metrics_daily` table + tests) is implemented and reviewed. The owner answered
§8's two required decisions on 2026-09-22 (Telegram msg 356, recorded verbatim in the plan's §10):
OAuth scope approved, and metric scope widened to every metric `yt-analytics.readonly` covers (not
`views` alone) — see §14.2 below for the schema consequence.

**All four slices are now implemented:** slice 1 (OAuth scope, BL-056) — `YOUTUBE_ANALYTICS_READ_SCOPE`
added to `src/lib/auth.ts`'s `YOUTUBE_SCOPES`, no separate re-consent mechanism needed (every
sign-in path already forces full consent, `docs/SYSTEM_MAP.md` §2.1); slice 2 (table, BL-055);
slice 3 (Analytics adapter + domain module, BL-057) — `collectMetrics`/`listMetrics`, tested
against mocked HTTP, but the per-video query shape (one call per video vs. a hypothetical bulk
query) remains unconfirmed against a real API response, since that needs the owner's own
re-consent to test; slice 4 (manual "collect now" trigger + Web UI, BL-058). A fifth item, BL-059
(daily staleness-based auto-collection + a configurable local sync-time/timezone setting,
superseding the plan's original "no scheduling" boundary, plan §10 items 3-4), is also done —
see §14.6.

**Live-verified against the real "Tropico Jazz" channel** (`claude-in-chrome`, 2026-09-22, twice):
the manual trigger correctly reaches and fails at `AUTH_SCOPE_INSUFFICIENT` (the real stored token
predates BL-056's scope); the dashboard-mount auto-collect effect (BL-059) correctly fires once,
reaches the same point, and — per its own documented mark-then-run tradeoff — marks
`analyticsLastAutoCollectedAt` even though the underlying collection failed. That real timestamp
was reset back to `NULL` on the real channel after verification (a throwaway script, not
committed) specifically so the owner's own first post-re-consent dashboard load is not skipped
until the next day's boundary. Zero console errors across both verification passes.

### 14.2 Schema (additive, `SCHEMA_MIGRATIONS` versions 8-9)

```text
video_metrics_daily (new, v8) — channelId, videoId, metricDate (ISO date), metricName (e.g. "views"),
                                 metricValue (REAL), collectedAt
                                 PRIMARY KEY (videoId, metricDate, metricName)
                                 + index on channelId
channels.analytics_last_auto_collected_at (new column, v9) — nullable timestamp, BL-059's
                                 per-channel "when did the daily auto-collection last actually
                                 run" marker
```

`channels.analyticsLastAutoCollectedAt` mirrors the existing `lastSyncedAt` column's own shape
exactly (same table, same nullable-timestamp pattern) — deliberately NOT derived from
`MAX(video_metrics_daily.collected_at)`, since that column is a per-row last-*write* time: a
manual re-collection of an old date range would bump it without today's actual auto-collection
run ever having happened, silently defeating the staleness check's own purpose. See
`src/lib/analytics/staleness.ts`'s own doc comment and §14.6 below.

No `videos`/`channels` schema change — this is a purely additive new table alongside the existing
"current snapshot" `videos` table, storing a time-series `videos` was never meant to hold.
`channelId` is stored directly on the row (per `docs/PROJECT_SPEC.md` §33's canonical
`channelId`/`videoId`/`date` linkage) rather than requiring a join through `videos` to scope a
query to a channel, and stays a plain, non-FK column (denormalized convenience only, never an
identity/authorization boundary — `write-context.assertWriteChannel` remains that).

**`videoId` has a foreign key on `videos.id`**, matching `PHASE_8_PLAN.md` §5's own DDL exactly.
An earlier draft of this section claimed "deliberately no foreign key," following the
`video_edit_audit_events` precedent (§13; this database defaults to `foreign_keys=ON`,
`docs/TECHNICAL_DEBT.md` RISK-33) and reasoning that an FK here would add a new table-ordering
constraint to `applySnapshotToDatabase`/`scrubDatabaseCopy` (`src/lib/snapshot/`). An independent
review caught that this doesn't survive reading those two functions: both already wrap their
*entire* drop/replace sequence in `PRAGMA foreign_keys = OFF` ... `ON` regardless of any
relationship, so an FK here adds no new ordering constraint to either. Unlike
`video_edit_audit_events` (an audit trail that must genuinely outlive the row it describes), this
table has no such requirement, so there was no remaining reason to deviate from the plan's own
explicit schema — corrected in `src/lib/db.ts` and here.

### 14.3 Persistence access (`src/lib/db.ts`, additive)

```text
upsertVideoMetric(input)          — insert-or-update by the table's own primary key; re-collecting
                                     an already-collected date overwrites metricValue/collectedAt,
                                     never creates a duplicate row (tested against real SQLite)
listVideoMetricsByVideo(videoId)  — full metric history for one video
```

`src/lib/analytics/adapters/store.ts` now wraps both (§14.4) — no longer a bare `db.test.ts`-only
pair.

### 14.4 Analytics domain module (`src/lib/analytics/`)

Follows the standard `contracts/schemas/services/adapters/index` layering (§6.2). One operation,
`collectMetrics({credentialRef, channelId, startDate, endDate, metricNames?})`: for every video
`videoStore.listVideosByChannel(channelId)` returns, calls the low-level
`queryVideoAnalyticsReport` (§14 area / `src/lib/youtube-read-gateway/analytics-api.ts`) once and upserts every
returned `(date, metric)` pair via `upsertVideoMetric`. `metricNames` defaults to
`ANALYTICS_METRIC_NAMES` (the full non-monetary list, `PHASE_8_PLAN.md` §10 item 2) when omitted.

Channel-context validation mirrors `channel-sync/services.ts`'s `listSyncedVideos` exactly: since
this service already receives `credentialRef`, it calls `channelAccess.assertActiveChannel`
itself (once, here) rather than deferring to a future route — a future BL-058 route must not add
a second check. A video genuinely belonging to a different channel can never be reached through a
given `channelId` by construction (`listVideosByChannel(channelId)` only returns that channel's
own rows), proven by an explicit cross-channel test (`services.test.ts`) rather than left as an
inferred property.

One video's Analytics call throwing is isolated into `skippedVideoIds` (logged), never failing the
whole channel's run — mirrors `change-drafts-sync`'s per-peer isolation. `upsertsIssued` counts
upsert *attempts*, not distinct new rows — re-collecting an already-collected range reports a
nonzero count even though the underlying rows were only overwritten, not created (see the field's
own doc comment in `contracts.ts`). A metric absent/non-finite in a given API response row is
silently omitted from that row's upserts, never defaulted to `0` (matches `videos.viewCount`'s
existing nullable-never-zeroed convention, §2.7).

An automated `write-path-inventory.test.ts` (mirroring `ai-localization`'s) proves no file in this
module references any `videos`/`channels`-mutating `db.ts` function or any
`youtube-write-gateway` symbol — the plan's §7 "never writes to videos/channels" acceptance
criterion as a structural, automated check, not an inference from the dependency-injection shape
alone.

`credentialRef` shapes with no `userId` (e.g. a hypothetical future CLI caller passing raw tokens)
can never pass `assertActiveChannel` and so can never use this service — documented as a known
constraint in the function's own doc comment, not a bug.

A second read-only operation, `listMetrics({credentialRef, channelId})`, returns every already-
collected `(videoId, metricDate, metricName, metricValue)` row for the channel (via a new
`listVideoMetricsByChannel` in `db.ts`, mirroring `listVideoMetricsByVideo`'s own shape) — pure
local read, no `authResolver`/YouTube call, same active-channel check as `collectMetrics`.

### 14.5 Manual "collect now" trigger + Web UI (BL-058) — **IMPLEMENTED**

`POST /api/channels/[channelId]/analytics/collect` (real local-state mutation — writes
`video_metrics_daily` rows — gated normally by `src/proxy.ts`'s blanket device-availability check,
deliberately NOT added to its read-only exemption list) and `GET /api/channels/[channelId]/analytics`
(pure read, ungated) call `collectMetrics`/`listMetrics` directly. Neither route calls
`channelAccess.assertActiveChannel` itself — both services already do, mirroring
`channel-sync`'s own `videos/route.ts`, not `ai-localization`'s routes (whose services don't
receive `credentialRef` the same way).

Web UI: `src/components/analytics-manager.tsx`, replacing the Studio-parity S6-stub "coming soon"
placeholder in the Analytics tab (`docs/roadmap/BACKLOG.md` BL-017). A date-range form (local-date
defaults, ending *yesterday* — the Analytics API's own documented behavior is that a `day`-dimension
query never returns the most recent day(s) yet, so defaulting to "today" would look like a silent
partial failure) plus a "Collect now" button, and a paginated read-only table of whatever
`GET .../analytics` returns (no video-title join — this component only knows about metrics, video
metadata display stays `content-manager.tsx`'s concern).

**Live-verified against the real "Tropico Jazz" channel (2026-09-22, `claude-in-chrome`):** the
tab resolves the active channel and loads its (empty) collected-metrics table correctly; clicking
"Collect now" exercises the real chain (session → active-channel check → credential resolution →
scope check) end to end and correctly fails with `AUTH_SCOPE_INSUFFICIENT` — the real stored
token predates BL-056's scope addition, so this is exactly the expected, correct outcome pending
the owner's own re-consent, not a bug. Zero console errors throughout.

### 14.6 Daily staleness-based auto-collection (BL-059) — **IMPLEMENTED**

The owner's own rule, verbatim (Telegram msg 356, items 3-6): a daily check "при входе в наш
дашборд" (on entering the dashboard), comparing "now" against a **wall-clock local boundary**
(e.g. 12:05), not an elapsed-duration window — a run at 11:59 local today is still stale, a run at
12:06 local today is fresh. This app has no background daemon/cron separate from the Next.js
server process, so the check runs once per dashboard mount
(`src/app/dashboard/page.tsx`'s `autoCollectTriggeredRef`-guarded effect, independent of which tab
is active), not on a repeating interval — reusing the same "check once per mount, not a
continuous poll" discipline `content-manager.tsx`'s own `AUTO_RESYNC_STALENESS_MS` pattern
already established, generalized from "20 minutes" to "once a day."

**`src/lib/analytics/staleness.ts`** (pure, no I/O): `isAnalyticsCollectionStale` formats both
"now" and the last-collected instant into the target IANA timezone's own local calendar
date + time strings (one `Intl.DateTimeFormat` each) and compares those strings — deliberately
NOT an offset-arithmetic instant conversion (`Date.UTC` + `formatToParts` + diff-correction),
which is unnecessary for a pure comparison and easy to get subtly wrong. `Intl` already applies
the zone's real DST rules to each instant independently, proven by a dedicated test that gets a
*different* result for the same wall-clock UTC hour in January (EST) vs. July (EDT) for
`America/New_York` — the owner's own "зимнее/летнее время" concern, verified, not assumed.
`computeDefaultAutoCollectionRange` (same file) picks the unattended run's date range — 7 days,
ending yesterday, matching the manual UI's own default (`AUTO_COLLECTION_RANGE_DAYS`,
`contracts.ts`) — via pure calendar-day arithmetic on the zone's own Y-M-D components, so it has
no DST edge case to reason about (a calendar day is a calendar day in every zone).

**Settings:** two new `app_settings` keys (reusing the existing key/value table, `docs/SYSTEM_MAP.md`
§2.9f, not a new table) — `analytics_sync_local_time` (default `"12:05"`) and
`analytics_sync_timezone` (default: this machine's own OS timezone, detected via
`Intl.DateTimeFormat().resolvedOptions().timeZone` the first time it's ever read, then persisted —
never re-detected on a later read, so an explicit owner override is never silently clobbered;
safe specifically because this app's server and the operator's browser are the same machine, the
established "local-first single-operator tool" model). Both are validated at the `/api/settings`
write boundary (`isValidLocalTimeOfDay`/`isValidIanaTimezone`) rather than letting a bad value
throw inside the staleness check on a later dashboard load. UI: `src/components/analytics-sync-settings.tsx`
(Settings tab) — plain text/time inputs, not `ToggleSwitch` (these aren't booleans).

**UTC times (2026-10-13, owner, Telegram msgs 2725/2727).** The two collection times are now set in UTC, with the owner's own
time shown in parentheses for the date (summer or winter), the same rule as the channel publish time (BL-182). Keys
`analytics_sync_utc_time` and `analytics_evening_utc_time`; the analytics adapter hands the services `timezone: "UTC"`, so every
boundary above (staleness, the evening window, the weekly report, the "yesterday" of the auto-collection range) is computed in
UTC while the services themselves stay zone-generic. A computer that has only the legacy local keys converts them (or the old
defaults 12:05 / 22:05 local) on first read with the zone's offset on 2026-10-13, not on the conversion day, so two computers
updated on either side of a DST change get the same UTC times (Helsinki: 09:05 and 19:05; after 25.10 that is 11:05 and 21:05
local). `analytics_sync_timezone` stays as the owner's own zone (`userTimezone` in `/api/settings`): the parentheses and the quota
reset time use it. The zone helpers live in `src/lib/zoned-time/`; the field is `src/components/utc-time-field.tsx`.

**Concurrency (advisor review):** `runAutoCollectionIfStale` marks
`channels.analyticsLastAutoCollectedAt` **before** calling `collectMetrics`, not after. Two
browser tabs mounting the dashboard at the same moment would otherwise both see "stale" and both
run a full per-video collection, doubling real Analytics API quota for no benefit — marking first
means the second caller sees fresh and no-ops (proven by a dedicated test simulating two
sequential calls at the same instant). The accepted tradeoff: if the collection itself then fails
or crashes mid-run, today's window is still marked "collected" and won't retry until tomorrow's
boundary — judged the better failure mode than doubling quota on every multi-tab load.

**Every connected channel (BL-142, 2026-10-06, owner msgs 1867/1868/1874).** The dashboard no longer calls the
per-channel `auto-collect` and `weekly-reports/generate-if-due` routes; once per load (after the active channel is
resolved) it calls `POST /api/analytics/auto-collect-all` (`src/lib/analytics/auto-collect-all.ts`), then the Research
`collect-if-stale` as before. The session's active channel is collected with the session's credentials while the
dashboard waits; every other channel runs after the response, one after another, with its own `connected_user_id`,
through the quota-guarded `runAutoCollectionIfStale` (BL-117 reserve and quota attribution apply), and its
`assertActiveChannel` still fails closed for a user who has another channel selected. Per channel the weekly report runs
after the collection, also when it failed. Note that `collectMetrics` marks a channel collected only after a
**successful** run, so nothing in it throttles a failure: a failing background channel is held back for 6 hours by an
in-process backoff (`channel-fanout`), the active channel is retried at once as before. One all-channels run at a time
per process. The BL-118 catch-up of every channel with a gap runs after the background part; a channel whose collection
just failed is not planned. Reasons a background channel was not collected are logged (no persisted record). The
response shows only the active channel (ADR 0004). Shared rules with BL-141 live in `src/lib/channel-fanout/`
(credential choice, error code, backoff, channel list). Cross-account token use: RISK-112. The per-channel routes remain.

**A reload that finds nothing due (BL-196, `docs/roadmap/plans/FAST_STARTUP_PLAN.md`).** `runAutoCollectionIfStale` applies the
freshness gate first. The gate is `freshnessGate`, moved out of `collectMetrics` unchanged. The quota reserve (`beforeCollect` from
`index.ts`) is asked only for a due collection, because it costs 8 Cloud Monitoring calls. `collectMetrics` still applies the gate
itself, so a racing second tab stays safe. `auto-collect-all` first asks `isAutoCollectionCurrent`, which only reads. When the
active channel is current, the route answers at once. The other computer's import, the active channel's weekly report and catch-up
plan, and every other channel then run in `after()`, in the same order as a collecting load. A failing check falls back to the full
path. The research `collect-if-stale` and the automatic `reach/sync-all` likewise return before device sync and the peers' import
when their own read-only due checks (`countResearchChannelsDueForCollection`, `isAnyReachSyncDue`) find nothing.

**Screens answer from stored data (BL-197, owner Telegram 2026-10-18).** The dashboard's own reads no longer spend quota on data the
app already holds:
- The header's `channel-info` reads `channels.list mine` once per signed-in identity and then answers for 6 h from an in-process memo
  (`channel-access/live-channel-memo.ts`). Only a live answer is stored, so the channel it names is still what that identity's grant
  resolved. The memo is cleared by a Google sign-in, by a disconnect and by a restart. Each answer still activates the channel
  (ADR 0004). Grant liveness is checked by `channel-connections/health` (no quota).
- The switcher's automatic sync (`onlyIfStale`) is skipped only while the channel this process last read live for the identity
  (the header memo, never the stored selection, which may still name the previous channel right after a sign-in) has a copy owned
  by this identity at most 6 h old (`channel-sync/freshness.ts`, the same window as `publishing/refresh-stale`).
- Home's summary uses `preferLocal`. Traffic-source and device cards (and the MCP `agent_query_channel_breakdown`) are summed from
  `analytics_breakdown_daily` when the stored range covers the period by `isRangeFullyCovered` (`answerChannelBreakdownFromStore`);
  like the stored totals, the lag days count with what is stored. Any failure of that path falls back to the live read.
- The Web UI playlist pickers use a 1 h per-identity memo, which any playlist change made through the core, a Google sign-in and a
  disconnect clear; agents and the CLI read live. Both memos use `src/lib/user-ttl-memo/`, whose forget counter keeps a read that
  started before a forget from storing its older answer.

**`GET /api/settings` is not purely read-only**: `getUserTimezone`'s detect-and-persist behavior means a plain `GET` can write
the OS-detected timezone on first read, and `getAnalyticsCollectionTimes` saves the UTC times converted from the legacy local
ones (stated in that route's own doc comment, not left as a surprise).

**Live-verified against the real "Tropico Jazz" channel (2026-09-22, `claude-in-chrome`):** the
dashboard-mount effect fires exactly once and reaches the real `runAutoCollectionIfStale` →
`collectMetrics` chain, correctly failing at `AUTH_SCOPE_INSUFFICIENT` for the same
not-yet-re-consented reason as §14.5's manual trigger. Confirmed directly against the real
database that this **did** mark `analyticsLastAutoCollectedAt` despite the underlying collection
failing — exactly the documented mark-then-run tradeoff, not a bug — and then reset that column
back to `NULL` on the real channel afterward (a throwaway, uncommitted script) so the owner's own
first post-re-consent dashboard load is not skipped until the next day's boundary. Separately
confirmed the real machine's OS timezone (`Europe/Helsinki`) was correctly auto-detected and
persisted to `app_settings` on the first `GET /api/settings` call. Zero console errors.

**Build-time note, observed not introduced:** `npm run build`'s "Collecting page data" step
occasionally logs a `SQLITE_BUSY: database is locked` (or, once, a stale-schema-version rejection
from a leftover local DB state during this session's own testing) from one of several parallel
build workers racing to initialize the same real local database file — confirmed present on a
clean pre-BL-059 tree too (`git stash -u` + rebuild), so this is a pre-existing characteristic of
this dev environment's multi-worker build touching a real, singleton-guarded database file, not a
regression from this slice. Build exit code is unaffected (0) both with and without BL-059.

### 14.7 Known limitations

No Analytics API client, no OAuth scope request, no route, no UI — this slice is the persistence
primitive only, exactly `PHASE_8_PLAN.md` §6 slice 2's scope, deliberately not a vertical slice
end-to-end. See `docs/roadmap/BACKLOG.md` BL-056/BL-057/BL-058/BL-059 for the current status of
the remaining slices.

`metricValue` is `REAL NOT NULL` (changed 2026-09-22, before this table ever merged to `dev` —
`docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 2). The plan's original DDL had it as `INTEGER`,
correct for `views` alone; once the owner authorized collecting every metric
`yt-analytics.readonly` covers, several of those (e.g. `averageViewPercentage`,
`annotationClickThroughRate`) are inherently fractional, so the column was widened to `REAL`
(exact for both integer counts and fractional rates) rather than adding a second,
metric-type-dependent column. Because this happened before the table shipped anywhere, no ADR was
needed (`docs/decisions/0001-additive-idempotent-schema-strategy.md`'s "non-additive change" gate
applies to a change against an already-released schema, not an in-progress, unmerged one) — any
*future* change to this column's type would need one.

**BL-151 (2026-10-07, §31):** these rows (and the reach rows) now travel between devices through their own per-device day
files, `src/lib/analytics-data-sync/`, not through the snapshot. The paragraph below still holds for the snapshot itself.

`video_metrics_daily` is **deliberately not added to `SNAPSHOT_TRANSFERRED_TABLES`**
(`src/lib/snapshot/contracts.ts`) in this slice — collected metrics stay device-local and do not
travel with a device handoff/snapshot import. Accepted limitation, parallel in kind to RISK-33's
own `rules.user_id` orphan case: a snapshot-import replace of `videos` (`SNAPSHOT_REPLACE_ON_IMPORT_TABLES`
already includes `videos`) can leave a local `video_metrics_daily` row referencing a `videoId` no
longer present in the receiving device's `videos` table after import — this never crashes (FK
enforcement is disabled for that entire operation, same as every other table it processes), it
just leaves a stale row. `docs/PROJECT_SPEC.md` §33 frames this data as the future basis for real
recommendations, so unlike `video_edit_audit_events` (a local audit trail with no such framing),
losing collected history silently on every handoff is worth flagging explicitly rather than
letting it repeat as an unstated gap — revisit whether this table should join
`SNAPSHOT_TRANSFERRED_TABLES` once real collection (slice 3+) makes the data worth carrying
across devices.

### 14.8 Channel-level Analytics reads for Studio-Parity S6b (`getChannelOverview`) — **IMPLEMENTED**

Every read documented above (§14.1-§14.7) is per-video: one `reports.query` call per synced
video, `filters=video==<id>`. Studio's own Analytics "Overview" tab (BL-072,
`docs/roadmap/plans/STUDIO_PARITY_PLAN.md` §4 Slice S6b) needs channel-level totals instead —
summing per-video rows would silently miss any activity not attributable to a currently-synced
video (a deleted video, or subscribers gained from the channel page itself), the same class of
undercounting problem RISK-33-style orphan rows already illustrate elsewhere in this document.

A throwaway diagnostic route (never committed, same technique BL-057 used) confirmed live against
a real channel that dropping `filters=video==...` entirely — `ids=channel==<id>`,
`dimensions=day`, no filter — is accepted by the real API and returns genuine per-day channel
totals. This is a *different* report shape from the one BL-057 already ruled out (a bulk
`dimensions=video,day` query across every video with no filter, which the API rejects outright) —
dropping the dimension, not just the filter, is what makes the difference. `queryChannelAnalyticsReport`
(`youtube-read-gateway/analytics-api.ts`) is this second report shape; both it and the existing
per-video report now share one response parser (`parseDayDimensionReport`) rather than duplicating
the name-based column-lookup logic.

`getChannelOverview` (`src/lib/analytics/services.ts`) is deliberately a **live read, never
persisted** — unlike `collectMetrics`, it writes nothing to `video_metrics_daily` or any new
table, and so is not subject to `collectMetrics`'s own once-a-day freshness gate (§14.6); it is
already gated by the existing per-category "Analytics reads enabled" toggle every
`createYoutubeAnalyticsClient` call goes through. It issues exactly two calls — the requested
period and the immediately-preceding period of the same length (`analytics/period.ts`'s pure
`computePreviousPeriod`) — and sums each into totals itself, rather than a third "totals only, no
dimensions" call; one report shape, two date ranges. A day the API omits from its response
contributes `0` to that sum, which is a true fact about the sum (no rows means no reported
activity), not the same "silently defaulted a missing per-day-per-metric value to 0" case
`collectMetrics`'s own doc comment warns against for raw per-row display.

Also confirmed live and worth recording here since it corrects §7 of `contracts.ts`'s own
provenance note: `impressions`/`impressionClickThroughRate` (Studio's thumbnail-impressions/CTR
widgets, both on Home and on Analytics' Content sub-tab), under those exact names, are rejected by
the real API as unknown metric identifiers. These are not the same as the `annotation*`/`card*`
legacy metrics already in `ANALYTICS_METRIC_NAMES` (dead since 2019, always zero) — they are a
structurally different capability. **Corrected 2026-09-26 (§14.12 below, found during the deep-
parity plan's own research):** the real identifiers Google actually shipped
(`videoThumbnailImpressions`/`videoThumbnailImpressionsClickThroughRate`, added 2026-01-15) *are*
recognized by the API — the 2026-09-23 rejection above was the wrong names, not a capability gap —
but they belong to a structurally different YouTube Reporting API v1 "Reach report" (a bulk,
scheduled-job system), never this ad-hoc `reports.query` endpoint, so the practical conclusion is
unchanged: no code path in this repository requests them, and none can via this endpoint regardless
of naming.

**Totals will not exactly match Studio's own displayed numbers for the same nominal date range,
and this is expected, not a bug.** Cross-checked live 2026-09-23 against the real "Rural Japan
Music" channel for the identical "Aug 26 - Sep 22" window Studio itself showed earlier the same
session: Studio displayed 2,052 views / 379.7 watch-time hours / +18 net subscribers; this
endpoint returned 1,966 / 364.1 hours / +17 for the exact same request. Inspecting the raw
response showed why: the API's `daily` rows stopped at `2026-09-20` -- no row at all for
`2026-09-21`/`2026-09-22`, even though both were inside the requested range. This is the same
reporting lag `PHASE_8_PLAN.md` §10 item 4 already documents for the per-video report (the API
does not yet report the most recent day(s) of any range) -- Studio's own internal dashboard
evidently draws from a less-lagged data source than the public Analytics API `reports.query`
exposes. Nothing here should try to "fix" this by guessing or interpolating the missing days;
`getChannelOverview` correctly sums exactly what the API has processed as of query time, and the
chart's `zeroFillDailySeries` correctly stops at the last date actually present rather than
padding through `endDate` with fabricated zeros (see its own doc comment). A future slice
re-querying a completed period after the lag has cleared would show a different, larger total for
the same historical dates -- this is inherent to using the public API, not a caching bug to chase.

### 14.9 Data-quality diagnostics (`getDataQualityReport`) — Phase 8 follow-up, slice 2 of 4

`docs/roadmap/FUTURE_PHASES.md` §4's "data-quality/missing-data diagnostics" line item. New
additive table `analytics_collection_runs` (`SCHEMA_MIGRATIONS` version 13) -- one append-only row
per `collectMetrics` invocation, recording the requested date range, video count, upserts issued,
and which video IDs were skipped due to a per-video failure.

**Why a separate history table is needed, not just a scan of `video_metrics_daily`:** live-verified
2026-09-23 against a real low-traffic video that the Analytics API silently OMITS a day from its
`reports.query` response when that video had zero activity that day -- it is never returned as a
zero-value row. An absent `video_metrics_daily` row is therefore ambiguous between "never
collected" and "collected, zero activity" without an independent record of which ranges collection
actually attempted.

`computeDataQualityReport` (`src/lib/analytics/data-quality.ts`, pure, no I/O) classifies each date
in the requested range as covered (a recorded run's own range includes it, OR at least one real
`video_metrics_daily` row exists for that date -- the latter fallback exists specifically for data
collected *before* this table existed, which would otherwise show as "never collected" purely
because the tracking mechanism postdates it), uncovered (a genuine gap), or too-recent (within
`ANALYTICS_REPORTING_LAG_DAYS` = 2 days of "now" -- the same reporting lag §14.8 documents, which
means even a requested collection wouldn't have data yet, so this is never flagged as a real gap).
Skipped-video aggregation only counts runs whose own range overlaps the requested range.

Live-verified against the real "Tropico Jazz" channel: a 28-day report correctly found only 6 of
28 days actually covered (the channel's real collected history is a narrow 6-day band, `2026-09-15`
through `2026-09-20` -- confirmed directly against `video_metrics_daily`'s own distinct dates), a
genuine, previously-invisible data gap this feature exists to surface, not a bug in the check
itself.

Exposed via `GET .../analytics/data-quality`, the MCP tool `analytics_data_quality`, and the CLI's
`analytics data-quality` command -- all three read-only, ungated, following the same pattern as
`analytics_list`/`analytics_overview` (BL-073). `analytics_collection_runs` is deliberately kept
out of `SNAPSHOT_TRANSFERRED_TABLES`, the same as `video_metrics_daily` itself (§14.7) -- a
re-derivable, device-local history, not data that needs to survive a device handoff.

**BL-181 (FO-REQ-0020 §2.4, schema v87).** A run also records `newest_video_date` / `newest_channel_date`: the newest date the
API actually returned (the maximum over every video's rows, and over the channel totals). The requested range says what was
asked; these columns say what came back. The report gives the latest run's dates as `newestReturned`. "Too recent" stays
clock-based (now minus 2 days): the new dates measure the lag, they do not redefine coverage. The columns are device-local:
the cross-computer analytics file carries runs by an explicit field list (unchanged), so a peer on an older build is
unaffected, and runs imported from a peer have no dates.

### 14.10 Comparable-age video comparison (`getComparableAgeComparison`) — Phase 8 follow-up, slice 3 of 4

`docs/roadmap/FUTURE_PHASES.md` §4's "comparing videos at comparable ages" line item. Given 2-10
`videoIds` on the same channel, aligns each video's already-collected `video_metrics_daily` rows by
**days since publish** rather than calendar date, so videos published on different dates can be
compared at the same point in their own lifecycle (mirroring YouTube Studio's own "Compare videos"
growth-curve feature).

**Pacific-Time day alignment (`src/lib/analytics/comparable-age.ts`, pure, no I/O):**
`video_metrics_daily.metricDate` is the Analytics API's own `day` dimension, a Pacific-Time
calendar day (§14.7/`youtube-read-gateway/analytics-api.ts`). `videos.publishedAt` is a UTC instant
from the Data API. Day 0 of a video's life is therefore its **Pacific-Time** calendar date of
`publishedAt` (`toPacificCalendarDate`, via `Intl.DateTimeFormat` with `timeZone:
"America/Los_Angeles"`), never the UTC calendar date -- a video published shortly after UTC
midnight can otherwise land a full day off relative to every other video it's compared against. Day
offsets are a pure calendar-day diff of two `YYYY-MM-DD` strings via `Date.UTC` (`diffCalendarDays`,
mirroring `period.ts`'s own DST-safe convention), never a raw millisecond subtraction. Day 0 is
necessarily a **partial day** (the hours before publication aren't part of the video's life, but
the Analytics API only reports whole-day totals) -- the same approximation Studio's own feature
makes.

**Only additive metrics are offered for comparison.** `CUMULATIVE_COMPARISON_METRIC_NAMES` is an
explicit allowlist (views, likes, estimatedMinutesWatched, subscribersGained, etc.) excluding every
ratio/average entry in `ANALYTICS_METRIC_NAMES` (`averageViewDuration`,
`annotationClickThroughRate`, etc.) -- summing a ratio across days produces a meaningless number.
Requesting a non-additive metric is rejected as `validation_failed`.

**A missing day is "unknown," never a fabricated zero, and this slice deliberately does NOT reuse
`analytics_collection_runs`'s channel-level coverage to infer "known zero."** §14.9 already
established that `analytics_collection_runs` records which channel-wide date *ranges* were
attempted, not which specific videos a given past run actually queried -- a video published after
an older run's own snapshot of `videos` was never attempted by it, and there is no historical record
of channel membership to check against. Given that unresolved ambiguity, a real `video_metrics_daily`
row is the only fact this module treats as "known"; every other day-offset is "unknown." This means:
raw `points` never include a fabricated zero, and the running `cumulativePoints` total stops dead at
the last contiguous known day from day 0 (never skips a gap and keeps summing past it). This is the
same "a materially larger data model than this diagnostic's actual purpose justifies as a first
slice" tradeoff §14.9 already accepted for its own, narrower scope -- a more precise model would need
an additive `analytics_collection_runs.queriedVideoIdsJson` column and is left as a future follow-up,
not attempted here.

**Real-data caveat, confirmed by directly querying two real channels' `video_metrics_daily` before
designing this feature's response shape:** the daily auto-collection window only covers the most
recent ~7 calendar days per run (§14.6), not "the video's first 7 days since publish." For a video
published more than about a week before regular collection started for its channel, `points` will
typically have no entries for low day-offsets (0-7) specifically, and `cumulativePoints` will
typically be empty entirely (it always starts from day 0, so a missing day 0 halts it before it
starts) -- not a bug, a genuine, expected data-coverage gap. `points` for that same video may still
be non-empty overall if the rolling collection window happened to cover some LATER day-offset --
an empty `cumulativePoints` does not imply an empty `points`. On the two real channels used to validate this feature ("Rural Japan
Music", "Tropico Jazz"), this happens to be a much smaller problem than it first appears, because
both channels upload frequently enough that the rolling 7-day window naturally overlaps most recent
videos' own early days -- but a video from more than ~1-2 weeks ago will still show sparse or empty
low-day-offset data until a manual historical backfill is run for it specifically. No backfill
mechanism was added by this slice -- widening `AUTO_COLLECTION_RANGE_DAYS` or adding a backfill path
was explicitly out of scope: the once-a-day freshness gate (§14.6) is the owner's own explicit rule
("ни человеку, ни агенту, ни каким-то скриптам") and is not something this slice may work around.

**No ranking, no "outperforming" language, no headline verdict** -- `docs/roadmap/FUTURE_PHASES.md`
§4's own constraint ("distinguish observed facts from interpretations... avoid unsupported
conclusions from small samples"). The response is the same raw per-video series for every caller,
human or agent, to draw its own conclusion from.

Every requested `videoId` is checked against `videoStore.listVideoDetailsByChannel(channelId)`
(`docs/DEVELOPMENT_PLAYBOOK.md` §6.6) -- an id that doesn't resolve to the given channel is reported
back as `validation_failed` with the offending id(s) in `details`, never silently dropped from the
comparison. Exposed via `GET .../analytics/comparable-age`, the MCP tool
`analytics_comparable_age`, and the CLI's `analytics comparable-age` command -- all three pure local
reads (never a live YouTube call), read-only, ungated, following the same pattern as
`analytics_list`/`analytics_data_quality` (unlike `analytics_overview`, which is a live, gated
Analytics API read -- see §14.8).

### 14.11 Weekly analytics reports (`runWeeklyReportIfDue`/`listWeeklyReports`/`getWeeklyReport`) — Phase 8 follow-up, slice 4 of 4

`docs/roadmap/FUTURE_PHASES.md` §4's "analytical reports and weekly channel reviews" line item --
the last of Phase 8's four follow-up slices. A frozen, reproducible snapshot per channel per
Monday-Sunday week, computed entirely from already-collected local `video_metrics_daily` rows --
**never a live YouTube API call**, matching the deliverable's own wording ("reproducible analytical
reports from stored historical data").

**Trigger (owner instruction, 2026-09-23): "Давай завяжемся на то же время что мы выбираем в
настройках -- 12-05 сейчас по понедельникам."** Reuses the exact `localTime`/`timezone` pair the
daily auto-collection boundary already reads from Settings (§14.6) -- no separate weekly-report
setting. `computeDueReportWeek` (`src/lib/analytics/weekly-report.ts`, pure, no I/O) determines the
single most recently completed week whose Monday-`localTime` boundary has passed, using the same
zoned-string-comparison technique `staleness.ts`'s `isAnalyticsCollectionStale` already uses (DST-
correct with no manual offset code). Missed weeks are never backfilled -- a long-dormant app only
ever gets the single most recently due week on its next dashboard load, the same "no backfill"
philosophy §14.10 already established for comparable-age comparisons.

**`status: "final"` vs `"provisional"` (advisor review, 2026-09-23):** the trigger boundary (Monday
12:05, the operator's own local clock) does not line up with the Analytics API's own reporting lag
(§14.8's 1-2 day lag) or with `video_metrics_daily`'s Pacific-Time day-numbering (§14.10) -- for an
operator outside Pacific Time, the just-completed week's own last day or two may genuinely not be
collected yet at the moment the trigger fires. Rather than freeze an undercounted snapshot forever,
a report is `"provisional"` whenever any date in ITS OWN week is still uncovered or too-recent
(`computeDataQualityReport`, §14.9, run against the report's own week); the next dashboard load's
trigger check regenerates (replaces) a provisional report for the same week once it clears, and
never touches an already-`"final"` row. `runWeeklyReportIfDue` (`services.ts`) does a cheap
read-before-write early exit, but the actual "never overwrite a final row" guarantee is enforced at
the DB layer, inside `db.ts`'s `upsertWeeklyReport` itself (a conditional `ON CONFLICT ... DO
UPDATE ... WHERE status != 'final'`) -- the service's own check-then-act is not atomic across two
concurrent callers (e.g. two open dashboard tabs both triggering the generate-if-due route near the
same moment), a real race an independent review found (2026-09-23) and this DB-level guard closes.

**Week-over-week `percentChange` is `null` (the whole object, not per-field) unless BOTH the
current and previous week are fully covered** -- comparing a real week against a mostly-uncollected
previous week (the exact situation the real "Tropico Jazz" channel is in today, per §14.9) would
measure collection coverage, not real change, which `FUTURE_PHASES.md` §4's own "avoid unsupported
conclusions from small samples" constraint forbids. Each week's own `currentWeekDataQuality`/
`previousWeekDataQuality` (the full `computeDataQualityReport` shape) is embedded in the stored
snapshot, so a reader can see exactly why a comparison is or isn't present.

**`syncedVideoTotals`, not "channel totals" (advisor review, 2026-09-23):** named and documented
(via `SYNCED_VIDEO_TOTALS_METRIC_DEFINITIONS`, embedded in every stored report) as a sum over
currently-synced videos' own `video_metrics_daily` rows -- the same undercounting caveat §14.8
already documents for any per-video-summed total (excludes deleted videos, and for subscriber
metrics, excludes activity not attributable to a specific video). Never presented as, or confused
with, YouTube Studio's own channel-wide subscriber count.

**Provenance, per `FUTURE_PHASES.md` §4's "clear provenance and documented metric definitions"
requirement:** every stored report embeds `reportFormatVersion`, `generatedAt`, `source` (a fixed
string stating the local-only origin), and `metricDefinitions` -- and is re-validated through
`weeklyReportContentSchema` (a strict zod schema mirroring `WeeklyReportContent` field-for-field) on
every READ, not just on write, so a corrupted or malformed stored row fails loudly
(`validation_failed`) rather than silently serving a partial report.

**Schema:** `analytics_weekly_reports` (`SCHEMA_MIGRATIONS` version 14) -- one row per
`(channel_id, week_start_date)` (`UNIQUE` index), `report_json` holding the full serialized
`WeeklyReportContent`. Deliberately kept out of `SNAPSHOT_TRANSFERRED_TABLES`, the same reasoning as
`video_metrics_daily`/`analytics_collection_runs` (§14.7/§14.9): derived, re-computable data that
never needs to travel with a device handoff.

**Trigger wiring:** `POST .../analytics/weekly-reports/generate-if-due`, called once per dashboard
mount (`src/app/dashboard/page.tsx`) chained via `.finally()` AFTER the existing auto-collect
trigger resolves -- so a Monday dashboard load's weekly snapshot sees whatever that same load's own
auto-collect just refreshed, not last week's data. Gated by `src/proxy.ts` like any other mutating
POST (a real local-persistence mutation when it decides a new/replacement snapshot is due).

**Read surfaces, all read-only, ungated, no generate-on-demand tool exposed to agents (same
exclusion reasoning as `collectMetrics`/`runAutoCollectionIfStale`, §14.5/§14.6):** `GET
.../analytics/weekly-reports` (list, newest week first), `GET
.../analytics/weekly-reports/[weekStartDate]` (one report, `{ report: null }` if none exists yet),
MCP `analytics_weekly_reports_list`/`analytics_weekly_report_get`, CLI `analytics weekly-reports`/
`analytics weekly-report-get`.

**Known, tracked duplication (`docs/TECHNICAL_DEBT.md` RISK-50):** the report's own `topContent`
ranking (group `views` by video, sum, sort, top 5) is a second implementation of the same
aggregation the client-side `use-top-videos.ts` hook already does for the Analytics
Overview/Content tabs (§14.12 below) -- not unified in this slice (see RISK-50 for why; that entry
itself needed a 2026-09-26 correction since the client-side implementation it names moved from
`channel-overview-panel.tsx`'s own inline `fetchTopContent` into that shared hook).

### 14.12 Content/Audience breakdown cards + video retention curve (deep-parity plan, BL-092..098) — **IMPLEMENTED, not yet in `dev`**

`docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md` -- extends §14.8's Overview-only Studio
parity to the Content and Audience sub-tabs, plus closes §14.8's own impressions/CTR question
(corrected above, not merely repeated).

**One new report shape, one new gateway function, reused seven ways.** Every capability this slice
adds -- traffic sources, device type, age/gender, geography, subscribed status, content format,
and the video retention curve -- shares an identical wire shape once dimension/metric names differ:
a single date range, no `day` dimension, one row per distinct dimension-value combination, an
optional `filters=video==<id>` for the one per-video case (retention). `queryChannelBreakdownReport`
(`youtube-read-gateway/analytics-api.ts`) is the single function for all seven, live-confirmed
against a real channel for each one individually before being written (not assumed from
documentation) -- the same "never trust a documented name until a real response confirms it"
discipline `CHANNEL_OVERVIEW_METRIC_NAMES`'s own doc comment (§14.8) already established, now paying
off in the other direction: all seven confirmed clean on the first live-probe attempt, no retry
needed for any of them (unlike impressions/CTR below, the one capability this research effort found
genuinely needed correcting after a wrong initial assumption).

**Two service methods, both live reads, never persisted** (same `getChannelOverview` precedent as
§14.8, not `collectMetrics`'s daily-collection model): `getChannelBreakdown` (parameterized by
`CHANNEL_BREAKDOWN_PRESETS`, `contracts.ts` -- the dimension/metric pair for each of the six
breakdown kinds) and `getVideoRetentionCurve` (the one case needing a `videoId`, which it verifies
belongs to `channelId` via `videoStore.listVideosByChannel` before querying -- the same discipline
§14.10's `getComparableAgeComparison` already uses for its own `videoIds` input).

**Impressions/CTR, corrected (see §14.8's own updated paragraph above for the full story):** the
real identifiers Google shipped 2026-01-15 are recognized by the API but belong to a structurally
different Reporting API v1 bulk-job "Reach report," never this app's ad-hoc query gateway --
confirmed by exhausting every plausible request shape against the real API (channel-level, with
`dimensions=day`, paired with `views`, filtered to one video) and getting "query not supported" for
every one once the metric name itself stopped being rejected outright. This capability is
**out of scope**, not merely unbuilt -- reaching it would need a second, structurally different
Google API integration this repository has never built (a scheduled-job model: create a job, then
poll/download generated report files, rather than a single request/response call).

**Realtime panel, also confirmed out of scope:** a direct probe for "today"/"the last 48 hours"
against the same query endpoint returned empty rows -- the documented 48-72 hour processing delay
(already the reason `computeDefaultAutoCollectionRange`, §14.6, targets "yesterday" rather than
"today") applies uniformly to both the ad-hoc query API and the bulk Reporting API. Studio's own
live-updating 48h/hourly panel and live subscriber ticker are built on infrastructure neither public
surface exposes.

**Content-format label casing, genuinely unresolved (independent review, round 1, 2026-09-26):**
this session directly observed a real API response returning `"videoOnDemand"` (lowerCamelCase) for
`creatorContentType`, but a later review round found Google's own published dimension docs state
uppercase-snake-case values (`VIDEO_ON_DEMAND`, `SHORTS`, `LIVE_STREAM`, `STORY`). A live re-probe to
settle the discrepancy hit an unrelated OAuth token-refresh failure and could not complete this
session. `breakdown-labels.ts` maps both casings rather than picking one, with the discrepancy
documented in a code comment -- treat this as open until re-probed against a real response.

**Traffic-source label accuracy (independent review, rounds 2-3, 2026-09-26):** three
`insightTrafficSourceType` labels were found copied from the enum name's own surface resemblance to
a familiar term rather than checked against Google's documented meaning -- exactly the §L failure
mode this whole plan's own research discipline was meant to avoid, caught this time by review
rather than by a live probe. `SUBSCRIBER` was labeled "Subscription feed," but Google's own docs
describe it as views referred from either the YouTube homepage feed *or* subscription features --
homepage-feed views are commonly the larger share of this bucket for many channels. `CAMPAIGN_CARD`
was labeled "Campaign card" (reading it as a UI card, by association with the unrelated legacy
`card*` end-screen metrics), but Google's docs describe it as views from a claimed, user-uploaded
video the content owner used to promote the viewed content -- a Content ID promotion mechanism, not
a literal card. `PROMOTED` was labeled "Promoted content," dropping the documented "unpaid"
qualifier that distinguishes it from `ADVERTISING` (the actual paid-promotion source) sitting right
next to it in the same list. All three corrected to match their documented scope.

### 14.13 Impressions and CTR from the YouTube Reporting API (`src/lib/reach-reports/`) — BL-114, on `feature/bl-114-reporting-api-reach`

Decision record: `docs/decisions/0014-youtube-reporting-api-gateway-child.md`.

- **Why a separate mechanism.** The Analytics `reports.query` endpoint rejects the thumbnail impressions / CTR metrics (§14.4's live probes); they exist only in the Reporting API v1's Reach reports. That API is bulk and scheduled: the app creates a **job** for a report type, Google generates one file per day, the app downloads and stores them. Google backfills 30 days before job creation, first files appear within ~48 h, backfill files expire after 30 days and regular ones after 60 -- so the app persists everything it downloads.
- **Gateway.** `youtube-read-gateway/reporting-api.ts` is the third `googleapis` child. The client constructor (`createYoutubeReportingClient`) is the single choke point for the **Reporting reads** toggle and the `reporting_reads` traffic counter. `jobs.reports` is a nested resource that the quota-classification proxy does not wrap, so each call goes through `callYoutubeApi` explicitly. A report's `downloadUrl` comes from an API response, so the download refuses any host except `youtubereporting.googleapis.com` before any credential is sent. Creating a job is **not** a YouTube write (ADR 0014): no Live writes, no write gateway.
- **Module.** `reach-reports` follows the usual layering and does not import `analytics` (AGENTS.md §M): turning Reporting off, or a failure here, never affects the Analytics tab or `agent_query_channel_analytics`.
  - `syncReachReports`: `assertActiveChannel` (fail closed, before any credential use) -> `ensureReportingJob` (reuse an existing job, never duplicate) -> list files -> skip ids already in the ledger -> process oldest `createTime` first -> per file: download, parse by header name, map, import in one transaction. One bad file lands in `failures` and is retried next time. `onlyIfDue` skips the whole run if the job was checked, or a sync attempted with outcome `ok`/`partial`, less than 6 h ago (a `failed` attempt holds the active channel for 1 h, `FAILED_ACTIVE_RETRY_AFTER_MINUTES`, BL-197: its cause is usually fixable). Every attempt after the channel check is recorded in `reporting_sync_attempts` (outcome `ok` / `partial` / `failed`, error text, failed files); a failure that stops the sync before any import is recorded and then rethrown. Failed files are deliberately **not** put in the file ledger, so they stay retryable.
  - `syncAllReachReports` (BL-141, `POST /api/reach/sync-all`, once per dashboard load after the active channel is
    resolved): every stored channel, concurrently. The session's active channel uses the session's credentials; every
    other channel goes through `syncReachReports` with its own `connected_user_id`, so its `assertActiveChannel` still
    fails closed when that user has another channel selected. For background channels a failed attempt also throttles
    (`throttleFailed`), and a "not synced" reason (no connected user, other channel selected) is written to that
    channel's `reporting_sync_attempts` row. An in-process guard skips a second automatic sync of a channel already
    running. The response shows only the active channel (ADR 0004). Cross-account token use: RISK-112.
  - **Import rules** (`reach-csv.ts`, `importReachReport`): a file is rejected whole for a missing documented column, a row naming another channel, an unreadable date/number, or two rows for one (video, day). A file for a period that already has an imported file replaces that file's rows only if its `createTime` is later (also dropping videos it no longer lists); an older file is recorded as superseded and changes nothing.
  - `getReachStatus`: a local read for the Analytics card (`GET .../reach/status`): job, `createTime + 48 h` as the expected first file (`firstFileOverdue` only when no file is imported and that time has passed), last attempt, next automatic check (`last check + 6 h`, or the end of the 1 h hold after a failed attempt when later), file list (period, rows, status). Settings shows only the quota (`cloud-quotas` `reporting`, `youtubereporting.googleapis.com`), never job/file status.
  - `getChannelReach`: a local read. `state` separates no job / job but no file yet / data, so an empty result is never read as zero. CTR is a ratio, so totals are **impressions-weighted** (clicks = ctr x impressions); a row without a CTR contributes to neither side, and no CTR at all gives `null`, never 0.
- **Storage (schema v38, plus `reporting_sync_attempts` in v40).** `reporting_jobs` (job per channel and report type; Google stays the source of truth), `reporting_report_files` (ledger + supersession status), `channel_reach_daily` (primary key channel/date/video, no FK to `videos`, nullable `ctr`). Classified device-local in `snapshot/contracts.ts` (same accepted limitation as `video_metrics_daily`, RISK-52) and `authorized` in `youtube-data-policy` (III.E.4.b names Reporting API data).
- **Unverified until real data exists:** the report's `date` format (both `YYYYMMDD` and `YYYY-MM-DD` are accepted) and the CTR scale (ratio assumed, `reach-format.ts` is the one place to change).
- **Not in this slice:** `channel_reach_combined_a1` (by traffic source / device), an agent tool that triggers a sync, video titles beside the ids in the UI table.

#### 14.13.1 Basic and traffic-source reports, lag, evening re-collect — BL-181 stage 1 (FO-REQ-0020)

Plan: `docs/roadmap/plans/REPORTING_BASIC_PLAN.md`. Owner msg 2687: yes to the two new jobs per channel, and agreement to two
stages. Stage 1 collects and measures. Stage 2 would show provisional values, and is decided after a week of measurements.

- **Two more report types,** `channel_basic_a3` and `channel_traffic_source_a3`.
  - Sync: `OtherReportType` entries built in `reach-reports/index.ts`.
    - `syncReachReports` runs them after Reach in the same call, under the same in-flight guard. The `onlyIfDue` throttle (6 h) is
      per type: Reach's checks come from both computers (BL-151), these types' are device-local. So the other computer checking
      Reach never holds back this computer's own downloads. When only these types are due, the call returns
      `checked_recently` with `otherReports`.
    - The first sync after the merge downloads about 30 history files per type per channel inside the dashboard's Reach step, so
      that one load is slower.
    - Each type has its own job, its own ledger rows and its own `reporting_sync_attempts` row.
    - A type that fails is recorded as failed and never changes Reach's result. Reach failing does not stop the other types: the
      call still throws Reach's error afterwards.
    - A core built without these types (the older tests) syncs Reach only.
  - Import: `basic-csv.ts` sums rows on import.
    - Basic rows are summed per (date, video); traffic-source rows per (date, video, traffic source code).
    - Anonymised rows count: `ZZ`, and an empty `video_id`, which is the channel-level and deleted-video remainder (Google's
      "Report characteristics").
    - An empty metric cell is `null`, never 0.
    - The whole file is refused for another channel's id (an empty `channel_id` is accepted), an unreadable date, a value that is
      not a number >= 0, or a missing required column. Only the stored columns are required, so a column Google drops does not
      fail every file.
- **Storage (schema v88, device-local):** `channel_basic_daily` and `channel_traffic_source_daily`.
  - Replacement works as for Reach: `importReportingFile` is generic, and one import queue serves every type.
  - `getChannelReachCoverage` now counts Reach files only. Before this, the first basic file would have made Reach "ready" with no
    Reach rows.
- **Not shared between computers.** `exportAnalyticsShareRows` / `importAnalyticsShareRows` pass only Reach files, attempts and
  jobs (`SHARED_REPORTING_REPORT_TYPE_ID`).
  - The peer importer stores Reach rows only. A basic file shared through it would be marked imported there with no rows, and that
    computer would never download the file itself.
  - Each computer downloads these types itself. The share format is unchanged.
- **Lag.**
  - **Reporting.** `getReachStatus` gives every file `lagHours` = `createTime` − `endTime` (the end of its Pacific day).
    - `firstFileLag` gives, per day, the first file created after the job existed. The 30 history days Google makes right after a
      job is created are left out.
    - `otherReports` carries the same block for the new types.
    - MCP: `agent_get_reporting_status` (Agent API 3.14.0).
  - **Analytics API.** `analytics_data_quality.returnLag` gives, per date D, the first run on this computer that asked for D and got
    it back.
    - It counts only when an earlier run also asked for D and did not get it. Otherwise D is unknown and left out, for example on
      the upgrade day, or after a history catch-up or backfill of another range.
    - The value is an upper bound: it is when this app asked, not when Google published.
    - `newestReturned` is the maximum over all runs, so a catch-up or backfill recorded later cannot lower it.
    - `pacificDayEnd` uses the DST-aware `zonedInstant` (`staleness.ts`).
  - **Hourly freshness probe (BL-245, owner 2026-11-06).** Runs alone give the lag only to the next run (once or twice a day).
    - `src/lib/analytics/freshness-probe.ts`, started by `instrumentation.ts` at minute :07 of every UTC hour (clock-aligned,
      `msUntilNextProbe`; device gate first; ticks never overlap). Every computer that runs the server probes for itself.
    - Per connected channel: one `reports.query` (`ids=channel==…`, `metrics=views`, `dimensions=day`, [today UTC − 5 days, today
      UTC], the date convention of BL-212's hourly pull) under the channel's own stored Google user, through the read gateway.
    - Stores only the newest returned day, or a short error, in `analytics_freshness_probes` (schema v119, device-local, not in
      snapshots or the BL-151 share file, deleted after 45 days). Reads switched off = the tick stores nothing.
    - Never a collection run: staleness, coverage, catch-up and `newestReturned` ignore probes. `getDataQualityReport` passes them
      to `returnLagOf` as channel-only runs, so `channelLagHours` is known to within an hour. Video lag is out of scope.
    - Cost: 1 Analytics unit per channel per hour per computer, logged in `quota_ledger` (label "Analytics freshness probe"). No
      quota-reserve check (BL-212's hourly pull has none either; the check itself costs Cloud Monitoring calls).
    - Production servers only (`NODE_ENV=production`): a `npm run dev` server on the same DB never probes.
    - Caveat: a probe asks `views` only, a collection run the overview metrics; a run's miss can be the proof for a probe's hit, so a
      date right after the upgrade may show a later lag than the true one (still an upper bound) until probes have their own miss.
- **Evening re-collect** (§14.6's daily boundary gets a second one).
  - Setting `analytics_evening_local_time`: default `22:05`, `""` = off. It must be later than the daily boundary, which the
    Settings API checks. Since 2026-10-13 it is `analytics_evening_utc_time` in UTC (§14.6, "UTC times").
  - `runEveningCollectionIfDue` runs only when all four hold:
    - the evening boundary has passed;
    - the channel was not collected since it;
    - no evening attempt was recorded since it (`analytics_evening_attempts`, an app setting of this device);
    - the newest video date the API returned is older than yesterday. That date is the maximum over this computer's runs and over
      the stored rows, which include the other computer's.
  - It asks the 3 days ending yesterday. It bypasses `collectMetrics`'s `analytics_data_current` refusal through an internal
    option that no tool input can set, so a manual collection in the evening is still refused.
  - If today's daily run has not happened (a dashboard left open since before its boundary), the evening run is that daily run,
    with the daily range.
  - The attempt is recorded before the call, so a run that gets nothing back is not retried that evening.
  - `POST /api/analytics/evening-collect` is called by the dashboard every 5 minutes while visible.
    - It answers from local settings before the boundary, and once every channel's evening is settled (an in-process memo).
    - Otherwise it imports the peer's rows, takes the daily run's process-wide lock, and goes through every connected channel with
      its own credentials (`runEveningCollectionForChannels`).
  - There is no server timer: an evening with the dashboard closed is not re-collected (FO-REQ-0020 §2.3 allows this: "check on
    mount, no hidden daemon").
- **Not in stage 1:** reading the basic (`channel_basic_a3`) rows anywhere (overview, agent, Producer). That is stage 2's
  provisional values. The traffic-source rows are readable (next item).
- **Traffic-source read (owner msg 2702, FO-MSG-0015).** The Operator reads the stored traffic-source rows through
  `agent_get_reporting_traffic_sources` (Agent API 3.15.0, `getReportingTrafficSources`).
  - Per day and code it sums the channel's videos, including the remainder; with `videoId`, only that video.
  - Labels are Google's code names.
  - Each day comes with its file's `createTime` and lag.
  - It is a local read; `state` is the traffic-source job's.

