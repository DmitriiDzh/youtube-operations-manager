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
  surface starts relying on specific values.
- Exact Web UI placement for the watchlist panel (new dashboard tab vs. a Settings-adjacent
  panel) — decided at slice 2.
- Whether slice 4 (agent-facing MCP/CLI surface) is in scope for this same assignment or its own
  follow-up — decided once slices 1-3 are done and reviewed, per this plan's own §6.

## 9. Where this is recorded

This plan lives here, refreshed in place rather than superseded by a new document (per
`FUTURE_PHASES.md` §9's own instruction that a picked-up phase's detailed plan belongs in its own
plan document, not duplicated into `BACKLOG.md`/`FUTURE_PHASES.md`). `docs/roadmap/BACKLOG.md`
tracks the individual slices above as their own rows once assigned/in-progress/done;
`docs/ROADMAP_STATUS.md` records the actual outcome once slices complete and merge.
