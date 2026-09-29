# Phase 9 slice 9A — structured, append-only market snapshot model

Assigned 2026-09-26 (Telegram): "да, начинай новую ветку и продолжай с 9А" — the first slice of
Phase 9's extended scope (Part II), after all 5 of `docs/roadmap/plans/PHASE_9_PLAN.md` §12's
gating decisions were resolved the same day. This plan derives 9A's exact scope from the owner's
own spec (`docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md` §2/§6-9/§35) and the already-
reviewed execution plan (`PHASE_9_PLAN.md` §10/§13/§14/§15), per `AGENTS.md` §L — acceptance
criteria are drafted here, from those sources, before implementation.

## 1. What 9A is, and what it deliberately is not

Per `PHASE_9_PLAN.md` §14: *"New `market_channel_snapshots`/`market_video_snapshots` tables (real
numeric columns...), referencing `research_channels`... Pure, testable derived-metric functions
(delta/velocity/age-normalized comparison, §8-§9 of the spec) computed at READ time from raw
snapshots, in the style of `staleness.ts`... the cheapest possible way to start building the
irreplaceable history... using only what slice 3 already proved works (1-unit `channels.list`
calls against an already-approved data flow)."*

**In scope:**
- Two new tables (schema v23): `market_channel_snapshots`, `market_video_snapshots`.
- Full CRUD service layer for both (insert + list-by-channel), following the exact
  `contracts/schemas/services/adapters` pattern this module already uses.
- One new automatic capture action, `captureChannelSnapshot`, reusing the existing
  `getPublicChannelSnapshot` read-gateway call (the same one `fetchPublicSnapshot`, slice 3, already
  uses) to populate a real `market_channel_snapshots` row from a live YouTube read — proving the
  "real data flow" the plan's own §14 bullet requires, even though nothing (no UI/CLI/MCP route)
  calls it yet.
- Pure, dependency-injected-`now` derived-metric functions over channel snapshots: delta (change
  since the previous observation) and velocity (rate of change over a window), per spec §8.
