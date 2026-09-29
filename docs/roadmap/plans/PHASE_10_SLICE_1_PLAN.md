# Phase 10 slice 1 — Decision & Experiment Engine: record-keeping foundation

Phase 10's first-ever implementation slice (this phase has been planning-only since
`docs/roadmap/plans/PHASE_10_PLAN.md`, 2026-09-20 — nothing under `src/` exists for it yet).
Assigned by the project owner directly, Telegram, 2026-09-29: "Создай новую ветку и приступай к
планированию и реализации фазы 10." Branch: `feature/phase-10-decision-experiment-engine`, from
`dev`'s tip (which already carries Phase 9 Part II, merged the same session).

**Mandatory reading completed for this slice** (`AGENTS.md` §A — a new subsystem/module
boundary), corrected after `advisor()` caught an overclaim in an earlier draft of this list (this
paragraph states only what was actually read, not what should have been): `docs/PROJECT_SPEC.md`
(Rules 1-18; nothing there names Phase 10 specifically — it predates Phases 7-10 and covers the
YouTube-write pipeline this slice does not touch), `docs/ROADMAP_STATUS.md` (confirms Phase 8/
Phase 9 Part I+II are both actually `DONE`, not merely planned), `docs/SYSTEM_MAP.md` §2.9i
(Phase 8 Analytics — the correct section number; an earlier draft cited "§14", which is actually
an `ARCHITECTURE.md` section, a stale citation caught before commit) and the market-intelligence
sections (what real evidence sources now exist), `docs/ARCHITECTURE.md` §3 (module layering, read
in full) and §18 (Market Intelligence, read in full — the structural-isolation-test pattern and
the device-handoff/`SNAPSHOT_TRANSFERRED_TABLES` lesson from RISK-52/RISK-79 directly shaped §5a/
§6 below), `docs/DEVELOPMENT_PLAYBOOK.md` §§6.2/6.3/6.6/6.9/6.11/6.12/6.14 (read in full),
`docs/TECHNICAL_DEBT.md` (grepped for "Phase 10"/"decision"/"hypothes"/"experiment" — zero
matches, confirmed no existing open risk references this phase), `docs/decisions/README.md`
(confirms a new domain module following the standard `contracts/schemas/services/adapters`
pattern does **not** need an ADR) and 0002 (additive schema versioning)/0004 (active-channel read
scoping), both read in full since both apply directly below.

## 1. What the requirement actually says (`FUTURE_PHASES.md` §6, not just the 2026-09-20 plan's own schema sketch)

`docs/roadmap/plans/PHASE_10_PLAN.md` predates a close re-read of `FUTURE_PHASES.md` §6's own
"Core entities" list, and its draft schema sketch materially simplifies that list — worth
recording explicitly (`AGENTS.md` requires reporting a documentation/requirement discrepancy
rather than silently picking one side):

