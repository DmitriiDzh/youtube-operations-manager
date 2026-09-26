# Shared XLSX I/O module — implementation plan

Produced 2026-09-26, per the project owner's Telegram instruction: *"давай вынесем и обобщим этот
функционал — экспорт / импорт в эксель. Это должен быть отдельный модуль который мы будет
подключать к разным экранам в будущем при необходимости. На данный момент можно сделать его
подключенным только к переводам. Его статус всегда должен быть как вспомогательный, дополнительный
инструмент и он никогда не задействован в стандартном процессе хранения данных."*

This follows directly from `docs/roadmap/plans/XLSX_LOCALIZATION_CURRENT_STATE_RESEARCH.md`
(produced minutes earlier the same session), which established the exact current boundary between
generic spreadsheet mechanics and localization-specific business logic. This plan turns that
boundary into an actual module.

**This is NOT BL-075's "replace XLSX with JSON/MCP" question.** That question (does XLSX still
deserve a place as a human-editable interface at all) stays exactly as open as the research left
it. This task does something narrower and orthogonal: take the XLSX capability that already exists
and already works, and factor its genuinely generic parts into their own module so any other
screen can reuse them later, per `AGENTS.md` §M's shared-logic-extraction principle. Nothing about
XLSX's role in localization changes for the end user; this is a structural move, not a behavior
change or a product decision.

## 1. Module boundary — what is genuinely generic vs. what stays domain-specific

Verified against the actual current code (`src/lib/localization/adapters/xlsx.ts`,
`src/lib/changesets/import.ts`):

**Moves to the new module (`src/lib/shared-xlsx/`) — zero knowledge of channels, videos, or
localization:**

| Function | Current location | What it does |
|---|---|---|
| `cellText` | `changesets/import.ts` | Reads a cell as safe plain-text data (rich text, cached formula result, date, number, boolean) |
| `buildHeaderIndex` | `changesets/import.ts` | Header-name → column-index map, so a workbook survives column reordering |
| `styleHeaderRow` | `localization/adapters/xlsx.ts` | Bold header row, vertical-middle alignment |
| a new `buildWorkbook(sheets)` | inlined in `xlsx.ts`'s `buildWorkbook` | Generic: given sheet specs (name, columns, rows, optional freeze/autoFilter/wrapText columns), produces an `ExcelJS.Workbook` |
| a new `workbookToBuffer` | inlined in `xlsx.ts` | `workbook.xlsx.writeBuffer()` → `Buffer` |
| a new `loadWorkbookFromBuffer(buffer, {maxBytes})` | top of `parseAndValidateWorkbook` | Empty-buffer / oversized-buffer / corrupt-workbook checks, then `ExcelJS.Workbook().xlsx.load()` |
| a new `readKeyValueSheet(workbook, sheetName)` | `readMetaSheet` in `import.ts` | Generic two-column key→value sheet reader, returns `null` if the sheet doesn't exist |
| a new `findMissingColumns(headerIndex, required)` | inlined in `parseAndValidateWorkbook` | Set-difference check, no domain meaning |
| a new `assertDataRowCountWithinLimit(sheet, maxRows)` | inlined in `parseAndValidateWorkbook` | Row-count safety check, assumes row 1 is a header (the same convention `buildHeaderIndex` already uses) |

**Stays exactly where it is — this is the load-bearing business logic:**

- Which sheet/columns are required (`"Localizations"`, `REQUIRED_LOCALIZATION_COLUMNS`) —
  `changesets/import.ts`.
- The specific Videos/Localizations/Meta column layouts and what data fills them —
  `localization/adapters/xlsx.ts`, now built by calling the generic sheet-builder with
  localization's own column specs, not by hand-rolling `ExcelJS` calls.
- All per-row business validation: video-on-channel check, language-code validation, duplicate
  detection, title/description length limits, field-change classification, conflict detection —
  `changesets/import.ts` + `changesets/diff.ts`, completely untouched.
- The specific limit *values* (`MAX_WORKBOOK_BYTES = 25MB`, `MAX_LOCALIZATION_ROWS = 20_000`) —
  these are this app's own tuning decisions, not a generic XLSX concern; they stay as constants in
  `changesets/import.ts`, only the *mechanism* that enforces them moves to the shared module.
  `docs/TECHNICAL_DEBT.md` RISK-01 (upload-size enforcement is best-effort) gets its "Affected
  components" list updated to name the new module's `loadWorkbookFromBuffer`, since that is now
  where the post-parse byte check actually executes — the risk itself is unchanged, only its
  location.
- `DomainError` wrapping — the shared module never throws a `DomainError` (it has no dependency on
  `changesets/contracts.ts`, keeping it usable by any future caller regardless of that caller's own
  error model). It throws small, local error classes (`XlsxSizeLimitError`,
  `XlsxInvalidWorkbookError`, `XlsxRowLimitError`); `changesets/import.ts` catches these and wraps
  them into its own `DomainError({code: "validation_failed", ...})` with the **exact same message
  text** the current 13 tests in `import.test.ts` already assert on, so no test needs to change.

