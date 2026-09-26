# Channel Workspaces & Workflow Runtime — Analysis (not a plan, not implementation)

Produced 2026-09-26 per the project owner's Telegram request: *"Проведи анализ этого дополнения к
фазе 7"* (analyze this addition to Phase 7), quoting a 26-section spec titled "Phase 7 Extension —
Channel Workspaces & Workflow Runtime Foundation." **This document is analysis only. No code was
written. It does not authorize, scope, or begin implementation of anything described here or in
the owner's own spec.**

Method: three independent research passes over the actual current repository state (not the
owner's spec, not assumptions) — (1) the Agent Operations Interface, asset catalog, content
proposals, and multi-agent zoning; (2) the channel model, cross-platform/device architecture, and
sync-gateway; (3) `docs/PROJECT_SPEC.md`, the roadmap documents, `docs/TECHNICAL_DEBT.md`, and the
ADR index, plus an `AGENTS.md` §A governance check. Every claim below traces to a specific file,
line, or document section — see "Evidence index" at the end.

## TL;DR — two conflicts to resolve before any design work starts

**1. This is not a Phase 7 extension — it is the already-recorded, deliberately-deferred §6b
"Media Production Automation" direction, arriving out of sequence.**

`docs/roadmap/FUTURE_PHASES.md` §6b (added today, 2026-09-26, in the same session as this
analysis) already describes almost exactly this proposal's core: *"let operational agents use the
product's own intelligence to produce or coordinate new media... Potential future workflow:
Decision/Content Proposal → production specification → external audio/image/video tools →
generated artifacts → quality control → artifact registration → final render → Publishing Pipeline
→ outcome analytics... the asset registry... workflow state."* That section is explicitly labeled
"a strategic direction, not approved implementation" and is sequenced **after** Phase 9 and Phase
10 — neither of which is assigned. The roadmap's own §11 "Current next-action marker" states the
current priority is the Operational Validation Gate (§2a), then Phase 9; §9 explicitly says *"do
not automatically start Phase 9 because it is recorded here, and do not automatically proceed from
Phase 9 to Phase 10."*

Phase 7 itself (`FUTURE_PHASES.md` §3) is scoped as API/MCP/CLI contracts, the permission model,
capability discovery, and draft/approval separation — it never covered local filesystem workspace
management or external-tool workflow orchestration, and its one filesystem-adjacent deliverable
(item 2 below) was explicitly narrowed *away* from that territory nine days ago. Calling the new
proposal a "Phase 7 extension" does not change what its content actually is, and — per the
roadmap's own sequencing rule — content that matches §6b needs the same authorization §6b needs:
an explicit owner decision to reprioritize ahead of Phase 9/10, made knowingly, not inferred from
Phase 7's completion.

**2. The proposal asks for the opposite of a boundary the owner drew narrower two days ago.**

Phase 7 slice I (BL-087, `docs/AGENT_OPERATIONS_INTERFACE.md` §4j) already built something in this
space: a single **global** (not per-channel), **read-only**, **text-file-only**
(`.md/.txt/.json/.yaml/.yml`, size/depth-capped) "operations workspace" path, settable only by a
human via Settings, never by an agent. The owner's own words when scoping it (Telegram,
2026-09-24): *"Как вести канал будет сложено в папке вне данного репозитория... Чтобы эта
информация попала к подключенному агенту и не попадала при этом в наш репозиторий."* This was a
deliberate narrowing from a fuller "operations-workspace template" concept (AGENTS/config/
permitted-capabilities/task-output folders) down to exactly this scope, hardened across 3
independent-review rounds specifically because of the path-traversal/self-authorization risk a
broader, writable, binary-capable workspace would reintroduce.

The new proposal asks for **per-channel**, presumably **read/write**, **multi-media-type**
(branding/audio/video — binary files, not text) workspaces — the exact direction the owner just
moved away from. This may well be the right call now that the underlying need (production-file
context per channel) is clearer, but it is a substantive widening of a boundary drawn two days ago
for a stated reason, not a forgotten gap. It deserves an explicit yes from the owner, with that
history in view, not a "since Phase 7 is done, this follows naturally" framing.

Everything below assumes the owner still wants this analyzed on its technical merits regardless of
where it lands sequencing-wise — the two points above are what to resolve before deciding *when*,
not reasons the content itself is unsound.

## What already exists and is directly reusable

- **`shared-provenance`** (`src/lib/shared-provenance/index.ts`) — `CreatedVia`
  (`"mcp"|"cli"|"web_ui"`) and `EvidenceReference`, already used by both `ai-localization` and
  `content-proposals`. A Workflow Registry recording who/what created a workflow run should adopt
  this directly rather than reinventing it — exactly the `AGENTS.md` §M case it was extracted for.
