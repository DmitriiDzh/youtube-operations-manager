# FUTURE_PHASES.md — Strategic Product Backlog

Recorded 2026-09-20, from the project owner's "Persistent Product Roadmap — Future Development
Backlog" instruction. **This is a strategic backlog, not an implementation specification.**

- **What this file is not:** it does not duplicate `docs/PROJECT_SPEC.md` (the requirements
  source of truth for what is *currently* being built), and it never marks anything here as
  implemented. `docs/ROADMAP_STATUS.md` remains the sole authoritative execution log of what has
  actually happened, when, and in which commit — this file records what *might* happen next,
  in what order, and why.
- **How it relates to `AGENTS.md` §B:** every phase below is described at the level of
  *capabilities and interfaces* (what the product can do, what boundaries it enforces) — never
  channel-specific editorial guidance, YouTube SEO strategy, or an operations agent's own
  playbook. Those remain permanently out of scope for this repository regardless of which phase
  is active.
- **Authorization:** recording a phase here is planning only. Per `AGENTS.md` §C, no phase below
  may begin without its own explicit project-owner assignment, exactly as for any other phase.
  Nothing in this file authorizes real YouTube writes, paid AI calls, Google OAuth login,
  destructive database operations, deployment, or a release — those each have their own
  separate gates (`AGENTS.md` §G/§K) unaffected by this document's existence.
- **Tracked backlog items:** `docs/roadmap/BACKLOG.md` holds the discrete, trackable slices
  derived from the phases below (managed via the `roadmap-backlog` skill,
  `.claude/skills/roadmap-backlog/SKILL.md`) — this file stays the strategic description, that
  one tracks status (`proposed`/`assigned`/`in_progress`/`done`/`dropped`) for individual pieces
  of it.

---

## 1. Product vision

YouTube Operations Manager is intended to become a multi-channel operations and intelligence
platform. Long-term purpose:

- Manage an arbitrary number of YouTube channels.
- Automate repetitive operational workflows.
- Provide controlled access to AI agents.
- Analyze owned-channel performance.
- Discover competitors, trends, and new market opportunities.
- Generate evidence-based proposals.
- Execute approved experiments and learn from their outcomes.
- Support a future expansion into automated content production.

Standing architectural principles for every phase below:

- Never restrict the architecture to the channels, niches, or content types known today (no
  hard-coded channel identity, no music-specific or niche-specific logic baked into core paths).
- Stay modular, versioned, auditable, and compatible with changing AI providers.
- Prefer existing platform capabilities over new custom infrastructure.
- Maintain the development/operations separation `AGENTS.md` §B already establishes — product
  development (this repository, Claude Code) stays structurally separate from any operational
  agent (Codex or otherwise) actually running a released version.

## 2. Immediate priority — first local test release (already in progress, not a future phase)

This is not a new phase; it is the work already assigned and substantially completed in prior
sessions (`docs/ROADMAP_STATUS.md`'s "Pre-Release" rows: Cross-Platform Persistence, First Local
Test Build, Publish snapshots + independent-review risk remediation). Restated here only to record
its priority relative to the future phases below, per the owner's instruction — **not** to
re-describe or duplicate its own status, which lives entirely in `docs/ROADMAP_STATUS.md`.

Must remain true throughout every future phase: reproducible local builds, safe first-run
configuration, persistent application data, upgrade-safe SQLite migrations, a functional UI, AI
Connections, AI Localization, safe device handoff via Syncthing, and — unconditionally — the
Phase 5 write-safety barrier (`docs/TECHNICAL_DEBT.md` RISK-09/Gate B). This milestone is not
"complete" merely because tests pass or `npm run build` succeeds; it requires an actual manual
smoke test (`docs/FIRST_LOCAL_TEST_BUILD.md` §7). Gate B (real YouTube writes) remains a wholly
separate safety requirement, independent of this milestone's completion.

## 3. Phase 7 — Codex Operations Interface

**Objective:** let Codex (or an equivalent operational agent) work as an operational agent
against a *versioned release* of this product — never against this development repository.

Planned capabilities:

- Stable, versioned API/MCP interfaces.
- An independent Codex operations workspace, with its own permissions, entirely separate from
  this repository.
- Operation-specific permissions and read-only access to application data.
- Draft-only operations: creating proposals and Change Sets, never bypassing existing
  approval/audit mechanisms.
- A clear separation between generation, review, approval, and execution.
- Standardized error shapes and operation results.
- Explicit compatibility rules between an agent's configuration and the product release it talks
  to.

Initial specialist roles to consider (capability descriptions only, never channel-specific
guidance — that content stays outside this repository per `AGENTS.md` §B): Operations Manager,
Localization, Quality Control. Additional specialist roles may follow once the underlying product
capability they'd rely on actually exists.

Constraints: do not build a custom agent-orchestration framework if native Codex capabilities
already cover the need; never grant an agent direct database access or unrestricted YouTube
credentials.

**Deliverable:** Codex can connect to a released version of the application, inspect permitted
data, and prepare localization Change Sets — with no development-repository access. Real YouTube
mutations remain gated by their own, separate safety/approval requirements throughout.

## 4. Phase 8 — Intelligence Foundation