- A minimal, explicit data-quality signal on each channel snapshot row (`hiddenSubscriberCount`,
  boolean) — the one item from spec §27's fuller vocabulary that is actually knowable from a
  `channels.list` response today (`PHASE_9_PLAN.md` §14's 9I bullet: "should be captured starting
  in 9A, not retrofitted later").
- A `write-path-inventory.test.ts`-style structural test proving neither table's own code path ever
  reaches `write-context`/`youtube-write-gateway` (mirrors Part I's own pattern exactly).

**Explicitly out of scope, deferred to later slices (never silently dropped):**
- **Any actual video-enumeration/collection logic** (walking a channel's uploads playlist,
  batch-calling `videos.list`) — this is 9B's own named scope ("known video refresh") per the
  owner's original §35 and `PHASE_9_PLAN.md` §14's 9B bullet ("Repeatable refresh for
  already-watchlisted entities... still `channels.list`/`videos.list`-only"). `market_video_snapshots`
  therefore gets a full schema + CRUD service layer in 9A (so 9B has something to write into,
  and so it is independently testable now), but **no automatic writer exists for it yet** — only
  a manual `recordVideoSnapshot` entry point, mirroring how `research_evidence`'s own manual
  `recordEvidence` predated slice 3's automatic `fetchPublicSnapshot`.
- **Age-normalized comparison** (spec §9: "views at day 1/3/7/30") — this needs a video's own
  `publishedAt` and real accumulated video-snapshot history, neither of which exists yet without
  9B's collector actually running. The `market_video_snapshots` schema includes a nullable
  `publishedAt` column so 9B/9D can populate it, but no age-normalization function is written in
  9A against data that cannot yet exist for real.
- **Channel baselines, breakout detection, emerging-channel signals** — explicitly 9D
  ("historical intelligence"), and per `PHASE_9_PLAN.md` §15, cannot be meaningfully
  acceptance-tested against real data until 9B has actually run for multiple real days.
- **Repeatable/scheduled capture, and any UI** — 9B (scheduling, per the owner's decision 1: "check
  while the app's interface is running") and 9H (UI) respectively. 9A ships a working,
  independently-testable service layer; wiring an actual button/scheduler/MCP-CLI surface to
  `captureChannelSnapshot` is later slices' job, not silently smuggled into this one.
- **Cross-device transfer** (`docs/TECHNICAL_DEBT.md` RISK-52) — the owner's decision 5 ("да, я бы
  объединял") resolved the *product* question (yes, this data should travel/reconcile across
  devices), but the *engineering* choice between `SNAPSHOT_TRANSFERRED_TABLES` (simple whole-copy)
  and `sync-gateway`-style continuous CRDT merge (matching `change_sets`/`changes`) is its own,
  separately-scoped decision RISK-52 already names as "not something to bundle into the same slice
  that introduces the table in the first place" — doubly true here, introducing two more tables at
  once. Left OPEN, not touched by this slice.

## 2. Schema (SCHEMA_MIGRATIONS v23)

```sql
CREATE TABLE IF NOT EXISTS market_channel_snapshots (
  id TEXT PRIMARY KEY,
  research_channel_id TEXT NOT NULL REFERENCES research_channels(id),
  observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  subscriber_count INTEGER,
  view_count INTEGER,
  video_count INTEGER,
  hidden_subscriber_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_via TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_channel_snapshots_research_channel_id_idx
  ON market_channel_snapshots(research_channel_id);

CREATE TABLE IF NOT EXISTS market_video_snapshots (
  id TEXT PRIMARY KEY,
  research_channel_id TEXT NOT NULL REFERENCES research_channels(id),
  video_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  published_at INTEGER,
  source TEXT NOT NULL,
  created_via TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_video_snapshots_research_channel_id_idx
  ON market_video_snapshots(research_channel_id);
CREATE INDEX IF NOT EXISTS market_video_snapshots_video_id_idx
  ON market_video_snapshots(video_id);
```

Design notes:
- **Append-only, never upserted** — every observation is a fresh row with its own generated `id`
  (mirrors `research_evidence`'s own precedent, `PHASE_9_PLAN.md` §10's central finding: unlike
  `video_metrics_daily`'s per-day upsert, a public snapshot has no "historical day" concept to key
  on — every call returns only the *current* cumulative count).
- **`hiddenSubscriberCount` as an explicit boolean**, not inferred from `subscriberCount IS NULL` --
  `subscriberCount` can be `NULL` for more than one reason in principle (YouTube hides it, or a
  future collection failure), and collapsing both into one nullable column would silently blur
  "the count exists but is hidden" (a real, known fact) with "we don't know" (a data-quality gap).
  This is the one §27 vocabulary item this slice actually stores; the fuller enum
  (`insufficient_history`/`missing_snapshot`/`stale_observation`/`deleted_video`/`private_video`/
  `partial_discovery`/`quota_limited`) is deferred to whichever later slice first has a real
  scenario for each value — inventing unused enum members now would be exactly the kind of
  speculative schema `AGENTS.md`'s own anti-overengineering guidance warns against.
- **No FK on `market_video_snapshots.video_id`** — there is no local table of "videos we don't own"
  to reference (per `PHASE_9_PLAN.md` §13's entity-mapping table, that watchlist-of-videos concept
  is 9C's own future table, not this one); `video_id` is a plain YouTube id, exactly like
  `research_evidence.observation` never references anything structured today.
- **`createdVia`** — reuses `shared-provenance`'s `CreatedVia` vocabulary unchanged, server-stamped
  via `callOrigin` at the call site, identical discipline to every existing function in this module.

## 3. Service layer

New functions on `market-intelligence`'s services (all validate a `researchChannelId` actually
exists first, `RESEARCH_CHANNEL_NOT_AVAILABLE` otherwise — same discipline as `recordEvidence`):

- `recordChannelSnapshot(input, callOrigin)` — manual structured entry; `subscriberCount`/
  `viewCount`/`videoCount` each independently optional (never coerced to `0` when omitted).
- `listChannelSnapshotsByChannel(input)` — every snapshot for a channel, oldest first (the natural
  order for delta/velocity computation).
- `recordVideoSnapshot(input, callOrigin)` — manual structured entry; same optionality discipline.
- `listVideoSnapshotsByChannel(input)` — every video snapshot recorded against a research channel
  (across all its videos), oldest first.
- `captureChannelSnapshot(input, callOrigin)` — the one live-YouTube action: resolves credentials
  (`YOUTUBE_READ_SCOPE`, identical to `fetchPublicSnapshot`), calls the existing
  `getPublicChannelSnapshot` read-gateway function, and inserts a `market_channel_snapshots` row
  from the real response — `hiddenSubscriberCount` set from the same signal `fetchPublicSnapshot`
  already uses. Deliberately does **not** touch `fetchPublicSnapshot`'s own existing behavior (the
  free-text `research_evidence` row it writes stays unmodified) — this is a pure addition, not a
  rewrite of already-shipped, already-reviewed code; a later slice decides whether/how to unify the
  two call sites once a real UI/scheduler trigger exists to justify that design choice.

## 4. Pure derived-metric functions (new file, `src/lib/market-intelligence/derived-metrics.ts`)

Style: `src/lib/analytics/staleness.ts` — zero I/O, every time-sensitive function takes `now`
(or the snapshot list itself) as a plain argument, never reads a clock or the database internally.

- `computeSnapshotDelta(earlier, later)` — per-field change (`subscriberCount`/`viewCount`/
  `videoCount` gained) between two channel snapshots. A field is `null` in the result whenever
  *either* input snapshot has `null` for it — never fabricated as `0` (spec §8's own "prefer
  retaining raw observations" principle applies equally to the derived value: an unknown delta is
  reported as unknown, not zero).
- `computeSnapshotVelocity(snapshots, windowDays, now)` — rate of change per day for each numeric
  field, computed between the two snapshots that bound the requested trailing window (or the
  earliest and latest available if history is shorter than the window). Returns an explicit
  `{ value: number | null; basis: "full_window" | "partial_window" | "insufficient_history" }` per
  field — `insufficient_history` (not a fabricated `0` or a thrown error) when fewer than 2
  snapshots exist at all, `partial_window` when real history exists but doesn't yet span the full
  requested window (spec §27's data-quality-limitation principle: "expose limitations when history
  is incomplete," §9).

## 5. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- Adding a channel snapshot with an empty/missing `researchChannelId` not on the watchlist fails
  with `RESEARCH_CHANNEL_NOT_AVAILABLE`, before any insert.
- `recordChannelSnapshot`/`recordVideoSnapshot` never coerce an omitted numeric field to `0`; a test
  asserts the stored (and round-tripped) value is `null`, not `0`.
- `computeSnapshotDelta` given two snapshots where one field is `null` on either side returns `null`
  for that field specifically, while still computing the other fields normally (independent
  per-field nullability, not an all-or-nothing result).
- `computeSnapshotVelocity` given exactly one snapshot returns `insufficient_history` for every
  field, never a computed rate or a thrown error.
- `computeSnapshotVelocity` given snapshots spanning less than the requested window returns
  `partial_window` with the rate computed over the actually-available span, not silently
  extrapolated to the full requested window.
- `captureChannelSnapshot` stores `hiddenSubscriberCount: true` and `subscriberCount: null`
  together when YouTube reports a hidden count (never `subscriberCount: 0` presented as real) —
  mirrors the existing, already-tested `fetchPublicSnapshot`/`describePublicChannelSnapshot`
  behavior for the identical underlying signal.
- `captureChannelSnapshot` never modifies `research_evidence` — a test proves the existing
  `fetchPublicSnapshot` path and its own stored rows are completely unaffected by this slice.
- Schema initialization succeeds against both a fresh empty database and the existing
  pre-migration-database re-apply path (`docs/DEVELOPMENT_PLAYBOOK.md` §6.3/§6.11), matching
  `src/lib/db.test.ts`'s existing pattern for prior migrations.
- `market-intelligence`'s own `write-path-inventory.test.ts` (`PHASE9-INV-01`/`02`) continues to
  pass for the two new tables — no new file in this module ever references
  `write-context`/`assertWriteChannel`/`youtube-write-gateway`, and no file outside the module
  reaches the new tables' `db.ts` symbols directly.

## 6. Where this is recorded

Outcome recorded in `docs/ROADMAP_STATUS.md`/`docs/roadmap/BACKLOG.md` (BL-102) once merged, per
`AGENTS.md` §H. This plan document is left as-is afterward, a historical record of what was decided
before implementation.
