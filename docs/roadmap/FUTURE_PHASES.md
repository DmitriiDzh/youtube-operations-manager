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

**Status update (2026-09-23, owner instruction via Telegram, full 34-section spec, "Phase 7 —
Agent Operations Interface for Codex"):** this phase's original scope above (MCP/CLI tools for
Change Sets/Batches/channel-sync/analytics/ai-localization) is fully delivered — see
`docs/ROADMAP_STATUS.md` BL-073/074/076/077/078. The owner then substantially expanded this same
phase with a full, detailed design covering channel/video context, an agent-oriented analytics
wrapper, a new creative-asset catalog, bulk-localization draft integration, content-proposal/
external-artifact registration, and audit/provenance tracking, explicitly authorizing design and
incremental implementation without per-slice approval (only the final merge to `dev` needs the
owner's sign-off). The authoritative, continuously-updated technical design and implementation-
status document for this expanded scope is `docs/AGENT_OPERATIONS_INTERFACE.md` — this bullet
records that the assignment happened and points there rather than duplicating the design here.

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
- **YouTube Studio UI parity — Home, Content, Analytics, Languages tabs** (recorded 2026-09-20,
  owner request via Telegram, after manually testing this app against real YouTube Studio).
  Objective: give this app's own UI the same information and layout shape as Studio's four
  namesake sections, built on top of existing capabilities where possible rather than inventing
  new ones. Content and Languages need only this app's existing YouTube Data API v3 access plus
  one additive schema change (video view/comment/like counts, never synced today); Home is a mix
  (its video/comment/subscriber cards need Data API v3 plus, for comments/subscribers
  specifically, a feasibility check that has not been done yet; its analytics-summary card needs
  the same dependency as Analytics below); the Analytics tab itself is this same "YouTube
  Analytics API integration" already scoped at the strategic level by Phase 8 above, just
  requested here as a concrete, full-parity UI target rather than Phase 8's own smaller first
  vertical slice. See `docs/roadmap/plans/STUDIO_PARITY_PLAN.md` for the researched breakdown
  (real Studio UI structure, per-tab dependency table, proposed slices, open questions) — that
  plan is the actual detail; this bullet only records that the idea exists and where its
  Analytics-tab portion reuses Phase 8 rather than duplicating it. Owner follow-up (2026-09-20,
  Telegram) resolved several of its open questions and requested two further, separately-planned
  pieces of the same idea, recorded as their own bullets below.
- **Fold "AI Localization" into a Studio-styled "Languages" tab, AI-generation as the primary
  workflow** (recorded 2026-09-20, owner follow-up to the Studio-parity item above). The
  "AI Localization" nav tab is removed outright; localization is expected to happen via AI
  generation by default, with manual editing framed as reviewing/correcting the agent's output,
  not as an independent authoring path. See `docs/roadmap/plans/LANGUAGES_TAB_MERGE_PLAN.md` for
  the full design (existing Change Set review is already fully shared across both sources, so
  this is smaller than it sounds) and its remaining open questions (sub-tab semantics, editorial
  profile placement).
- **Auto-refresh tab data on tab switch; remove now-redundant channel-selection dropdowns**
  (recorded 2026-09-20, owner request via Telegram). Most tabs already refresh their local data
  on every switch for free (React mount/unmount from this app's existing conditional-rendering
  tab pattern); the real gaps are the Rules tab (state owned by the parent, not the tab) and the
  Sync tab's live YouTube re-sync (which costs real API quota and needs an explicit trigger
  policy, not blind automation on every click). See
  `docs/roadmap/plans/TAB_REFRESH_AND_CHANNEL_UI_PLAN.md`.
- **Automatic device-handoff export/import + an update-available notification** (recorded
  2026-09-20, owner request via Telegram). Auto-export on graceful app shutdown (no such hook
  exists today — this is new infrastructure, not a config flag), a safe-case auto-import at
  startup (never overriding the existing divergent-lineage-requires-a-human safety check), and a
  notification affordance when a newer snapshot appears in the shared Syncthing folder while the
  app is already running. **Explicitly does not make concurrent multi-device editing safe** —
  that remains the separate, harder, already-tracked problem above (multi-device
  application-managed synchronization). See
  `docs/roadmap/plans/DEVICE_HANDOFF_AUTO_SYNC_PLAN.md` for the full design and the real cost
  constraints found by reading the actual export/import code (export is expensive — an app-wide
  lock plus a full-database `VACUUM` — so "export on every single change" is deliberately not
  the literal design; see that plan §2).
