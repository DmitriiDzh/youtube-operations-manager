# Phase 10 slice 2 — agent-facing MCP/CLI surface

Continues on `feature/phase-10-decision-experiment-engine` (`AGENTS.md` §K.1, same branch as
slice 1). Owner said "Продолжай" after slice 1 (`18d0fbd`/`f712f81`) was reported done, and gave
standing permission to restart the real server as needed during this work.

**Mandatory reading for this slice:** `docs/roadmap/FUTURE_PHASES.md` §6 (read in full this pass —
"Agent integration" paragraph: "Codex-class agents should be able to propose hypotheses, attach
evidence, create experiment drafts, suggest criteria, review results, and produce retrospectives.
Human approval is preserved before any consequential execution"); `docs/roadmap/plans/
PHASE_10_SLICE_1_PLAN.md` (what slice 1 built — `hypotheses`/`experiments`/`experiment_outcomes`,
service-layer channel-access checks already built into `createDecisionEngineServices`); the Phase
9 slice 9G part A/B precedent in `src/mcp/server.ts` and `src/lib/agent-operations/{contracts,
services}.ts` (read directly — the exact MCP tool registration, handler, capability-descriptor,
and DRAFT-class-approval-gate pattern this slice mirrors); `src/lib/agent-operations/contracts.ts`
already reserves `"create_experiment_proposal"` in `PLANNED_FUTURE_CAPABILITIES` and notes
`"experiment_history"` as the data domain Phase 10 would use once implemented — both anticipated
exactly this slice.

## 1. Choosing this slice over evidence auto-linking

Two candidates were on the table (see the prior Telegram report). `FUTURE_PHASES.md` §6 names
both "evidence... always retains provenance back to its source" and explicit "Agent integration."
This slice picks the agent-facing surface as the smaller, safer next step (`AGENTS.md` §C):
evidence auto-linking requires a real cross-module design decision (how `decision-engine`
references `analytics`/`market-intelligence` data without breaking `AGENTS.md` §M module
independence — does disabling `market-intelligence` orphan a hypothesis's evidence reference?),
which deserves its own slice with that question worked through deliberately, not folded into
this one. The MCP/CLI surface below has a direct, already-proven precedent (Phase 9 slice 9G) and
introduces no new cross-module coupling — evidence stays exactly as slice 1 left it
(`evidenceNotes`, free text) for now.

## 2. Scope

**As actually built (updated post-implementation — the original draft below proposed five
thin read tools; advisor review during implementation found this duplicated the trail composition
in both the MCP and CLI handlers, the same "real duplication" pattern BL-104's round-1 review had
already flagged once for this project. Collapsed to two read tools instead, with the composition
itself moved into a new shared service function, `getHypothesisTrail`, in `services.ts` — owner
spec §25's "prefer a small number of composable tools" also independently favors this shape):**

**In scope — read surface (all `READ`, ungated, global device-availability rules only):**
- `agent_list_hypotheses` / `agent list-hypotheses` — `listHypotheses(ctx)`, already
  channel-filtered by the service layer (channel-scoped rows narrowed to the caller's active
  channel; channel-less "new concept" hypotheses always included).
- `agent_get_hypothesis_trail` / `agent get-hypothesis-trail --hypothesisId <id>` — one combined
  read: the hypothesis plus every one of its experiments, each with its own outcomes. Backed by
  the new `getHypothesisTrail(hypothesisId, ctx)` service function (does ONE access check via
  `assertHypothesisAccessible`, then reads experiments/outcomes directly from the store — not
  `listExperimentsByHypothesis`/`listExperimentOutcomes`, which would each redundantly re-check
  access per experiment). `HYPOTHESIS_NOT_FOUND` for an unknown id.

**In scope — one DRAFT-class write, the pre-reserved capability (name kept EXACTLY as reserved,
never renamed — `create_experiment_proposal`, not `agent_create_experiment_proposal` as the
original draft below proposed):**
- `create_experiment_proposal` / `agent create-experiment-proposal` — calls
  `createExperiment(hypothesisId, input, ctx)` against an **already-existing, human-created**
  hypothesis. Always lands the new row at `status: "proposed"` (slice 1's own `insertExperiment`
  never accepts a caller-supplied status) — an agent can never itself reach `"approved"`;
  `transitionExperiment` (slice 1, Web-UI-only per its own plan) is NOT exposed here, mirroring
  `agent_create_market_research_request`'s "create only, approve only via Web UI" precedent
  exactly, mechanically enforceable the same way (see §5). `createdBy: "agent"` is passed in the
  service call's `ctx` but is never actually persisted — `createExperiment`/`insertExperiment`
  have no `createdBy` column to write it to (stated plainly here since the plan below originally
  implied otherwise); only `createdVia` (`"mcp"`/`"cli"`) is real and stored.

**Explicitly out of scope, named not dropped:**
- **Agent-created hypotheses.** `FUTURE_PHASES.md` §6 says agents should "propose hypotheses,"
  and `PLANNED_FUTURE_CAPABILITIES` only ever reserved `create_experiment_proposal`, not a
  hypothesis-creation name. Given the reserved name is the one concrete signal of what this slice
  was meant to cover, and `AGENTS.md` §C favors the smaller slice, hypothesis creation stays
  human-only (Web UI) for now — a natural, separately-assignable next increment, not silently
  dropped.
- Evidence auto-linking (§1 above).
- Recording outcomes/retrospectives via MCP/CLI (`createExperimentOutcome`) — plausible future
  agent capability ("review results, produce retrospectives" per §6), but not the one reserved
  name; left for its own slice alongside agent-created hypotheses.
- Any transition/approval capability via MCP/CLI — approval stays Web-UI-only, structurally,
  exactly like slice 1's own design intent.

## 3. Why this needs no new gate beyond the existing device-availability check

`createExperiment` mutates local state (a new `experiments` row) but spends no YouTube quota, no
AI-provider cost, and creates no obligation — identical risk shape to
`agent_create_market_research_request` and `agent_create_content_proposal`, both gated only by
`assertMcpDeviceAvailable`/the operation lock, never a live-writes toggle. Same treatment here.

## 4. Interfaces (as actually built)

New `AGENT_CAPABILITY_DOMAINS` entry: `"decision_engine"`. New `AGENT_DATA_DOMAINS` entry:
`"experiment_history"` (already named, unused, in `PLANNED_FUTURE_CAPABILITIES`'s own doc
comment). `PLANNED_FUTURE_CAPABILITIES` loses `"create_experiment_proposal"` (moves to a real
capability, mirroring how `query_market_intelligence`/`query_competitors` moved out on Phase 9
slice 4) and gains `"create_hypothesis"` instead (§6's "propose hypotheses," left out of this
slice's own narrower scope — a NEW reservation, not one carried over from the original owner spec
§14 list; flagged for the project owner's own awareness in the implementation report, not silently
assumed). `AGENT_API_VERSION` bumps 0.13.0 -> 0.14.0. `docs/AGENT_OPERATIONS_INTERFACE.md` §4l
**was** added this slice (the original draft below incorrectly said it wouldn't be) — every prior
Phase 7/9 slice that changed this interface updated that document, and leaving it stale would be
exactly the drift `AGENTS.md` §H warns against.

New zoned capability: `CAPABILITY_DECISION_ENGINE_CREATE_EXPERIMENT_PROPOSAL =
"decision_engine.create_experiment_proposal"` (capability id matches the tool name exactly — the
original draft below had proposed `decision_engine.agent_create_experiment_proposal`, which would
have silently renamed the one reserved capability), added to `ZONED_CAPABILITIES`
(`src/lib/agent-connections/contracts.ts`), domain `"Decision engine"`.

MCP tools (all `credentialRef`-resolved the same way `changesetList`/`changesetGet` already do —
`resolveCredentialRef(undefined)` -> `getCredentialUserId` -> pass as `ctx.userId` into the
service call, which does its own channel-access assertion internally; no separate
`channelAccessCore.assertActiveChannel` call needed in the MCP handler, unlike `changesetList`,
since `decisionEngineCore`'s own service layer already does it (slice 1's own design, confirmed
by reading `services.ts` directly) — duplicating it in the handler would be exactly the kind of
redundant-check `AGENTS.md` §D warns against): `agent_list_hypotheses`, `agent_get_hypothesis_trail`,
`create_experiment_proposal`. CLI parity: `agent list-hypotheses`, `agent get-hypothesis-trail`,
`agent create-experiment-proposal`, all under the existing `agent` namespace in
`src/cli/video-metadata.ts`.

`createdVia` on the created experiment: server-stamped (`"mcp"` or `"cli"`, matching whichever
surface calls it), never caller-supplied. `agentApiVersion` is **not** stamped on the experiment
row at all (unlike `agent_create_market_research_request`, which does store it) — `Experiment` has
no such column, and adding one would need its own schema migration (v30), judged out of
proportion for this slice; the original draft below incorrectly claimed this was already covered.

## 5. Mechanical enforcement (mirrors `market-research-request-approval-inventory.test.ts`)

New `decision-engine-agent-approval-inventory.test.ts` (or extend the existing
`decision-engine-inventory.test.ts` if that's the established file for this module's own
structural tests) asserting no MCP tool or CLI command can transition an experiment's status —
only the existing Web UI API route can. Grep-based, same style as the existing inventory tests in
this module and in `market-intelligence`.

## 6. Acceptance criteria (drafted before implementation, `AGENTS.md` §L — post-implementation
note added per criterion: what actually proves it, since advisor review found the original draft
below claimed "an integration test through the MCP handler" for the channel-context criterion when
the actual MCP-layer test stubs the core, and the real composition/channel-enforcement logic moved
to the service layer)

- `agent_list_hypotheses` returns exactly what the service layer's own channel-filtering already
  guarantees (a hand-built fixture: one channel-scoped hypothesis for channel A, one for channel
  B, one channel-less — with active channel A, the list contains exactly the channel-A row and the
  channel-less row, never channel B's). **Covered:** `decision-engine/services.test.ts`'s existing
  channel-filtering tests (slice 1) plus `MCP agent_list_hypotheses returns exactly the service
  layer's own already-channel-filtered list` (handler pass-through only).
- `agent_get_hypothesis_trail` on an unknown id returns `HYPOTHESIS_NOT_FOUND` (the service
  layer's own existing code), before ever reading experiments. **Covered, at the service level**
  (where the logic actually lives): `AC-10-09: getHypothesisTrail surfaces HYPOTHESIS_NOT_FOUND...`
  in `services.test.ts`. The MCP-layer test (`MCP agent_get_hypothesis_trail surfaces
  HYPOTHESIS_NOT_FOUND...`) only proves the handler forwards the service's error unchanged — it
  stubs the core, it is not itself an integration test of the channel/not-found logic.
- `create_experiment_proposal` against a hypothesis scoped to a channel the caller is NOT
  authorized for is rejected. **Covered at the service level** (`assertHypothesisAccessible`,
  slice 1's own existing channel-rejection tests) plus `MCP create_experiment_proposal propagates
  a channel-context rejection from the service layer unchanged` (handler pass-through only, stubs
  the core — same honest scoping as above).
- A created experiment always has `status === "proposed"` regardless of any extra field a
  malicious/buggy caller tries to inject (schema is `.strict()`, no `status` field accepted at
  all). **Covered:** `MCP create_experiment_proposal forwards hypothesisId separately, stamps
  createdBy/createdVia, and never accepts a caller-supplied status`.
- No MCP tool or CLI command reaches `createHypothesis`/`transitionExperiment`/
  `createExperimentOutcome` — mechanical inventory test, not a manual claim. **Covered:**
  `decision-engine-agent-approval-inventory.test.ts`, `PHASE10-INV-02`.
- `get_capabilities` (`system_capabilities`) reports `decision_engine.agent_list_hypotheses`/
  `decision_engine.agent_get_hypothesis_trail`/`decision_engine.create_experiment_proposal` under
  `capabilities`, `experiment_history` under `dataDomains`, and lists `create_hypothesis` (not
  `create_experiment_proposal`) under `plannedFutureCapabilities`. **Covered:**
  `agent-operations/services.test.ts`'s existing capabilities-list assertions (updated this slice,
  with justification recorded in the fix commit per `AGENTS.md` §L).
- **Gate correctness** (not in the original draft below, added post-implementation once the CLI
  read-only allowlist was found and had to be updated too): `list-hypotheses`/`get-hypothesis-trail`
  are never blocked by the operation lock; `create-experiment-proposal` is rejected while it is
  held, and is wired through agent-zone enforcement with the exact capability id. **Covered:** the
  CLI tests added alongside the `READ_ONLY_CLI_COMMANDS` update, mirroring `create-research-request`'s
  own four tests.

## 7. Non-goals restated

Agent-created hypotheses, evidence auto-linking, outcome/retrospective recording via MCP/CLI, any
approval/transition capability via MCP/CLI, automatic execution — all deferred, per §2 above.
