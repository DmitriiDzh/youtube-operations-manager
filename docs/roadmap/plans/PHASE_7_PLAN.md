# Phase 7 Plan — Codex Operations Interface

Produced 2026-09-20 per `docs/roadmap/FUTURE_PHASES.md` §9's planning sequence, covering backlog
items `BL-001` and `BL-002` (`docs/roadmap/BACKLOG.md`). **This is a plan, not an implementation.**
Nothing here authorizes writing the actual MCP tools, API routes, or workspace described below —
that requires its own explicit assignment per `AGENTS.md` §C, exactly like any other phase.

## 1. Current repository state relevant to this phase

- **MCP surface today** (`src/mcp/server.ts`, 744 lines): tools for auth/write-context
  (`writeContext`, `writeChannelList`, `writeChannelSelect`, `whoami`, `authUserSelect`), video
  metadata (`list`, `transcript`, `preview`, `apply`), and playlist management (`playlistList`,
  `playlistCreate`, `playlistDelete`, `playlistUpdate`, `playlistAddVideos`,
  `playlistRemoveVideos`). Transport is `StdioServerTransport` only — no HTTP transport is
  instantiated anywhere (`docs/TECHNICAL_DEBT.md`'s dependency-audit table confirms this for the
  `hono`/`express`-family transitive deps).
- **What's missing for Codex to do anything with Phase 4-6's work:** no `changeset_*`,
  `localization_*`, `channel_sync`, `batch_*`, or `ai_localization_*` MCP tools exist yet — this
  is exactly `docs/TECHNICAL_DEBT.md` RISK-04, already documented, `BLOCKS_OPERATIONS_RELEASE`.
  RISK-04's own note is reassuring for scoping this phase: `createChannelSyncCore()`,
  `createLocalizationCore()`, and `createChangeSetCore()` are already interface-agnostic (same
  pattern as the existing `createVideoMetadataCore()` that the current MCP tools already wrap),
  so exposing them is additive wiring, not a redesign.
- **Existing read/propose/apply pattern to reuse, not reinvent** (`docs/DEVELOPMENT_PLAYBOOK.md`
  §6.7): read tools return data with no side effect; propose-adjacent tools create local draft
  state (a Change Set, a preview) with no YouTube write; apply-class tools are the only ones that
  can reach a write path, and only after the same identity/guardrail checks every other write
  path already uses (`write-context.assertWriteChannel`).
- **The live-write barrier** (`docs/TECHNICAL_DEBT.md` RISK-09/Gate B) is unconditional and
  independent of this phase — any new "apply"-class MCP tool for changesets/batches inherits it
  automatically as long as it goes through the existing `WriteExecutor`/batch pipeline rather than
  a new write path (`AGENTS.md` §D: no parallel guardrail).

## 2. Existing capabilities vs. missing dependencies

| Capability Phase 7 needs | Status |
|---|---|
| Interface-agnostic core logic for channel sync / localization / change sets | **Exists** (`createChannelSyncCore`, `createLocalizationCore`, `createChangeSetCore`) |
| MCP tools exposing that core logic | **Missing** — RISK-04, this is most of this phase's actual work |
| A versioned release the Codex workspace would talk to | **Missing** — `published/<version>/` mechanism exists (`docs/decisions/0003-published-release-snapshots.md`) but no version has been published yet |
| An isolated Codex operations workspace (own permissions, no dev-repo access) | **Missing** — does not exist in any form; `AGENTS.md` §B already states the boundary this workspace must respect, but nothing enforces it today because there is no such workspace |
| Standardized error shapes | **Partially exists** — `DomainError` and MCP tools already return structured errors (`docs/DEVELOPMENT_PLAYBOOK.md` §6.7); needs extending to any new tool, not invented fresh |
| Compatibility rules between an agent's configuration and the product release it talks to | **Missing entirely** — no versioning scheme exists yet for what a Codex config declares itself compatible with |

## 3. Smallest useful vertical slice

Given the above, the smallest slice that produces real value without crossing any safety gate is:

**Read/propose-only MCP tools for Change Sets and Batches** (`changeset_list`, `changeset_get`,
`localization_import_preview`, `batch_list`, `batch_get`) — no apply-class tool yet. This mirrors
RISK-04's own suggested remediation and deliberately excludes the apply-class tool RISK-04 also
mentions, because an apply-class Change Set/Batch MCP tool needs Gate B's live-write validation
track resolved first (a separate, already-tracked blocker, unaffected by this phase) — bundling
that into Phase 7's first slice would violate `AGENTS.md` §C's "smallest safe implementation
phase" by conflating two independent gates.

