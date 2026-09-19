# Phase 9 Plan — Market Discovery & Trend Intelligence

Produced 2026-09-20 per `docs/roadmap/FUTURE_PHASES.md` §9's planning sequence, covering backlog
item `BL-004` (`docs/roadmap/BACKLOG.md`). **This is a plan, not an implementation.** Nothing
here authorizes writing discovery/collection code or calling any public YouTube data endpoint for
channels the operator does not own — that needs its own explicit assignment (`AGENTS.md` §C).

## 1. Current repository state relevant to this phase

- Every existing data model in this codebase (`channels`, `videos`, and everything downstream —
  `change_sets`, `changes`, `batches`) is scoped to **channels the authenticated operator owns**,
  enforced by `write-context.assertWriteChannel` and OAuth token ownership. Phase 9 is the first
  phase whose entire purpose is data about channels the operator does **not** own — this is a
  genuinely new trust/scope boundary, not an extension of an existing one.
- No public-data collection code exists anywhere in `src/`. The `googleapis` Data API v3 client
  already in use can read public channel/video data without write scope, so the API surface
  needed is not new — the missing piece is a *discovery* layer (deciding what to look at) and a
  *storage* layer (an evidence/watchlist model), not a new API client.
- `docs/PROJECT_SPEC.md`/`FUTURE_PHASES.md` both emphasize provenance and confidence for
  observational data — this is consistent with how `docs/ai-localization/` already tracks
  provenance for AI-generated proposals (`aiLocalizationGenerationProvenance` table) — that
  existing pattern (immutable, timestamped, linked to what produced it) is the closest analog to
  reuse for "why is this candidate on the watchlist."

## 2. Existing capabilities vs. missing dependencies

| Capability Phase 9 needs | Status |
|---|---|
| A Data API v3 client capable of reading public channel/video data | **Exists** (`googleapis`, already a prod dependency, already used read-only elsewhere) |
| A provenance/evidence-tracking pattern to imitate | **Exists** (`aiLocalizationGenerationProvenance`) |
| Any concept of "a channel/video the operator does not own" | **Missing entirely** — every current table implicitly assumes ownership; this needs a new, explicitly-not-owned entity, not a nullable field bolted onto `channels` |
| A discovery/prioritization mechanism | **Missing entirely** — needs its own design (see §3) |
| Freshness/confidence indicators | **Missing entirely** |

## 3. Smallest useful vertical slice

**A manually-seeded research watchlist with evidence records — no automatic discovery yet.**
Concretely: a `research_channels` table (distinct from `channels`, never merged with it — the
owned/not-owned boundary must stay structurally obvious, not a flag), each row carrying a
manually-entered channel ID/handle plus a free-text reason; and a `research_evidence` table
recording individual public observations (a video's view count on a given date, a title pattern
noticed, etc.) each linked to a `research_channels` row, with a `source` field and a
`collected_at` timestamp. Discovery logic (finding new candidates automatically) and any
scoring/ranking mechanism are later slices — this first one proves the storage model and the
provenance discipline before building anything that writes to it automatically.

## 4. Scope and explicit non-goals for this phase, once assigned

**In scope (eventually, on separate assignment):**
- `research_channels`/`research_evidence` tables, additive, structurally separate from
  `channels`/`videos`.
- Manual add-to-watchlist Web UI/API (operator pastes a channel ID/handle + reason).
- Public read-only fetch of that channel's basic public metadata (title, video count, etc. —
  whatever `channels.list`/`videos.list` already exposes without owner-level permissions) to
  populate an initial evidence record.

**Explicitly out of scope, regardless of how this phase eventually proceeds:**
- Automatic discovery/crawling of new candidates — needs its own resource-budget and
  prioritization design per `FUTURE_PHASES.md` §5's own constraint ("no arbitrary fixed
  competitor-list limit — use resource budgets, prioritization, and discovery rules instead"),
  which this first slice deliberately doesn't attempt to solve yet.
- Any private-analytics-shaped data (CTR, retention, revenue) — `FUTURE_PHASES.md` §5 explicitly
  forbids assuming access to a competitor's private analytics; every field in
  `research_evidence` must be something genuinely observable through a public API or a public
  page, never inferred or estimated as if it were measured.
- Any "this channel is profitable" or similar conclusion — publicly observed growth is
  explicitly not proof of profitability per the same constraint; this phase's evidence rows are
  raw facts with sources, never conclusions.
- Restricting discovery to music or any niche the operator's existing channels happen to be in —
  the watchlist's channel/reason fields must not assume any subject-matter category.

## 5. Interfaces, data structures, and security boundaries needed

- Additive tables, e.g.:
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
    observation TEXT NOT NULL,           -- e.g. "video X had N views on date D"
    source TEXT NOT NULL,                -- e.g. "youtube.videos.list", "manual observation"
    confidence TEXT,                     -- explicit, never silently assumed "confirmed"
    collected_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  ```
- Security boundary: `research_channels`/`research_evidence` must never be reachable from any
  write-capable code path — these rows describe channels the operator has no write authority
  over, and no future code should ever construct a `write-context` for one of them. An automated
  inventory test (same pattern as the Phase 5/6 write-path inventories) should prove this once
  implemented.
- No credential or OAuth token is needed to read public channel/video data via `videos.list`/
  `channels.list` beyond the existing API key or the operator's own already-granted read scope —
  confirm this doesn't require requesting any new scope (unlike Phase 8's Analytics work).

## 6. Proposed implementation slices (for whichever future assignment picks this up)

1. `research_channels`/`research_evidence` tables (additive migration) + tests.
2. Manual add-to-watchlist API route + minimal Web UI.
3. A single "fetch public snapshot" action populating one evidence row from `channels.list`/
   `videos.list` for a watchlisted channel.
4. (Separate, later assignment) automatic discovery, scoring/prioritization, and any Phase-10-
   facing "candidate opportunity" surface.

## 7. Acceptance criteria (drafted from the requirement, per `AGENTS.md` §L)

For slices 1-3 above, once assigned:
- A test proves `research_channels`/`research_evidence` are never joined against or written by
  any code path that also touches `write-context`/`assertWriteChannel` — the ownership boundary
  is structural, verified by an automated inventory, not just "we didn't write that code yet."
- Every `research_evidence` row created by the fetch action has a non-null `source` and
  `collected_at` — a test asserts the insert path rejects a record missing either.
- A negative test: attempting to add a `research_channels` row with an empty `reason` is
  rejected — this phase's own constraint against undocumented, unexplained watchlist entries is
  enforced by code, not by convention alone.

## 8. Required project-owner decisions before implementation can start

- Confirm the "manually-seeded, no auto-discovery" scope for the first slice matches intent, or
  specify a different starting point.
- Decide what "confidence" values are meaningful (a fixed enum vs. free text) before the schema
  is finalized — changing this after data exists is a non-additive schema change requiring an ADR.
- Explicit assignment to begin implementation.

## 9. Where this is recorded

This plan lives here, not in `docs/roadmap/BACKLOG.md` or `docs/roadmap/FUTURE_PHASES.md`, per
`FUTURE_PHASES.md` §9 step 9. `BL-004` points at this document once marked `done`.
