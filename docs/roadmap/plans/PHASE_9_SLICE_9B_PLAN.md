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
  own "attempt in progress" signal before doing real work. **Correction (advisor review, before
  implementation): this does NOT actually mirror BL-059/`runAutoCollectionIfStale`** as first
  drafted here — direct inspection of `analytics/services.ts` found that function is mark-AFTER
  (it marks `analyticsLastAutoCollectedAt` only once `collectMetrics` itself finishes, and its own
  doc comment explicitly accepts a rare double-collection race as a deliberate tradeoff, since
  Analytics quota is ample). That looser guard is the wrong fit here: this feature's operator-set,
  possibly-small budget makes a double-spend a real correctness problem, not a rare harmless
  waste, so this slice earns its own STRICTER guard instead of reusing that precedent. Concretely:
  a new `research_channels.collection_claimed_at` column (nullable timestamp, added to the same v24
  migration as `last_auto_collected_at`), claimed via one atomic `UPDATE ... WHERE (stale) AND
  (unclaimed) ... RETURNING id` for EVERY eligible channel at once (not per-channel), and released
  once each channel's attempt reaches any terminal outcome. A claim older than 15 minutes is
  treated as abandoned (crash safety) and may be reclaimed. Verified directly against the real
  libsql driver (`db.test.ts`), not assumed from SQLite's general reputation.
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
ALTER TABLE research_channels ADD COLUMN collection_claimed_at INTEGER;

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
exactly, scoped to `research_channels` instead. `collection_claimed_at` is the mark-then-run
concurrency claim (§2's correction above) -- transient, cleared once an attempt reaches any
terminal outcome, never a substitute for `last_auto_collected_at`. The collection-run table is this
slice's own `analytics_collection_runs` counterpart -- append-only, one row per real attempt at one
channel, used both as the audit trail and as the quota ledger's source of truth (`SUM(units_spent)`
for today's UTC calendar day).

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
- **Correction (independent/advisor review, before merge): checked once per CHANNEL, against the
  full worst-case cost, not once per individual call.** The original design above (per-call
  checking) was implemented first and found, by review, to let a channel whose `channels.list` and
  `playlistItems.list` succeeded but whose `videos.list` got cut short by budget still be recorded
  `"success"` and marked collected -- directly contradicting this same section's own "records this
  channel's row as skipped_quota_limited" sentence and §2's "a channel skipped because the budget
  ran out must remain stale." Fixed: before a channel is started at all, the collector checks
  `remaining >= PER_CHANNEL_WORST_CASE_UNIT_COST` (3 -- `channels.list` + `playlistItems.list` +
  `videos.list`); if not, the channel is never started (0 units spent) and its row is
  `status: "skipped_quota_limited"`. A channel that IS started is therefore always either fully
  processed or fails outright -- never cut short by budget partway through. Each call's own cost is
  still charged to `remaining` BEFORE that call resolves (not after), so a thrown error still
  records real spend rather than a fabricated 0 (YouTube's own quota docs: a failed/invalid request
  still costs at least 1 unit).
- **Known residual race, stated plainly:** `remaining` is recomputed from the ledger once, right
  after this run's own claim lands -- narrowing, but not eliminating, the race between two
  concurrent callers (e.g. two dashboard tabs opened moments apart) each starting from the same
  not-yet-updated spend total. Two such runs could each independently decide they have budget for
  one full channel and both proceed, together spending up to `2 * 3` units against a budget that
  only covered one. Judged an acceptable, bounded overshoot for a same-machine, low-frequency
  trigger (never a distributed system) -- the channel-level claim still guarantees the two runs
  never spend budget on the SAME channel twice.

## 5. New read-gateway functions/widenings (`src/lib/youtube-read-gateway/data-api.ts`)

- `PublicChannelSnapshot` gains `uploadsPlaylistId: string | null` (additive); `getPublicChannelSnapshot`
  requests `part: ["snippet", "statistics", "contentDetails"]` (was `["snippet", "statistics"]`)
  and reads `channel.contentDetails?.relatedPlaylists?.uploads ?? null`. Its own doc comment's
  "never enumerates a non-owned channel's videos" claim is updated -- 9B is exactly that exception.
- **Correction (advisor review, before implementation): NOT an options-based `maxResults` widening
  of `listUploadsPlaylistVideoIds`** as first drafted here -- that would leave the real unit cost
  observable only as "1 call," when a first page short of `maxResults` valid ids plus a
  `nextPageToken` would actually issue a second `playlistItems.list` request the caller's own
  meter would never see (silently under-counting real spend). Implemented instead as a new, separate
  `listUploadsPlaylistFirstPageVideoIds(youtube, uploadsPlaylistId)` -- exactly ONE
  `playlistItems.list` call, never paginates regardless of `nextPageToken`, so its real YouTube
  quota cost is always and exactly 1 unit, deterministically. `listUploadsPlaylistVideoIds` itself
  is unchanged from before this slice.
- New `getPublicVideoSnapshots(youtube, videoIds)` -- `part: ["snippet", "statistics"]`, batched by
  the existing `YOUTUBE_VIDEOS_LIST_BATCH_SIZE`/`chunk` helper, returns `{ videoId, title,
  publishedAt, viewCount, likeCount, commentCount }[]`; a requested id absent from the response is
  simply absent from the result array (never fabricated) -- the caller diffs requested-vs-returned.

## 6. Market-intelligence module additions

- **Deliberately does NOT call the public `captureChannelSnapshot` (9A) inside the orchestration**
  (advisor review, before implementation): that action's own output schema strips
  `uploadsPlaylistId` (a field the persisted `MarketChannelSnapshot` contract has no reason to
  carry) and it would re-resolve credentials once per channel instead of once for the whole run.
  `runCollectionIfStale` calls `deps.youtubeApi.getPublicChannelSnapshot`/
  `deps.insertMarketChannelSnapshot` directly instead, on one already-resolved credential set.
- New orchestration, `runCollectionIfStale({ credentialRef })` (schema-validated `unknown` input,
  matching this module's own convention): resolves credentials FIRST (a scope/credential failure
  aborts before any channel is claimed); computes today's spend and the stale/failure-backoff
  cutoffs; excludes channels whose most recent run failed within the last 24h
  (`listRecentlyFailedResearchChannelIds` -- found necessary by advisor review: without it, a
  permanently broken channel would spend a unit on every single dashboard mount, forever); claims
  every remaining eligible channel AT ONCE in one atomic call
  (`claimStaleResearchChannelsForCollection` -- also advisor review: a per-channel-only claim still
  leaves a run-scoped shared budget racy across two channels claimed by two different concurrent
  callers); then per claimed channel, in order: capture channel snapshot (± uploads playlist id) →
  capture up to 50 video snapshots (only if budget allows) → record one
  `market_intelligence_collection_runs` row (`success`/`failed`, with real spend recorded even on a
  partial failure) → release the claim → mark `last_auto_collected_at` **only on full success**.
  The moment a channel's very first call can't be paid for, that channel gets exactly one
  `skipped_quota_limited` row (unitsSpent 0) and every other still-claimed channel is released
  WITHOUT its own row (avoids one identical row per remaining stale channel on every mount once the
  budget is merely small) -- the whole run then stops.
- New API route, `POST /api/market-intelligence/collect-if-stale` (mirrors
  `.../analytics/auto-collect`'s own shape/idempotence contract) -- real mutation, gated by
  `src/proxy.ts` normally, never exempted, matching every other real-mutation route in this app.
- The daily quota budget getter/setter are exposed as their own thin service actions
  (`getDailyQuotaBudgetUnits`/`setDailyQuotaBudgetUnits`) rather than left as a direct `db.ts`
  import inside `/api/settings/route.ts` -- found necessary by this module's own mechanical
  `PHASE9-INV-02` inventory test, which forbids any file outside the module from reaching into its
  db.ts symbols directly, even for a setting as simple as a plain nullable number.

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
- `listUploadsPlaylistVideoIds` (unchanged, no options added -- §5's correction) behaves identically
  to today; the new `listUploadsPlaylistFirstPageVideoIds` issues exactly one `playlistItems.list`
  call and never a second one, even when the response carries a `nextPageToken`.
- Two concurrent calls to `runCollectionIfStale` (simulating two open tabs) never both spend budget
  refreshing the same channel -- the second sees the first's claim and skips it.
- Schema initialization succeeds against both a fresh empty database and the pre-migration re-apply
  path, matching every prior migration's own test coverage.
- **Added by independent/advisor review, before merge (§2/§4's own corrections above):** a budget
  below the full per-channel worst-case cost (3) never starts a channel at all -- no channel is ever
  recorded `"success"` having only partially completed its 3 possible calls. A channel whose
  uploads playlist genuinely enumerates to zero videos gets `videos_requested: 0`/
  `videos_returned: 0` (a known fact); a channel with no uploads playlist at all, or one this run
  never reaches, keeps both fields `null` (an unattempted step) -- these two must never be
  conflated. A call that throws still records its own real spend in `units_spent`, never a
  fabricated 0. A `failed` row preserves whatever `videos_requested`/`videos_returned` were already
  known before the failure, never discards them back to `null`.

## 10. Where this is recorded

Outcome recorded in `docs/ROADMAP_STATUS.md`/`docs/roadmap/BACKLOG.md` once the whole phase is
ready to merge (owner: "делаем всю фазу до конца в этой ветке"), not per-slice this time.