## 2. Enforcing "always auxiliary, never in the standard storage path" mechanically

A doc comment saying "don't depend on this from core persistence" is not a guarantee — this
codebase's own established pattern for a rule like this is a mechanical inventory test (see
`youtube-read-gateway/read-gateway-inventory.test.ts`, `batches/write-path-inventory.test.ts`).

New `src/lib/shared-xlsx/usage-inventory.test.ts`: greps every `.ts`/`.tsx` file under `src/` for
an import of `@/lib/shared-xlsx` (or a relative equivalent) and asserts the importing files are
**exactly** an explicit allowlist — initially `src/lib/localization/adapters/xlsx.ts` and
`src/lib/changesets/import.ts`, nothing else. Adding a new screen's XLSX support later means adding
its own adapter file to that allowlist deliberately, not an accidental import from inside a
`services.ts`/persistence path. This gives the owner's "always auxiliary" requirement a real,
enforced meaning: `shared-xlsx` can never become a dependency `createChangeSetFromProposals` (the
actual persistence path used by both XLSX import AND AI generation) needs to function — and the
test fails loudly the day someone tries.

## 3. Files touched

- **New:** `src/lib/shared-xlsx/index.ts` (all functions above), `src/lib/shared-xlsx/index.test.ts`
  (unit tests for the generic functions themselves, independent of localization), and
  `src/lib/shared-xlsx/usage-inventory.test.ts` (§2's mechanical check).
- **Refactored, same public API, zero behavior change:**
  - `src/lib/localization/adapters/xlsx.ts` — `createXlsxBuilder().buildWorkbook({channel, videos})`
    keeps its exact signature and return shape (`{buffer, rowCount}`); internally calls
    `shared-xlsx`'s `buildWorkbook`/`workbookToBuffer` instead of raw `ExcelJS`.
  - `src/lib/changesets/import.ts` — `parseAndValidateWorkbook`, `classifyRowForSummary`,
    `summarizeParsedWorkbook`, `MAX_WORKBOOK_BYTES`, `MAX_LOCALIZATION_ROWS` keep their exact
    signatures; internally calls `shared-xlsx`'s reading primitives instead of local copies.
  - Neither `src/lib/localization/services.ts` nor `src/lib/changesets/services.ts` needs any
    change — both call the same public functions with the same shapes as before.
- **Tests:** the existing 3 tests in `xlsx.test.ts` and 13 tests in `import.test.ts` must pass
  **unmodified** — that is the acceptance criterion for "zero behavior change," per `AGENTS.md` §L
  (a passing pre-existing test suite is evidence here precisely because these tests were written
  independently of this refactor and encode the actual contract).
- **Docs:** ~~`docs/ARCHITECTURE.md` (new section describing the module, mirroring how
  `shared-crypto`/`shared-logger`/`shared-provenance` are already documented)~~ **Amended during
  implementation (independent review, 2026-09-26): this line's own premise was wrong.** None of
  `shared-crypto`/`shared-logger`/`shared-provenance` are actually documented in
  `docs/ARCHITECTURE.md` at all — checked, zero mentions of any of the three anywhere in that file.
  They live only in `docs/SYSTEM_MAP.md` (via the task/backlog row that created each one), which is
  the real precedent this module follows — done as the new `docs/SYSTEM_MAP.md` §2.9u instead, plus
  a note in the existing Localization/Change-Set sections pointing at the new module.
  `docs/DEVELOPMENT_PLAYBOOK.md`
  §6.10 (update the reference example to name the new module alongside the two thin adapters),
  `docs/TECHNICAL_DEBT.md` RISK-01 (affected-components update, §1 above),
  `docs/roadmap/FUTURE_PHASES.md` §7's XLSX-replacement bullet (one sentence distinguishing this
  modularization from that still-open question, so a future reader doesn't conflate the two),
  `docs/roadmap/BACKLOG.md` (new row), `docs/ROADMAP_STATUS.md` (once merged).

## 4. Explicitly not an ADR

Per `docs/decisions/README.md`'s own criterion ("a new domain module following the existing
pattern... does not need one") — this is exactly that: a new utility module following the
already-three-times-used `shared-*` pattern (`shared-crypto`, `shared-logger`, `shared-provenance`),
not a replacement of a major subsystem or a write-safety/schema/API-contract change. No ADR.

## 5. Validation

`npm test` (all pre-existing tests unmodified and passing, plus new `shared-xlsx` tests),
`npx tsc --noEmit`, `npm run lint`, `npm run build`, `git diff --check`. Independent review before
presenting for merge (this is a substantive/structural change per `AGENTS.md` §K.2, even though it
changes no observable behavior — new module boundary, `AGENTS.md` §A trigger).

## 6. What this explicitly does not do

Does not add a second XLSX consumer yet (Analytics/asset-catalog export, etc.) — the owner's own
instruction is "connect it to translations only for now." Does not change any UI, API route, MCP
tool, or CLI command — every existing entry point keeps calling the same domain functions with the
same signatures. Does not touch `diff.ts`, conflict detection, approval, or persistence. Does not
resolve BL-075's open question about XLSX's long-term role.
