# Phase 9 Plan — Market Discovery & Trend Intelligence

Originally produced 2026-09-20 per `docs/roadmap/FUTURE_PHASES.md` §9's planning sequence
(`BL-004`). **Refreshed 2026-09-26** on explicit owner assignment (Telegram: "Создай новую ветку
для Phase 9... Проведи исследование и составь план. Приступай к выполнению плану. Я согласую уже
финальный мердж в дев") — the repository has changed substantially since the original pass (Phase
7's Agent Operations Interface, Phase 8's analytics, `shared-provenance`, `agent-connections`
zoning, `AGENTS.md` §M all now exist), so §1/§2/§5 below are re-verified against the current state,
not carried over unchanged. This remains a living plan document for this one phase, not a permanent
record — `docs/ROADMAP_STATUS.md` is where the actual outcome gets recorded once slices complete.

## 1. Current repository state relevant to this phase (re-verified 2026-09-26)

- Every existing data model (`channels`, `videos`, and everything downstream) is scoped to
  **channels the authenticated operator owns**, enforced by `write-context.assertWriteChannel` and
  OAuth token ownership. Phase 9 remains the first phase whose entire purpose is data about
  channels the operator does **not** own — a genuinely new trust/scope boundary, not an extension
  of an existing one. `FUTURE_PHASES.md` §1's prioritization principles (added 2026-09-26) now
  state this explicitly as a standing rule: "keep owned-channel analytics (private, Phase 8) and
  public market/competitor observations (Phase 9) explicitly separate."
- **Confirmed still true, and more directly reusable than the original pass assumed:**
  `src/lib/youtube-read-gateway/data-api.ts` already exports functions that read PUBLIC
  channel/video data by an *explicit* id, not just `mine: true` —
  `getChannelForSync(youtube, channelId?)` (channels.list) and `getVideoById`/`getVideoSnippet`
  (videos.list) already accept an arbitrary id and require no special ownership scope. The API
  surface this phase needs already exists; the missing piece is still a *storage* layer (an
  evidence/watchlist model) and, later, a *discovery* layer — not a new API client, and not even
  new low-level read-gateway plumbing for the very first slice (a small, distinctly-named
  wrapper is still added — see §5 — to avoid conflating this phase's "any public channel" reads
  with `getChannelForSync`'s "my own channel, or a channel I'm about to treat as mine" naming and
  intent).
- **New since the original pass, and directly reusable:** `src/lib/shared-provenance/`
  (`CreatedVia`, `EvidenceReference`, bounded list/text-length constants) is now the established,
  dependency-free provenance vocabulary two other feature modules (`ai-localization`,
  `content-proposals`) already share (`AGENTS.md` §M in action). This phase's evidence records
  should adopt it directly rather than inventing a parallel shape, as the original plan's §1
  anticipated only by analogy to `aiLocalizationGenerationProvenance` (a narrower, single-table
  precedent that predates the actual extraction).
- **New since the original pass:** the Agent Operations Interface (Phase 7) exists, with its
  `agent_get_capabilities` response already naming this phase's eventual capabilities —
  `query_market_intelligence`/`query_competitors` (`src/lib/agent-operations/contracts.ts`'s
  `PLANNED_FUTURE_CAPABILITIES`) — as `CAPABILITY_NOT_AVAILABLE` placeholders. Whatever MCP/CLI
  surface this phase eventually adds should use these exact names, not new ones, to make good on
  that already-published promise rather than leaving it stale or introducing a second name for the
  same thing.
- **New since the original pass:** multi-agent responsibility zoning (`src/lib/agent-connections/`)
  exists, with a proven, zero-schema-migration pattern for making any capability id zoneable. Any
  agent-facing write-shaped action this phase eventually adds (e.g. "add to watchlist" if ever
  exposed to an agent, not just the human operator) is a candidate for this, decided per-capability
  when that slice is actually built, not assumed now.
- **New since the original pass:** `AGENTS.md` §M (feature-module independence, added 2026-09-22)
  is now a formal, standing rule, not just an emerging pattern. This phase's own module(s) should
  be built as a self-contained, removable vertical from the start (the rest of the app must keep
  working if this module is disabled), following the exact `contracts/schemas/services/adapters`
  shape `asset-catalog`/`content-proposals`/`operations-instructions` already established for
  Phase 7's own additive modules.
- `docs/decisions/README.md`'s own ADR-trigger criteria confirm no ADR is needed here: this is "a
  new domain module following the existing contracts/schemas/services/adapters pattern," explicitly
  named as *not* requiring one.

## 2. Existing capabilities vs. missing dependencies (re-verified)