- **`bootstrapConfig.deviceId`** (`src/lib/bootstrap-config/`) — a stable, device-local,
  never-synced UUID generated once per install, already threaded through `device-handoff` and
  `sync-gateway`. This is precisely the "device identity" primitive §5 of the owner's spec
  (cross-platform paths) needs to key a workspace-root binding on — it does not need to be
  invented.
- **Sync-gateway's existing "never synced" precedent** — `deviceId` and `syncthingRootPath` are
  read fresh from a local JSON file every cycle and never enter any Automerge document; every
  synced document family is designed to converge to identical content across devices. A
  channel-workspace's device-local root path fits this exact shape (its own local record, read
  fresh, never synced) — no new *pattern* is needed, only a new record.
- **`agent-connections` zoning** (`src/lib/agent-connections/`) — `assertAgentAllowedForCapability`
  treats a capability id as an opaque string with no enum/CHECK constraint; adding a new zoneable
  capability (e.g. a future `workflow.execute`) needs **zero schema migration** — just a new
  constant and a call site. Confirmed both by direct code reading and by the DB schema itself.
- **`src/lib/operations-instructions/`'s path-safety logic** (`services.ts`) — the codebase's one
  real, hardened precedent for validating an operator-configured directory: realpath-based
  containment (`path.relative`, never `startsWith`), app-data-dir overlap rejection, symlink-aware
  entry classification, depth/count budgets, cycle detection. This is the concrete technique a new
  channel-workspace module should reuse (as a shared, imported module — see "module boundaries"
  below) — not reimplement from scratch. It is currently scoped globally and to text files only;
  extending it to per-channel and to binary files is new work, but the containment logic itself
  transfers directly.
