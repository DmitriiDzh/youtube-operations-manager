> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 19. Decision & Experiment Engine (`src/lib/decision-engine/`) — Phase 10, slices 1-5

Owner instruction, Telegram 2026-09-29: an explicit assignment to plan and implement Phase 10
(`docs/roadmap/FUTURE_PHASES.md` §6). **Detailed design, transition rules, and acceptance
criteria live in `docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md` and `docs/SYSTEM_MAP.md` §2.9w --
this section states only the architectural decisions worth recording permanently here.**

**Approval lives on the experiment, not a separate entity.** The first-pass plan document
(2026-09-20, planning only) sketched a `decisions` table conflating approval
(`approvedBy`/`approvedAt`) with outcome recording into one row. Re-reading `FUTURE_PHASES.md`
§6's own "Core entities" list before implementing found this doesn't match the actual
requirement: `Experiment` itself carries "approval status" as one of its own fields, and
`Outcome`/`Retrospective` are named as entities distinct from approval, not folded into it. This
slice follows §6 over the older sketch, `experiments.status` (`proposed → approved → running →
concluded|abandoned`) being the one place approval lives, transitioned only through one atomic
`UPDATE ... WHERE status IN (<valid predecessors>) ... RETURNING` function
(`transitionExperimentStatusIfValid`) -- the same shape Phase 9's
`approveMarketResearchRequestIfPending` already established for exactly this "two tabs race to
approve the same row" class of bug.

