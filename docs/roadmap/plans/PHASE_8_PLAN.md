# Phase 8 Plan — Intelligence Foundation

Produced 2026-09-20 per `docs/roadmap/FUTURE_PHASES.md` §9's planning sequence, covering backlog
item `BL-003` (`docs/roadmap/BACKLOG.md`). **This is a plan, not an implementation.** Nothing
here authorizes writing analytics-collection code, calling the YouTube Analytics API, or
performing OAuth — each needs its own explicit assignment (`AGENTS.md` §C) and, for OAuth
specifically, is separately gated (`AGENTS.md` §G).

## 1. Current repository state relevant to this phase

- `docs/PROJECT_SPEC.md` explicitly defers analytics: "Do not implement analytics prematurely
  during localization MVP" (§ around line 1325) and lists it as a later-phase item ("later
  analytics/publishing/AI workflows"). Phase 8 is that later phase.
- The `videos` table (`src/lib/db.ts`) stores only metadata synced from `videos.list`: title,
  description, `published_at`, `privacy_status`, language fields, thumbnails, localizations,
  `etag`, `last_synced_at`. **No performance metrics (views, watch time, CTR, subscriber deltas,
  retention) exist anywhere in the schema today.** Phase 8 is greenfield in this respect — there
  is no prior analytics code, table, or API client to preserve or extend (`AGENTS.md` §D doesn't
  apply defensively here; there's nothing yet to duplicate).
- No YouTube Analytics API client exists anywhere in `src/`. The only Google API surface in use
  today is the Data API v3 (`googleapis`, already a prod dependency) for channels/videos/
  playlists — the Analytics API is a distinct API surface requiring its own OAuth scope
  (`https://www.googleapis.com/auth/yt-analytics.readonly` at minimum), which the current OAuth
  consent flow does not request.
- `src/lib/channel-sync/` already establishes the pattern this phase should reuse: a
  scheduled/triggerable sync core, a `channels`/`videos`-shaped persistence layer, and a
  read-only Web UI/API surface with zero write capability. Phase 8 is structurally "channel-sync,
  but for metrics instead of metadata" — the existing module is the closest analog to imitate,
  not a new pattern to invent.

## 2. Existing capabilities vs. missing dependencies

| Capability Phase 8 needs | Status |
|---|---|
| A synced, channel-scoped video/channel data model to attach metrics to | **Exists** (`channels`/`videos` tables) |
| A read-only, scheduled/triggerable sync pattern to imitate | **Exists** (`src/lib/channel-sync/`) |
| An OAuth scope covering YouTube Analytics | **Missing** — current consent flow requests only Data API v3 scopes; adding a scope is a user-facing re-consent change, needs explicit owner sign-off |
| Any Analytics API client code | **Missing entirely** |
| Historical metrics storage (time-series, not just latest-value) | **Missing entirely** — the existing `videos` table is a "current snapshot" model (`last_synced_at` overwrites), not a history; Phase 8 needs an additive, non-overwriting table |
| Metric definitions / normalized time periods | **Missing** — must be defined before any code, per this plan's own acceptance criteria below |

## 3. Smallest useful vertical slice

**Historical view-count collection for already-synced videos, on manual trigger, with explicit
metric provenance — no scheduling, no comparison logic, no reports yet.** Concretely: a new
additive table (e.g. `video_metrics_daily`) storing one row per `(videoId, date, metric)`, a
YouTube Analytics API adapter that fetches `views` for a channel's already-synced videos over a
requested date range, and a manual "collect now" trigger (Web UI button + API route), mirroring
`channel-sync`'s existing manual-trigger pattern.

Deliberately excluded from this first slice: scheduled/automatic collection, any metric beyond
`views`, comparing videos "at comparable ages" (needs a well-defined cohort/age-alignment rule
first), and any report generation — each is its own later slice once the collection primitive
itself is proven.

## 4. Scope and explicit non-goals for this phase, once assigned

**In scope (eventually, on separate assignment):**
- The new re-consent flow for the Analytics read-only scope (explicit user-facing change,
  requires its own review — re-consent changes what a user is agreeing to, which is exactly the
  kind of thing `AGENTS.md` §F's spirit extends to even though it doesn't literally name OAuth
  scopes).
- An additive `video_metrics_daily`-style table (or equivalent), never replacing `videos`.
- A single Analytics adapter module (`src/lib/analytics/`, following the existing
  `contracts/schemas/services/adapters` pattern per `AGENTS.md` §D / `docs/DEVELOPMENT_PLAYBOOK.md`
  §6.2/§6.4 — no parallel Google-API-client pattern next to the existing Data API v3 one).
- Manual "collect now" trigger, read-only Web UI display of collected metrics.

**Explicitly out of scope, regardless of how this phase eventually proceeds:**
- Automatic/scheduled collection (needs its own design for retry/backoff/rate-limit behavior
  against Analytics API quotas, which differ from Data API v3's).
- Any "hypothesis" or "recommendation" logic — that's Phase 10, and `FUTURE_PHASES.md` §4's own
  constraint requires this phase to stick to "distinguish observed facts from
  interpretations/hypotheses explicitly," i.e. Phase 8 produces facts only.
- Comparing videos "at comparable ages" or any other analytical report — needs its own
  acceptance criteria once the underlying data actually exists to validate against.
- Hard-coding any channel identity or niche-specific metric logic, per `FUTURE_PHASES.md` §1's
  standing architectural principle.

## 5. Interfaces, data structures, and security boundaries needed

- New additive table, e.g.:
  ```sql
  CREATE TABLE IF NOT EXISTS video_metrics_daily (
    video_id TEXT NOT NULL REFERENCES videos(id),
    metric_date TEXT NOT NULL,      -- ISO date, the Analytics API's own reporting-day granularity
    metric_name TEXT NOT NULL,      -- e.g. 'views' -- never a bag of untyped columns
    metric_value INTEGER NOT NULL,
    collected_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (video_id, metric_date, metric_name)
  );
  ```
  A `metric_name` column (rather than one column per metric) keeps adding a new metric additive
  — no migration needed to add `watchTimeMinutes` later, consistent with this project's existing
  additive-schema-versioning approach (`docs/decisions/0002-additive-schema-versioning.md`).
- Channel-context validation: every metrics query must verify the requested video belongs to the
  currently-authorized channel, exactly as `AGENTS.md` §F requires for any `channelId`-scoped
  resource — this is not automatic just because the data is "read-only historical."
- The Analytics adapter needs the same `write-context` channel-identity check other adapters use
  before making any Analytics API call scoped to a specific channel's data.

## 6. Proposed implementation slices (for whichever future assignment picks this up)

1. Re-consent / new OAuth scope design and review (own decision point, see §8).
2. `video_metrics_daily` table (additive migration) + tests.
3. Analytics adapter (`src/lib/analytics/adapters/`) fetching `views` for a date range + tests
   with a fake/mocked Analytics response (no real API call in `npm test`, same discipline as
   every other adapter in this codebase).
4. Manual "collect now" API route + minimal Web UI display.
5. (Separate, later assignment) scheduling, additional metrics, comparable-age comparison,
   reports.

## 7. Acceptance criteria (drafted from the requirement, per `AGENTS.md` §L)

For slice 2-4 above, once assigned:
- A metrics-collection test proves the adapter never writes to `videos`/`channels` — read-only
  Data API v3 tables are untouched by this new Analytics path (channel-context isolation test,
  same shape as existing `write-path-inventory.test.ts` suites but for Analytics scope).
- A wrong-channel metrics request (video belonging to a different synced channel) fails closed
  with a structured `DomainError`.
- Re-running collection for a date range already collected is idempotent (upsert by the table's
  primary key), not a duplicate-row bug — this must be an explicit test, not assumed.
- No test performs a real Analytics API call; a fake/mocked HTTP layer proves the adapter's
  request-shaping and response-parsing logic independently of any real quota usage.

## 8. Required project-owner decisions before implementation can start

- Approve requesting the new Analytics OAuth scope — this changes what the consent screen asks
  existing and new users to grant, which is a user-facing change worth a deliberate decision, not
  an assumption.
- Confirm `views` alone is an acceptable first metric, or specify a different starting metric.
- Explicit assignment to begin implementation.

## 9. Where this is recorded

This plan lives here, not in `docs/roadmap/BACKLOG.md` or `docs/roadmap/FUTURE_PHASES.md`, per
`FUTURE_PHASES.md` §9 step 9. `BL-003` points at this document once marked `done`.
