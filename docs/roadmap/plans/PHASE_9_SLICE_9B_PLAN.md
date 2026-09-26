# Phase 9 slice 9B — repeatable refresh, video collection, quota budget, scheduling

Continues directly from 9A on the same branch (`docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md`), per
the owner's instruction to complete the whole Phase 9 extended scope on one branch
(`AGENTS.md` §K.1, established 2026-09-26) before any merge. Scope derived from the owner's
original spec §25-27 (`docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`) and
`docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9B definition, per `AGENTS.md` §L.

## 1. What 9A left undone, that 9B must build

Per `PHASE_9_SLICE_9A_PLAN.md` §1: 9A shipped the data model, a manual entry point, and one
automatic action (`captureChannelSnapshot`) with **zero callers anywhere** — no trigger, no video
enumeration. 9B's job (owner's original §35: "known channel refresh; known video refresh;
snapshots; scheduler integration; quota accounting"):

1. Wire `captureChannelSnapshot` to an actual repeatable trigger.
2. Build real video-enumeration collection (does not exist at all yet).
3. A check-on-app-open scheduler trigger (owner decision 1).
4. A real, enforced quota budget (owner decision 2) — **does not exist anywhere in this codebase
   today**; `gatewayCallEvents`/`getGatewayTrafficLast24h` count *calls*, not YouTube quota
   *units*, and enforce nothing (confirmed by direct inspection and `PHASE_9_PLAN.md` §10).

## 2. Design corrections from the original sketch (advisor review, before implementation)

- **Quota metering must be per-request, not per-client-construction.** `recordGatewayCallOutcome`
  fires once inside `assertDataApiReadsAuthorized`/`createYoutubeClient` — one event per client
  built, not one per `channels.list`/`playlistItems.list`/`videos.list` call. A single client used
  for a paginated enumeration would under-count real spend by an unbounded factor. This slice
  builds its own per-request unit ledger (§4 below), never reusing the gateway's call-count
  category as a units proxy.
- **No cross-feature-module import for staleness/day-boundary logic (`AGENTS.md` §M).**
  `src/lib/analytics/staleness.ts` and `comparable-age.ts`'s Pacific-Time helpers belong to the
  `analytics` feature module; importing them here would violate the same
  feature-module-independence rule the read/write gateways exist to satisfy. This slice writes its
  own small, independent staleness check and uses a plain UTC calendar day for its quota window
  (explicitly NOT Pacific-Time-aligned like `cloud-quotas`' own display) rather than sharing either
  module's logic. This is deliberately simpler than Phase 8's own wall-clock-boundary rule (which
  exists to satisfy a specific owner rule about a *local time-of-day* cutover) -- market
  intelligence has no equivalent requirement, so a plain elapsed-time check (stale after 24h) is
  used instead of replicating that complexity.
- **An append-only collection-run log is required, not optional** (owner spec §25 "failures must
  be visible and auditable," §26 "expose quota-limited or partially collected states," §27's
  `missing_snapshot`/`quota_limited` vocabulary) — mirrors `analytics_collection_runs`' own
  precedent and role (disambiguating "never attempted" from "attempted, nothing to report" from
  "video genuinely gone"). Also serves as the quota ledger's own source of truth (§4).
- **One `channels.list` call per channel, not two.** `getPublicChannelSnapshot` is widened to also
  request/return `contentDetails.relatedPlaylists.uploads` (an additive, backward-compatible field
  — existing callers ignore it) instead of adding a second per-channel call for the same
  information `getChannelForSync` already knows how to read.
- **Enumeration is capped to the uploads playlist's first page (≤50 newest videos) for this
  slice.** The full-history walk `listUploadsPlaylistVideoIds` already performs (used by owned-
  channel sync) is unbounded and can cost hundreds of units for a channel with a large catalog —
  fine for a one-time owned-channel sync, not for a repeatable, budget-conscious competitor
  refresh. `listUploadsPlaylistVideoIds` gains an optional `maxResults` parameter (default
  unchanged, unlimited) rather than a new function, since the underlying pagination logic is
  identical. **Explicit simplification against owner spec §26's "hot/active/stable/ignored"
  priority tiers: this slice applies one flat cadence and one flat page cap to every watchlisted
  channel — no per-channel priority tiering yet.** Recorded here as a known, deliberate gap, not a
  silently dropped requirement.
- **A lean, public-only video-stats function, not the sync-oriented `getVideosMetadataContextBatch`.**
  That function fetches `localizations`/`contentDetails`/`status` this feature never uses, and is
  named/scoped for the operator's own already-synced videos. A new `getPublicVideoSnapshots`
  mirrors `getPublicChannelSnapshot`'s own "public, explicit-id, nothing extra" precedent, and
  includes `snippet` so `publishedAt` is populated (`market_video_snapshots.publishedAt`, needed by
  9D's future age-normalized comparison — populating it now avoids a second migration later).
- **A channel is marked collected only after its OWN successful refresh**, never as a side effect
  of the overall run — a channel skipped because the budget ran out mid-run must remain stale for
  the next trigger, not silently marked done.
- **Concurrent-trigger guard: mark-then-run**, not mark-after — the running collection stamps its
  own "attempt in progress" signal before doing real work (mirrors the established, already-tested
  precedent this codebase uses for the identical two-open-tabs race, `docs/roadmap/BACKLOG.md`
  BL-059), so two near-simultaneous dashboard mounts can't both spend budget refreshing the same
  channel twice.
- **The quota Settings control is a real `<input type="range">` slider** (the owner's own word,
  "ползунок"), paired with a plain-text numeric readout of the exact value (never a locale-
  formatted number) -- consistent with this project's standing rule against locale-ambiguous
  display for a value whose exact meaning matters (`settings-input-widget-conventions`).
  **Unset/zero means auto-collection is off** — matches "the operator sets the number, no
  hardcoded default" (owner's own decision 2 wording); the Research tab surfaces this state
  explicitly rather than silently doing nothing.
- **Cross-device transfer (owner decision 5, RISK-52) is a phase-level item, tracked here but not
  implemented in 9B.** The owner's "да, я бы объединял" plus "делаем всю фазу до конца" makes this
  part of the phase's own deliverable, but `SNAPSHOT_TRANSFERRED_TABLES`' whole-table-replace
  semantics would destructively overwrite the receiving device's own history on import -- the
  opposite of "combine." For these specific append-only, UUID-keyed tables, a union-by-id import
  (never a delete, never a replace) is the natural, CRDT-free fit. This needs its own presentation
  to the owner once reached (§7 below), not a silent implementation choice now.

## 3. Schema additions (SCHEMA_MIGRATIONS v24)

```sql
ALTER TABLE research_channels ADD COLUMN last_auto_collected_at INTEGER;

