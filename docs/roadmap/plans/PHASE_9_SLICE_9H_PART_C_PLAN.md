# Phase 9 slice 9H, part C — Videos tab

Continues on the same branch (`AGENTS.md` §K.1, owner: "делаем всю фазу до конца в этой ветке").
Owner instruction to continue this specific slice given directly in this session ("Продолжай",
after 9H part B was reported done). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§30 "Videos", which lists exactly:

- title
- channel
- publication date
- public views
- recent velocity
- relative performance
- topic/format

## 0. Mandatory-reading gate (`AGENTS.md` §A) — this slice adds a persisted schema column

Read in full before writing anything below: `docs/PROJECT_SPEC.md` (grepped for
market-intelligence/Phase 9 — genuinely no hits; that document governs the original
localization/write-safety scope only, Phase 9 is entirely a `FUTURE_PHASES.md`/owner-spec/
`PHASE_9_PLAN.md` vertical, so this document is correctly silent here and was not re-read
line-by-line beyond confirming that); `docs/ROADMAP_STATUS.md`'s Phase 9 section;
`docs/SYSTEM_MAP.md` §2.9v in full; `docs/ARCHITECTURE.md` §18 in full (the Market Intelligence
architecture section, including its own explicit note under 9H part B's entry: "a 'Videos' tab
(`market_video_snapshots` has no `title` column — though `getPublicVideoSnapshots` already fetches
it from YouTube at zero extra quota cost and simply discards it today, a separately-scoped schema
change)"); `docs/DEVELOPMENT_PLAYBOOK.md` §6.3 (adding database entities — confirmed this is a
purely additive nullable-column change, new `SCHEMA_MIGRATIONS` entry, no ADR needed), §6.11
(testing — schema-init tested against both fresh and pre-change databases), §6.12 (documentation
maintenance), §6.14 (spec-driven testing, already this module's standing convention);
`docs/TECHNICAL_DEBT.md` every Phase 9 `RISK-5x`–`RISK-79` entry (already read earlier this
session — RISK-63's schema-version constraint below is the one that actually gates this slice);
`docs/decisions/0002-additive-schema-versioning.md` (confirms the additive-migration mechanism
this slice uses is the established, accepted pattern, not a new decision).

**What this changed about the approach:** confirms the migration must be additive (a nullable
`TEXT` column, no ADR), must be version 28 (current max is 27, per `git log`/`src/lib/db.ts`
checked directly), and must never edit the already-shipped v26/v27 migrations in place (RISK-63).
No other change to the planned approach resulted from this pass — the design below was already
heading this way; the gate confirmed it rather than redirecting it.

## 1. Scope boundary

**In scope:**
- Schema migration v28: `market_video_snapshots.title TEXT` (nullable — existing rows stay `NULL`,
  honestly meaning "not captured then," never backfilled or guessed).
- `runCollectionIfStale` (9B) starts passing `title` through to `insertMarketVideoSnapshot` — this
  costs **zero additional YouTube quota**: `getPublicVideoSnapshots` already requests `part:
  ["snippet", "statistics"]` and its `PublicVideoSnapshot.title` is already populated
  (`src/lib/youtube-read-gateway/data-api.ts:350`), 9B's own collector just never read the field
  off the object it already received.
- One new service action, `getMarketVideosOverview()`, aggregating per-video rows across the WHOLE
  watchlist (title, channel, publication date, views, recent velocity, relative performance,
  topic/format), one new API route, one new UI section (Research tab, after Channels, before
  Trends — owner spec §30's own listed order: Overview, Channels, Videos, Trends, Opportunities).
- A shared internal refactor: the per-video breakout-assessment block currently inline inside
  `getChannelIntelligenceSummary` (9H part A) is extracted into a private helper,
  `computeRecentVideoBreakouts`, called identically by both actions — **no behavior change to
  `getChannelIntelligenceSummary`'s own existing output**, verified by its own existing tests
  continuing to pass unchanged.

**Explicitly out of scope (named, not silently dropped):**
- **`detectDisappearedVideoIds` (9I) wiring.** `docs/ARCHITECTURE.md` §18 flags this as belonging
  "with the Videos tab," but owner spec §30's own Videos field list (quoted above) does not include
  a disappeared/removed-video signal, and `data-quality.ts`'s own doc comment on this function
  warns the naive two-snapshot diff is unsafe against `listUploadsPlaylistFirstPageVideoIds`' own
  ≤50-item first-page cap (a video falling off the page boundary would be falsely flagged as
  "disappeared"). Doing this correctly needs either a real extra `videos.list` re-check (real
  quota cost, needs its own owner authorization) or restricting the comparison to ids at-or-newer
  than the current page's own oldest id (safe, no extra call, but a real design/test effort of its
  own). Left for its own later, explicitly-scoped follow-up rather than bolted on here under time
  pressure — recorded as a new `docs/TECHNICAL_DEBT.md` entry (§9 below).
- **Opportunities tab / 9F's UI caller.** Unaffected by this slice.
- **`getMarketVideosOverview` itself is UI-only** (no MCP/CLI wrapper for the new aggregation
  action) — but see §2/§5 below: adding `title` to `marketVideoSnapshotSchema` unavoidably touches
  `getWatchlistEntryContextOutputSchema` (it already embeds `videoSnapshots:
  z.array(marketVideoSnapshotSchema)`, confirmed by direct inspection, `schemas.ts:392`), which
  backs MCP `query_market_intelligence`/CLI `agent market-intelligence` — a real agent-contract
  change, corrected from this plan's first draft which claimed no such change at all (found by
  advisor review). **No `AGENT_API_VERSION` bump, though** (a second correction — advisor's
  initial suggestion to bump it, citing RISK-78, does not survive checking the constant's own
  governing doc comment directly: `src/lib/agent-operations/contracts.ts` explicitly states "Do
  NOT bump for a purely additive, backward-compatible widening of an EXISTING capability's own
  contract (e.g. a new optional input/output field an existing caller can simply ignore)... MINOR
  is reserved for capability-discovery-relevant changes... not every field-level widening" — this
  is exactly that case, and RISK-78's own "AGENT_API_VERSION-bumping" remark is about a DIFFERENT,
  future change of its own — adding a LIMIT/bound to an already-unbounded array, which changes
  existing behavior for an existing caller — not about adding a new ignorable field, which this
  slice actually does). `title` is still recorded in `docs/interfaces.md` as a documentation update
  (a real field a reader should know exists), just without a version bump.
  `docs/AGENT_OPERATIONS_INTERFACE.md`'s own `query_market_intelligence` section describes the
  capability at a level that doesn't itemize `MarketVideoSnapshot`'s fields at all — it needs no
  edit here, and does not get one (checked directly, not assumed).
- **Pagination/bounding of the per-video listing.** Same accepted scope call as `RISK-78` already
  names for the underlying `listMarketVideoSnapshotsByChannel` read this slice's aggregation is
  built on — cross-referenced, not duplicated as a new risk.
- **Backfilling `title` for pre-migration snapshot rows.** Never done — a video's title from before
  this slice is genuinely unknown to this application; showing `null`/"title not captured" is the
  honest answer, not a guess from, say, a later snapshot of the same `videoId` (a later snapshot's
  title could itself have changed since the earlier row was captured, so borrowing it would silently
  misattribute a NEWER title to an OLDER observation — this module's own "never fabricate" discipline
  extended to a case it hadn't hit before).

## 2. Reused building blocks

| Videos column | Source |
|---|---|
| title | `market_video_snapshots.title` (new column), surfaced via `MarketVideoSnapshot.title`, latest known value per video (`null` if only pre-migration rows exist for that video) |
| channel | the watchlisted channel's own `channelId`/`handleOrUrl` (`ResearchChannel`, unchanged) |
| publication date | `MarketVideoSnapshot.publishedAt` (already existed, 9B) |
| public views | `MarketVideoSnapshot.viewCount` (already existed, 9B) |
| recent velocity | NEW: `computeSnapshotVelocity` (9A, `derived-metrics.ts`) reused per-video — fed `{subscriberCount: null, videoCount: null, viewCount, observedAt}[]` from that video's own snapshot series, exactly the same reuse-by-shape pattern `getChannelIntelligenceSummary` already applies to `uploadCadence` (videoCount slot) |
| relative performance | `computeRecentVideoBreakouts` (extracted from 9H part A's existing inline logic — age-normalized leave-one-out breakout assessment, unchanged methodology) |
| topic/format | `market_topic_assignments` rows with `subjectType: "video"`, resolved to topic `name` via one `listTopics()` call (9E part A), never a raw `topicId` shown in the UI |

**Topic source, corrected (found by advisor review — the plan's first draft was wrong here):**
`getWatchlistEntryContext`'s own `topicAssignments` field is hardcoded to `subjectType: "channel"`
only (`services.ts:957`, `deps.listTopicsForSubject("channel", parsedInput.channelId)`) — it never
contains a video-subject row, so it cannot be this slice's source. No existing bulk "all
video-subject assignments" read exists in `db.ts` either (`listTopicsForSubject` takes one
`subjectId` at a time — calling it once per video across the whole watchlist would be a real N+1).
This slice adds one new, narrow `db.ts` read, `listMarketTopicAssignmentsBySubjectType(subjectType)`
(a plain `WHERE subject_type = ?` scan, covered by the existing composite
`market_topic_assignments_subject_idx(subject_type, subject_id)` index), called exactly once with
`"video"` inside `getMarketVideosOverview`, and grouped client-side (in `services.ts`) into a
`Map<videoId, MarketTopicAssignment[]>`. This is a new read function, not a new table/column — no
migration needed for it.

No existing action's *output* schema changes except `marketVideoSnapshotSchema` itself gaining
`title` (additive — every current consumer of `MarketVideoSnapshot` gets one new field, no
existing field removed or retyped; see the agent-contract consequence noted in §1). No new
YouTube call.

## 3. `getMarketVideosOverview` — shape, cost, and the shared-helper refactor

```ts
async getMarketVideosOverview(): Promise<{
  videos: {
    videoId: string;
    channelId: string;
    channelHandleOrUrl: string | null;
    title: string | null;
    publishedAt: string | null;
    viewCount: number | null;
    observedAt: string;
    velocity: FieldVelocity; // viewCount-per-day, reusing derived-metrics.ts's own vocabulary/basis
    breakout: BreakoutAssessment | null; // null only when the video falls outside RECENT_VIDEO_WINDOW_DAYS or has no publishedAt -- never a fabricated "not a breakout"
    topics: { topicId: string; name: string }[];
  }[];
  // Added post-implementation (found necessary by advisor review): the UI must never hardcode a
  // second copy of these -- same discipline getChannelIntelligenceSummary's own `methodology`
  // field already established (`docs/ARCHITECTURE.md` §18).
  methodology: { velocityWindowDays: number; recentVideoWindowDays: number; baselineDayOffset: number };
}>
```

**Deterministic ordering (found necessary by advisor review, matching the requirement 9H part B's
own review already established):** `videos[]` sorted by `publishedAt` descending (`null` last),
then `channelId`, then `videoId` — a stable, human-meaningful default ("newest first") that a test
can `deepEqual` without its own separate sort step. `topics[]` per video sorted by `name` ascending,
then `topicId` (a tiebreaker only — topic names are operator-entered free text, not guaranteed
unique).

Implementation: `const { channels } = await services.listWatchlist();`, then for each channel call
`services.getWatchlistEntryContext({ channelId: channel.channelId })` directly (the same
lower-level call `getChannelIntelligenceSummary` itself makes internally — this action does not
call `getChannelIntelligenceSummary`, since that action deliberately does NOT return the full
`videoSnapshots` array (RISK-78) this slice genuinely needs per-video history for, unlike 9H part
B's aggregation which only needed *already-summarized* per-channel fields). One `listTopics()` call
(once, not per channel) builds the `topicId → name` map.

For each channel's `context.videoSnapshots` (ascending by `observedAt`), grouped by `videoId`:
- **latest row** → title/publishedAt/viewCount/observedAt (title/publishedAt honestly `null` if
  never captured).
- **`computeSnapshotVelocity`** over that video's own full series, window
  `CHANNEL_VELOCITY_WINDOW_DAYS` (reused, not a new constant — a video's view-growth rate and a
  channel's subscriber-growth rate are the same "how fast recently" question at a different
  granularity).
- **`computeRecentVideoBreakouts`** (extracted helper, §1) — returns `null` for a video outside
  `RECENT_VIDEO_WINDOW_DAYS`/with no `publishedAt`, exactly mirroring part A's own existing
  "excluded from every other video's baseline sample" behavior, now made an explicit, visible
  `null` here rather than silently absent from an array.
- **topics** — every `market_topic_assignments` row with `subjectType: "video"` and matching
  `subjectId`, mapped to `{topicId, name}` via the map built above; empty array, never `null`, when
  none exist.

**Per-channel race:** identical narrow-catch treatment to 9H part B's own §4 (`DomainError` code
`RESEARCH_CHANNEL_NOT_AVAILABLE` only, channel's videos simply absent; every other error
propagates).

**Cost, stated plainly:** `N` `getWatchlistEntryContext` calls for `N` watchlisted channels (same
shape as 9H part B), plus one `listTopics()` call — same accepted-tradeoff class as RISK-79/9H part
B's own cost note. The per-video result array size is bounded by however many distinct videos this
application has actually collected across the whole watchlist — realistically small today (Phase 9
tables confirmed empty on the real local database, RISK-63), the same "revisit if this becomes a
real problem" posture RISK-78 already states for the underlying read.

## 4. Shared helper extraction (`computeRecentVideoBreakouts`)

`getChannelIntelligenceSummary`'s existing inline block (grouping `context.videoSnapshots` by
`videoId`, computing each video's age-normalized day-7 point, then a leave-one-out baseline and
`assessBreakout` per video) is moved, verbatim in logic, into:

```ts
function computeRecentVideoBreakouts(
  videoSnapshots: MarketVideoSnapshot[], // ascending by observedAt
  now: Date
): Map<string, BreakoutAssessment> // keyed by videoId; a video outside the recent window / with no publishedAt is simply absent from the map
```

`getChannelIntelligenceSummary` calls this helper and builds `recentBreakoutVideos` from its
values exactly as before (its own output schema and every existing test are unaffected — this is a
pure relocation, not a behavior change). `getMarketVideosOverview` calls the same helper and reads
`breakout ?? null` per video instead of filtering to an array. A test asserts
`getChannelIntelligenceSummary`'s existing breakout fixture (day-7 views `[10, 20, 30, 65]`) still
produces byte-identical output after the refactor.

## 5. New API route and schema

- `GET /api/market-intelligence/videos-overview` → `getMarketVideosOverview()`. Injectable-handler
  factory shape (same convention as `.../overview/route.ts`), its own `route.test.ts`.
- `getMarketVideosOverviewOutputSchema` (schemas.ts): `.strict()`, reuses
  `breakoutAssessmentSchema` (nullable) and a new small `{topicId, name}` object schema inline (no
  standalone export needed elsewhere yet). `velocity` reuses the existing `fieldVelocitySchema` if
  one already exists for `getChannelIntelligenceSummaryOutputSchema`'s own `subscriberVelocity`/
  `uploadCadence` fields — check and reuse rather than redefine.
- `marketVideoSnapshotSchema` gains `title: z.string().nullable()`.

## 6. Migration (v28)

```ts
{
  version: 28,
  description:
    "market_video_snapshots.title -- Phase 9 slice 9H part C, capturing a field getPublicVideoSnapshots already fetches at zero extra quota cost but 9B's own collector previously discarded (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md)",
  apply: async (client) => {
    try {
      await client.execute("ALTER TABLE market_video_snapshots ADD COLUMN title TEXT");
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  },
},
```

`marketVideoSnapshots` (Drizzle table def) gains `title: text("title")` (nullable, no default).
`insertMarketVideoSnapshot`/`StoredMarketVideoSnapshot`/`StoredMarketVideoSnapshotForService`/
`toMarketVideoSnapshot` all gain `title` (optional on insert — `recordVideoSnapshot`'s own manual
entry path, still Web-UI-only, is not required to supply one; `?? null` when omitted).

## 7. UI

New `market-videos-panel.tsx`, mounted in the Research tab's stack right after `MarketResearchPanel`
(Channels) and before `MarketDiscoveryPanel`, matching owner spec §30's own listed order. A flat
table: title (or "Title not captured" in italics when `null` — never a blank cell with no
explanation), channel (`handleOrUrl` if present, else `channelId`), publication date
(`formatDisplayDateTime`), views **shown next to `observedAt` ("as of &lt;date&gt;")** — found
necessary by advisor review: 9B's collector only re-observes a channel's ≤50 newest uploads-playlist
videos (`listUploadsPlaylistFirstPageVideoIds`'s own first-page cap), so an older video that has
fallen off that page simply stops being re-observed; its view count is real but frozen at whatever
`observedAt` last captured it, not a live, current figure, and showing the date next to it is what
keeps that honest rather than implying freshness that isn't there — velocity (`+N/day` or
`-N/day`, or the basis wording `getChannelIntelligenceSummary`'s own UI-mirroring type already
establishes for `insufficient_history`/`stale_latest`/`partial_window` — reused verbatim, not
reworded a second way; a video whose views have frozen this way will itself naturally surface as
`stale_latest`, the same honest signal, not a separate new label), relative performance
(`ratio`/`reason` exactly like the Channels view's breakout column when `breakout` is non-null —
note this already covers "too young"/"no snapshot near day 7" with their own specific `reason` text,
per `getChannelIntelligenceSummary`'s existing, unchanged logic; `breakout` is `null` **only** for a
video the age-normalized comparison never considers at all — no `publishedAt` on record at all, or
older than `RECENT_VIDEO_WINDOW_DAYS` — shown as "no publication date on record" vs. "older than the
recent-video window," the two real, distinct reasons `null` can occur, corrected from this plan's
first draft, which invented a third, non-existent case), topic/format (comma-joined topic names, or
"No topic assigned" when empty). Empty state (zero videos across the whole watchlist): a plain
sentence, matching every other section's convention.

## 8. Acceptance criteria (drafted from the requirement, `AGENTS.md` §L, before implementation)

1. Migration: a fresh empty database boots to schema v28 with `title` present and nullable; a
   database already at v27 (pre-existing `market_video_snapshots` rows, `title` absent) boots to
   v28 without error, and every pre-existing row's `title` reads back `null` (never `""` or a
   guessed value).
2. `runCollectionIfStale`: a fixture where `getPublicVideoSnapshots` returns a video with
   `title: "Real Title"` results in a stored snapshot whose `title` is exactly `"Real Title"` — not
   silently dropped as it was before this slice.
3. `getMarketVideosOverview` with an empty watchlist: `videos: []`. (Unlike 9H part B's
   `newDiscoveries`/`trendCandidates`, nothing in this action's own output is independent of the
   watchlist — there is no other array to assert here, and asserting an internal call count would
   pin an implementation detail, not a requirement — corrected from this plan's first draft, found
   by advisor review.)
4. One channel, one video with two real snapshots: day 0 (`viewCount: 100`), day 5 (`viewCount:
   150`), `now` pinned to exactly the day-5 timestamp, `CHANNEL_VELOCITY_WINDOW_DAYS = 7` (its real,
   checked value). Hand-derived from `derived-metrics.ts`'s own documented rules, not from running
   the code: `strictlyEarlier` = [day 0] (one snapshot before latest); `windowStartCutoff` = day −2
   (5 − 7); `latestIsStale` = false (day 5 ≥ day −2); `closestAtOrBeforeCutoff` = none (day 0 is
   AFTER day −2, so no snapshot reaches that far back); `earliest` = day 0 (the fallback);
   `basis = "partial_window"` (an earlier snapshot exists, but not one reaching all the way back to
   the window's own start); `spanDays = 5`; `value = (150 − 100) / 5 = 10`. Expected:
   `velocity: { value: 10, basis: "partial_window" }` — exactly, not "whatever the function
   returns" (corrected from this plan's first draft, found by advisor review, §L).
5. Breakout-refactor parity: no new test is written for this — the existing, unmodified AC-9H-04
   through AC-9H-07 fixtures (`services.test.ts`, day-7 views `[10, 20, 30, 65]` among them) already
   assert `getChannelIntelligenceSummary`'s exact `recentBreakoutVideos` values, and continuing to
   pass unchanged after the `computeRecentVideoBreakouts` extraction (verified: they do) is itself
   the regression pin for this refactor — a second, literal "before/after" test would only restate
   what those pre-existing tests already prove now that they still pass against the refactored code.
6. Same fixture via `getMarketVideosOverview`: the video with day-7 view count `65` has
   `breakout.isBreakout: true`, `breakout.ratio: 3.25` — proving the extracted helper produces the
   identical value through the new call path, not just the old one.
7. A video older than `RECENT_VIDEO_WINDOW_DAYS` (or with no `publishedAt`): `breakout: null` in
   `getMarketVideosOverview`'s output — never a fabricated non-breakout verdict.
8. Topic resolution: a video with two `market_topic_assignments` rows (`subjectType: "video"`)
   pointing at two real topics named `"Jazz"`/`"Ambient"`: `topics` contains both `{topicId, name}`
   pairs, names resolved via `listTopics()`, sorted `"Ambient"` before `"Jazz"` (name ascending, §3's
   own ordering rule) — not "assignment-table order" as this plan's first draft said (corrected,
   found by advisor review: insertion order into `market_topic_assignments` is not something this
   or any other test may rely on without an explicit `ORDER BY`). A video with zero assignments:
   `topics: []`.
8a. Empty-title normalization: a fixture where `getPublicVideoSnapshots` returns `title: ""` (the
   real fallback `data-api.ts:350` produces when YouTube's own response omits `snippet.title`)
   results in a stored/returned `title` of `null`, never the empty string — pins the single,
   consistent "no title known" representation the UI's own null-check (§7) depends on (found
   necessary by advisor review: without this, `""` and pre-migration `null` would need two
   different UI checks for the same real-world meaning).
9. Per-channel race: identical shape to 9H part B's own AC-11 — a channel removed between
   `listWatchlist()` and its own `getWatchlistEntryContext` fetch is skipped (its videos absent, no
   500), any other error propagates.
10. New API route: a `route.test.ts` proving session/DomainError-mapping, matching every other
    route this phase added.

## 9. Live verification

No live YouTube call anywhere in this part beyond what 9B already made (this slice only changes
what gets stored from an existing response, and aggregates already-collected local rows). Any
throwaway verification script runs with `NODE_TEST_CONTEXT=1` and prints
`getProductionAppPaths().dbPath` first, per RISK-63's established convention — the real local
database (schema v27 as of this slice's start) is never touched directly; schema-boot testing uses
isolated temporary databases only, per `docs/DEVELOPMENT_PLAYBOOK.md` §6.11.

New `docs/TECHNICAL_DEBT.md` entry: `detectDisappearedVideoIds` (9I) still has no caller anywhere
in this codebase after this slice, despite `docs/ARCHITECTURE.md` §18 naming the Videos tab as its
natural home — recorded as its own scoped follow-up (§1 above), not silently dropped.

**Real-database guard (found necessary by advisor review, RISK-63 has already drifted twice
mid-session from an unguarded boot):** after this slice's final `npm test`/`NODE_TEST_CONTEXT=1 npm
run build` pass, read the real local database's stamped version directly and read-only —
`sqlite3 -readonly "$HOME/Library/Application Support/YouTubeOperationsManager/playlist-manager.db"
"SELECT * FROM schema_meta"` — and confirm it still reads **27**, exactly as RISK-63's own entry
currently states. If it reads 28 (or anything else), stop and report that plainly in this slice's
own completion report — never silently absorb a further drift into RISK-63's existing text without
saying so.

**Snapshot/device-handoff transfer, checked directly (no code change needed):** `market_video_
snapshots` is already on `SNAPSHOT_TRANSFERRED_TABLES` (`src/lib/snapshot/contracts.ts`), and the
scrub mechanism (`src/lib/snapshot/adapters/scrub.ts`) operates at the whole-table level (an
allowlisted table's full schema and rows travel via a raw file copy plus dropping non-allowlisted
tables) — not a hand-maintained per-column list. `title`, once added to this table, therefore
travels automatically with any future snapshot/handoff; there is no RISK-52-style column-level gap
to repeat here (confirmed by reading `scrub.ts` directly, found necessary by advisor review, which
had flagged this as worth checking rather than assuming).

## 10. Documentation

- `docs/SYSTEM_MAP.md` §2.9v: append this part's own bullet.
- `docs/ARCHITECTURE.md` §18: append this part's own paragraph (the shared-helper extraction is the
  one architectural point worth recording permanently, matching this section's own established
  style of naming one real decision per slice rather than restating the whole plan).
- `docs/interfaces.md`: the new `GET .../videos-overview` route.
- `docs/roadmap/BACKLOG.md` BL-103 / `docs/ROADMAP_STATUS.md`: short update noting 9H parts A-C
  done, matching 9H part B's own commit convention.