> Hypothesis / Evidence / Experiment / Outcome / **Decision is not named as a distinct entity
> in §6** — "approval status" is listed as one of `Experiment`'s own fields, not a separate
> record. `PHASE_10_PLAN.md`'s own sketch instead invented a `decisions` table conflating
> approval (`approved_by`/`approved_at`) with outcome (`outcome`/`outcome_recorded_at`) into one
> row. §6 also names **Retrospective** as its own entity ("what was learned... an AI agent may
> never silently rewrite a past outcome or piece of evidence"), which the 2026-09-20 sketch does
> not mention at all.

This slice follows `FUTURE_PHASES.md` §6 over the older sketch where they disagree, since §6 is
the actual product requirement Phase 10 traces to (`AGENTS.md`: "`docs/PROJECT_SPEC.md`
[equivalent role held by `FUTURE_PHASES.md` here] is the source of truth for what is required").

## 2. Scope boundary for this slice

**In scope:** `hypotheses`, `experiments`, `experiment_outcomes` — manual entry only, human types
into a form. Full entity separation per §6 (hypothesis ≠ evidence-as-a-row ≠ experiment ≠ outcome
≠ retrospective), but **evidence** stays a free-text field on the hypothesis for now (not its own
table) — auto-linking it to real Phase 8/9 rows is explicitly deferred (§4 below), and a real
"evidence" entity table with no way to populate it automatically would be dead weight today.
**Retrospective** is folded into the same outcome-recording action as one additional field
(`lessonsLearned`), not a fifth table — recorded by the same person at the same time as the
outcome in practice, and splitting it into its own table today would only matter once either (a)
multiple retrospectives per outcome are needed, or (b) an AI-authored retrospective distinct from
the human's own is needed — neither exists yet. Both simplifications are named here, not silent.

**Explicitly out of scope, per `PHASE_10_PLAN.md` §4 (unchanged by this slice):**
- Any AI-generated hypothesis/recommendation.
- Automatic/controlled execution of an approved experiment.
- Evidence auto-linking from real Phase 8 (`video_metrics_daily`) or Phase 9
  (`market_channel_snapshots`/`market_trend_candidates`/etc.) rows — a later, separate slice, now
  that both are real (tracked as a natural next-slice candidate, not created as a backlog row
  here since no owner assignment exists for it yet, per `AGENTS.md` §C).
- **MCP/CLI agent surfaces.** `FUTURE_PHASES.md` §6 explicitly calls for Codex-class agents to
  propose hypotheses, attach evidence, create experiment drafts, and produce retrospectives — none
  of that is built here. Named explicitly (found by `advisor()` review) so this doesn't become a
  silent RISK-04-style parity gap the way MCP/CLI support for other modules sometimes lagged their
  Web UI — it is a deliberate next slice, not an oversight.

## 3. Schema (additive migration, `SCHEMA_CURRENT_VERSION` 28 → 29 — confirmed the current max via `src/lib/db.ts` before writing this, per `docs/decisions/0002-additive-schema-versioning.md`)

```sql
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(id),  -- nullable: "new channel concept" has no channel yet
  statement TEXT NOT NULL,
  evidence_notes TEXT NOT NULL,             -- free-text manual justification (see §2)
  created_by TEXT NOT NULL,                 -- real identity (session user id), never a default
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  treatment TEXT NOT NULL,
  control_baseline TEXT NOT NULL,
  success_criteria TEXT NOT NULL,           -- required, FUTURE_PHASES.md §6 + PHASE_10_PLAN.md §7 AC
  stopping_criteria TEXT NOT NULL,          -- required, same
  start_conditions TEXT,
  planned_duration TEXT,
  sample_coverage_constraints TEXT,
  budget_estimate TEXT,
  responsible TEXT NOT NULL,                -- real identity, human or named agent
  status TEXT NOT NULL DEFAULT 'proposed',  -- see §4 for the enum + transition rules
  approved_by TEXT,                         -- set only by the approve action (§5), never at creation
  approved_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS experiment_outcomes (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  recorded_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  outcome_data TEXT NOT NULL,               -- actual data / comparison against baseline
  data_quality_limitations TEXT,
  criteria_met TEXT NOT NULL,               -- 'met' | 'not_met' | 'inconclusive'
  lessons_learned TEXT                      -- retrospective, folded in per §2
);
```

`experiment_outcomes` is **append-only**, mirroring this codebase's established pattern for
"never silently rewrite a past observation" (`market_channel_snapshots`/`market_video_snapshots`,
Phase 9) — no `updateOutcome`/`deleteOutcome` function is written. A correction is a new row, not
an edit, which is exactly what §6's "an AI agent may never silently rewrite a past outcome"
requires structurally, not just by convention. An experiment can accumulate more than one outcome
row over its lifetime (e.g. an interim read, then a final one) — nothing in this slice assumes
exactly one.

`decisions.outcome`/`outcome_recorded_at`-cannot-be-set-at-creation (`PHASE_10_PLAN.md`'s own §7
acceptance criterion) is satisfied structurally here by construction: `experiment_outcomes` rows
don't exist until the separate outcome-recording action inserts one — there is no field on
`experiments` itself that outcome data could leak into at creation time.

## 4. `experiments.status` — enum and transition rules

Values: `proposed | approved | running | concluded | abandoned` (as sketched in the original
plan, confirmed with the owner via Telegram before this slice started).

Transition table (`assertValidStatusTransition`, a pure function, unit-tested directly):

| From | Valid next states | Rationale |
|---|---|---|
| `proposed` | `approved`, `abandoned` | A proposal can be approved, or dropped before ever running — no experiment silently starts `running` without an approval step. |
| `approved` | `running`, `abandoned` | Approved-but-not-yet-started can still be abandoned (budget pulled, priorities changed) before real execution begins. |
| `running` | `concluded`, `abandoned` | A running experiment ends either by reaching its own stopping criteria (`concluded`) or by being cut short (`abandoned`) — both are terminal from here. |
| `concluded` | *(none — terminal)* | Matches §6's "may never silently rewrite a past outcome" spirit extended to status: a concluded experiment's own lifecycle is over: a new hypothesis/experiment picks up whatever comes next. |
| `abandoned` | *(none — terminal)* | Terminal, same reasoning. |

No transition skips `approved` on the way to `running` — this is the structural human-approval
gate `FUTURE_PHASES.md` §6 requires ("Human approval is preserved before any consequential
execution, until the project owner explicitly changes that"). `approved_by`/`approved_at` are set
**only** by the transition into `approved`, enforced in the same service function that performs
the transition (never settable directly via a generic "update experiment" call — there isn't
one; only `createExperiment` and `transitionExperimentStatus` exist).

**Atomicity (`advisor()` finding — a read-then-write transition lets two concurrent callers both
"succeed", the second silently overwriting the first's `approved_by`):** `transitionExperimentStatus`
does one atomic `UPDATE experiments SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?
AND status IN (<valid predecessor statuses for the target>) RETURNING *` — the exact pattern
`approveMarketResearchRequestIfPending` (`src/lib/db.ts`, Phase 9) already uses for the identical
race. `approved_by`/`approved_at` are only included in the `SET` clause when the target is
`approved`. Zero rows returned means the transition was invalid *at the moment it actually ran*
(not necessarily at the moment the caller last read the status) — the service throws
`EXPERIMENT_INVALID_TRANSITION` with the row's real current status (a cheap follow-up `SELECT`,
for a useful error message only, never used to decide whether the transition itself succeeded).

**Which statuses allow outcome recording (`advisor()` finding — not decided in the first draft):**
only `running`, `concluded`, and `abandoned`. A `proposed` or `approved` experiment has not
actually run yet, so recording an "outcome" for one would be fabricated data, not an observation —
rejected with `EXPERIMENT_NOT_OBSERVABLE`. `concluded`/`abandoned` remain outcome-recordable
(not just `running`) specifically so "what we learned from stopping early" / a final read after
`concluded` can still be recorded.

## 5. Channel-context validation — all six routes, not just create (`advisor()` finding)

An earlier draft of this plan only guarded hypothesis *creation*. Per `docs/decisions/
0004-active-channel-read-scoping.md`/`docs/TECHNICAL_DEBT.md` RISK-02, a **read** leaks exactly
as much as an unguarded write if it returns another channel's data to an unrelated session — every
route below needs the check, via one shared service guard, not six separately-written ones:

- `assertHypothesisAccessible(hypothesisId, {userId})` — loads the hypothesis, throws `not_found`
  if it doesn't exist, calls `channelAccess.assertActiveChannel({userId, channelId})` only if
  `channel_id` is non-null, returns the row. Used by `GET /hypotheses/[id]`, `POST
  /hypotheses/[id]/experiments`, and `GET /hypotheses/[id]/experiments`.
- `assertExperimentAccessible(experimentId, {userId})` — loads the experiment, resolves its
  parent hypothesis, delegates to the same channel check as above (an experiment has no
  `channel_id` of its own — it inherits its parent hypothesis's). Used by `GET /experiments/[id]`,
  `POST /experiments/[id]/transition`, `GET/POST /experiments/[id]/outcomes`.
- `GET /hypotheses` (list): **not** `channelAccess.filterToActiveChannel` directly — that helper
  requires a non-nullable `channelId` on every item, which this list doesn't have. A small local
  filter keeps a row if `channel_id` is `null` OR `channel_id === activeChannelId`, mirroring
  `filterToActiveChannel`'s own "narrow to active, empty active channel yields nothing scoped"
  behavior for the non-null rows while never hiding channel-less rows (there's nothing to scope
  them by).
- Hypothesis/experiment **creation** keeps the check it already had (`assertActiveChannel` when
  `channel_id`/the parent hypothesis's `channel_id` is non-null).

One hand-written cross-channel-access test per route shape (`DEVELOPMENT_PLAYBOOK.md` §6.6 point
8), not just for creation.

## 5a. Device handoff — travels with the snapshot, from this slice's first commit (`advisor()` finding)

RISK-52 hit every single Phase 9 slice from 9A onward — each one added a new table without adding
it to `SNAPSHOT_TRANSFERRED_TABLES`, silently leaving it device-local until a dedicated fix pass
caught up much later (`docs/TECHNICAL_DEBT.md` RISK-52/RISK-79). Decision/experiment records are
exactly the kind of "cannot be reconstructed later" history Phase 9's own fix reasoning applies to
— not repeating that gap here means doing it in the *first* commit, not a follow-up:

- `hypotheses`, `experiments`, `experiment_outcomes` added to `SNAPSHOT_TRANSFERRED_TABLES`
  (`src/lib/snapshot/contracts.ts`), in FK order (matching RISK-46's own "FK-ordering bug" lesson:
  a referenced row must be inserted before the row that references it).
- A travels-with-snapshot test mirroring `snapshot/services.test.ts`'s existing Phase 9 one.
- This module's own structural-isolation test (§6 below) gets the same narrow
  `isExemptReference`-style exemption `PHASE9-INV-02` gives `snapshot/contracts.ts` — snake_case
  raw table-name strings only, never a camelCase business-logic symbol.

## 6. Module layout and API routes

New domain module `src/lib/decision-engine/` (`FUTURE_PHASES.md` §6's own phase title —
"Decision & Experiment Engine" — the source of the name), following `AGENTS.md` §D/§M and
`DEVELOPMENT_PLAYBOOK.md` §6.2's standard five-piece layering unchanged:
`contracts.ts`/`schemas.ts`/`services.ts`/`adapters/store.ts`/`index.ts`, plus a structural
isolation test (`decision-engine-inventory.test.ts`, mirroring `PHASE9-INV-02`'s pattern) proving
no file outside this module references its own `db.ts` symbols directly — `AGENTS.md` §M requires
this module be independently disable-able without breaking the rest of the app, and this is the
same mechanical enforcement Phase 9 already uses, not a new invented mechanism.

Routes are **global**, not nested under `/api/channels/[channelId]/...` — unlike most channel-
scoped resources (§6.6's own reference shape), a hypothesis is only *sometimes* channel-scoped
(§5), so there is no `channelId` to put in every URL path the way there is for e.g. change sets.
This mirrors `src/lib/market-intelligence/`'s own routing shape (`/api/market-intelligence/...`,
global, channel-optional-or-absent), adapted here for "optionally scoped to an owned channel"
rather than market-intelligence's "never scoped to an owned channel at all":

- `GET/POST /api/decision-engine/hypotheses`
- `GET /api/decision-engine/hypotheses/[hypothesisId]`
- `GET/POST /api/decision-engine/hypotheses/[hypothesisId]/experiments`
- `GET /api/decision-engine/experiments/[experimentId]`
- `POST /api/decision-engine/experiments/[experimentId]/transition` (body: target status)
- `GET/POST /api/decision-engine/experiments/[experimentId]/outcomes`

**Implementation details from `advisor()` review, folded in here rather than left implicit:**
- **Clock:** `approved_at`/`recorded_at` are stamped from the service's own injected `clock`
  dependency, never `DEFAULT (unixepoch())` — this exact "two clock sources for one moment" bug
  class was one of the findings just fixed in the Phase 9 Part II merge-review pass; not repeating
  it here on day one.
- **Error codes:** `CHANNEL_NOT_ACTIVE` (reused, `channel-access`), plus new
  `EXPERIMENT_INVALID_TRANSITION`/`EXPERIMENT_NOT_OBSERVABLE`/`validation_failed`/`not_found`
  added to the shared `DomainErrorCode` union and `DOMAIN_ERROR_STATUS` map
  (`DEVELOPMENT_PLAYBOOK.md` §6.2), not a module-local error type.
- **Proxy:** each new mutating POST route gets its own `proxy.test.ts` entry (gated like every
  other real mutation), matching the existing market-intelligence rows there.
- **Provenance:** `createdVia: "web_ui"` is server-stamped via `shared-provenance` on hypothesis/
  experiment/outcome creation, the same pattern Phase 9 already established — since agent (MCP/
  CLI) creation is the explicitly-named next slice (§4 above), this field already existing avoids
  a retrofit later.

## 7. UI

A new **Decisions** dashboard tab (sidebar, after Research) — minimal, matching this app's
established conventions (`ConfirmDialog` never `window.confirm`, `formatDisplayDateTime` for
timestamps): a hypothesis list + create form, per-hypothesis experiment list + create form,
per-experiment status-transition controls (only the valid next states per §4 are offered) and an
outcome-recording form. No dashboard-mount auto-fetch side effect is needed (unlike Phase 9's
collection trigger) — this is pure manual record-keeping, nothing to poll or auto-collect.

## 8. Acceptance criteria (drafted from `FUTURE_PHASES.md` §6 + `PHASE_10_PLAN.md` §7, before implementation, `AGENTS.md` §L)

- Creating an `experiments` row without `success_criteria` or without `stopping_criteria` is
  rejected (`validation_failed`) — schema-level, not just documented.
- `experiment_outcomes` rows cannot exist for an experiment that was never created — obvious, but
  also: **no code path can insert an outcome row as a side effect of creating or transitioning an
  experiment** — only the dedicated outcome-recording action does.
- `assertValidStatusTransition` rejects every transition not in §4's table (e.g. `proposed →
  running` directly, `concluded → running`) with a stable error code, verified by an exhaustive
  test over all 25 (5×5) from/to pairs, not just the valid ones.
- `approved_by`/`approved_at` are `NULL` immediately after `createExperiment`, and set only after
  a transition into `approved` — a hand-written test creates an experiment, asserts both are
  null, transitions it, asserts both are now set to the real caller identity/clock time.
- A hypothesis created with `channel_id` set to a channel the current session is not authorized
  for is rejected with the same `CHANNEL_NOT_ACTIVE` error every other channel-scoped route in
  this codebase uses (not a new, one-off error code).
- A hypothesis created with `channel_id: null` succeeds with no channel-access check attempted at
  all (verified against a fake `channelAccess` dependency that throws if called).
- Recording an outcome against a `proposed` or `approved` experiment is rejected
  (`EXPERIMENT_NOT_OBSERVABLE`); against `running`/`concluded`/`abandoned` it succeeds.
- A concurrent second `transitionExperimentStatus` call from a now-stale expected "from" state
  (the first call already moved it) fails, and `approved_by`/the row's real status reflect only
  the first call's result — proven against the real atomic `UPDATE ... RETURNING`, not a mocked
  read-then-write.
- Every one of the six routes in §5/§6 rejects a request scoped to a channel the session isn't
  authorized for, the same way (`CHANNEL_NOT_ACTIVE`), not just hypothesis creation.
- A round-trip through `applySnapshotToDatabase` (device handoff) carries a `hypotheses` row and
  its child `experiments`/`experiment_outcomes` rows to the receiving device, replacing whatever
  it had — mirroring Phase 9's own existing snapshot test.

## 9. Live verification

No YouTube call, no real quota spend, no live-data dependency — this slice is local-only record-
keeping. Verification is `npm test`/`lint`/`build` only, plus (per this session's own established
`NODE_TEST_CONTEXT=1` convention for `build`) never touching the real local app-data database
during validation.

## 10. Not yet a `docs/roadmap/BACKLOG.md` row

Per the `roadmap-backlog` skill's own convention, a row is added once the branch/assignment is
real — will be added as part of this slice's own commits (status `in_progress`, citing this
branch and the owner's actual Telegram assignment), not left for a separate follow-up.