The isolated Codex workspace and the compatibility-rule mechanism are a second, separate slice —
they depend on a published version existing to point at, which nothing currently assigned
produces (`published/<version>/` remains genuinely empty per policy, §K.4).

## 4. Scope and explicit non-goals for this phase, once assigned

**In scope (eventually, on separate assignment):**
- `changeset_*`, `batch_*` (read/propose only), `localization_*` MCP tools.
- A documented compatibility-declaration mechanism (e.g. a `compatibleWith` field in whatever
  manifest `published/<version>/build-info.json` already carries, extended if needed).
- Draft-only operation semantics documented for every new tool, matching the existing
  read/propose/apply convention.

**Explicitly out of scope, regardless of how this phase eventually proceeds:**
- Any apply-class Change Set/Batch tool that can reach a real YouTube write — blocked by Gate B
  independently of Phase 7.
- Any channel-specific editorial guidance, prompt, or playbook content — `AGENTS.md` §B forbids
  this in this repository permanently, not just during this phase.
- A custom agent-orchestration framework, if Codex's own native capabilities already cover
  workspace isolation — per `FUTURE_PHASES.md` §3's own constraint.
- Actually running Codex against this application, or performing a real OAuth login, or
  publishing a version for Codex to target — each has its own separate authorization
  (`AGENTS.md` §G/§K, `docs/PROJECT_SPEC.md`).

## 5. Interfaces, data structures, and security boundaries needed

- New MCP tool schemas (Zod, matching every existing tool's pattern) for `changeset_list`,
  `changeset_get`, `localization_import_preview`, `batch_list`, `batch_get` — read-only inputs,
  structured `DomainError`-shaped failures, channel-scoped (reusing the existing
  channel-ownership verification pattern per `AGENTS.md` §F, not a new one).
- A `docs/interfaces.md` section for the new MCP tools, following that document's existing
  format.
- A compatibility manifest field, decided jointly with whatever `published/<version>/` metadata
  already exists — this needs an ADR if it changes `build-info.json`'s schema non-additively
  (`docs/DEVELOPMENT_PLAYBOOK.md` §6.3).
- Security boundary: every new tool must be independently verified (an automated inventory test,
  mirroring `src/lib/batches/write-path-inventory.test.ts`) to prove it cannot reach a YouTube
  write — the same discipline Phase 5/6 already established, reused rather than reinvented.

## 6. Proposed implementation slices (for whichever future assignment picks this up)

1. `changeset_list`/`changeset_get` MCP tools (read-only) + tests.
2. `localization_import_preview` MCP tool (already-existing preview-only core logic, just wired
   through MCP) + tests.
3. `batch_list`/`batch_get` MCP tools (read-only) + tests.
4. `docs/interfaces.md` update documenting all of the above.
5. (Separate, later assignment) apply-class Change Set/Batch tools — blocked on Gate B.
6. (Separate, later assignment) the isolated Codex workspace itself and the compatibility-rule
   mechanism — blocked on a first published version existing.

## 7. Acceptance criteria (drafted from the requirement, per `AGENTS.md` §L — not from a draft implementation, since none exists yet)

For slices 1-4 above, once assigned:
- Each new MCP tool has a passing test proving: (a) it returns the same data shape the existing
  Web UI/API route for the same core function returns; (b) a wrong-channel request fails closed
  with a structured `DomainError`, not a bare exception; (c) no code path inside the tool can
  reach `videos.update` or any other write method — verified by an automated inventory test, not
  manual inspection.
- A negative test exists for at least one malformed-input case per tool (missing required field,
  wrong type) proving the tool's Zod schema rejects it before reaching the core logic.
- `docs/interfaces.md` accurately lists every new tool with the same detail level as existing
  entries — verified by a human or reviewer diff-reading the new section against an existing one.

## 8. Required project-owner decisions before implementation can start

- Confirm this slice's scope (read/propose-only, no apply-class tool) matches what "Phase 7" is
  meant to mean, or clarify if a narrower/broader first slice is preferred.
- Decide whether the compatibility-declaration mechanism belongs in this phase's first slice or a
  later one — it has no urgency until a version is actually published.
- Explicit assignment to begin implementation (this document is planning only, per `AGENTS.md`
  §C — recording this plan does not itself authorize writing the code above).

## 9. Where this is recorded

This plan lives here, not in `docs/roadmap/BACKLOG.md` (the tracked-item list) or
`docs/roadmap/FUTURE_PHASES.md` (the strategic description) — per `FUTURE_PHASES.md` §9 step 9.
`BL-001` and `BL-002` in `docs/roadmap/BACKLOG.md` point at this document once marked `done`.
