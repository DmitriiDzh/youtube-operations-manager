# Phase 10 slice 3 — evidence auto-linking to real Phase 8/9 data

Continues on `feature/phase-10-decision-experiment-engine`. `AGENTS.md` §K.1's one-branch-per-
phase rule ("all of that phase's slices share ONE branch, merged into `dev` together once") is
what keeps this on the same branch as slices 1/2 — the "делаем всю фазу до конца в этой ветке"
quote itself was said specifically about Phase 9 Part II (2026-09-27), not Phase 10; corrected
here after `advisor()` flagged the earlier draft of this paragraph for misattributing it. Owner
said "продолжай" (Telegram, 2026-09-29) after slice 2 (agent-facing MCP/CLI surface) was reported
done.

**Mandatory reading for this slice's own scope** (`AGENTS.md` §A): `docs/roadmap/plans/
PHASE_10_PLAN.md` §5's original `evidence_refs_json` sketch; `docs/roadmap/plans/
PHASE_10_SLICE_1_PLAN.md` §2's deferred-evidence scope boundary and §4/§6 (status/routes, for
continuity); `docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md` (agent surface, for continuity — its
`PLANNED_FUTURE_CAPABILITIES` reservation of `create_hypothesis` is unaffected by this slice).
Read the actual current exported read surface of `src/lib/analytics/index.ts`/`services.ts`
(`listMetrics`, `StoredVideoMetricRow` shape) and `src/lib/market-intelligence/index.ts`/
`services.ts` (`listChannelSnapshots`/`listVideoSnapshots`/`listTrendCandidates`, all list-based —
no single "get by id" lookup exists in that module's current public surface for any of the three).
`listMetrics`' own function body (`src/lib/analytics/services.ts`) was read in full, not just its
signature/schema line — it already calls `deps.channelAccess.assertActiveChannel({userId,
channelId})` internally (via `getCredentialUserId(parsedInput.credentialRef)`), confirmed before
§5 below relied on that claim (an earlier draft of this plan asserted it from the signature alone,
without reading the body — `advisor()` caught this and it was verified properly before writing
this sentence). `docs/roadmap/plans/PHASE_9_PLAN.md` §5 was also read (grep + the actual
paragraph) to confirm the Phase 9 slice 4 precedent §4 below relies on: market-intelligence must
never become a hard dependency of another domain's own service layer.

## 1. What this slice does

A hypothesis can now cite **structured, validated references** into real Phase 8 (`video_metrics_daily`)
and Phase 9 (`market_channel_snapshots`/`market_video_snapshots`/`market_trend_candidates`) rows,
in addition to (never instead of) the free-text `evidenceNotes` field from slice 1. A brand-new
idea with no real data yet remains fully expressible with free text alone — this is strictly
additive, not a replacement.

## 2. Why a new table, not a JSON blob on `hypotheses`

A hypothesis can cite zero, one, or several pieces of structured evidence — a one-to-many
relationship, not a single field. Mirrors `research_evidence` (Phase 9)'s own shape: one row per
observation, linked to its parent by FK, rather than an array serialized into the parent row
(which this codebase's own `AGENTS.md` §F already flags as harder to validate/query and easier to
silently corrupt than real rows).

## 3. Reference shapes (discriminated by `source_type`, validated at creation, never at read time)

```
{ sourceType: "phase8_metric", channelId, videoId, metricDate, metricName }
{ sourceType: "phase9_channel_snapshot", researchChannelId, snapshotId }
{ sourceType: "phase9_video_snapshot", researchChannelId, snapshotId }
{ sourceType: "phase9_trend_candidate", trendCandidateId }
```

Every field is a real identifying field already returned by that module's own existing read
functions — none invented. Validation at creation time calls straight into
`createAnalyticsCore()`/`createMarketIntelligenceCore()`'s existing **list** functions (no new
"get by id" endpoint added to either module — reuse over a new API surface, `AGENTS.md` §D) and
checks the cited id is actually present in the result:
- `phase8_metric` → `analyticsCore.listMetrics({channelId, videoId})`, then check a row with the
  given `metricDate`/`metricName` exists.
- `phase9_channel_snapshot`/`phase9_video_snapshot` → `marketIntelligenceCore.listChannelSnapshots`/
  `listVideoSnapshots({researchChannelId})`, then check `snapshotId` is present.
- `phase9_trend_candidate` → `marketIntelligenceCore.listTrendCandidates()`, then check
  `trendCandidateId` is present.

A reference that fails validation is rejected with `validation_failed` at creation — never stored
half-valid, never silently dropped.

## 4. Module independence (`AGENTS.md` §M)

`decision-engine` gains a **read-only, one-directional, opt-in** dependency on
`analytics`/`market-intelligence` for this one validation step only. This does not violate §M:
- Hypothesis creation and every other decision-engine action (experiments, transitions, outcomes)
  never calls into either module — only creating a *structured evidence reference* does, and that
  is itself optional (a hypothesis with zero structured refs, only free text, never touches either
  module).
- No live cross-module query at *read* time — `hypothesis_evidence` rows store the already-
  validated reference fields verbatim; listing a hypothesis's evidence later never re-queries
  analytics/market-intelligence, so neither module needs to be "up" for existing evidence to keep
  displaying (only *adding new* structured evidence needs them).
- The dependency direction (decision-engine → analytics/market-intelligence) is new for this
  session but not circular — neither of those modules will ever import from `decision-engine`.

## 5. Channel scoping

`phase8_metric`'s `channelId` must equal the parent hypothesis's own `channelId` when the
hypothesis has one set (citing a different owned channel's metrics as if they were about this
hypothesis's channel would be actively misleading) — when the hypothesis's `channelId` is `null`
("new channel concept"), any of the caller's own accessible channels may be cited, subject to the
existing `assertActiveChannel` check analytics' own `listMetrics` already performs internally (no
new channel-access code needed — analytics already gates this correctly; decision-engine does not
need to duplicate that check, only to compare `channelId` equality when its own hypothesis is
channel-scoped). `phase9_*` references need no channel check at all — Phase 9 watchlist data is
never owned-channel data by construction (`AGENTS.md` §F's boundary doesn't apply to it, same as
every other Phase 9 read).

## 6. Schema (additive migration, v29 → v30)

```sql
CREATE TABLE IF NOT EXISTS hypothesis_evidence (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  source_type TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  note TEXT,
  created_via TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS hypothesis_evidence_hypothesis_id_idx ON hypothesis_evidence(hypothesis_id);
```

Append-only (mirrors `experiment_outcomes`/Phase 9 snapshot tables) — no update/delete function;
a wrong reference is superseded by adding a corrected one, never edited in place, consistent with
this codebase's "never silently rewrite a past observation" convention.

Added to `SNAPSHOT_TRANSFERRED_TABLES` (`src/lib/snapshot/contracts.ts`) in FK order, after
`hypotheses` and before nothing else references it — mirroring slice 1's own RISK-52-avoidance
discipline (added in the *first* commit, not a follow-up).

## 7. API / module surface

New route: `POST /api/decision-engine/hypotheses/[hypothesisId]/evidence` (create one structured
reference), `GET /api/decision-engine/hypotheses/[hypothesisId]/evidence` (list them) — both reuse
`assertHypothesisAccessible` (slice 1) for the channel check, never a new one. No MCP/CLI surface
for this in this slice (slice 2's agent surface already shipped `agent_get_hypothesis_trail`,
which is extended to also return `evidence` rows — no new MCP/CLI tool needed, just a wider
existing read).

`src/lib/decision-engine/services.ts` gains two new optional dependencies
(`analyticsCore`/`marketIntelligenceCore`, both real by default via `index.ts`, injectable for
tests) and `addHypothesisEvidence`/`listHypothesisEvidence`.

## 8. UI

The existing per-hypothesis detail view (`decisions-manager.tsx`, slice 1) gains a small "Add
structured evidence" form (source-type selector + the relevant identifying fields + optional
note) and a list of already-attached structured evidence, alongside the existing free-text
`evidenceNotes` display — additive, no existing UI removed or restructured.

## 9. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- A `phase8_metric` reference to a real, existing `(channelId, videoId, metricDate, metricName)`
  row succeeds.
- A `phase8_metric` reference to a non-existent combination (wrong date/metric name/videoId) is
  rejected `validation_failed`, and no row is inserted.
- A `phase8_metric` reference whose `channelId` differs from a channel-scoped hypothesis's own
  `channelId` is rejected, even if that metric row genuinely exists (for a *different* channel).
- A `phase8_metric` reference is accepted for a hypothesis with `channelId: null` regardless of
  which of the caller's own channels the metric belongs to.
- A `phase9_channel_snapshot`/`phase9_video_snapshot`/`phase9_trend_candidate` reference to a real
  existing id succeeds; to a fabricated id is rejected `validation_failed`.
- `hypothesis_evidence` rows travel with a device-handoff snapshot (mirrors slice 1's own test for
  `hypotheses`/`experiments`/`experiment_outcomes`).
- The decision-engine structural-isolation test (`decision-engine-inventory.test.ts`) still passes
  unmodified in its own no-db.ts-leak guarantee — importing `analyticsCore`/`marketIntelligenceCore`
  via their own public `index.ts` is not a violation of that test's rule (only a direct `db.ts`
  symbol reference from outside a module is), confirmed by reading what that test actually asserts
  before assuming this addition is safe.

## 10. Explicitly out of scope

- AI-suggested evidence (an AI agent recommending which real data to cite) — no such capability
  exists yet anywhere in this codebase for any module; out of scope for Phase 10 entirely per
  `PHASE_10_PLAN.md` §4.
- Automatically re-validating an existing `hypothesis_evidence` row if the underlying Phase 8/9
  row it references is later deleted (e.g. a watchlist channel removed) — the reference becomes a
  dangling but harmless historical record, same tradeoff this codebase already accepts elsewhere
  (e.g. Phase 9's own snapshot rows surviving a channel's removal in some cascades but not others,
  `docs/TECHNICAL_DEBT.md` RISK-66). Not addressed here; a future slice's own concern if it proves
  to matter in practice.
- Widening `experiment_outcomes`' own evidence/lessons-learned with the same structured-reference
  mechanism — the original plan only names hypothesis-level evidence; not expanded here without a
  clearer requirement basis.
