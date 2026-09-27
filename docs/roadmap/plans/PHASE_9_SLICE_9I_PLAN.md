# Phase 9 slice 9I — data-quality vocabulary (operational hardening)

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§27 and `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9I definition ("the spec's §27 data-quality
vocabulary... should be captured starting in 9A, not retrofitted later"), per `AGENTS.md` §L.
Taken next (ahead of 9F/9G/9H) per advisor review: every additional slice that reads Phase 9 data
without this shared vocabulary makes the eventual retrofit larger, and 9H (UI) and 9G (agent
interface) both need a single, consistent set of quality labels to surface rather than each
inventing its own.

## 1. Scope boundary

**A single shared vocabulary type plus pure derivation functions, computed at READ time from facts
this phase's own tables already record — no new schema, no rewrite of any existing write path.**
Mirrors 9A's `derived-metrics.ts` / 9D's `historical-intelligence.ts` precedent exactly: this module
ships with **zero real callers** in this slice (9H is where these functions get their first caller,
per `PHASE_9_PLAN.md` §14's own note that 9D's functions get their first caller there too — folding
9I's UI wiring into 9H rather than inventing a UI surface here without an assigned consumer).

**The actual problem this slice solves:** 9A-9E already independently produce several of the spec's
own §27 signals, but each as its own bespoke, ad-hoc local shape:

- `hiddenSubscriberCount` — a raw boolean column on `market_channel_snapshots` (9A).
- `basis: "not_yet_reached" | "insufficient_history" | "observed"` — `computeAgeNormalizedViews`'s
  own return shape (9D).
- `status: "skipped_quota_limited"` — a string literal on `market_intelligence_collection_runs`
  (9B) and the `MARKET_INTELLIGENCE_QUOTA_DISABLED`/`_EXCEEDED` `DomainErrorCode`s (9C).
- A discovery run recording partial `candidatesFound`/`candidatesNew` before a mid-loop failure (9C,
  `756f1c4`'s own fix).

None of these share one name, one type, or one place an agent/UI can read "what's wrong with this
observation" from generically. This slice's job is to **collapse them into one named union other
code can pattern-match on**, and to add pure derivation for the two spec items nothing yet computes
at all (`missing_snapshot`, `stale_observation`) — not to change what any of 9A-9E's services already
do or store.

## 2. The shared vocabulary (`DataQualityFlag`, `src/lib/market-intelligence/contracts.ts`)

```ts
export type DataQualityFlag =
  | "insufficient_history"
  | "missing_snapshot"
  | "stale_observation"
  | "video_no_longer_public"
  | "hidden_subscriber_count"
  | "partial_discovery"
  | "quota_limited";
