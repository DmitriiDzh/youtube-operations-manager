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

This feature has a **read-only, one-directional, opt-in** dependency on
`analytics`/`market-intelligence` for this one validation step only — but, per §7's own
corrected design below, `decision-engine`'s own module code never imports either: the dependency
is realized entirely in the interface layer (the route file), which supplies an already-resolved
port to `decision-engine`'s own `addHypothesisEvidence`. This does not violate §M:
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
hypothesis's channel would be actively misleading) — decision-engine's own service-layer check
(never the resolver) compares this equality before the resolver is even called. When the
hypothesis's `channelId` is `null` ("new channel concept"), decision-engine imposes no restriction
of its own on which channel the reference names — but this does **not** mean "any of the caller's
own accessible channels" (an earlier draft of this section overclaimed that; corrected after
`advisor()` review). `analyticsCore.listMetrics` itself only allows the caller's own **active**
channel (`assertActiveChannel`, ADR 0004 — ` docs/decisions/0004-active-channel-read-scoping.md`),
already enforced internally, so a channel-less hypothesis can only ever successfully cite the
active channel's own metrics in practice, not an arbitrary owned channel the operator happens to
have. No new channel-access code needed either way — `listMetrics` already gates this correctly;
decision-engine's own contribution is only the `channelId`-equality comparison above. `phase9_*`
references need no channel check at all — Phase 9 watchlist data is never owned-channel data by
construction (`AGENTS.md` §F's boundary doesn't apply to it, same as every other Phase 9 read).

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
`assertHypothesisAccessible` (slice 1) for the channel check, never a new one.

**Corrected after `advisor()` review (an earlier draft of this section was wrong about where the
resolver lives):** `src/lib/decision-engine/services.ts` gains **no** new dependency on
analytics/market-intelligence at all — `addHypothesisEvidence` instead takes an
`EvidenceReferenceResolver` (a plain port defined in `decision-engine/contracts.ts`) as an
explicit extra parameter, supplied by the caller. The real implementation
(`createRealEvidenceReferenceResolver`) lives in
`src/app/api/decision-engine/evidence-reference-resolver.ts` — a sibling file OUTSIDE
`decision-engine/`'s own directory, so it can import `@/lib/analytics`/`@/lib/market-intelligence`
without ever making `decision-engine/**` itself do so (`AGENTS.md` §M; the same
`PHASE_9_PLAN.md` §5 precedent cited above). It takes its two cores as constructor arguments
(never a module-level singleton), which is what makes it independently testable against fake
cores — its own `evidence-reference-resolver.test.ts` is what actually proves §9's existence-check
criteria below; `services.test.ts`'s fake-resolver tests only prove `addHypothesisEvidence`
correctly delegates to whatever a resolver decides, not that the real resolver decides correctly.
The route file (`.../evidence/route.ts`) constructs the real resolver once, exactly like every
other route's `createAnalyticsCore()`/`createMarketIntelligenceCore()` call. This resolver is
also the file that records this app's new consumer of `@/lib/market-intelligence`
(`docs/SYSTEM_MAP.md` §2.9v's own "who imports this module" list, per `PHASE_9_PLAN.md` §5's own
requirement to name every such importer explicitly, never let it become a silent addition).

No MCP/CLI surface for structured evidence in this slice (mechanically verified,
`decision-engine-agent-approval-inventory.test.ts`'s `FORBIDDEN_AGENT_SYMBOLS` list now also
includes `addHypothesisEvidence`). Slice 2's `agent_get_hypothesis_trail` response widens
additively to also return `evidence` — per `AGENT_API_VERSION`'s own doc comment
(`src/lib/agent-operations/contracts.ts`, verified by reading it directly, not assumed): "Do NOT
bump for a purely additive, backward-compatible widening of an EXISTING capability's own contract
(e.g. a new optional input/output field an existing caller can simply ignore)" — exactly this
case, so `AGENT_API_VERSION` stays unchanged.

## 8. UI

The existing per-hypothesis detail view (`decisions-manager.tsx`, slice 1) gains a small "Add
structured evidence" form (source-type selector + the relevant identifying fields + optional
note) and a list of already-attached structured evidence, alongside the existing free-text
`evidenceNotes` display — additive, no existing UI removed or restructured.

## 9. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

**Service layer (`services.test.ts`, against a fake resolver — proves delegation, not real
existence-checking):**
- A reference the resolver confirms exists is accepted and stored; one it reports as not existing
  is rejected `validation_failed`, and no row is inserted.
- A `phase8_metric` reference whose `channelId` differs from a channel-scoped hypothesis's own
  `channelId` is rejected BEFORE the resolver is even called, even though the resolver would
  confirm it exists.
- A `phase8_metric` reference is accepted for a hypothesis with `channelId: null`, regardless of
  which channel it names — decision-engine itself imposes no restriction here (§5's own correction
  applies: the REAL resolver still only allows the active channel, this criterion is scoped to
  decision-engine's own logic, not the resolver's).
- `getHypothesisTrail` includes structured evidence alongside experiments/outcomes.
- `addHypothesisEvidence`/`listHypothesisEvidence` reject a session active on a different channel
  than a channel-scoped hypothesis.

**Real resolver (`evidence-reference-resolver.test.ts`, against fake `analyticsCore`/
`marketIntelligenceCore` — proves the actual existence-checking logic, found necessary by
`advisor()` review after the first draft only had fake-resolver coverage):**
- A `phase8_metric` reference to a real, existing `(videoId, metricDate, metricName)` row
  resolves `true`; the same video with a different `metricDate` or `metricName` resolves `false`.
- A `phase9_channel_snapshot`/`phase9_video_snapshot`/`phase9_trend_candidate` reference to a real
  existing id resolves `true`; to a fabricated id resolves `false`.
- A real channel-access failure from `listMetrics` (`CHANNEL_NOT_ACTIVE`) propagates as a real
  error, never silently swallowed into `false`.
- A `researchChannelId` not on the watchlist (`RESEARCH_CHANNEL_NOT_AVAILABLE`) resolves `false`
  (folded into the same "doesn't exist" outcome), rather than leaking a market-intelligence-
  specific error code out of a decision-engine route — a real gap `advisor()` found and this test
  now proves is fixed. Any OTHER error still propagates (never swallowed indiscriminately).
- Missing `ctx.userId` resolves `false` immediately, without calling either core.

**Cross-cutting:**
- `hypothesis_evidence` rows travel with a device-handoff snapshot (mirrors slice 1's own test for
  `hypotheses`/`experiments`/`experiment_outcomes`).
- `PHASE10-INV-03` (new, `decision-engine-inventory.test.ts`) proves `decision-engine/**` itself
  never imports `@/lib/analytics`/`@/lib/market-intelligence` — the structural-isolation test was
  **extended**, not left "unmodified" as an earlier draft of this section claimed (corrected after
  `advisor()` review). `PHASE10-INV-02` (`decision-engine-agent-approval-inventory.test.ts`,
  slice 2) is also widened, adding `addHypothesisEvidence` to its forbidden-agent-symbols list.

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
