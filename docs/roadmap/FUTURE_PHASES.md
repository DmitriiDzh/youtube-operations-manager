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

**Prioritization principles for future planning** (added 2026-09-26, owner instruction — "Strategic
Roadmap Update — Post Phase 8"), applied whenever a future phase is planned, reordered, or
reprioritized:

1. Validate completed functionality with real operational use before expanding it further (see
   §2a's Operational Validation Gate).
2. Prefer real operational feedback over speculative architecture polishing.
3. Build reusable interfaces around actual use cases, not anticipated ones.
4. Keep owned-channel analytics (private, Phase 8) and public market/competitor observations
   (Phase 9) explicitly separate — never blend them into one dataset or one permission tier.
5. Preserve provenance for every stored observation, evidence item, and decision.
6. Treat AI-generated outputs as hypotheses or proposals, never as established fact or a
   statistical probability.
7. Preserve human approval for consequential operations until the project owner explicitly
   changes that (restates, does not replace, `AGENTS.md` §G's existing approval model).
8. Optimize for automation, scalability, and low manual operator workload once validated.
9. Avoid premature graph databases, vector databases, or distributed systems unless a validated
   use case actually requires one — a plain relational table exposed over the existing MCP/API
   surface is this project's own established default (e.g. `analytics_collection_runs`).
10. Design production/experiment workflows so an individual stage or asset can be replaced
    without rebuilding the entire pipeline.

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

## 2a. Immediate priority — Operational Validation Gate

**Recorded 2026-09-26, owner instruction ("Strategic Roadmap Update — Post Phase 8").** This is
not a new product-feature phase — its purpose is to prove the system already built (Phases 0-8,
Phase 7's agent interface, the pre-release cross-platform foundations in §2 above) can actually be
used safely and practically, before the product is expanded further. It sits ahead of Phase 9 in
priority order: Phase 9 does not begin until this gate's workstreams are addressed, or the owner
explicitly reprioritizes.

Five independently-tracked workstreams — none is itself a new phase, and completing one does not
imply the others are also complete:

**A. Phase 5 Gate B.** Complete the previously defined live validation of the YouTube write
pipeline (`docs/TECHNICAL_DEBT.md` RISK-09, `docs/acceptance/PHASE_5_ACCEPTANCE.md` §4). The write
barrier (`assertLiveWritesAuthorized`) stays in place until that separately-authorized live
validation actually succeeds — this gate does not weaken any Phase 5 safety requirement, and
completing the other four workstreams below never substitutes for it.

**B. Codex / external-agent end-to-end validation.** Validate the real operational-agent workflow
through the released Agent Operations Interface (Phase 7), with the agent working entirely without
development-repository access (`AGENTS.md` §B). At minimum validate: capability discovery; channel
context retrieval; video context retrieval; analytics access; comparable-video discovery;
asset-performance access; localization draft creation; Content Proposal creation;
evidence/rationale recording; and that the agent genuinely cannot reach APPROVE/EXECUTE. Use real
application data where safe; never grant the operational agent development permissions.

**C. Cross-platform runtime validation.** Run the actual application on a real Windows machine and
verify: launcher/startup; the persistent data directory; settings persistence; update behavior; a
local build; and device handoff with the already-tested macOS installation. Per
`docs/ROADMAP_STATUS.md`'s Pre-Release rows, macOS has actually been exercised (a real production
build/launcher run); Windows runtime validation remains incomplete (`docs/TECHNICAL_DEBT.md`
RISK-17, whose own title is stale on this exact point — see that entry's 2026-09-26 update). Do
not claim Windows support is validated until it has actually been executed on Windows.

**D. Device handoff validation.** Verify the existing single-active-device workflow on two real
machines. Do not expand this into simultaneous multi-device synchronization — that remains its
own, separately-tracked future direction (§7).

**E. Phase 8 operational analytics validation.** Verify the analytics actually exposed to agents
match what's visible in the product and are genuinely useful for real operational decisions: data
freshness, date ranges, metric definitions, comparable-age behavior, missing-data behavior, and
weekly-report consistency.

**Completion criterion:** the product can be used for real, supervised operations without
development-repository access, manual architecture bypasses, or silent safety degradation.

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

## 4. Phase 8 — Owned-Channel Analytics

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

**Status:** slices 1-3 DONE (see §12's marker below); a much larger, detailed extended-scope
description was recorded 2026-09-26 in `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
(verbatim) with an analysis and execution plan in `docs/roadmap/plans/PHASE_9_PLAN.md` Part II —
planned only, not assigned; this section's own summary below predates and remains consistent with
that fuller detail.

**Objective:** extend the intelligence platform beyond owned-channel data — continuously discover
and observe competitor channels, competitor videos, emerging formats, topics, niches, creative
patterns, public trend signals, and potentially attractive new channel opportunities. Must not
assume the operator already knows every relevant competitor; no fixed competitor-list cap — use
discovery, prioritization, and resource budgets instead.

**Discovery.** Support discovery of new channels/videos/topics from public YouTube data, search
queries, related content, channel/video relationships, observed growth patterns, and — where
justified — future external trend sources.

**Observation.** Persist public observations over time: channel/video identity, title,
description, thumbnail reference, publication date, public views, channel public statistics where
available, upload frequency, duration, category/topic signals, and historical observations. Only
store data actually available through permitted sources — never fabricate or estimate a metric a
source doesn't actually expose.

**Watchlists.** Support dynamic watchlists — a channel/video/topic may enter or leave one based on
operator choice, agent proposal, discovery rules, or observed relevance. A watchlist is not the
same as a permanent competitor database; membership is expected to change over time.

**Trend candidates.** Structured records containing observed evidence, source references,
freshness, why the candidate was surfaced, affected topics/niches, and confidence/uncertainty
notes. AI-stated confidence is never treated as a statistical probability (§1's prioritization
principles).

**Market opportunity candidates.** Broader candidates, including niches entirely outside the
operator's current channels. Every candidate must be explainable through stored public
observations — never conclude profitability from public view counts alone.

**Agent integration.** Expose this intelligence through the existing Agent Operations Interface
(Phase 7) — Codex-class agents should be able to query discovered channels, observed competitor
history, trend candidates, topic/niche candidates, and the underlying public evidence. Keep OWNED
PRIVATE ANALYTICS (Phase 8) and PUBLIC MARKET OBSERVATIONS (this phase) clearly distinguished
throughout the interface — never let one silently stand in for the other. Never fabricate
unavailable competitor metrics such as CTR, retention, traffic sources, revenue, or private
subscriber-conversion data — these are not observable through public sources and must not appear
even as an estimate.

Constraints: no arbitrary fixed competitor-list limit — use resource budgets, prioritization, and
discovery rules instead; never assume access to a competitor's private analytics, CTR, retention,
or revenue; never treat publicly observed growth as proof of profitability; never restrict
discovery to music or the operator's existing niches.

**Deliverable / completion criterion:** the system identifies new research candidates — previously
unknown channels, topics, or niches — and states which public observations, with freshness
metadata, support each one, never an unexplained ranking.

## 6. Phase 10 — Decision & Experiment Engine

**Objective:** create a controlled system for turning evidence (Phase 8 owned-channel analytics,
Phase 9 market intelligence, historical content/assets, prior proposals and experiments, and
operator goals) into testable actions, and for learning from the results.

**Core entities**, kept explicitly distinct throughout — no consequential action executes merely
because an AI agent proposed it:

- **Hypothesis** — a falsifiable proposition (e.g. a thumbnail pattern may improve CTR; a specific
  video duration may improve watch time; a localized title structure may improve target-language
  discovery; a new channel concept may have enough market evidence to justify a pilot).
- **Evidence** — supports or contradicts a hypothesis, drawn from owned analytics, public market
  observations, historical experiments, or external research; always retains provenance back to
  its source.
- **Experiment** — hypothesis, affected channel/content, treatment, control/baseline, start
  conditions, duration, success criteria, stopping criteria, required sample/coverage constraints
  where applicable, budget/resources, responsible agent/human, and approval status.
- **Outcome** — actual data, comparison against baseline, data-quality limitations, and whether the
  experiment's own criteria were actually met.
- **Retrospective** — what was learned. An AI agent may never silently rewrite a past outcome or
  piece of evidence.

Supports both **(A) optimizing existing channels** (titles, thumbnails, localization, publication
timing, format/duration, content concepts, packaging) and **(B) validating entirely new channel
opportunities** via small pilot experiments — an AI recommendation is never itself permission to
launch a new channel into production.

**Agent integration.** Codex-class agents should be able to propose hypotheses, attach evidence,
create experiment drafts, suggest criteria, review results, and produce retrospectives. Human
approval is preserved before any consequential execution, until the project owner explicitly
changes that.

**Completion criterion:** a decision can be traced end-to-end — evidence → hypothesis → approved
experiment → execution → analytics → outcome → retrospective — without losing provenance at any
step.

## 6a. Post-Phase-10 direction — Publishing Pipeline

**Recorded 2026-09-26 as the next likely product direction after the Decision & Experiment
Engine — not approved implementation work; do not implement now.** Objective: let a completed
media package move safely toward YouTube publication. Conceptual workflow: Content Proposal →
Production Package → Validation → Upload as Private → Human Review → Schedule/Publish.

Potential future capabilities: register a final rendered video; validate required
metadata/assets; upload the video through the YouTube Data API as private; upload its thumbnail;
apply metadata/localizations; retrieve the resulting YouTube video ID; preserve upload
audit/provenance; review inside YouTube Operations Manager; separately approve
scheduling/publication.

`UPLOAD_PRIVATE` and `PUBLISH` must be treated as separate permission classes/capabilities —
uploading a private draft must never silently authorize public publication. Every external
mutation this would introduce still passes through the product's existing controlled action model
and never bypasses Phase 5 write safety (`AGENTS.md` §G).

## 6b. Post-Phase-10 direction — Media Production Automation

**Recorded 2026-09-26 as a strategic direction, not approved implementation.** Objective: let
operational agents use the product's own intelligence to produce or coordinate new media, without
this application internally implementing every generation model itself. Potential future workflow:
Decision/Content Proposal → production specification → external audio/image/video tools →
generated artifacts → quality control → artifact registration → final render → Publishing Pipeline
(§6a) → outcome analytics.

Potential domains: thumbnail generation, image generation, video generation, audio generation,
script generation, rendering, quality-control checks, production manifests. This application's own
role stays limited to context, analytics, historical references, production specifications, the
asset registry, provenance, workflow state, and approval boundaries — avoid building monolithic,
model-specific generation logic into the core application. Supersedes/absorbs the older, terser
"automated media production" bullet §7 used to carry — not duplicated there anymore.

**Relationship to Phase 11 (below), added 2026-09-26:** Phase 11 — Channel Workspaces & Production
Orchestration is the concrete foundation this direction depends on (channel-scoped production
workspaces, an asset registry that can reference files inside one, a Workflow Registry describing
external procedures). This bullet stays the higher-level "why," Phase 11 is the "what gets built" —
see that section rather than duplicating scope here.

## 7. Future directions — not yet numbered phases

Recorded as future opportunities only, not approved implementation work, and not to be
implemented during Phases 7-10 unless separately approved.

**Deferred infrastructure directions** (grouped 2026-09-26 per the owner's "Strategic Roadmap
Update" — recorded as deferred, not planned in implementation detail):

- **Simultaneous multi-device operation.** The current single-active-device model remains
  acceptable. Do not assume the existing Syncthing-based handoff (`docs/RELEASE_LAYOUT.md`) is
  sufficient for genuine concurrent multi-device database synchronization — it explicitly is not,
  by design (Variant A is one-active-device-at-a-time). Future simultaneous operation will require
  a deliberate synchronization/conflict model, not just embedding Syncthing further.
- **Application-managed synchronization** — a potential future replacement for the external
  Syncthing transport. `src/lib/sync-gateway/`'s existing transport-adapter design already keeps
  this option open (Syncthing today, a custom transport later) — keep current sync/storage
  abstractions transport-independent where practical.
- **Localization transport modernization** — the same still-open direction as the "Replace XLSX as
  the localization Change Set interface..." bullet below, restated under this grouping for
  visibility. Safety-critical (feeds the write pipeline) — never migrate casually; requires its own
  dedicated future design/acceptance process.
- **Comments / subscriber capabilities** — require a feasibility analysis against current official
  YouTube API capabilities (see the Studio-parity bullet below, which already flags this as an
  unresolved feasibility question for Home's comment/subscriber cards) before adding either to the
  roadmap as committed functionality. Do not promise unavailable YouTube Studio parity.
- **Manual workflow-shortcut launcher** (recorded 2026-09-26, owner follow-up while scoping down
  Phase 11 §11's Workflow Registry — see that section). A possible future interface where the
  operator points this product at specific external workflow paths, so its own UI can serve as a
  manual-launch shortcut for a given production workflow (e.g. "create a video"). Explicitly
  deferred — "это детальнее мы продумаем позже" — not designed, not scoped, not part of Phase 11's
  own deliverable.
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
  **Not to be confused with a separate, narrower, already-completed task (2026-09-26,
  `docs/roadmap/plans/SHARED_XLSX_MODULE_PLAN.md`):** the genuinely generic XLSX mechanics (cell
  reading, sheet building, safety limits) were extracted into `src/lib/shared-xlsx/` so any future
  screen can reuse them — a pure structural move, zero behavior change, that neither answers nor
  narrows this bullet's own still-open question about XLSX's long-term role.
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
  `src/lib/agent-connections/` module, per-capability zone assignment, fail-closed-once-enabled
  policy). **Update, 2026-09-25:** owner confirmed both open scope questions (expand zoning beyond
  the Phase 7 `agent_*` DRAFT tier to `channel_sync`/`changeset_create_from_import`/
  `ai_localization_*`: "Согласен"; keep the new tables device-local, not synced: "Оставим
  локально"). All three slices (data model, enforcement at the 6 approved MCP tools + CLI
  equivalents, Settings UI) are done and merged `--no-ff` into `dev` in `18f8854`, 2026-09-25
  (owner approval, Telegram "Ок, мердж"). An unassigned capability is rejected for everyone once
  one or more connections are enabled -- even
  with only one connection, since the owner explicitly rejected treating a sole connection as an
  implicit grant ("нельзя одну и ту же зону ответственности дать обоим... добавление одного
  агента не должно автоматом давать ему авторство над всеми модулями", Telegram 2026-09-25).
  This work is **not** the same as `docs/TECHNICAL_DEBT.md`
  RISK-32 (device-availability-gate consistency, separately OPEN, untouched by this feature); it
  separately tracks its own `RISK-60` (`write_channel_select`/`auth_user_select` mutate global,
  not per-connection, active-channel state). The independent-review cycle ran 13 rounds and was
  stopped by explicit owner instruction, 2026-09-25 (not because a round found zero issues) --
  see `docs/roadmap/BACKLOG.md` BL-091 row for the tally.

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

**Reinforced, 2026-09-26 (owner instruction):** this roadmap's existence is never itself
authorization — do not automatically start Phase 9 because it is recorded here, and do not
automatically proceed from Phase 9 to Phase 10 once Phase 9 is done. Each still requires its own
explicit owner assignment, exactly as this section already requires for every phase.

## 10. Git and permissions

Governed entirely by `AGENTS.md`'s existing git policy (§K) — nothing in this document changes
it. Roadmap and future-phase-plan changes are isolated on their own branch, never mixed into an
unrelated feature commit, and never disrupt an in-progress feature branch or merge. Recording or
updating this roadmap never itself authorizes a push of `dev` beyond the standing approval
`AGENTS.md` §K.2 already records, a merge into `main`, a tag, or a release — each remains
separately gated exactly as before.

## 11. Phase 11 — Channel Workspaces & Production Orchestration

**Recorded 2026-09-26, owner instruction (Telegram, after reviewing `docs/roadmap/plans/
CHANNEL_WORKSPACES_WORKFLOW_RUNTIME_ANALYSIS.md`) — "Согласен, можешь сохранить как это как Phase
11." Recording only; not assigned, not sequenced relative to Phase 9/10, and not authorized for
implementation (`AGENTS.md` §C — recording a phase here is planning only).**

**Scope resolved the same day, in follow-up discussion of the analysis document's two flagged
conflicts — both are now closed, and the phase is substantially narrower than the original
26-section proposal.** The two follow-up discussions are summarized here; the analysis document
itself is left as a historical snapshot of the pre-discussion research, not rewritten to match.

**Objective:** give operational agents (Codex, or a future Claude session managing a channel) a
production-cycle substrate that pairs this product's own structured context (Phase 8 analytics,
Content Proposals) with a device-local production-file location per channel — without this product
itself brokering, cataloging, or executing anything inside that location.

**Resolved: Global Operations Workspace stays exactly as already implemented.** One shared,
human-configured, read-only, text-file-only path (`docs/AGENT_OPERATIONS_INTERFACE.md` §4j,
BL-087), set once on the "AI Agent" Settings tab, independent of channel or which agent connects
(Codex or a future Claude-as-channel-manager both read the same shared instructions). **Claude Code
(the development agent working in this repository) has no access to this path — not read, not
write** — resolving the analysis's conflict #2 by removing the write-access question rather than
answering it: the coding agent was never a candidate writer here, and the "keep instructions
current for operational agents" need this raised is already served by this repository's own
technical/release documentation (`docs/interfaces.md`, `docs/AGENT_OPERATIONS_INTERFACE.md`, and
each MCP tool's own self-describing schema via `agent_get_capabilities`) — content operational
agents already discover through the interface itself, never through a hand-written instructions
file that could be confused with editorial/channel-strategy content.

**Resolved: Channel Workspace is just a per-channel local path, nothing more.** This product's own
responsibility is limited to: a Settings field, next to each linked channel, where the operator
sets a local filesystem path on that device; storing it (device-local, never synced — the same
"deliberately excluded from sync/snapshot" shape `cloud_connection`/`agent_connections` already
use, keyed on this app's existing `deviceId`, `src/lib/bootstrap-config/`, if the same channel is
ever managed from more than one device); and exposing it read-only to an already-channel-scoped,
already-authorized agent through the existing Agent Operations Interface (no new access-control
dimension needed — the existing `assertActiveChannel` channel-scoping already gates who can even
ask). **This product never enumerates, reads, writes, or validates anything inside that path.**
What the folder contains and how it's organized is entirely the operational agent's own concern,
governed by that agent's own instructions living outside this repository — this removes conflict
#1's read/write/binary-file risk by construction: there is no file-access surface on this
product's side to secure, because it never touches the files themselves (the agent uses its own
native filesystem tools, the same way Claude Code uses `Read`/`Write`/`Bash` locally, not a
brokered MCP call).

**Resolved: no Workflow Registry in this phase.** Dropped entirely for now, per explicit owner
decision (2026-09-26): *"Пока что убираем полностью, в будущем сделаем интерфейс в котором
пользователь сам сможет прокидывать пути до конкретных воркфлоу и таким образом наш интерфейс
будет служить условным 'ярлыком' для запуска в ручном режиме тот или иной воркфлоу... но это
детальнее мы продумаем позже."* (For now, removed entirely; a future interface may let the
operator point at specific workflow paths so this product's own UI can serve as a manual-launch
shortcut for a given workflow — design deferred, not scoped here.) This is recorded as its own,
separate, not-yet-designed future direction (§7's "Deferred infrastructure directions" territory,
once it's actually planned) — not part of Phase 11's own deliverable.

**Constraints:** never let a channel-workspace path imply or grant filesystem access beyond
returning that one string; never let this feature take on any file-brokering responsibility later
without a fresh, explicit design/acceptance pass (this phase's whole safety posture depends on
never touching the files); respect existing channel-scoping (`assertActiveChannel`) and multi-agent
responsibility zoning (`src/lib/agent-connections/`) rather than inventing a parallel mechanism.

**Deliverable:** the operator can set a local production-workspace path per linked channel per
device; a connected, channel-authorized operational agent can read that path back through the
existing interface; this product's own responsibility ends at the path string.

Original 26-section proposal, initial reusable-vs-new inventory, and the two conflicts this
follow-up discussion resolved: `docs/roadmap/plans/CHANNEL_WORKSPACES_WORKFLOW_RUNTIME_ANALYSIS.md`
(left as a historical snapshot — read this section for the phase's actual, current scope).

## 12. Current next-action marker

Recorded 2026-09-26, owner instruction ("Strategic Roadmap Update — Post Phase 8") — kept short
and updated in place rather than accumulating a new dated paragraph every time it changes, since
its whole purpose is to answer "what's next" at a glance:

**CURRENT NEXT PRIORITY:** Operational Validation Gate (§2a) remains the default priority order —
**explicitly superseded for Phase 9 specifically** on 2026-09-26, when the owner directly assigned
Phase 9 over Telegram ("Создай новую ветку для Phase 9, Market Discovery & Trend Intelligence.
Проведи исследование и составь план. Приступай к выполнению плану.") without first completing
§2a's workstreams. Per §2a's own escape clause ("or the owner explicitly reprioritizes"), this is
that explicit reprioritization for Phase 9 alone — it does not waive §2a for any other phase, and
§2a's five workstreams remain open and still block everything else in this list.

**DONE, slices 1-3:** Phase 9 — Market Discovery & Trend Intelligence (§5), merged to `dev` in
`b83c9b2` (2026-09-26) — manually-seeded watchlist, Web UI/API, public-snapshot fetch. See
`docs/ROADMAP_STATUS.md` and `docs/roadmap/plans/PHASE_9_PLAN.md` Part I for detail.

**EXTENDED SCOPE PLANNED, NOT ASSIGNED (2026-09-26):** the owner sent a much larger, detailed
39-section description of this same phase the same day slices 1-3 merged (market data model,
discovery, historical observation/trend/breakout detection, topic/creative intelligence, niche
discovery, quota-budgeted collection, a full Agent Operations Interface surface) — verbatim in
`docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`, analyzed with an execution plan in
`docs/roadmap/plans/PHASE_9_PLAN.md` Part II (§10-17). **This is a plan only — none of it is
authorized to start** until the owner resolves the 5 decisions Part II §12 identifies (background-
collection scheduling; a YouTube API quota budget shared with the rest of this app; whether/when
to spend on real AI for topic/creative analysis; when `search.list`-based discovery is authorized;
cross-device history transfer for the new observation tables) and explicitly assigns a next slice.

**DEPENDENCY:** Phase 10 (§6) depends on Phase 9 (§5) and Phase 8 (§4).

**POST-PHASE-10 DIRECTIONS:** Publishing Pipeline (§6a) and Media Production Automation (§6b).

**ALSO RECORDED, NOT YET SEQUENCED:** Phase 11 — Channel Workspaces & Production Orchestration
(§11) — recorded 2026-09-26; whether it runs before, after, or alongside Phase 9/10 has not been
decided, and its own file-access scope is still under discussion with the owner (see §11's "Open,
owner-level decision").

**DEFERRED:** simultaneous multi-device operation, application-managed synchronization,
localization transport modernization, and other infrastructure improvements without immediate
operational value — see §7's "Deferred infrastructure directions."

None of the above is an authorization to start work — see §8's priority order and §9's planning
policy, both unaffected by this marker's existence.