CREATE TABLE IF NOT EXISTS market_intelligence_collection_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  research_channel_id TEXT NOT NULL REFERENCES research_channels(id),
  ran_at INTEGER NOT NULL DEFAULT (unixepoch()),
  status TEXT NOT NULL,             -- 'success' | 'skipped_quota_limited' | 'failed'
  units_spent INTEGER NOT NULL,
  videos_requested INTEGER,         -- null when the channel had no uploads playlist / step skipped
  videos_returned INTEGER,          -- < requested means some ids came back missing (never assumed deleted)
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS market_intelligence_collection_runs_research_channel_id_idx
  ON market_intelligence_collection_runs(research_channel_id);
CREATE INDEX IF NOT EXISTS market_intelligence_collection_runs_ran_at_idx
  ON market_intelligence_collection_runs(ran_at);
```

`last_auto_collected_at` mirrors `channels.analyticsLastAutoCollectedAt`'s own shape/purpose
exactly, scoped to `research_channels` instead. The collection-run table is this slice's own
`analytics_collection_runs` counterpart -- append-only, one row per real attempt at one channel,
used both as the audit trail and as the quota ledger's source of truth (`SUM(units_spent)` for
today's UTC calendar day).

## 4. Quota budget

- New Settings key, `marketIntelligenceDailyQuotaBudgetUnits` (nullable integer; `null`/`0` means
  disabled). Stored via the existing generic `app_settings` key/value mechanism
  (`getAppSetting`/`setAppSetting`), read/written through `GET`/`POST /api/settings` like every
  other setting.
- `getMarketIntelligenceUnitsSpentToday(now)`: `SELECT SUM(units_spent) FROM
  market_intelligence_collection_runs WHERE ran_at >= <start of today, UTC>` -- a plain UTC
  calendar day, deliberately not Pacific-Time-aligned like `cloud-quotas`' own display (§2's
  "no cross-module import" constraint) -- the Settings UI labels this window explicitly
  ("resets at UTC midnight") so it is never confused with `cloud-quotas`' own Pacific-Time-based
  numbers.
- Before each individual outbound call (`channels.list`, `playlistItems.list`, `videos.list`) the
  collector checks `remaining = budget - spentToday - spentSoFarThisRun >= callCost`; if not, it
  stops immediately (never partially issues a call it can't account for) and records this
  channel's row as `status: "skipped_quota_limited"`.

## 5. New read-gateway functions/widenings (`src/lib/youtube-read-gateway/data-api.ts`)

- `PublicChannelSnapshot` gains `uploadsPlaylistId: string | null` (additive); `getPublicChannelSnapshot`
  requests `part: ["snippet", "statistics", "contentDetails"]` (was `["snippet", "statistics"]`)
  and reads `channel.contentDetails?.relatedPlaylists?.uploads ?? null`. Its own doc comment's
  "never enumerates a non-owned channel's videos" claim is updated -- 9B is exactly that exception.
- `listUploadsPlaylistVideoIds` gains an optional `{ maxResults?: number }` third parameter --
  when given, stops paging once that many ids are collected (still deduping); omitted preserves
  today's unlimited-pagination behavior unchanged for owned-channel sync's own existing caller.
- New `getPublicVideoSnapshots(youtube, videoIds)` -- `part: ["snippet", "statistics"]`, batched by
  the existing `YOUTUBE_VIDEOS_LIST_BATCH_SIZE`/`chunk` helper, returns `{ videoId, title,
  publishedAt, viewCount, likeCount, commentCount }[]`; a requested id absent from the response is
  simply absent from the result array (never fabricated) -- the caller diffs requested-vs-returned.

## 6. Market-intelligence module additions

- `captureChannelSnapshot` (9A) is extended to also persist `uploadsPlaylistId` internally for the
  same call's use by the video-collection step -- no second `channels.list` call.
- New `captureVideoSnapshots(researchChannelId, videoIds, credentials)`-shaped internal helper
  storing one `market_video_snapshots` row per returned video via the already-existing
  `insertMarketVideoSnapshot` (9A).
- New orchestration, `runMarketIntelligenceCollectionIfStale(credentialRef)`: for every
  `research_channels` row where `last_auto_collected_at` is null or >24h old (independent, small
  staleness check owned by this module, per §2), attempt in mark-then-run order: mark attempt-in-
  progress → capture channel snapshot (± uploads playlist id) → capture up to 50 video snapshots →
  record one `market_intelligence_collection_runs` row → mark `last_auto_collected_at` **only on
  success**. Stops issuing further calls (this channel or later ones) the moment the budget check
  in §4 fails, recording `skipped_quota_limited` for whatever didn't run.
- New API route, `POST /api/market-intelligence/collect-if-stale` (mirrors
  `.../analytics/auto-collect`'s own shape/idempotence contract) -- real mutation, gated by
  `src/proxy.ts` normally, never exempted, matching every other real-mutation route in this app.

## 7. Trigger wiring

Chained as a third fire-and-forget `POST` in `src/app/dashboard/page.tsx`'s existing mount effect,
after the two Phase-8 calls already there -- "while the app's interface is running" (owner decision
1) means once per app session generally, not gated on the Research tab specifically being open.

## 8. Explicitly out of scope for 9B (named, not silently dropped)

- Priority tiers (hot/active/stable/ignored, owner spec §26) -- flat cadence/cap for every channel.
- `search.list`-based discovery -- still gated to on-demand-only UI action, not this slice's
  `.list`-only refresh (owner decision 4).
- The full §27 data-quality vocabulary -- this slice implements `quota_limited` (via `status`) and
  an implicit `missing_snapshot`/"video not returned" signal (via `videos_requested` vs
  `videos_returned`); `deleted_video`/`private_video`/`stale_observation`/`partial_discovery` need
  more signal than a single `videos.list` diff can honestly provide and are left for 9I.
- Cross-device transfer implementation (§2's own note) -- phase-level, presented separately.
- Any UI beyond the Settings-tab quota slider and an explicit "auto-collection is off" state on the
  Research tab -- the full Research-tab UI expansion (velocity/baseline display) is 9H.

## 9. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- A channel that has never been auto-collected (`last_auto_collected_at IS NULL`) is stale;
  processing it and succeeding sets `last_auto_collected_at`, and a second run within 24h of that
  does not re-process it.
- With budget `0`/unset, `runMarketIntelligenceCollectionIfStale` makes zero real calls and marks
  nothing.
- Given a budget that covers exactly one channel's 3-call cost and two stale channels, the run
  processes the first, marks it collected, records `status: "skipped_quota_limited"` for the
  second, and leaves the second's `last_auto_collected_at` untouched (stays stale for next time).
- A video id present in the uploads-playlist enumeration but absent from the `videos.list` response
  is reflected as `videos_returned < videos_requested` on the run's own log row, never silently
  ignored and never assumed `deleted_video` (no evidence for that specific conclusion exists yet).
- `getPublicChannelSnapshot`'s existing behavior (title/subscriber/view/video count, hidden-count
  handling) is completely unchanged by adding `uploadsPlaylistId` -- existing 9A/slice-3 tests keep
  passing unmodified.
- `listUploadsPlaylistVideoIds` with no `maxResults` given behaves identically to today (existing
  channel-sync tests keep passing unmodified); with `maxResults: 50` and a 2-page fake response of
  30+40 ids, stops after collecting 50, never issuing a third page request.
- Two concurrent calls to `runMarketIntelligenceCollectionIfStale` (simulating two open tabs) never
  both spend budget refreshing the same channel -- the second sees the first's in-progress mark and
  skips it.
- Schema initialization succeeds against both a fresh empty database and the pre-migration re-apply
  path, matching every prior migration's own test coverage.

## 10. Where this is recorded

Outcome recorded in `docs/ROADMAP_STATUS.md`/`docs/roadmap/BACKLOG.md` once the whole phase is
ready to merge (owner: "делаем всю фазу до конца в этой ветке"), not per-slice this time.
