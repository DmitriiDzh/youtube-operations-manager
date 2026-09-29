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

**In scope — read surface (all `READ`, ungated, global device-availability rules only):**
- `agent_list_hypotheses` / `agent list-hypotheses` — `listHypotheses(ctx)`, already
  channel-filtered by the service layer (channel-scoped rows narrowed to the caller's active
  channel; channel-less "new concept" hypotheses always included).
- `agent_get_hypothesis` / `agent get-hypothesis --hypothesisId <id>` — `getHypothesis(id, ctx)`.
- `agent_list_experiments` / `agent list-experiments --hypothesisId <id>` —
  `listExperimentsByHypothesis(hypothesisId, ctx)` (there is no top-level "all experiments" list
  in slice 1's own service surface — mirroring that shape here, not inventing a new one).
- `agent_get_experiment` / `agent get-experiment --experimentId <id>` — `getExperiment(id, ctx)`.
- `agent_list_experiment_outcomes` / `agent list-experiment-outcomes --experimentId <id>` —
  `listExperimentOutcomes(experimentId, ctx)`.

**In scope — one DRAFT-class write, the pre-reserved capability:**
- `agent_create_experiment_proposal` / `agent create-experiment-proposal` — calls
  `createExperiment(hypothesisId, input, ctx)` against an **already-existing, human-created**
  hypothesis. Always lands the new row at `status: "proposed"` (slice 1's own `insertExperiment`
  never accepts a caller-supplied status) — an agent can never itself reach `"approved"`;
  `transitionExperiment` (slice 1, Web-UI-only per its own plan) is NOT exposed here, mirroring
  `agent_create_market_research_request`'s "create only, approve only via Web UI" precedent
  exactly, mechanically enforceable the same way (see §5).

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

## 4. Interfaces

New `AGENT_CAPABILITY_DOMAINS` entry: `"decision_engine"`. New `AGENT_DATA_DOMAINS` entry:
`"experiment_history"` (already named, unused, in `PLANNED_FUTURE_CAPABILITIES`'s own doc
comment). `PLANNED_FUTURE_CAPABILITIES` loses `"create_experiment_proposal"` (moves to a real
capability, mirroring how `query_market_intelligence`/`query_competitors` moved out on Phase 9
slice 4). `AGENT_API_VERSION` bumps 0.13.0 -> 0.14.0 (minor, new capabilities, per the existing
convention `docs/AGENT_OPERATIONS_INTERFACE.md` — not itself modified this slice, no schema
version change).

New zoned capability: `CAPABILITY_DECISION_ENGINE_CREATE_EXPERIMENT_PROPOSAL =
"decision_engine.agent_create_experiment_proposal"`, added to `ZONED_CAPABILITIES`
(`src/lib/agent-connections/contracts.ts`), domain `"Decision engine"`.

MCP tools (all `credentialRef`-resolved the same way `changesetList`/`changesetGet` already do —
`resolveCredentialRef(undefined)` -> `getCredentialUserId` -> pass as `ctx.userId` into the
service call, which does its own channel-access assertion internally; no separate
`channelAccessCore.assertActiveChannel` call needed in the MCP handler, unlike `changesetList`,
since `decisionEngineCore`'s own service layer already does it (slice 1's own design, confirmed
by reading `services.ts` directly) — duplicating it in the handler would be exactly the kind of
redundant-check `AGENTS.md` §D warns against): `agent_list_hypotheses`, `agent_get_hypothesis`,
`agent_list_experiments`, `agent_get_experiment`, `agent_list_experiment_outcomes`,
`agent_create_experiment_proposal`. CLI parity: `agent list-hypotheses`, `agent get-hypothesis`,
`agent list-experiments`, `agent get-experiment`, `agent list-experiment-outcomes`,
`agent create-experiment-proposal`, all under the existing `agent` namespace in
`src/cli/video-metadata.ts`.

`createdVia`/`agentApiVersion` on the created experiment: server-stamped (`"mcp"` or `"cli"`,
matching whichever surface calls it), never caller-supplied — same discipline as
`agent_create_market_research_request`.

## 5. Mechanical enforcement (mirrors `market-research-request-approval-inventory.test.ts`)

New `decision-engine-agent-approval-inventory.test.ts` (or extend the existing
`decision-engine-inventory.test.ts` if that's the established file for this module's own
structural tests) asserting no MCP tool or CLI command can transition an experiment's status —
only the existing Web UI API route can. Grep-based, same style as the existing inventory tests in
this module and in `market-intelligence`.

## 6. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- `agent_list_hypotheses`/`agent_get_hypothesis` return exactly what the service layer's own
  channel-filtering already guarantees (a hand-built fixture: one channel-scoped hypothesis for
  channel A, one for channel B, one channel-less — with active channel A, the list contains
  exactly the channel-A row and the channel-less row, never channel B's).
- `agent_get_hypothesis`/`agent_get_experiment` on an unknown id return `HYPOTHESIS_NOT_FOUND`/
  `EXPERIMENT_NOT_FOUND` (the service layer's own existing codes), not a generic error.
- `agent_create_experiment_proposal` against a hypothesis scoped to a channel the caller is NOT
  authorized for is rejected (channel-context validation actually enforced, not just present in
  source) — reuses slice 1's own `assertHypothesisAccessible`, verified by an integration test
  through the MCP handler, not just the service function directly.
- A created experiment always has `status === "proposed"` regardless of any extra field a
  malicious/buggy caller tries to inject (schema is `.strict()`, no `status` field accepted at
  all).
- No MCP tool or CLI command reaches `transitionExperimentStatusIfValid`/`createExperimentOutcome`
  — mechanical inventory test, not a manual claim.
- `get_capabilities` (`system_capabilities`) reports `decision_engine.agent_create_experiment_proposal`
  under `capabilities`, `experiment_history` under `dataDomains`, and no longer lists
  `create_experiment_proposal` under `plannedFutureCapabilities`.

## 7. Non-goals restated

Agent-created hypotheses, evidence auto-linking, outcome/retrospective recording via MCP/CLI, any
approval/transition capability via MCP/CLI, automatic execution — all deferred, per §2 above.
