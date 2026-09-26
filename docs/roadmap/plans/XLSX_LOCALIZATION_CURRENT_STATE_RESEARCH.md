# XLSX-based localization: current-state research (BL-075, deepened)

Produced 2026-09-26, per the project owner's Telegram request: *"Про предпоследний пункт — замена
xlsx на json для локализации. По моему мы это обсуждали уже. Запусти исследование на тему того как
это работает сейчас."* This deepens `docs/roadmap/BACKLOG.md` BL-075 (`proposed`, recorded
2026-09-23), which is itself the tracked future-direction item in `docs/roadmap/FUTURE_PHASES.md`
§7 ("Replace XLSX as the localization Change Set interface with the same JSON/MCP-based pattern...").

**This is research only — how the pipeline works today.** It does not propose or decide anything
about replacing, deprioritizing, or keeping XLSX; it does not authorize any implementation. Per
`AGENTS.md` §C, any actual change here needs its own explicit future assignment; per `AGENTS.md`
§F/§L, this subsystem is safety-critical (the Change Set mechanism has authority over exactly
`title`/`description`, per language, and nothing else) so a real design pass would need the full
`AGENTS.md` §A reading list before a single line of implementation, same as BL-075's own row
already states.

## 0. What BL-075's first research pass (2026-09-23) already established

The original ask ("эксель нам тоже не нужен... перевод делать должен агент, а не человек") was
built on a framing that turned out not to match the actual architecture: **XLSX was never the
agent's authoring interface.** "Generate with AI" (`src/lib/ai-localization/`) already bypasses
XLSX entirely and produces the identical Change Set. The concrete, narrower gap that research
found — no MCP/CLI tool could reach `generateProposals`/`createChangeSetFromGeneration` — was
scoped out and delivered as BL-078 (done, 2026-09-23). BL-075 itself stayed `proposed`: the
broader question (does XLSX still deserve a place as an interface at all, specifically for a human
reviewer/editor, and what would a JSON/MCP-based replacement need to cover) was deliberately left
open. This document is that deeper look, verified against the current code, not assumed to still
match after three days of further work on this branch's own history.

## 1. Three current authoring paths into a Change Set

| Path | Entry point(s) | External-agent reachable? |
|---|---|---|
| **XLSX import** | `parseAndValidateWorkbook` (`src/lib/changesets/import.ts:109`) → `createChangeSetFromImport` (`src/lib/changesets/services.ts:496`) | Yes — MCP `changeset_create_from_import`, CLI `changeset import` (both take base64 workbook bytes) |
| **AI generation** | `generateProposals` (`src/lib/ai-localization/services.ts:246`) → `createChangeSetFromGeneration` (`services.ts:413`) → shared `createChangeSetFromProposals` (`src/lib/changesets/services.ts:323`) | Yes — MCP `ai_localization_generate`/`ai_localization_create_change_set`, CLI `ai-localization generate`/`create-change-set` |
| **Manual in-review edit** | `updateChange` inside the Change Set review UI (`src/components/change-set-review.tsx`) | No — Web-UI-only, no MCP/CLI tool touches an individual `Change`'s value post-creation |