- **Consolidate device sync into one "Sync Gateway" module; migrate the remaining whole-DB
  Device-Handoff tables into it; retire whole-database snapshot transfer entirely** (recorded
  2026-09-22, owner request via Telegram, extended same day: "Все остальное думаю можно перевести
  на новую систему миграции" → confirmed categories, confirmed retiring the old mechanism → "Так же
  используем так же правило 1 модуля и шлюза. Объединяем весь этот функционал в отдельный модуль.
  Он отвечает за отслеживание изменений, каталогизировать это отправлять на перенос. Транспортом
  пока занимается syncthing."). One new module (`src/lib/sync-gateway/`, name open to confirmation)
  absorbs `change-drafts`/`change-drafts-sync` and owns three responsibilities — change tracking,
  cataloging (the Automerge document layer), and transport dispatch behind a swappable interface
  (Syncthing today, a custom transport later) — mirroring this project's existing single-gateway
  pattern (`docs/decisions/0005`/`0007`). Beyond the already-migrated draft layer (`change_sets`/
  `changes`, CD1-CD7), it also catalogs: pure external caches needing no CRDT work at all
  (`channels`/`videos` — dropped from cross-device transfer, always re-derivable via "Sync now");
  operator-authored config (`channel_editorial_profiles`, `ai_connections` config fields); and
  append-only draft provenance (`ai_localization_generation_provenance`). The safety-critical
  write pipeline (`batches`/`batch_ledger_rows`/`batch_attempts`/`audit_events`) does **not**
  migrate — final scope, 2026-09-22, `docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`
  — after research (done before writing any of that slice's code) found two independent,
  structural blockers: three of the four tables depend on SQL compare-and-set/UNIQUE-constraint
  primitives with no Automerge equivalent (Phase 5's AC-CONCURRENCY-01/02/03/AC-RESUME-01), and
  the fourth (`audit_events`, genuinely insert-only) depends on its SQLite `AUTOINCREMENT` rowid
  for the exact event ordering AC-AUDIT-01/04 requires, which a CRDT document has no equivalent
  for either. ADR 0006's original write-pipeline exclusion is reinstated in full for all four
  tables. Whether `src/lib/device-handoff/`/`src/lib/snapshot/` can still be deleted outright, or
  must keep a small scoped-down transfer just for these four tables, is now an open decision for
  the owner (not yet resolved) — see `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`
  for the full breakdown and slice order (M0-M6).
- **Real Google Cloud Quotas/Monitoring numbers for the gateway traffic counters** (recorded
  2026-09-22, owner request via Telegram: "Можем ли мы собирать статистику?... сколько наши
  лимиты"). The gateway traffic counters (rolling 24h attempts/succeeded per category,
  `docs/SYSTEM_MAP.md` §2.9k) answer "how much are we calling," not "how close are we to Google's
  own limits." Splits into three slices: (1) the counters themselves (done); (2) a single,
  device-persistent Google Cloud OAuth grant, entirely decoupled from per-channel YouTube login so
  a channel switch/re-login never revokes it (`docs/decisions/0008-cloud-connection.md`, done); (3)
  real limit/usage numbers surfaced in Settings under a reusable progress-bar component (done,
  `docs/ARCHITECTURE.md` §16) — a live spike found the Cloud Quotas API unnecessary, since the
  already-connected Cloud Monitoring API supplies both the limit and the usage numbers on its own.
  All three slices are complete and merged into `dev` (`4be1f29`, 2026-09-22, owner approval "ок,
  можно мерджить в дев") — see `docs/ROADMAP_STATUS.md`'s BL-061/062/063 row. This bullet is kept
  here as a historical record of the original ask; it does not describe outstanding work.
- **Replace XLSX as the localization Change Set interface with the same JSON/MCP-based pattern
  used by the new Analytics diagnostics tools** (recorded 2026-09-23, owner request via Telegram,
  following the same-day architecture decision for Phase 8's analytics-diagnostics storage —
  a plain new SQLite table via Drizzle, exposed as JSON over MCP/API, no new database technology —
  after live 2026 web research confirmed that scope is right for this app's actual workload).
  Owner's stated reasoning, verbatim: "эксель нам тоже не нужен и надо на такую же систему для
  локализации завезти, т.к. перевод делать должен агент, а не человек" (XLSX isn't needed for
  localization either, and the same system should be brought there too, because translation is
  meant to be done by an agent, not a human). This is a future direction only, not approved
  implementation work, and not yet scoped: the Change Set/localization pipeline is one of this
  repo's most safety-critical, heavily-tested subsystems (`docs/PROJECT_SPEC.md` §21, AGENTS.md §F),
  so any real design pass needs the full AGENTS.md §A architectural documentation read before a
  single line of implementation, plus its own explicit future assignment per §C. Open question for
  whoever picks this up, deliberately left unresolved here: XLSX import/export is currently this
  pipeline's primary *human*-editing interface — even if agent-driven generation no longer needs a
  spreadsheet intermediary, XLSX (or some other human-facing view) may still carry real value for a
  human reviewer/editor path, and this bullet does not decide whether or how that path is kept.
- **Multi-agent responsibility zones** (recorded 2026-09-25, owner request via Telegram, same
  conversation that assigned Phase 7's merge to `dev`). After Phase 7 established that any
  MCP-compatible client (Claude, not only Codex) can already connect with zero code changes, the
  owner asked for a way to run more than one agent connection at once, each exclusively
  responsible for a domain (owner's own example: "Клод делает переводы и анализ аналитики. А
  кодекс делает ассеты, тк Клод не может сгенерировать изображения"), while all connected agents
  still see the same underlying data and each other's conclusions ("но при этом все должны
  работать в одном информационном поле... создание новых ассетов... должно опираться на анализ
  прошлых креативов, даже если этот анализ делал другой агент"). Owner's explicit instruction:
  produce a plan and start executing it, built as its own module per `AGENTS.md` §M ("составь
  план выполнения... чтобы это было отдельным модулем отвечающим за подключение агентов + доп
  модули если требуется"). See `docs/roadmap/plans/AGENT_ZONES_PLAN.md` for the full design (new
  `src/lib/agent-connections/` module, per-capability zone assignment, fail-closed-once-any-
  connection-is-registered policy). **Update, 2026-09-25:** owner confirmed both open scope
  questions (expand zoning beyond the Phase 7 `agent_*` DRAFT tier to `channel_sync`/
  `changeset_create_from_import`/`ai_localization_*`: "Согласен"; keep the new tables device-local,
  not synced: "Оставим локально"). Slices 1 (data model) and 2 (enforcement wired at the 6
  approved MCP tools + their CLI equivalents) are done on `feature/agent-connections`, not yet
  merged to `dev`. This work is **not** the same as `docs/TECHNICAL_DEBT.md` RISK-32 (an earlier
  draft of the plan mistakenly conflated the two) -- RISK-32 is about device-availability-gate
  consistency and remains separately OPEN, untouched by this feature. A new risk was found and
  recorded instead, RISK-60 (`write_channel_select`/`auth_user_select` mutate global, not
  per-connection, active-channel state). Remaining: slice 3 (Web UI) and the owner's "yes, merge"
  before this feature reaches `dev`.

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

**Scoped exception, 2026-09-21:** the project owner granted `.claude/skills/autonomous-dev-loop/`
a narrower-but-deeper exception to this section's "plan only, never implement automatically" rule
— see that skill's §3 for the exact wording and the two conditions that must both hold (no task
findable/creatable for the current phase, and a just-completed independent-review cycle found zero
issues) before it may start implementing, not just planning, the next phase. This exception applies
only inside that skill's own autonomous loop; every other context — interactive sessions, any other
skill — still follows this section exactly as written above.

## 10. Git and permissions

Governed entirely by `AGENTS.md`'s existing git policy (§K) — nothing in this document changes
it. Roadmap and future-phase-plan changes are isolated on their own branch, never mixed into an
unrelated feature commit, and never disrupt an in-progress feature branch or merge. Recording or
updating this roadmap never itself authorizes a push of `dev` beyond the standing approval
`AGENTS.md` §K.2 already records, a merge into `main`, a tag, or a release — each remains
separately gated exactly as before.