- **`asset-catalog`'s opaque reference model** (`referenceKind`/`referenceValue`) — already has a
  three-way discriminated shape (`url | local_path | external_artifact_id`); a fourth kind such as
  `workspace_relative_path` (workspaceId + relativePath, per §9 of the owner's spec) fits this
  existing pattern without restructuring the table.
- **Zero-migration extensibility for zoning** and **the catalog/registry pattern already used
  three times** (`asset-catalog`, `content-proposals`, `operations-instructions`) as separate,
  narrow modules that delegate to each other rather than duplicating — this is the template a
  Workflow Registry module should follow, not a new shape.

## What has no existing precedent and would be built from nothing

- **Per-channel arbitrary configuration storage.** The only generic key-value table
  (`appSettings`) is singleton/global — every existing key is a single flat value, never
  channel-namespaced. This repository's own consistent pattern for "new per-channel data" is a
  dedicated table with a `channel_id` FK (every one of `videos`, `changeSets`,
  `channelEditorialProfiles`, `batches`, `creative_assets`, `content_proposals` follows this). A
  channel-workspace-binding table should follow the same pattern, not stretch `appSettings`.
- **Fine-grained, sub-channel resource scoping.** Every scoping mechanism that exists today stops
  at "the whole channel" (`assertActiveChannel`) or "one global path" (operations-workspace) — there
  is no concept of "this agent may see subset X of this channel's own resources." A workspace
  capability tier that wants to expose semantic directory bindings (§4 of the owner's spec) as
  individually grantable/revocable would be new modeling, not a reuse of anything that exists.
- **Per-(channel, device) filesystem access to binary files.** The one working precedent
  (operations-instructions) is global, read-only, and text-extension-allowlisted by design,
  specifically to keep the self-authorization/path-traversal surface small. Extending this to
  binary media files, writes, and per-channel scoping multiplies that surface — the safety analysis
  done for the existing feature (3 independent-review rounds) would need to be redone from
  scratch for the new one, not assumed to still hold.
- **Task/run correlation.** `docs/TECHNICAL_DEBT.md` RISK-57 already tracks that no capability in
  the Agent Operations Interface stamps a `taskId` — "originating task" traceability is an
  open, only-partially-addressed gap. A Workflow Registry that wants to trace an execution back to
  an agent task and a Content Proposal (§16 of the owner's spec) would be the first thing in this
  codebase to actually need and close that gap, not something it can lean on today.
- **A workflow descriptor schema/table and its MCP discovery surface.** No existing table or
  module resembles this. The catalog pattern (asset-catalog/content-proposals) is a directly
  applicable template, but the actual descriptor shape, execution-backend enumeration, and
  availability model are new design, not adaptation of something existing.
- **A registry entry for path-traversal/security findings.** `docs/TECHNICAL_DEBT.md` has no
  RISK-NN specifically for the operations-workspace's path-traversal defenses — that work is
  documented inline in `docs/AGENT_OPERATIONS_INTERFACE.md` §4j instead. A new, wider-surface
  filesystem module should decide up front whether its own security findings get a tracked RISK
  entry (recommended, given the larger surface) rather than living only in a design doc.

## Governance check (`AGENTS.md` §A) — clear result, not ambiguous

This proposal trips at least three of §A's independent triggers for the full seven-document
mandatory reading pass, regardless of its "Phase 7 extension" framing:

1. It introduces a new subsystem/module boundary other work would build on (nothing in `src/lib/`
   today manages per-channel local media folders or external-procedure descriptions).
2. It requires new persisted schema (a workflow registry needs its own table(s); a channel-workspace
   binding needs its own table).
3. It touches channel identity and data preservation (per-channel workspaces are channel-scoped by
   definition and hold production media — exactly what `AGENTS.md` §F's own-channel verification
   discipline and `PROJECT_SPEC.md` §21/§27/§30's write-safety/data-preservation categories exist
   for).

Whoever picks this up next should read `docs/PROJECT_SPEC.md`, `docs/ROADMAP_STATUS.md`,
`docs/SYSTEM_MAP.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT_PLAYBOOK.md`,
`docs/TECHNICAL_DEBT.md`, and `docs/decisions/` in full before any design pass — not skip it on the
strength of Phase 7 having already been read once.

## Module-boundary assessment (`AGENTS.md` §M)

Per the repository's own established pattern — Phase 7 alone produced three separate, narrow
modules (`asset-catalog`, `content-proposals`, `operations-instructions`) that delegate to each
other rather than merging, plus a dependency-free `shared-provenance` extraction for genuinely
shared vocabulary — **"channel workspaces" and "workflow registry" read as two distinct concerns
and should very likely be two separate modules**, not one combined module:

- **Channel workspaces** = a filesystem-organization and access-control concern. Its path-safety
  logic is the natural candidate for extraction into a shared module both it and
  `operations-instructions` import, rather than each maintaining its own copy of containment/
  symlink defenses that took three review rounds to harden the first time — the textbook §M
  shared-logic case.
- **Workflow Registry** = a metadata/description-only catalog of external procedures, with no
  execution in this pass. Its closest analog is `asset-catalog`/`content-proposals`, not
  `channel-workspaces`.

Both would need to independently satisfy §M's core requirement (the rest of the app keeps working
if either is disabled/removed) — every Phase 7 sibling module achieved this by being an optional,
additive read/draft layer with no core route depending on it, and there is no structural reason
these two couldn't follow the same shape, but it needs to be verified for each, not assumed.

## Section-by-section technical feasibility (owner's spec, condensed)

| Spec section | Feasibility given current architecture |
|---|---|
| §1-2 Conceptual split (global workspace / channel workspace / workflow runtime) | Sound — matches how `operations-instructions` (global) and `asset-catalog`/`content-proposals` (per-channel) are already separated. Keeping the three concepts in three different modules follows existing convention. |
| §3-4 Channel workspaces + semantic bindings | New table needed (no existing per-channel KV to reuse); the "roles as data, not a rigid enum" requirement is easy to satisfy (a `role -> relativePath` map is just JSON in a column, same pattern `content_proposals.brief_json` already uses for a flexible sub-shape). |
| §5 Cross-platform paths, device-local binding | `deviceId` already exists and is exactly the right key; a `(channelId, deviceId) -> rootPath` table is new but trivial given the primitive already exists. |
| §6 Settings/config UI | Directly analogous to the existing `operations-workspace-settings.tsx` component and `agent-connections-manager.tsx`'s per-capability assignment UI — both are close templates. |
| §7-8 Agent session context, channel-specific agent context, instruction precedence | The instruction-precedence hierarchy (product safety > global > channel > task > workflow) needs to be stated explicitly wherever agent context is assembled — no existing code enforces an instruction hierarchy today (the current model is "read-only text surfaced to the agent," never "instructions that could compete with product rules"), so this is a genuinely new safety property to design and test, not a restatement of something already enforced. |
| §9 Asset catalog integration | Straightforward — a new `referenceKind` value fits the existing discriminated-union shape. |
| §10 Agent-safe file access (list/inspect/materialize) | The hardest new piece. No existing MCP tool returns binary payloads or file handles; `docs/AGENT_OPERATIONS_INTERFACE.md` §8's safety invariant ("never expose unrestricted filesystem access to any agent-facing response") is the standing constraint any design here must satisfy explicitly, not by omission. Correctly flagged in the owner's own spec as possibly needing to "remain limited" for now. |
| §11-15 Workflow Registry, descriptor, discovery, future execution, backends | The registry/descriptor/discovery pieces (metadata only) are buildable now using the existing catalog pattern. Execution is correctly scoped out of this pass by the owner's own spec (§14: "DO NOT implement... merely to satisfy this conceptual API") — treat that as load-bearing, not aspirational. |
| §16 Relationship to Content Proposals | `content_proposal_artifacts` already links a proposal to a registered asset; extending that same link shape to a workflow-run's output artifacts is additive, not a redesign. |
| §17-18 Channel-specific workflow differences, multi-agent compatibility | `agent-connections` zoning already supports per-capability assignment with zero migration for new capabilities — a `workflow.*` capability family would slot in the same way `content_proposal.*` did. |
| §19 Safety boundaries | Restates `docs/AGENT_OPERATIONS_INTERFACE.md` §8's existing invariants almost verbatim — good alignment, but "workspace instructions must never override product permissions" (§8 of the owner's spec) is a NEW enforced property (see §7-8 row above), not an existing one. |
| §20 Future in-product production | Consistent with `FUTURE_PHASES.md` §6b's own "native vs. external workflow" framing — no conflict, this is the same idea from two directions. |
| §21 Migration from current setting | Confirmed straightforward: the existing `operations_workspace_path` setting is unambiguously global/text-only/read-only and completely separate in code, storage, and purpose from what a channel-workspace would be — no conflation exists in the current code to untangle, contrary to what the spec's cautious wording might imply. |
| §22-23 Acceptance-first, smallest vertical slice | Consistent with `AGENTS.md` §L/§C — but the "smallest useful vertical foundation" as scoped (11 bullet deliverables) is still substantial; see recommendation below on further slicing. |

## Recommendation

Do not begin design or implementation now. Three honest paths, for the owner to choose between —
this analysis does not pick one:

**(a) Treat it as what it structurally is** — fold this proposal into `FUTURE_PHASES.md` §6b
("Media Production Automation"), where its content already belongs, and let it wait for Phase 9/10
to be assigned and completed first, per the roadmap's own stated sequencing. Lowest risk, most
consistent with the roadmap governance the owner set up earlier today.

**(b) Explicitly reprioritize it ahead of Phase 9/10**, the same way `.claude/skills/
autonomous-dev-loop/`'s §3 exception was granted explicitly and narrowly for a different case — if
there's a concrete reason (e.g. real production work is blocked on this today) that justifies
jumping the sequence, state it, and this analysis's technical findings above can seed a real
implementation plan.

**(c) Split the ask**: authorize only the metadata/schema layer now (channel-workspace bindings,
semantic path roles, Workflow Registry as a pure catalog with zero execution) as a bounded,
lower-risk slice, while explicitly deferring §10 (agent file access) and all of §14-15 (execution)
to Phase 9/10 or later — even this narrower slice still requires resolving conflict #2 above (the
read/write, binary, per-channel widening), since even a metadata-only workspace record implies the
intent to eventually grant that access.

