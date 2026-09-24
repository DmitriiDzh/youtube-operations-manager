# PHASE_7_ACCEPTANCE.md

**Status: retroactive/incremental acceptance contract, started 2026-09-24.** Owner spec §28 asks for a dedicated Phase 7 acceptance contract, produced before implementation. Slices A-I were implemented before this document existed; their acceptance criteria WERE derived from the spec per slice (each slice's own commit history and `docs/AGENT_OPERATIONS_INTERFACE.md` sections record this), just never consolidated into one document (`docs/AGENT_OPERATIONS_INTERFACE.md` §4i tracks this gap). Per that same §4i note, backfilling A-I's own scenarios into this document is deferred to slice J (independent security/integration review), not done here. **This document currently covers slice K only, written before K's implementation, per `AGENTS.md` §L** — L will be added the same way when it starts.

This document is derived strictly from:

- The recovered verbatim owner spec, §10 ("Comparable-content context") — "For decisions such as localization or creative generation, provide tools to retrieve relevant comparable owned content... Possible filters: same channel; same content family; similar topic; similar duration; similar publication period; similar target audience; similar metadata pattern; historical performance threshold. Do not hard-code a single comparison algorithm. The first implementation may use explicit filters and simple ranking. Do not prematurely build embeddings/vector search unless actual use cases require it."
- Owner spec §9 ("The exact metrics must follow the ACTUAL data currently collected. Do not invent unavailable metrics") and §23/§24 (context size/efficiency, freshness) — inherited unchanged.
- `AGENTS.md` §D (reuse existing modules, one owner per capability), §F (channel-scoping is never automatic), §L (spec-derived, independent testing), §M (feature-module independence).
- The project owner's explicit assignment of BL-088 into this phase (Telegram, 2026-09-24: "Да, такие находки как BL 88 и 89 тоже включай в список тасков текущей 7 фазы").

---

## 1. Scope boundary — slice K (comparable-content context, owner spec §10)

**In scope:** an anchor-based `find_comparable_videos` capability over already-synced, already-collected local data only (no live YouTube call). Filters that map to real, currently-collected data: same channel (mandatory anchor), publication-date proximity, duration proximity (new: durationSeconds sync, see §2 below), and an age-aligned performance-metric threshold (reusing the existing Phase 8 comparable-age analytics logic, never a second implementation). An explicit, named `titleTokenOverlap` signal (shared significant words between titles) stands in for "similar topic" — explicit and inspectable, never called "topic similarity" as if it were semantic understanding, and never embeddings/vector search (explicitly forbidden by the spec's own text above).

**Out of scope (not implemented, not claimed as implemented):**

- "Same content family" / "similar target audience" / "similar metadata pattern" — no data source exists for any of these (no series/family taxonomy, no audience classification, no structured metadata beyond title/description/tags-that-don't-exist). Not approximated; the capability description states plainly that these three are unsupported rather than silently ignoring the spec text.
- Embeddings, vector search, or any ML-based similarity — explicitly forbidden by owner spec §10 itself for a first implementation.
- Any live YouTube API call — this capability reads only already-synced local data (channel/video mirror) and already-collected analytics (`video_metrics_daily`), matching every other read-only agent-operations capability's own convention.
- Any write of any kind — this is a pure READ capability.
- Slice L (performance ↔ asset linkage, owner spec §16) — separately assigned, separately scoped, tracked in its own section of this document once started.

## 2. New persisted data: `videos.durationSeconds`

Owner spec §10 lists "similar duration" as an explicit filter. No duration field is currently synced from YouTube (`videos` table has no duration column; `contentDetails` is not among the parts requested by the batched `videos.list` sync call). Implementing the filter honestly (never inventing data) requires adding this field to the existing sync path — not a new subsystem, an additive extension of the already-existing Studio-parity `viewCount`/`commentCount`/`likeCount` sync precedent (`SCHEMA_MIGRATIONS` version 4).

- AC-DUR-01: a fresh channel sync fetches `contentDetails.duration` (ISO-8601, e.g. `"PT10M30S"`) for every video alongside the fields already fetched, and persists it as `durationSeconds` (integer, nullable).
- AC-DUR-02: an ISO-8601 duration string is parsed to whole seconds correctly for every unit (`P`/`Y`/`M`/`D`/`T`/`H`/`M`/`S` combinations YouTube can plausibly return); an unparseable or absent value is stored as `null`, never `0` (owner spec §9's "never invent unavailable data" principle, already established for `viewCount`/`commentCount`/`likeCount`'s own nullable convention).
- AC-DUR-03: a `"P0D"`/all-zero duration (YouTube's placeholder for an in-progress live broadcast/premiere with no fixed length yet) is stored as `null`, never a literal `0`-second fact.
- AC-DUR-04: a targeted single-video field patch (`src/lib/video-details/`'s `refreshVideoFields`, which merges its edit forward onto the current stored row for every field it doesn't itself touch) copies the CURRENT stored `durationSeconds` forward unchanged — this edit path never fetches `contentDetails` itself, and must never silently clobber a previously-synced duration back to `null`.
- AC-DUR-05: schema initialization against a fresh (empty) database, an existing pre-migration database, and the pre-versioning-database re-apply path (`docs/DEVELOPMENT_PLAYBOOK.md` §6.11) all succeed and produce the expected column, mirroring the existing `view_count`/`comment_count`/`like_count` migration test coverage.
- AC-DUR-06: `videos` is not in `SNAPSHOT_TRANSFERRED_TABLES` (confirmed unchanged, not a new gap this slice introduces) — a device-handoff snapshot never carries video rows at all, so this new column has no device-handoff-specific transfer concern beyond what already applies to every other video column.

## 3. `find_comparable_videos` scenarios

- AC-CMP-01: given `{ channelId, anchorVideoId }` with no further filters, returns other videos from the SAME channel only, excluding the anchor itself from the results.
- AC-CMP-02: an `anchorVideoId` that does not belong to the requesting `channelId` (or does not exist) fails with a not-available error, never silently falling back to "no anchor" or leaking whether it exists on another channel.
- AC-CMP-03: a `publicationWindowDays` filter excludes candidates whose `publishedAt` falls outside the requested distance (in days) from the anchor's own `publishedAt`, in either direction.
- AC-CMP-04: a `durationToleranceSeconds` filter excludes candidates whose `durationSeconds` differs from the anchor's own `durationSeconds` by more than the tolerance; a candidate (or the anchor itself) with `durationSeconds: null` is excluded from duration-filtered results (never treated as "0 duration" or "infinitely close"), and the response separately reports how many candidates were excluded for this reason (`excludedForMissingData.duration`) rather than silently shrinking the result set with no explanation.
- AC-CMP-05: a `performanceThreshold` filter (a named metric from the existing `ANALYTICS_METRIC_NAMES`, a comparison operator, and a value) is evaluated AGE-ALIGNED — at the same number of days-since-publish for every candidate as for the anchor — reusing the existing Phase 8 comparable-age logic (`analytics_comparable_age`) rather than a second, parallel age-alignment implementation (`AGENTS.md` §D). A candidate with no analytics coverage at that age is excluded and counted in `excludedForMissingData.performance`, never silently given a `0`/failing value.
- AC-CMP-06: `sort` is an explicit enum (e.g. `publicationProximity`, `durationProximity`, `performanceMetric`, `titleTokenOverlap`) — never a single hard-coded "best match" ranking, per the spec's own "do not hard-code a single comparison algorithm" instruction. Each candidate's response row reports the raw comparison facts behind whichever sort was requested (date delta, duration values, the metric's value the anchor is compared against, or the actual shared title tokens) — never a single opaque similarity score.
- AC-CMP-07: `limit` is capped at a fixed maximum; a request that would exceed it returns `truncated: true` with the capped result set, never an unbounded response (owner spec §23).
- AC-CMP-08: the whole capability performs local reads only — no live YouTube API call, verified by a fake dependency set that throws if any YouTube-calling function is invoked.
- AC-CMP-09: `channelId` is checked against the caller's active channel at the MCP/CLI layer before the service is ever called, mirroring every other channel-scoped capability in this interface (`AGENTS.md` §F) — the service itself does no such check (consistent with this module's established convention).
- AC-CMP-10: the capability's own description explicitly states that "same content family," "similar target audience," and "similar metadata pattern" are NOT supported (no data source exists), rather than silently omitting them from the response with no explanation.

## 4. Deliberately not verified here

- Real YouTube OAuth/live API behavior for `contentDetails.duration` on an actual account (no live Google login available in this environment, `AGENTS.md` §G) — verified against this codebase's own parsing logic and documented ISO-8601 duration grammar only.
- Slice L's own acceptance criteria (added separately when that slice starts).
- A-I's backfilled scenarios (deferred to slice J per `docs/AGENT_OPERATIONS_INTERFACE.md` §4i).