```

**Seven entries, not the spec's literal eight — a documented discrepancy, not a silent drop
(`AGENTS.md` §A: "identify and report the discrepancy... do not silently rewrite requirements to
match an incomplete implementation").** The spec's own `deleted_video`/`private_video` are collapsed
into one `video_no_longer_public` flag.

**Correction (2026-09-27, later the same day -- the original version of this section overstated its
own evidence).** The claim below was first written as "confirmed against the API's own documented
behavior." Re-checked directly against the official docs (fetched both pages, not assumed): the
`videos.list` reference page does not describe per-id behavior for a multi-id request at all, and
`playlistItems.list` (the other real call 9B's own collector makes) has a `status.privacyStatus`
field whose behavior for a since-deleted video is likewise undocumented there. **What is actually
true, and narrower than the original claim:** this codebase's own `listUploadsPlaylistFirstPageVideoIds`
(`src/lib/youtube-read-gateway/data-api.ts`) requests only `part: ["contentDetails"]` from
`playlistItems.list` -- it never requests `snippet`/`status`, so no `privacyStatus` signal reaches
this codebase today regardless of whatever that field might contain for a deleted video. Whether
requesting that part would even resolve deleted-vs-private is itself unconfirmed (undocumented, and
a decisive answer needs a real API call against a known-deleted and a known-private video id, which
spends real quota and was not authorized for this purpose here). The collapse to
`video_no_longer_public` remains this module's own honest design choice either way -- exposing the
one thing this codebase's actual calls can observe ("this previously-known video id no longer comes
back") without fabricating a split it does not have evidence for -- but the discrepancy note itself
must say "undocumented, unverified, and not currently requested," not "confirmed." `PHASE_9_PLAN.md`
§10's own related finding ("a public `channels.list`/`videos.list` response omitting a video means
either 'never observed' or 'now deleted/private' — genuinely indistinguishable without a separate
record of the attempt itself") predates this session and was not independently re-verified here
either -- it should be read with the same caveat until someone does.

**If the project owner later wants the two split**, the only honest path is a manual, operator-set
distinction recorded the same way `research_evidence` already records manual observations — never an
auto-detected split this codebase cannot actually make. This is recorded here as the discrepancy
report `AGENTS.md` §A requires, not resolved unilaterally.

## 3. New pure functions (`src/lib/market-intelligence/data-quality.ts`)

Zero I/O, `now` always an explicit argument (matches `derived-metrics.ts`/`historical-intelligence.ts`).

- **`assessObservationFreshness(lastObservedAt: Date | null, now: Date, staleAfterMs: number):
  DataQualityFlag | null`** — returns `"stale_observation"` when `lastObservedAt` is older than
  `staleAfterMs` (reuses the same `MARKET_INTELLIGENCE_STALE_WINDOW_MS` constant `services.ts` §9B
  already defines for its own staleness check — imported, never redefined, per `AGENTS.md` §D "one
  guardrail"), `null` when fresh, and `null` (not a flag) when `lastObservedAt` is itself `null`
  (that is `missing_snapshot`'s job below, a different fact: "never observed" vs. "observed, but a
  while ago").
- **`assessSnapshotCompleteness(videosRequested: number | null, videosReturned: number | null):
  DataQualityFlag | null`** — returns `"missing_snapshot"` when both are non-null and
  `videosReturned < videosRequested` (some of a channel's enumerated videos yielded no snapshot at
  all this run — the exact `market_intelligence_collection_runs` columns 9B already writes, unused
  as a quality signal until now), `null` otherwise (including when either is `null`, since that
  means the channel was never actually collected at all, a case the caller's own absence-of-any-run
  check already covers, not something this function should re-report).
- **`assessDiscoveryRunQuality(run: { status: "success" | "failed"; candidatesFound: number | null
  }): DataQualityFlag | null`** — returns `"partial_discovery"` when `status === "failed"` AND
  `candidatesFound` is a positive number (progress was made before the failure — 9C's own
  `756f1c4` fix is what makes this fact recoverable at all), `null` for a clean `"failed"` (zero
  progress) or any `"success"`.
- **`toHiddenSubscriberCountFlag(hiddenSubscriberCount: boolean): DataQualityFlag | null`** — trivial
  wrapper (`hiddenSubscriberCount ? "hidden_subscriber_count" : null`), so a caller can fold this
  9A fact into the same generic flag list as everything else instead of special-casing it.
- **`toAgeNormalizedBasisFlag(basis: "not_yet_reached" | "insufficient_history" | "observed"):
  DataQualityFlag | null`** — trivial wrapper mapping 9D's own `basis` value
  (`computeAgeNormalizedViews`/`computeChannelVideoBaseline`) onto `"insufficient_history"` for
  either non-`"observed"` case (`not_yet_reached` is also, from a consumer's perspective, "not
  enough history yet" — the spec's own vocabulary has no separate item for "too early", and inventing
  one un-asked-for would violate `AGENTS.md` §F's localization-mechanism-style "never extend beyond
  what's asked" discipline applied here to a vocabulary, not a data field).
- **`detectDisappearedVideoIds(previousVideoIds: readonly string[], currentVideoIds: readonly
  string[]): string[]`** — a pure set-difference (`previousVideoIds` not in `currentVideoIds`),
  returning the ids a caller should label `"video_no_longer_public"`. Ships with **no real caller in
  this slice** — the caller needs the same before/after enumeration a real 9B collection run
  produces, which is a service-layer wiring decision belonging to 9H (its first consumer), exactly
  like 9D's own functions waited for their first caller.

## 4. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- **AC-9I-01:** `assessObservationFreshness` returns `null` for a `lastObservedAt` exactly at the
  staleness boundary minus 1ms, and `"stale_observation"` exactly at/after the boundary — hand-
  derived from the same boundary semantics `runCollectionIfStale`'s own staleness check already
  uses (`>=`, not `>`), never copied from reading that function's own output.
- **AC-9I-02:** `assessObservationFreshness` returns `null` (not a flag) for `lastObservedAt: null`.
- **AC-9I-03:** `assessSnapshotCompleteness` returns `"missing_snapshot"` for `(5, 3)`, `null` for
  `(5, 5)`, and `null` for `(null, null)`/`(5, null)`/`(null, 3)` (any null input).
- **AC-9I-04:** `assessDiscoveryRunQuality` returns `"partial_discovery"` for
  `{status: "failed", candidatesFound: 2}`, `null` for `{status: "failed", candidatesFound: 0}`,
  `null` for `{status: "failed", candidatesFound: null}`, `null` for `{status: "success",
  candidatesFound: 10}`.
- **AC-9I-05:** `toHiddenSubscriberCountFlag(true) === "hidden_subscriber_count"`,
  `toHiddenSubscriberCountFlag(false) === null`.
- **AC-9I-06:** `toAgeNormalizedBasisFlag` maps `"not_yet_reached"` and `"insufficient_history"` both
  to `"insufficient_history"`, and `"observed"` to `null`.
- **AC-9I-07:** `detectDisappearedVideoIds(["a","b","c"], ["a","c"])` returns exactly `["b"]`;
  `detectDisappearedVideoIds([], ["a"])` returns `[]`; `detectDisappearedVideoIds(["a"], [])`
  returns `["a"]`.
- **AC-9I-08 (negative/boundary):** every function above returns a value from the `DataQualityFlag`
  union or `null` — never `undefined`, never a fabricated flag not in the union (schema-checked via
  the union type itself, no runtime validation needed for pure internal functions per this module's
  own `derived-metrics.ts`/`historical-intelligence.ts` precedent, neither of which validates its
  own pure-function outputs at runtime either).

## 5. Explicitly out of scope for 9I

- **No new service action, API route, MCP tool, or UI.** These functions are pure and uncalled by
  real request-handling code until 9H wires them into the Research tab (and, per spec §28,
  `query_market_intelligence`/agent-facing MCP surfaces in 9G) — matches 9D's own precedent.
- **No auto-detected split of `deleted_video`/`private_video`** — see §2's discrepancy note. Not
  revisited without a fresh, explicit owner decision naming the manual mechanism, since the current
  spec text assumes an API capability this codebase's research found does not exist.
- **No live-data verification.** These are pure, hand-fixture-tested functions exactly like 9D's own
  (BL-105 applies identically) — `assessObservationFreshness`/`assessSnapshotCompleteness` are
  trivial enough that live verification adds little beyond what deterministic fixtures already
  prove, but the general caveat is recorded for consistency with every other 9D/9E function's own
  documented limitation.
- **No change to any existing 9A-9E write path, schema, or stored shape.** Purely additive.

## 6. Files

- New: `src/lib/market-intelligence/data-quality.ts` + `data-quality.test.ts`.
- Extended: `src/lib/market-intelligence/contracts.ts` (`DataQualityFlag` type export only).