**Objective:** give the product a reliable analytical foundation built on actual owned-channel
data.

Planned capabilities: YouTube Analytics API integration; historical collection of channel/video
metrics; scheduled synchronization; consistent metric definitions and normalized time periods;
comparing videos at comparable ages; data-quality/missing-data diagnostics; analytical reports
and weekly channel reviews; machine-readable analytics for operational agents to consume.

Constraints: distinguish observed facts from interpretations/hypotheses explicitly; avoid
unsupported conclusions from small samples; never hard-code channel identities or niche-specific
metric logic.

**Deliverable:** reproducible analytical reports from stored historical data, each with clear
provenance and documented metric definitions.

## 5. Phase 9 — Market Discovery & Trend Intelligence

**Objective:** continuously discover competitors, content formats, niches, and market
opportunities beyond the channels already known to the system.

Planned capabilities: public YouTube data collection through permitted interfaces; competitor
and channel discovery; a dynamic, expanding research watchlist; video/channel history; emerging
content-pattern and topic/niche discovery; public trend signals; source attribution and evidence
storage; freshness/confidence indicators; candidate opportunities for further investigation.

Constraints: no arbitrary fixed competitor-list limit — use resource budgets, prioritization, and
discovery rules instead; never assume access to a competitor's private analytics, CTR, retention,
or revenue; never treat publicly observed growth as proof of profitability; never restrict
discovery to music or the operator's existing niches.

**Deliverable:** the system identifies new research candidates and states which public
observations support each one.

## 6. Phase 10 — Decision & Experiment Engine

**Objective:** turn the analytical and market-research foundation into a controlled,
evidence-based experimentation workflow.

Planned capabilities: generating testable hypotheses; recommendations for existing channels;
evaluation of new channel concepts; experiment design with success/stopping criteria and
budget/resource estimates; human approval; controlled execution through already-authorized
product interfaces; monitoring results against predefined baselines; recording lessons learned;
a reusable decision history.

Supports both (A) optimizing existing channels and (B) discovering/validating entirely new
channel opportunities. Must keep observed evidence, AI-generated hypotheses, proposed decisions,
approved actions, and actual outcomes as explicitly distinct categories throughout — no
consequential action executes merely because an AI agent proposed it.

**Deliverable:** an experiment is traceable end-to-end, from initial hypothesis through approval,
execution, measurement, and retrospective analysis.

## 7. Future directions — not yet numbered phases

Recorded as future opportunities only, not approved implementation work, and not to be
implemented during Phases 7-10 unless separately approved:

- Simultaneous multi-device operation, with application-managed synchronization (do not assume
  the existing Syncthing-based handoff, `docs/RELEASE_LAYOUT.md`, is sufficient for genuine
  concurrent multi-device database synchronization — it explicitly is not, by design, Variant A
  is one-active-device-at-a-time).
- Automated media production: audio generation and quality control, video generation and
  rendering, automated publishing workflows, livestream management.
- Scalable remote execution infrastructure.

## 8. How to use this roadmap in future sessions

This roadmap is persistent strategic context. It never overrides: `AGENTS.md`, the current
approved task, existing acceptance contracts, explicit owner decisions, or safety restrictions.

Priority order, highest first:

1. Explicit new instructions from the project owner.
2. Completion and verification of the currently approved task.
3. Resolution of confirmed blockers within the authorized scope.
4. Previously approved, unfinished tasks.
5. Future-roadmap planning (this document) — only when no higher-priority task remains.

If a task is already running when a roadmap update arrives, record the update once it is safe to
do so without disrupting that task, then resume the task immediately. The absence of a new owner
message is never itself permission to start implementing a new phase.

## 9. Autonomous planning when idle

When all previously authorized work is complete and no new owner instruction is pending, planning
(never implementation) for the next phase in this backlog is permitted, following this exact
sequence:

1. Inspect the actual current repository state.
2. Identify existing capabilities and missing dependencies.
3. Identify the smallest useful vertical implementation slice.
4. Define that phase's scope and explicit non-goals.
5. Identify interfaces, data structures, and security boundaries it needs.
6. Propose implementation slices.
7. Define independently testable acceptance criteria (per `AGENTS.md` §L — derived from
   requirements, never from a draft implementation).
8. Identify required owner decisions.
9. Record the proposal in an appropriate planning document (not this file — this file is the
   backlog, not the plan for any one phase).

Plan phases strictly in order, starting with Phase 7, and only one phase's plan at a time — never
produce detailed plans for every phase in one pass, and never automatically start implementing a
plan once it's prepared. Present it for approval and stop. Do not invent capabilities or assume
unfinished work is complete, and do not modify an existing phase's acceptance contract without a
demonstrated defect and the authorization that requires.

## 10. Git and permissions

Governed entirely by `AGENTS.md`'s existing git policy (§K) — nothing in this document changes
it. Roadmap and future-phase-plan changes are isolated on their own branch, never mixed into an
unrelated feature commit, and never disrupt an in-progress feature branch or merge. Recording or
updating this roadmap never itself authorizes a push of `dev` beyond the standing approval
`AGENTS.md` §K.2 already records, a merge into `main`, a tag, or a release — each remains
separately gated exactly as before.