**Outcome is its own append-only table, gated by status.** `experiment_outcomes` never gets an
update/delete function (mirrors `market_channel_snapshots`'s append-only shape) -- a correction is
a new row, never an edit, which is what §6's "an AI agent may never silently rewrite a past
outcome" requires structurally. Recording one is only accepted for `running`/`concluded`/
`abandoned` experiments; a `proposed`/`approved` one has not actually run yet, so an "outcome" for
it would be fabricated, not observed.

**Structural isolation test deliberately differs from Phase 9's own `PHASE9-INV-02` pattern.**
That test scans whole-file text for forbidden substrings, which relies on Phase 9's table names
(`research_channels`, `market_channel_snapshots`) being unlikely to appear anywhere else by
coincidence. This module's table names (`hypotheses`, `experiments`) are plain English words that
really do collide -- with unrelated prose comments elsewhere in the repo, and with this module's
own public service-layer method names and JSON response keys (`{ hypotheses }`). `decision-engine-
inventory.test.ts` instead parses actual `import { X } from "@/lib/db"` specifiers and checks only
those against the forbidden list, immune to all three collision classes while still catching the
one real violation this test exists to prevent.

**Built as its own follow-up slice (2026-09-29):** an MCP/CLI agent surface --
`docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md` -- `agent_list_hypotheses`/
`agent_get_hypothesis_trail` (READ) and `create_experiment_proposal` (DRAFT, the reserved
capability name, always `status: "proposed"`, gated like `agent_create_market_research_request`).
Creating a hypothesis from scratch, transitioning an experiment's status, and recording an outcome
remain Web-UI-only, mechanically verified (`decision-engine-agent-approval-inventory.test.ts`).

**Evidence auto-linking (slice 3, 2026-09-29) references Phase 8/9 data without ever importing
either module from `decision-engine/**` itself.** `hypothesis_evidence` (SCHEMA_MIGRATIONS v30,
append-only) stores a structured, discriminated-union reference (`phase8_metric`/
`phase9_channel_snapshot`/`phase9_video_snapshot`/`phase9_trend_candidate`) alongside the existing
free-text `evidenceNotes`, validated -- does the referenced row actually exist -- at creation
time only, never re-checked at read time. The validation logic itself is an
`EvidenceReferenceResolver` **port** (`decision-engine/contracts.ts`, a plain interface with no
implementation): `decision-engine/services.ts`'s `addHypothesisEvidence` takes an
already-constructed resolver as a parameter, and the one real implementation
(`createRealEvidenceReferenceResolver`, `src/app/api/decision-engine/evidence-reference-
resolver.ts`) is built entirely OUTSIDE `decision-engine/`'s own directory, taking
`analyticsCore`/`marketIntelligenceCore` as constructor arguments (never module-level singletons,
which is what makes it independently testable against fakes). This is the identical shape
`PHASE_9_PLAN.md` §5 already established for market-intelligence itself ("no existing route/
service/component may take a hard dependency on market-intelligence's tables or services") --
applied here in the reverse direction (decision-engine depending on analytics/market-intelligence,
not the other way around) via the standard port/adapter split rather than a direct import.
Mechanically enforced by a new `PHASE10-INV-03` test (`decision-engine-inventory.test.ts`),
scanning for any `@/lib/analytics`/`@/lib/market-intelligence` import inside
`decision-engine/**`. A `RESEARCH_CHANNEL_NOT_AVAILABLE` from market-intelligence (a
`researchChannelId` not on the watchlist) is caught inside the resolver and folded into the same
`false` ("this reference doesn't exist") outcome, rather than leaking a market-intelligence-
specific error code out of a decision-engine route -- a real gap found by `advisor()` review and
covered by the resolver's own dedicated test file (`evidence-reference-resolver.test.ts`), kept
separate from `services.test.ts` (which only proves delegation to a fake resolver, not that the
real one decides correctly).

**AI-generated hypothesis drafts (slice 4, 2026-09-29) reuse `ai-connections`'s transport, never
duplicate it.** `openai-compatible.ts`'s SSRF-validated, timeout/retry-bounded HTTP call
(`callOnce`) was already security-critical, protocol-transport code with zero content specific to
localization; it is now wrapped by a shared `performChatCompletion` helper that both the
pre-existing `generate` (title/description) and the new `generateHypothesis` (statement/rationale)
build on, an additive widening of `ConnectionProtocolAdapter` rather than a refactor of its public
shape or a second copy of the transport -- proven zero-behavior-change by every pre-existing
ai-connections/ai-localization test passing unmodified. `HypothesisGenerationRequest`/
`HypothesisGenerationOutcome`/`HypothesisDraftProvider` are owned by `decision-engine/contracts.ts`
(the domain shape) and imported by `ai-connections/contracts.ts`, the identical relationship
`LocalizationProvider` already has -- `decision-engine/index.ts` imports `createAiConnectionCore()`
directly, exactly like `ai-localization/index.ts` does, since `ai-connections` is shared
infrastructure, not a feature-module peer `AGENTS.md` §M would forbid a hard dependency on
(`PHASE10-INV-03` only forbids `@/lib/analytics`/`@/lib/market-intelligence`, never
`ai-connections`). **The model never sees or produces an `EvidenceReference`.** It only receives
plain-text summaries of references the operator already selected and this module already
validated (`EvidenceReferenceResolver.describe`, a new method on slice 3's own port, implemented
alongside `resolve` in the same route-layer file) -- avoiding both a fabricated-citation risk and
a second evidence-fetch path. `saveGeneratedHypothesis` mirrors `createChangeSetFromProposals`'s
own "the caller resubmits the reviewed values, the server re-validates and persists them" shape
(`AGENTS.md` §D) rather than a server-held draft referenced by id -- every evidence reference is
re-validated at save time, never trusted from generation time, since real state (a channel's
snapshot history, a candidate's lifecycle status) can change in between. AI authorship is recorded
in a new, separate `hypothesis_generation_provenance` table (SCHEMA_MIGRATIONS v31, append-only) --
`createdVia` (mcp/cli/web_ui) is transport, and cannot represent "the AI wrote this text, a human
may have edited it before saving," the same reason `aiLocalizationGenerationProvenance` exists as
its own table rather than overloading an existing column. `editedBeforeSave`/`evidenceRefCount`
are computed server-side from the request, never trusted as caller-asserted fields. The draft route
(`/hypotheses/generate`) persists nothing and is `proxy.ts`-exempt exactly like
`/ai-localization/generate`; the save route (`/hypotheses/generate/save`) persists a real
hypothesis and stays behind the ordinary mutation gate. No real, non-mock AI provider call was made
in this session -- validated only against the mock adapter and an injected `fetchImpl` fake,
per `AGENTS.md` §K.2's separate gate on a real paid AI API call.

**Execution of an approved, localization-type experiment (slice 5, 2026-09-29) reuses the existing
Change Set/Batch pipeline unchanged -- no new write path.** Owner-confirmed scope, three explicit
safety questions answered before this slice started (Telegram): only localization-type experiments
get real execution (the only type with an existing execution interface); approval alone never
triggers it (a separate, explicit Execute action is required); execution never bypasses an existing
gate (Live Writes, identity, dry-run) -- it is one more caller of `createBatchCore().createBatch`,
never `prepareBatchExecution`/`executeBatch`. `experiments` gained `changeSetId`/`executionBatchId`/
`executionClaimedAt` (SCHEMA_MIGRATIONS v32) -- **deliberately no FK** on the first two: `change_sets`
rows are really deleted (`change-drafts/services.ts`'s `discardLocalAndAdoptPeer`, RISK-46's
divergent-lineage flow), and this connection runs with `foreign_keys=ON`, so an FK would break that
unrelated delete; validated at the application level instead, the same "no FK for an informal
reference" pattern RISK-66 already accepts. Execution is a second cross-module dependency in the
same shape as slice 3's evidence resolver: `ExperimentExecutionResolver` (`contracts.ts`) is a port
`decision-engine/**` depends on but never implements; the real implementation
(`experiment-execution-resolver.ts`) lives outside that directory, the only place allowed to import
both `@/lib/decision-engine` and `@/lib/changesets`/`@/lib/batches` (`PHASE10-INV-03` widened to
forbid both inside `decision-engine/**`, alongside the pre-existing analytics/market-intelligence
ban). **The execution design went through two real `advisor()`-caught redesigns, not one.** The
first draft called the resolver (creating a real Batch) BEFORE any atomic guard -- two concurrent
Execute calls could both create one, an exact repeat of the RISK-68 anti-pattern this project
already knows to avoid, not the claim-first pattern it was meant to copy. Redesigned claim-first,
mirroring Phase 9 slice 9B's `claimStaleResearchChannelsForCollection` exactly: an atomic claim
(`execution_claimed_at`, exclusive against another FRESH claim but reclaimable once stale --
`EXPERIMENT_EXECUTION_CLAIM_EXPIRY_MS`, the identical 15-minute precedent) taken BEFORE the resolver
is ever called. The second round found the claim alone wasn't sufficient: `transitionExperimentStatusIfValid`/
`setExperimentChangeSetIfEligible` never checked it, so an Abandon or a detach could land inside the
claim window and `finalizeExperimentExecution`'s then-unconditional write would resurrect a terminal
state back to `"running"`. Both functions now refuse while a fresh claim is held (still permitting
the action once the claim is stale/expired -- a crash must never permanently lock the experiment out
of its own lifecycle); `finalizeExperimentExecution` is now guarded by the exact claim timestamp and
clears the claim in the same write (required so the claim-freshness guard above doesn't then block
the experiment's own normal `running -> concluded/abandoned` transitions); and finalize was moved
OUTSIDE the resolver's own try/catch, so a finalize failure never releases a claim whose Batch
already exists (which would let a second call create a second real Batch for it) -- it self-heals
only via the same 15-minute expiry, a narrow, documented residual (`docs/TECHNICAL_DEBT.md`
RISK-82). `dryRun` mirrors the existing Batch-creation route's own fail-closed gate exactly
(`getLiveWritesEnabled()`, `live: true` in the request honored only when that toggle is already on)
-- the route is an injectable factory (`createExecuteExperimentHandler`) specifically so this
wiring itself has a test, not just the service's own boolean-in/boolean-out logic. The response
(and the UI) surface `dryRun` explicitly, so the operator can tell "dry-run Batch" from "LIVE
Batch" rather than the outcome being silent.

**Still not built, named explicitly rather than silently deferred:** agent-created hypotheses from
scratch (`create_hypothesis`, the reserved extension point left after slice 2); recording an
outcome/retrospective through MCP/CLI; execution of any non-localization experiment type (no
execution interface exists for one yet); MCP/CLI exposure of Change Set attach/execute (a
Batch-creating agent action is a materially different risk category than slice 2's read+draft
surface, needs its own separate assignment); evidence selection during AI generation is not yet
exposed in the Web UI (fully built and tested at the
API/service layer -- the "Generate with AI" panel is notes-only for this first UI pass, evidence
still attaches to a saved hypothesis through the existing, separate evidence form).