| Capability Phase 9 needs | Status |
|---|---|
| A Data API v3 client capable of reading public channel/video data by explicit id | **Exists**, confirmed reusable as-is (`getChannelForSync`/`getVideoById` already accept an explicit id) |
| A provenance/evidence-tracking vocabulary to reuse | **Exists**, now a real shared module (`shared-provenance`), not just an analogous pattern |
| A module-independence convention to follow | **Exists as a formal rule** (`AGENTS.md` §M), with three prior modules (`asset-catalog`, `content-proposals`, `operations-instructions`) as concrete templates |
| Agent-facing capability names already committed to | **Exists** (`query_market_intelligence`, `query_competitors` in `PLANNED_FUTURE_CAPABILITIES`) — this phase should fulfill, not rename, them |
| Any concept of "a channel/video the operator does not own" | **Still missing entirely** — every current table implicitly assumes ownership; needs a new, explicitly-not-owned entity, not a nullable field bolted onto `channels` |
| A discovery/prioritization mechanism | **Still missing entirely** — needs its own design, deliberately deferred (see §4) |
| Freshness/confidence indicators | **Still missing entirely** |

## 3. Smallest useful vertical slice (unchanged in substance, confirmed still right)

**A manually-seeded research watchlist with evidence records — no automatic discovery yet.**
Concretely: a `research_channels` table (distinct from `channels`, never merged with it — the
owned/not-owned boundary must stay structurally obvious, not a flag), each row carrying a
manually-entered channel ID/handle plus a free-text reason; and a `research_evidence` table
recording individual public observations, each linked to a `research_channels` row, with a
`source` field, a `shared-provenance`-shaped provenance (`createdVia`), and a `collectedAt`
timestamp. Discovery logic and any scoring/ranking mechanism are later slices — this first one
proves the storage model and the provenance discipline before building anything that writes to it
automatically.

## 4. Scope and explicit non-goals for this phase, this assignment

**In scope, this assignment (owner: "Приступай к выполнению плану"):**
- New module `src/lib/market-intelligence/` (`contracts.ts`/`schemas.ts`/`services.ts`/
  `adapters/`/`index.ts`, the established pattern), owning `research_channels`/`research_evidence`
  end to end.
- `research_channels`/`research_evidence` tables, additive migration, structurally separate from
  `channels`/`videos`.
- Manual add-to-watchlist service + API route + minimal Web UI (operator supplies a channel
  ID/handle + a required reason), plus a remove-from-watchlist capability (added during this
  assignment's own independent review, 2026-09-26 — the first version had no way to correct a
  mistyped reason or a wrong channel id).