Approve/reject/apply (turning a `pending` Change into `approved`, or into a live YouTube write via
a Batch) has **no MCP tool and no CLI command at all** today — confirmed against `src/mcp/server.ts`
and `src/cli/video-metadata.ts`'s `changeset`/`ai-localization` namespaces (`changeset: ["list",
"get", "preview", "import"]`, `"ai-localization": ["generate", "create-change-set"]`,
`src/cli/video-metadata.ts:168,172`). This is the documented RISK-04-class gap
(`docs/SYSTEM_MAP.md` §2.13-adjacent) — the Web UI remains the only way to approve anything or run
a Batch, regardless of which of the two agent-reachable paths created the Change Set.

## 2. XLSX's exact current role

- **Library:** `exceljs` (`src/lib/localization/adapters/xlsx.ts`, `src/lib/changesets/import.ts`).
- **Export** produces two data sheets plus a metadata sheet:
  - **Videos**: `channel_id, channel_name, video_id, youtube_url, published_at, default_language, original_title, original_description`.
  - **Localizations**: `video_id, language, language_name, title, description, remote_title, remote_description, status`.
  - **Meta** (added in Phase 4): `schema_version`, `exported_at`, `channel_id` — used on import for wrong-channel protection and as the conflict-detection baseline's provenance.
- **Import validation** (`import.ts:109-266`) runs two tiers: structural checks that reject the
  whole file (missing sheet/columns, file over 25MB, over 20,000 rows, `Meta.channel_id` mismatch),
  and per-row checks that are collected per-row so the rest of the file still imports (missing
  `video_id`/`language`, invalid language code, video not on the active channel, duplicate row,
  oversized title/description).
- **Validation is fully shared with AI generation, not duplicated.** Both paths call the same
  `classifyFieldChange`/`computeConflictStatus`/`currentRemoteValueFor`/`isValidLanguageCode`/
  `YOUTUBE_TITLE_MAX_LENGTH`/`YOUTUBE_DESCRIPTION_MAX_LENGTH` from `src/lib/changesets/diff.ts`. No
  drift was found between what XLSX import accepts/rejects and what AI generation accepts/rejects.
- **Export is not purely an import companion.** `remote_title`/`remote_description` captured at
  export time is literally the conflict-detection baseline used later by `computeConflictStatus`
  (`diff.ts`) — so even a workflow that never re-imports a file still uses export's own snapshot
  mechanism as the baseline. Nothing else in the app reads an exported file for any other purpose.
- **Real-usage evidence, not merely theoretical availability:** `docs/ROADMAP_STATUS.md`'s
  Languages-tab-merge row records a live-browser-verified "XLSX export-selected → real file
  download" alongside AI generation on the same real channel — both paths are exercised, not just
  present in code.

## 3. The shared Change Set core

- **Data model** (`docs/PROJECT_SPEC.md` §17): `ChangeSet {id, channelId, source, createdAt,
  status, changes[]}`, `Change {videoId, language, field, before, after, validationStatus,
  approvalStatus, applyStatus, error}`. The actual `source` values found in code are
  `"xlsx_import" | "ai_localization" | "deletion"` (`src/components/languages-manager.tsx`) — the
  spec's own list also mentions `"manual_edit"`/`"api"`/`"mcp_agent"` as conceptually possible
  values, but no such enum member exists; an in-review edit mutates an existing `Change` in place
  rather than creating a new, separately-sourced one.
- **Field-scope enforcement is a single choke point, not scattered.**
  `export type ChangeField = "title" | "description"` (`src/lib/changesets/contracts.ts:15`),
  referenced by every `Change`-shaped type in the module. This is exactly what makes
  `AGENTS.md` §F / `docs/PROJECT_SPEC.md` §21's "exactly title and description, nothing else"
  invariant structural (the type system itself has no way to represent a different field) rather
  than a convention someone could accidentally violate in a new call site.
- **Diff/conflict/approval**: `diff.ts` holds the pure comparison functions; `computeChangeSetStatus`
  drives the deterministic lifecycle; since 2026-09-21 the Automerge document under
  `sync-gateway/change-drafts/` is the actual source of truth, with the SQL tables a regenerated
  projection (`docs/SYSTEM_MAP.md` §2.9m-adjacent).
- **Provenance**: the `ai_localization_generation_provenance` table is an immutable per-Change-Set
  snapshot of which editorial-profile version/effective context produced it. XLSX import has no
  equivalent provenance record — there is nothing to attribute; the value is a raw human-supplied
  input, not a generation the system needs to explain later.

## 4. Current MCP/CLI inventory for this domain

**MCP:** `changeset_list`, `changeset_get`, `localization_import_preview`,
`changeset_create_from_import`, `ai_localization_generate`, `ai_localization_create_change_set`
(`src/mcp/server.ts`). Matches `docs/interfaces.md`'s own MCP inventory for this domain exactly —
no discrepancy found.

**CLI:** `changeset {list, get, preview, import}`, `ai-localization {generate, create-change-set}`
(`src/cli/video-metadata.ts:168,172`).

**Known gap:** RISK-51 (`docs/TECHNICAL_DEBT.md`) — CLI `ai-localization generate` has no
`--editorialBrief` flag even though MCP's own tool exposes it (the field is optional, so this is a
feature-parity gap, not a bug); the project owner personally deferred fixing this, still `OPEN`.

**Not exposed to any agent today, by either path:** approve/reject/apply (Web-UI-only, tied to
Gate B's live-write barrier for the apply step specifically), and
`getEditorialProfile`/`saveEditorialProfile`/`getGenerationProvenance` for the AI-localization
domain specifically (a *different*, Phase-7 `agent_get_generation_provenance` tool exists and
covers provenance lookup generically across domains, per `docs/interfaces.md`, but not this
domain's own profile read/write).

## 5. What a JSON/MCP-based replacement would actually displace

- **XLSX-specific code that would become dead if import specifically were removed:**
  `src/lib/changesets/import.ts` (the whole parser, ~266 lines), the MCP
  `changeset_create_from_import` tool and CLI `changeset import` command, the "Import from XLSX" UI
  block in `languages-manager.tsx`, and the XLSX-wrapping portion of
  `createChangeSetFromImport` in `services.ts`. Everything downstream of the point where a parsed
  file becomes a list of `ChangeToPersist` records is **already** 100% shared with the AI-generation
  path via `createChangeSetFromProposals` — its own doc comment states it "produces the same
  `ChangeToPersist` shape XLSX import produces and hands it to this one shared path." A JSON/MCP
  authoring path would not need to reinvent diff, conflict detection, persistence, or approval —
  only whatever XLSX import's file-parsing step is doing today.
- **Export's fate is a separate question from import's.** Export builds the conflict-detection
  baseline independent of whether any file is ever re-uploaded; removing import does not, by
  itself, remove a reason for export's underlying baseline-capture mechanism to exist — though
  export specifically *as a spreadsheet file format* (as opposed to some other way of capturing
  that baseline) would need its own separate justification if XLSX were dropped as a format.
- **BL-075's still-open question, restated against current facts, not decided here:** XLSX import
  is genuinely still the only *bulk*, spreadsheet-shaped, externally-editable interface into this
  pipeline that requires no coding or API access — a human reviewer can open, edit, and re-upload
  it today with nothing but a spreadsheet application. No JSON/MCP equivalent for that specific
  "bulk edit by a non-agent human, no tooling required" use case exists anywhere in the codebase
  today. This research found no new evidence pointing either way on whether that capability is
  still wanted going forward — it is exactly as open a question now as BL-075 left it on
  2026-09-23, just now grounded in a confirmed, current picture of what exists.

## 6. Test coverage for the XLSX-specific code

`src/lib/localization/adapters/xlsx.test.ts` — 3 tests (Videos-sheet shape, Localizations-sheet
shape, video-subset scoping on export). `src/lib/changesets/import.test.ts` — 13 tests (missing
sheet, missing columns, wrong-channel `Meta`, blank-means-no-change, ADD/MODIFY/CONFLICT
classification, wrong-channel `video_id`, malformed language code, duplicate rows, oversized field,
oversized file, summary categorization). **16 tests total** would need preserving or deliberately
replacing if XLSX import were ever removed or replaced.

## 7. Doc-vs-code discrepancies found

None. `docs/SYSTEM_MAP.md`, `docs/interfaces.md`'s MCP/CLI inventory, and
`docs/roadmap/BACKLOG.md` BL-075/BL-078 all matched the actual current code exactly on every point
checked (file locations, function names, tool names, CLI namespaces, and the shared-vs-XLSX-specific
code boundary). This is, as of this research pass, a well-documented subsystem with no drift.

## 8. What this document deliberately does not do

It does not recommend keeping, removing, or replacing XLSX. It does not sketch a JSON/MCP schema
for a hypothetical replacement authoring path. It does not resolve BL-075's open question about
whether a human-reviewer bulk-edit interface is still wanted. Any of that is a future, separately
assigned design task (`AGENTS.md` §C), and per that same section's own reading requirement, would
need the full `AGENTS.md` §A pass before a single line of implementation — this document exists so
that future pass starts from an accurate picture of the current system rather than from the
original, since-corrected framing.