Whichever path is chosen, the two conflicts in the TL;DR need an explicit owner answer before
design starts — not a "Phase 7 is done, so this follows" inference.

## What this analysis did not do

It did not design a schema, write an acceptance-criteria document, create a feature branch, or
touch any source file under `src/`. It did not decide between paths (a)/(b)/(c) above — that is the
owner's call. `docs/decisions/README.md`'s ADR index gap (0008-0010 missing) was fixed as a
one-line, zero-risk side correction found while reading it for this analysis (`AGENTS.md` §H) —
unrelated to the substance of this analysis otherwise.

## Evidence index

- `docs/roadmap/FUTURE_PHASES.md` §3 (Phase 7), §6b (Media Production Automation), §9, §11.
- `docs/AGENT_OPERATIONS_INTERFACE.md` §3 (permission model), §4c (asset catalog), §4f (content
  proposals), §4j (operations-workspace, BL-087), §8 (safety invariants).
- `docs/ROADMAP_STATUS.md` (Phase 7/9/10 rows, BL-091 row, "Next assignment").
- `docs/PROJECT_SPEC.md` §1, §66 (no filesystem/workflow/external-tool scope anywhere in the
  document).
- `docs/TECHNICAL_DEBT.md` RISK-32, RISK-52, RISK-56, RISK-57, RISK-58, RISK-60.
- `docs/decisions/` 0001-0010 and `README.md`.
- `src/lib/agent-operations/{contracts,services}.ts`, `src/lib/agent-connections/{contracts,
  services}.ts`, `src/lib/asset-catalog/{contracts,services}.ts`, `src/lib/content-proposals/
  {contracts,services}.ts`, `src/lib/operations-instructions/services.ts`, `src/lib/
  shared-provenance/index.ts`, `src/lib/bootstrap-config/{contracts,services}.ts`, `src/lib/
  sync-gateway/change-drafts-sync/services.ts`, `src/lib/db.ts` (channels, appSettings,
  creative_assets, content_proposals, agent_capability_zones tables), `src/mcp/server.ts` (agent_*
  tool registrations).