- A "fetch public snapshot" action populating one evidence row from a public, explicit-id read
  (`channels.list` with `part=snippet,statistics`) — reusing the read-gateway's existing
  capability, not a new API surface. **Delivered scope, corrected 2026-09-26 by independent
  review** against this bullet's own original wording: `title` and the subscriber/view/video
  counts are recorded together in the evidence row's `observation` text (so an operator who added
  a channel by bare `UC...` id still sees its real name once a snapshot is fetched) — there is no
  separate structured `title` field on `research_channels` itself, and no thumbnail is fetched or
  stored (a thumbnail needs either a new column plus display wiring or a separate fetch-and-cache
  concern, judged not "cheap" enough for this slice's own minimal scope — deferred, not delivered).
  `videoCount` comes directly from `statistics.videoCount`, not derived from the uploads playlist.
- A mechanical inventory test (same pattern as the existing `batches`/`ai-connections`
  write-path-inventory tests)
  proving `market-intelligence`'s own code never imports/calls `write-context`/
  `assertWriteChannel`/`youtube-write-gateway` — the ownership boundary enforced structurally, not
  just by convention.
- Updating `agent-operations`'s `PLANNED_FUTURE_CAPABILITIES` disposition once the corresponding
  agent-facing read tool(s) actually exist (moving `query_market_intelligence`/`query_competitors`
  from planned to implemented, or explicitly deferring the agent-facing surface to its own later
  slice if the vertical slice above lands without it — decided when that point is reached, not
  pre-committed here).

**Explicitly out of scope, regardless of how far this assignment's own slices get:**
- Automatic discovery/crawling of new candidates — needs its own resource-budget and
  prioritization design per `FUTURE_PHASES.md` §5's own constraint ("no arbitrary fixed
  competitor-list limit — use resource budgets, prioritization, and discovery rules instead"),
  deliberately not attempted yet.
- `search.list`-based discovery specifically — expensive (100 quota units/call) and a discovery
  concern, not a watchlist-storage concern; the public-snapshot slice above only ever needs
  `channels.list`/`videos.list` (1 unit/call) for an already-identified channel.
- Any private-analytics-shaped data (CTR, retention, revenue) for a researched channel —
  `FUTURE_PHASES.md` §5 explicitly forbids assuming access to a competitor's private analytics;
  every `research_evidence` field must be genuinely observable through a public API, never
  inferred or estimated as if measured.
- Any "this channel is profitable"/ranking conclusion — publicly observed growth is explicitly not
  proof of profitability; evidence rows are raw facts with sources, never conclusions.
- Restricting the watchlist to music or any niche the operator's existing channels happen to be
  in — channel/reason fields must not assume a subject-matter category.
- Phase 10's Decision & Experiment Engine entities (Hypothesis/Evidence/Experiment/Outcome) —
  `create_experiment_proposal` stays a `CAPABILITY_NOT_AVAILABLE` placeholder; this phase produces
  evidence Phase 10 will eventually consume, it does not build Phase 10 itself.

## 5. Interfaces, data structures, and security boundaries

- Additive tables (SCHEMA_MIGRATIONS, next version after whatever is current when this slice
  lands):
  ```sql
  CREATE TABLE IF NOT EXISTS research_channels (
    id TEXT PRIMARY KEY,                 -- YouTube channel ID, never our own owned-channel id
    handle_or_url TEXT,
    reason TEXT NOT NULL,                -- why this is on the watchlist -- never blank
    added_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS research_evidence (
    id TEXT PRIMARY KEY,
    research_channel_id TEXT NOT NULL REFERENCES research_channels(id),
    observation TEXT NOT NULL,           -- e.g. "channel had N subscribers as of date D"
    source TEXT NOT NULL,                -- e.g. "youtube.channels.list", "manual observation"
    confidence TEXT,                     -- explicit, never silently assumed "confirmed"
    created_via TEXT NOT NULL,           -- shared-provenance CreatedVia ("web_ui" for this slice)
    collected_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  ```
- Security boundary: `research_channels`/`research_evidence` must never be reachable from any
  write-capable code path — these rows describe channels the operator has no write authority
  over. `src/lib/market-intelligence/write-path-inventory.test.ts` (new, mirrors the established
  `write-path-inventory.test.ts` pattern in `batches`/`ai-connections`) fails the suite if this
  module's own files ever reference `write-context`, `assertWriteChannel`, or
  `youtube-write-gateway`.
- No credential or new OAuth scope is needed beyond the operator's own already-granted read scope
  to call `channels.list`/`videos.list` for an arbitrary public id — confirmed by reading the
  existing `getChannelForSync`/`getVideoById` call sites, which already do this today for the
  operator's own channel with the same scope.
- Module independence (`AGENTS.md` §M): no existing route/service/component may take a hard
  dependency on `market-intelligence`'s tables or services — it is purely additive, read/propose
  surface with no other module reading its data back. Verified by grep before merge (no import of
  `@/lib/market-intelligence` from outside its own module, `src/app/api/market-intelligence/**`,
  and (if built) its own Web UI panel/MCP tool registrations).

## 6. Proposed implementation slices (this assignment)

1. `market-intelligence` module skeleton (`contracts`/`schemas`/`services`/`adapters`/`index`) +
   `research_channels`/`research_evidence` additive migration + the write-path inventory test +
   unit tests for the service layer (add-to-watchlist, list, get, record-evidence), following
   `AGENTS.md` §L (acceptance criteria derived from §4/§7 here, before writing the implementation).
2. API routes (`POST /api/market-intelligence/channels`, `GET
   /api/market-intelligence/channels`, `GET /api/market-intelligence/channels/[id]`) + minimal Web
   UI (a new Settings-adjacent or dashboard panel — exact placement decided during slice 2, once
   slice 1's module shape is settled) for manually adding/viewing watchlist entries.
3. "Fetch public snapshot" action wired to slice 2's UI (or its own explicit action), populating a
   `research_evidence` row from a real, live `channels.list` call for the watchlisted id — this is
   the one point in this phase that makes a real outbound YouTube API call, so it gets its own
   focused review pass.
4. (Only if slices 1-3 land cleanly with review budget remaining) minimal MCP/CLI read-only
   surface (`agent_list_research_channels`/`agent_get_research_channel_context`, or reusing
   `query_market_intelligence`/`query_competitors` directly if their shape fits) — otherwise
   explicitly deferred to its own follow-up assignment, not silently dropped.
5. (Explicitly NOT this assignment — separate future assignment) automatic discovery, scoring/
   prioritization, and any Phase-10-facing "candidate opportunity" surface.

## 7. Acceptance criteria (drafted from the requirement, per `AGENTS.md` §L, before implementation)

- A test proves `market-intelligence`'s own source files never import `write-context`,
  `assertWriteChannel`, or `youtube-write-gateway` (the write-path-inventory test, §5) — the
  ownership boundary is structural, not just "we didn't write that code yet."
- Adding a `research_channels` row with an empty `reason` is rejected by the schema layer (Zod
  `.min(1)`), before it ever reaches storage — a negative test proves this.
- Every `research_evidence` row has a non-null `source` and `createdVia`; the schema rejects an
  attempt to omit either.
- `addToWatchlist` is idempotent-safe for a duplicate channel id: a second add for the same
  `research_channels.id` either updates the existing row's `reason`/re-confirms it, or is rejected
  with a clear `DomainError`, never silently creates a second row with the same primary key.
  **Decided in slice 1's own implementation: rejected with `RESEARCH_CHANNEL_ALREADY_WATCHED`,
  never silently overwritten** — an operator who wants to change the `reason` uses
  `removeFromWatchlist` (added during this assignment's own independent review, 2026-09-26) and
  re-adds the entry.
- The "fetch public snapshot" action (slice 3) never fabricates a value the API didn't actually
  return (mirrors the existing `viewCount`/`commentCount`-style "never default to 0/empty" pattern
  already established in `channel-sync`) — a test using a fixture where a field is genuinely
  absent from the API response proves the resulting evidence row reflects that honestly (e.g. a
  null/absent field, never a fabricated zero or empty string presented as a real observation).
- A channel already present in `channels` (i.e. the operator's own, owned channel) can still be
  legally added to `research_channels` too if the operator chooses (nothing prevents researching
  a channel you also happen to own) — but the two tables are never joined or conflated by any
  query. **Delivered as two complementary tests, corrected 2026-09-26 by independent review**
  against this bullet's original single-test wording (`channel-access` never reads channel/video
  content tables at all, and `listStoredVideosByChannel` uses a non-injectable module-level `db`
  singleton, so neither can actually be exercised the way originally described): a `db.test.ts`
  test proves the data-level half (no row appears in `channels` for a research-only id) and
  `market-intelligence/write-path-inventory.test.ts`'s `PHASE9-INV-02` proves the structural half
  (no other module's code references `research_channels`/`research_evidence`, by symbol or by raw
  SQL table name).

## 8. Required project-owner decisions

Already resolved by this assignment itself ("Приступай к выполнению плану... финальный мердж"):
implementation may proceed slice by slice without a per-slice approval gate, per the same pattern
already established for Phase 7's own assignment — only the final merge into `dev` needs the
owner's explicit "yes, merge" (`AGENTS.md` §K.2).

Still open, to be decided as each slice is actually reached (not blocking slice 1's own start):
- What "confidence" values are meaningful for `research_evidence.confidence` (a fixed enum vs.
  free text) — free text for slice 1 (matches the schema above), revisit before any UI/agent
  surface starts relying on specific values. **Known open edge case (independent review round 2,
  2026-09-26):** `fetchPublicSnapshot` stamps every successful fetch `"high"` unconditionally,
  including a fully-null snapshot (e.g. a hidden subscriber count with no other stats available)
  that described nothing concrete — revisit this alongside the enum-vs-free-text decision, not as
  a separate fix.
- Exact Web UI placement for the watchlist panel (new dashboard tab vs. a Settings-adjacent
  panel) — decided at slice 2.
- Whether slice 4 (agent-facing MCP/CLI surface) is in scope for this same assignment or its own
  follow-up — decided once slices 1-3 are done and reviewed, per this plan's own §6.
- **Known, accepted narrow races (independent review round 3, 2026-09-26), not fixed — single-
  operator local app, no data corruption in either case:** (a) removing a watchlist entry while
  its own `fetchPublicSnapshot` is still in flight can make the late `insertResearchEvidence`
  target an already-deleted `research_channel_id`; the real FK constraint (`foreign_keys=ON`)
  correctly rejects the insert, but the route currently surfaces this as a generic `500` rather
  than a clean `DomainError`. (b) the Web UI's evidence fetch/snapshot-fetch handlers don't guard
  against `selectedChannelId` having changed by the time a response lands, so rapidly switching
  between watchlist rows can transiently render one channel's evidence under another's card
  (self-corrects on the next explicit re-select). Revisit if this module ever moves beyond a
  single interactive operator clicking through the UI by hand.

## 9. Where this is recorded

This plan lives here, refreshed in place rather than superseded by a new document (per
`FUTURE_PHASES.md` §9's own instruction that a picked-up phase's detailed plan belongs in its own
plan document, not duplicated into `BACKLOG.md`/`FUTURE_PHASES.md`). `docs/roadmap/BACKLOG.md`
tracks the individual slices above as their own rows once assigned/in-progress/done;
`docs/ROADMAP_STATUS.md` records the actual outcome once slices complete and merge.

**Everything above this line (Part I, §1-9) describes slices 1-3, which shipped and merged to
`dev` in `b83c9b2` (2026-09-26) — left as the historical record of that work, not rewritten. Part
II below extends this same phase with a much larger scope the owner described the same day, after
slices 1-3 already merged.**

---

# Part II — Extended Scope (owner spec, 2026-09-26)

**Source: analysis and planning only, per the owner's own instruction ("Дополнительное описание
фазы 9. Сделай анализ и составь новый план выполнения").** The full verbatim requirement is
`docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md` (39 sections) — stored there, not
paraphrased here, because Telegram keeps no message history and a paraphrase would drift from the
actual requirement `AGENTS.md` §L requires acceptance criteria to trace back to. Everything in
this Part II is derived from that document; section numbers below (§10 onward) continue this
file's own numbering and are unrelated to that document's own §1-39.

**Discrepancy, reported per `AGENTS.md`'s "identify and report, don't silently resolve" rule:**
`docs/PROJECT_SPEC.md` has zero mentions of "Phase 9," "market," or "competitor" (confirmed by
direct search) — this phase exists only in `docs/roadmap/FUTURE_PHASES.md` §5 (a short strategic
summary, consistent with but far less detailed than the owner's spec) and, as of this Part II, in
`PHASE_9_OWNER_SPEC_2026-09-26.md`. This is not rewritten to fill that gap — `PROJECT_SPEC.md`'s
scope and update cadence is the project owner's call, not something a planning pass changes
unilaterally.

**This Part II does not authorize implementing anything.** No code has been written for it. Per
`AGENTS.md` §C, each slice below needs its own explicit future assignment, exactly as Part I's
slices 1-3 did.

## 10. What already exists vs. what the owner's spec assumes exists (research findings)

Researched directly against this repository's actual current code (not assumed from documentation
alone), specifically to answer the spec's own §25/§26 assumptions about reusable Phase 8
infrastructure:

- **No real scheduler exists anywhere in this application — confirmed, not assumed.** Phase 8's
  "auto-collection" (`src/lib/analytics/staleness.ts`'s `isAnalyticsCollectionStale`,
  `computeNextRefreshAt`) is a pure staleness *calculation*; what actually *triggers* a collection
  run is `src/app/dashboard/page.tsx`'s mount effect calling `POST
  .../analytics/auto-collect`, which only runs `collectMetrics` if that calculation says it's due.
  `docs/ARCHITECTURE.md` §14 states this explicitly: "no background daemon/cron separate from the
  Next.js server process... runs once per dashboard mount, not on a repeating interval." **The
  owner spec's §25 ("reuse existing Phase 8 scheduling infrastructure") assumes a scheduler that
  does not exist** — there is nothing to reuse for actually *triggering* discovery/observation-
  refresh/watchlist-refresh/trend-recomputation jobs "on a schedule" in the sense §25 means. The
  staleness-boundary-calculation *pattern* (pure functions, no I/O) is real, reusable precedent;
  the triggering mechanism is not. This is a genuine architectural gap this phase's own scope
  cannot silently paper over — see §12 below for the owner decision this requires.
- **No quota/budget enforcement exists anywhere.** `src/lib/cloud-quotas/` reads and displays
  Google's own real quota numbers (Cloud Monitoring API) — a dashboard readout, not an internal
  accounting or call-blocking mechanism. `gatewayCallEvents`/`recordGatewayCallOutcome`/
  `getGatewayTrafficLast24h` (`src/lib/db.ts`) is a real append-only call-count log per category
  (`data_api_reads`, `analytics_reads`, `mcp_tool_calls`, `cloud_monitoring_reads` today), but it
  counts *calls*, not YouTube API *quota units* (which vary 1-100+ per call depending on method —
  see §11), and enforces no budget or priority. The spec's §26 ("centralized discovery/observation
  budgets," "configurable priorities," "do not allow uncontrolled recursive search to consume the
  daily quota") needs genuinely new infrastructure; the append-only-event-log *shape* is reusable,
  the enforcement is not.
- **Phase 8's own data-quality reporting is bespoke, not a generic enum** —
  `src/lib/analytics/data-quality.ts`'s `computeDataQualityReport` returns a single-purpose shape
  (`{coveredDates, uncoveredDates, tooRecentDates, videosWithSkips}`), not a reusable vocabulary
  matching the spec's §27 list (`insufficient_history`/`missing_snapshot`/etc.). **The underlying
  pattern is directly reusable and important, though:** it derives quality/coverage signals from a
  separate, genuinely append-only "attempt record" table (`analytics_collection_runs`), never from
  the absence of a data row alone — because absence is ambiguous (YouTube's Analytics API silently
  omits zero-activity days, confirmed live during Phase 8's own development). The same reasoning
  applies even more directly to Phase 9: a public `channels.list`/`videos.list` response omitting a
  video means either "never observed" or "now deleted/private" — genuinely indistinguishable
  without a separate record of the attempt itself (see §27 below).
- **The most architecturally significant finding: `video_metrics_daily`'s storage pattern is the
  WRONG one to copy for Phase 9, and copying it would silently destroy the exact history this
  phase's own §38 says is irreplaceable.** `video_metrics_daily` is keyed `(videoId, metricDate,
  metricName)` with `onConflictDoUpdate` — a genuine *upsert*, not an append-only series. This is
  *correct* for owned-channel Analytics API data, where each `metricDate` is a stable, final
  historical fact YouTube itself reports once per real calendar day (re-collecting the same day
  just refreshes the same fact, safely). **It does not transfer to Phase 9's public-channel/video
  observations**, because `channels.list`/`videos.list` has no "historical day" concept at all —
  every call returns the *current* cumulative count as of that instant, with no way to ask YouTube
  "what was this video's view count on Sep 1st." To build the spec's own required "Sep 1: 10,000 /
  Sep 2: 35,000 / Sep 3: 82,000" series (§7), **every observation must be its own newly-inserted
  row, never upserted by any natural key** — the correct existing precedent to copy is
  `analytics_collection_runs`/`gatewayCallEvents`'s genuine append-only, insert-only shape, not
  `video_metrics_daily`'s upsert-by-date shape. **Already-shipped slice 1's `research_evidence`
  table already gets this right** (every `insertResearchEvidence` call inserts a fresh UUID-keyed
  row, never upserts) — this is a real point of continuity to build on, not a mistake to fix. Its
  limitation for Part II's purposes is different: `observation` is free text, not structured
  numeric columns, so it cannot support delta/velocity/baseline computation without fragile text
  parsing (see §14 below).
- **Agent Operations Interface**: confirmed via `src/lib/agent-operations/contracts.ts` and
  `docs/AGENT_OPERATIONS_INTERFACE.md` — `AGENT_CAPABILITY_DOMAINS` has 10 entries today, none for
  market intelligence; `PLANNED_FUTURE_CAPABILITIES` already reserves exactly `"query_market_
  intelligence"`/`"query_competitors"`/`"create_experiment_proposal"` (the last belongs to Phase
  10) — these names should be honored, never renamed. `GRANTED_PERMISSIONS = ["READ", "DRAFT"]` is
  a hardcoded constant, unaffected by anything this phase does. `src/lib/content-proposals/` (the
  closest existing DRAFT-class module) has **no approval-gate concept at all** — "create/get/list
  only" — so it is *not* the right template for the spec's §29 "agent-created research/discovery
  drafts," which must not spend quota without gating. `ai-localization`'s Change Set
  (`approvalStatus`, a real human-approval step before anything downstream happens) is the correct
  template for that specific capability. `ZONED_CAPABILITIES`
  (`src/lib/agent-connections/contracts.ts`) has 6 entries, none for market intelligence — a new
  entry is needed once (and only once) a DRAFT-class market-intelligence MCP tool actually exists.
- **`shared-provenance`'s `EvidenceReference`/`EVIDENCE_SOURCE_TYPES`** (`"external_research"`,
  `"channel_analytics"`, `"comparable_video"`, `"other"`) is already used by two otherwise-
  unrelated modules (`ai-localization`, `content-proposals`) per its own `AGENTS.md` §M
  extraction rationale — confirmed neither consumer branches on the specific enum values anywhere
  (both treat it as an opaque, caller-supplied attestation), so adding a market-intelligence use is
  safe and additive. `"external_research"` already fits a public YouTube observation reasonably
  well; no new enum value is proposed unless a real need to distinguish it from existing uses
  surfaces once this is actually built.

## 11. YouTube Data API v3 quota costs (verified against the official per-method cost table, not assumed)

Relevant to every decision in §12 below — a project's default quota is **10,000 units/day**,
shared across *every* caller in this application (owned-channel sync, Phase 5's dormant write
path, Phase 8's analytics collection, and this phase), not a separate allowance per feature:

| Method | Cost |
|---|---|
| `channels.list`, `videos.list`, `playlistItems.list`, `i18nLanguages.list` (any `.list` read) | 1 unit |
| `search.list` | **100 units** |
| `videos.update`, `playlists.insert/update/delete`, `playlistItems.insert/delete` (any write) | 50 units |

A single `search.list`-based discovery pass (the spec's §3/§35 9C) is as expensive as 100
`channels.list` calls — this is why the spec's own §26 ("do not allow uncontrolled recursive
search to consume the daily quota") is not a minor caution, it is the central constraint on
sequencing: everything this phase can do with `.list` calls alone (refreshing already-watchlisted
entities, exactly what slice 3 already ships) costs two orders of magnitude less than search-based
discovery of *new* entities.

## 12. Required owner decisions

Unlike Part I (where the owner's "Приступай к выполнению плану" itself resolved the equivalent
open questions), this Part II's scope depends on decisions only the owner can make — implementing
past these points on an assumed default would risk building on the wrong architecture or spending
real money/quota without authorization:

1. **Scheduling (§10's central finding).** No background scheduler exists today. Options:
   (a) keep today's pattern — check staleness when the Research tab (or dashboard) is open;
       cheapest, but any day nobody opens the app, no snapshot is taken, and that day's history is
       permanently unrecoverable (directly conflicts with the spec's own §38 priority);
   (b) an OS-level cron/`launchd`/Task Scheduler job invoking a new CLI refresh command — keeps
       this application's existing "no in-app daemon" architecture unchanged, most reliable;
   (c) an in-app long-running background timer — a genuine change to this app's core architecture
       (every other feature assumes "runs only while a request/page is active"), would need its
       own ADR first, not something to introduce as a side effect of one feature's scheduling need.
   **Recommendation: (b), or (a)+(b) together as a safety net** — (b) does not require an ADR and
   fits the existing single-operator local-tool model.
2. **YouTube API quota budget for market intelligence.** Per §11, this phase shares the same
   10,000-unit/day project quota as everything else. **Recommendation:** a fixed, configurable
   daily unit reservation for market-intelligence collection (conservative default, e.g.
   1,000-2,000 units/day — leaves headroom for owned-channel sync and any future live writes),
   enforced by a new pre-call reservation check (new infrastructure, per §10), surfaced next to
   `cloud-quotas`' existing display rather than replacing it.
3. **Real (paid) AI usage for topic modeling (§13) and creative/visual analysis (§17).** Both
   plausibly need a real AI provider call (a vision-capable model for thumbnails, a classifier for
   topics) — the same category of decision as Phase 6's still-open "which real `LocalizationProvider`
   to fund" question (`docs/ai-localization/PROVIDER_INTEGRATION_PLAN.md`), never inferred from
   this planning pass. **Recommendation:** keep both AI-connection-optional from the start (mock
   provider produces a clearly-labeled placeholder derivation, exactly like `ai-localization`/
   `content-proposals` already do), defer any real spend until an explicit AI Connection is
   selected for this specific purpose.
4. **When `search.list`-based discovery (100 units/call) is authorized to run at all** — not
   before decisions 1 and 2 are made, since running it against an unbounded/unbudgeted schedule is
   exactly the failure mode §26 warns against. **Recommendation:** the first slices (9A/9B) use
   only `channels.list`/`videos.list` (1 unit/call) refreshing entities already on the manually-
   curated watchlist — this is a direct, cheap extension of what slice 3 already ships. Search-
   based discovery (9C) is a distinct, later, separately-approved step.
5. **Cross-device history transfer (`docs/TECHNICAL_DEBT.md` RISK-52).** This existing, already-
   accepted limitation ("doesn't travel with device handoff") becomes materially more consequential
   for Part II's new observation tables than it ever was for `creative_assets`/`content_proposals`
   — per the spec's own §38, "historical public data that is not collected today often cannot be
   reconstructed later," and losing it on a device switch is exactly that scenario, not a cosmetic
   gap. **Recommendation:** decide this explicitly when slice 9A/9B actually adds new tables (add
   them to `SNAPSHOT_TRANSFERRED_TABLES`, or accept the loss explicitly and record why) — do not
   let the new tables silently inherit the old default by omission.

## 13. Entity mapping — the owner spec's vocabulary onto this repository's actual/planned entities

| Spec entity (§2) | Maps to | Note |
|---|---|---|
| Watchlist (channels) | `research_channels` (existing, kept as-is) | Already shipped in Part I; PK is the real YouTube channel id, so it cannot represent a video/topic/query watchlist entry |
| Watchlist (videos/topics/queries) | New table(s), slice 9C | `research_channels`' shape doesn't generalize; a separate table per entity kind, not a shared polymorphic one (mirrors this codebase's own preference for explicit, typed tables over generic ones) |
| MarketObservation (structured, numeric) | New append-only `market_channel_snapshots`/`market_video_snapshots`, slice 9A | Never upserted (§10's central finding); `research_evidence` remains the free-text/qualitative/AI-summary log, not replaced |
| EvidenceReference | Existing `shared-provenance` `EvidenceReference`/`evidenceReferenceSchema` | Reused as-is (§10); `sourceType: "external_research"` already fits a public YouTube observation |
| DiscoveryCandidate | New table, slice 9C | Gated on owner decisions 1/2/4 above |
| Topic / TrendCandidate / NicheCandidate | New tables, slices 9E/9F | Gated on decisions 1-4 and on 9A/9B having accumulated enough real history to be meaningful at all |

## 14. Revised slice plan

Renumbered from the spec's own §35 (9A-9I), adjusted for what §10-§13 above actually found —
**this repository's own AGENTS.md §C requires the smallest safe next slice, not the whole extended
scope, even once assigned:**

- **9A — Structured, append-only market snapshot model.** New `market_channel_snapshots`/
  `market_video_snapshots` tables (real numeric columns — `subscriberCount`/`viewCount`/
  `videoCount`/`likeCount`/`commentCount` where available — `observedAt`, `source`), referencing
  `research_channels` for channels already on the watchlist. Pure, testable derived-metric
  functions (delta/velocity/age-normalized comparison, §8-§9 of the spec) computed at READ time
  from raw snapshots, in the style of `staleness.ts` — never stored as a second, redundant
  representation (per the spec's own §8: "prefer retaining raw observations so formulas can
  evolve later"). **Recommended first slice, per independent technical review of this plan** — the
  cheapest possible way to start building the irreplaceable history the spec's §38 prioritizes
  above everything else, using only what slice 3 already proved works (1-unit `channels.list`
  calls against an already-approved data flow).
- **9B — Repeatable refresh for already-watchlisted entities.** Extends the already-shipped
  one-shot "Fetch public snapshot" button into a repeatable capture (each run appends a new
  snapshot row, never overwrites) plus whichever scheduling mechanism the owner picks in decision
  1. Still `channels.list`/`videos.list`-only (1 unit/call) — no `search.list` yet.
- **9C — Discovery (search-based expansion).** Gated on owner decisions 1, 2, and 4. Discovery-
  candidate lifecycle states (new/watching/promoted/ignored/archived) as a state machine on a new
  table, not bolted onto `research_channels`.
- **9D — Historical intelligence (breakout/baseline/velocity/emerging-channel detection).** Pure
  functions over 9A/9B's raw snapshots. **Cannot be meaningfully acceptance-tested against real
  data until 9B has actually run for multiple real days** — see §15's acceptance-criteria split.
- **9E — Topics & trends.** Gated on owner decision 3 for anything beyond manual/keyword-based
  topic tagging (no AI-assisted classification without an explicit AI Connection).
- **9F — Niche discovery.** Depends on 9C-9E having accumulated enough real data to be meaningful
  — explicitly the least-ready slice; do not start it before that data exists.
- **9G — Agent interface.** A new `market_intelligence` capability domain
  (`AGENT_CAPABILITY_DOMAINS`), honoring the already-reserved `query_market_intelligence`/
  `query_competitors` capability names (never renamed). Any DRAFT-class "create research request"
  capability (spec §29) follows the Change Set `approvalStatus` pattern, not `content-proposals`'
  ungated create-only pattern (§10) — a human approves before any quota is spent. A new
  `ZONED_CAPABILITIES` entry is added at that point, and `AGENT_API_VERSION` bumped (minor).
- **9H — UI.** Overview/Channels/Videos/Trends/Opportunities — a natural extension of the
  already-shipped "Research" tab. Can usefully start as soon as 9A/9B produce real structured data
  (velocity/baseline figures) to display, well before 9C-9F exist.
- **9I — Operational hardening.** The spec's §27 data-quality vocabulary
  (`insufficient_history`/`missing_snapshot`/`stale_observation`/`deleted_video`/`private_video`/
  `hidden_subscriber_count`/`partial_discovery`/`quota_limited`) should be captured starting in 9A,
  not retrofitted later — "no data" is inherently ambiguous (§10's data-quality finding), and
  waiting to add this vocabulary risks the exact "already-collected-but-now-unlabeled" gap Phase
  8's own `analytics_collection_runs` was built specifically to avoid.

## 15. Acceptance criteria — split into a code-complete track and a live-data track

Mirrors this project's own established Gate B pattern (Phase 5's live-validation track, tracked
separately from "code-complete against mocked adapters") — necessary because several of the
spec's own §36 acceptance criteria (breakout detection, cross-channel trend evidence, emerging-
channel detection, age-normalized comparison) are, by construction, impossible to demonstrate
against real data the moment code is written; they require real observation history accumulated
over real days.

- **Code-complete against fixtures** (achievable per-slice, immediately): schema/service/route/
  MCP-tool tests using fixed, hand-derived fixtures (`AGENTS.md` §L — never copied from a draft
  implementation's own output) proving each pure derived-metric function computes correctly given
  a known synthetic observation history, and that every new write path stays inside this module's
  own structural boundary (a `write-path-inventory.test.ts`-style test, matching Part I's own
  pattern) with no path to `write-context`/`youtube-write-gateway`.
- **Live-data track** (separate, needs real multi-day history — never bundled into `npm test`):
  the spec's §36 criteria that genuinely require it (breakout/emerging-channel detection producing
  a real result against real accumulated snapshots; a `TrendCandidate` actually supported by
  multiple independent real observations; cross-channel evidence from real, independently-observed
  channels). **Passing the code-complete track is not evidence these live behaviors work** — the
  same distinction this project's own `AGENTS.md` §K.3 already draws for Gate B.

## 16. Non-goals (unchanged from the spec, restated for this plan's own record)

No Phase 10 decision/experiment engine; no automatic content generation, production, or
publishing; no revenue estimation or competitor CTR/retention/traffic-source claims of any kind,
estimated or otherwise; no mandatory graph or vector database; no opaque "score" without exposed
components — all restated directly from the spec's own §33/§34/§21, not reinterpreted.

## 17. What this Part II does not authorize

This is analysis and planning only, per the owner's own instruction. No code has been written for
anything in §12-§16 above. Each slice requires its own explicit future assignment, exactly as Part
I's slices 1-3 did (`AGENTS.md` §C) — recording this plan, or any backlog item derived from it as
`proposed`, is bookkeeping, never authorization (`docs/roadmap/BACKLOG.md`'s own stated rule).
