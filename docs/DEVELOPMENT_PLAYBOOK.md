# DEVELOPMENT_PLAYBOOK.md

A practical implementation manual for future Claude Code sessions working on this repository. This is **not** a product roadmap — that is `docs/PROJECT_SPEC.md`. This is **not** a component map either — that is `docs/SYSTEM_MAP.md`, which this document references rather than duplicates. This document explains **how** to extend the actual, current architecture using the patterns already established in Phases 0–4, with real file paths and real examples.

If a rule here ever conflicts with `AGENTS.md`, `AGENTS.md` wins — this is a how-to guide, `AGENTS.md` is the persistent policy.

---

## 6.1 Repository orientation

Read `docs/SYSTEM_MAP.md` first — it is the authoritative, current map of every subsystem (responsibility, file paths, entry points, dependencies, read/write behavior, security boundaries). Do not duplicate it here. In one sentence per layer:

- **Entry points:** Web UI at `src/app/**` (Next.js App Router), CLI at `src/cli/video-metadata.ts`, MCP server at `src/mcp/server.ts`, API route handlers at `src/app/api/**/route.ts`.
- **Domain modules:** `src/lib/{video-metadata,playlist-management,write-context,channel-sync,localization,changesets,cli-auth}/` — each independent, each following the same internal layering (§6.2).
- **Persistence:** one file, `src/lib/db.ts`, wrapping a single local SQLite (libSQL) database at `data/playlist-manager.db`. No domain module talks to the database directly — each has its own `adapters/store.ts` wrapping `db.ts` functions.
- **Authentication:** `src/lib/auth.ts` (NextAuth + PKCE loopback + device flow) and `src/lib/cli-auth/*` (CLI/MCP local credential resolution) — both converge on the same `ResolvedCredentials` shape and the same `users` table.
- **YouTube client:** `src/lib/youtube.ts` — the **only** low-level `googleapis` wrapper. Every domain module's `adapters/youtube-api.ts` is a thin wrapper around functions in this one file.
- **Tests:** co-located `*.test.ts` next to the module they test, run by Node's built-in `node:test` via `tsx` (`npm test`), no Jest/Vitest.

Before touching any of these, run `git status`, check recent commits, and read `docs/SYSTEM_MAP.md`'s §4 "Статус компонентов" to know what is actually implemented vs. planned vs. deferred right now — that section is updated every phase and is more current than this playbook's prose could ever guarantee to be.

---

## 6.2 Adding a domain module

Every module under `src/lib/*` follows the same five-piece layering. This is not a suggestion — it is the single most important convention in this codebase, and every phase since Phase 0 has reused it rather than inventing a new shape.

```text
contracts.ts   — plain TS types + a DomainError class re-export (see below) with stable error codes
schemas.ts     — Zod schemas validating every input/output boundary, plus parseWithSchema()
services.ts    — orchestration logic; a factory function taking a ServiceDependencies object
                 (dependency-injected, so it is fully unit-testable with fake adapters, no network/DB)
adapters/      — concrete implementations: *.ts files wrapping real I/O (YouTube API calls,
                 src/lib/db.ts calls, exceljs, logging)
index.ts       — a createXCore() factory wiring the real adapters into services.ts
*.test.ts      — co-located next to the file under test
```

**Where logic belongs:**

- Business rules, classification, validation logic that has no I/O → pure functions, ideally in their own file (see `src/lib/changesets/diff.ts` — classification and conflict detection have zero dependencies and are directly unit-testable).
- Anything that talks to an external system (YouTube API, filesystem, `exceljs`) → an adapter in `adapters/`, injected into `services.ts` through its `ServiceDependencies` type. Never call `googleapis` or `db.ts` directly from `services.ts`.
- Input/output shape validation → `schemas.ts`, using `parseWithSchema(schema, payload, context)` (every module reimplements this tiny helper identically — see `src/lib/changesets/schemas.ts` for the current version — rather than sharing one, to keep modules independent).
- Errors → a `DomainError` with a stable `code` (see `src/lib/video-metadata/contracts.ts`'s `DomainErrorCode` union — this is the **one shared type** across modules; every domain module re-exports `DomainError`/`isDomainError` from it rather than defining its own error class). Adding a new error code means adding it to that one union and to `src/app/api/video-metadata/error-status.ts`'s `DOMAIN_ERROR_STATUS` map.

**Real examples, smallest to most complete:**

- `src/lib/write-context/` — the smallest module: one guardrail service, no persistence adapter beyond a thin `channelSelectionStore` wrapper.
- `src/lib/channel-sync/` — a read-only module with a real YouTube adapter (batched `videos.list`, paginated `playlistItems.list`) and a real persistence adapter.
- `src/lib/localization/` — a pure read model with **zero** YouTube calls, only a persistence adapter (reusing `channel-sync`'s tables) and an `exceljs`-based export adapter.
- `src/lib/changesets/` — the most complete example: pure logic (`diff.ts`), a non-trivial parser with its own resource-safety limits (`import.ts`), a `services.ts` with transactional persistence, and a dedicated `contracts.ts`/`schemas.ts` pair.

**A new module never**: creates a second YouTube client abstraction (extend `src/lib/youtube.ts` instead), duplicates `write-context`'s guardrail, or writes its own SQLite connection (add tables/functions to `src/lib/db.ts`, wrap them in `adapters/store.ts`).

---

## 6.3 Adding database entities

Current schema and initialization strategy: `src/lib/db.ts`, a single Drizzle `sqliteTable` per entity plus a boot-time `initializeDatabase()` that runs `CREATE TABLE IF NOT EXISTS` for every table (idempotent — safe to run against both an empty database file and an existing one) and try/catch `ALTER TABLE ADD COLUMN` for any additive column added to an existing table.

**This is a deliberate, documented decision, not an oversight** — see `docs/decisions/0001-additive-idempotent-schema-strategy.md`. Follow it:

1. Add a new `sqliteTable(...)` definition in `db.ts` for a new entity, or a new nullable/defaulted column on an existing table.
2. Add the matching `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE ADD COLUMN` to `initializeDatabase()`'s SQL block.
3. Add the table to the `schema: { ... }` object passed to `drizzle(client, { schema: {...} })`.
4. Write plain, flat, function-per-operation persistence functions (not a repository class) — e.g. `createChangeSetWithChanges`, `listStoredChangesByChangeSet`, `updateStoredChange`. Look at the `changes`/`change_sets` functions at the bottom of `db.ts` for the current, most complete example, including the transactional pattern (`db.transaction(async (tx) => { ... })`) used when multiple rows must be written atomically.
5. Wrap those functions in your module's `adapters/store.ts` (do not import `db.ts` from `services.ts` directly).
6. **Test schema initialization against both an empty database and the existing one** before considering the change done — see §6.11 for how.

**When formal migrations become necessary:** the moment a schema change is **not purely additive** — a column type change, a `NOT NULL` backfill on existing rows, a data transformation, or a multi-step ordering requirement. At that point, stop and write a new ADR (`docs/decisions/`) proposing Drizzle Kit migrations (already an installed devDependency, unused) **before** making the change — do not silently switch strategy. See `docs/TECHNICAL_DEBT.md` RISK-08.

**Do not** introduce a migration framework preemptively "to be safe" — every schema change through Phase 4 has been additive, and the existing pattern is verified to handle that case correctly.

---

## 6.4 Adding YouTube read operations

Reference implementation: `src/lib/channel-sync/`.

1. **Low-level call** goes in `src/lib/youtube.ts` — the single wrapper around `googleapis`'s `youtube_v3` client. If you need a new read (e.g. a new `part` on `videos.list`, or a new resource type), add a function here, not in a domain module's adapter directly.
2. **Batching:** YouTube's `videos.list` accepts up to 50 IDs per call — see `getVideosMetadataContextBatch` for the chunking pattern (chunk into groups of ≤50, one API call per chunk). Never fetch one video at a time in a loop over "all videos in a channel."
3. **Pagination:** use the uploads-playlist enumeration strategy (`channels.list` → `contentDetails.relatedPlaylists.uploads` → paginated `playlistItems.list`), never `search.list`, for full-channel enumeration — see `listUploadsPlaylistVideoIds`. `docs/PROJECT_SPEC.md` §9 requires this explicitly.
4. **Credential resolution:** every domain-module service calls `authResolver.resolve({ credentialRef, requiredScopes: [YOUTUBE_READ_SCOPE] })` before any YouTube call — see `src/lib/video-metadata/adapters/google-auth.ts`'s `resolveGoogleCredentials`, reused (not reimplemented) by every module including `channel-sync`.
5. **Channel context:** a **read** path (like `channel-sync`) does **not** need `write-context`'s `assertWriteChannel` guardrail — that guardrail exists specifically to fail-closed a **write**. Adding it to a read path is unnecessary scope creep (see `docs/ARCHITECTURE.md` §4.3 for the explicit reasoning). Only add the guardrail when you are about to call a YouTube write method.
6. **Adapter:** wrap the `youtube.ts` function(s) in your module's `adapters/youtube-api.ts`, injected into `services.ts` via `ServiceDependencies`.
7. **Quota awareness:** avoid unnecessary reads — cache/persist what you fetch (§6.3) rather than re-fetching on every UI render; do not build a naive per-item loop where a batched call exists.
8. **Tests:** unit-test the adapter's chunking/pagination math directly against a **mocked real-shaped** `youtube_v3.Youtube` client (see `src/lib/youtube.test.ts`'s "120 ids → 3 calls of 50/50/20" style test) — not just indirectly through the service layer, so the actual API-shape assumptions are verified.

---

## 6.5 Adding safe YouTube write operations

This section documents the **mandatory future pipeline** for bulk localization writes. **None of steps 3–12 below exist yet for bulk localization writes** — see `docs/TECHNICAL_DEBT.md` RISK-03 and RISK-09. Do not implement this pipeline in Phase 4.5 or as an incidental part of an unrelated task; it is Phase 5's primary scope.

| Step | Status | Where |
|---|---|---|
| 1. Identity verification | **IMPLEMENTED** (for single-item metadata/playlist writes) | `src/lib/write-context/service.ts` (`assertWriteChannel`) — reuse this unchanged for Phase 5, do not reimplement |
| 2. Input validation | **IMPLEMENTED** (Phase 4 import validation; single-item apply validation) | `src/lib/changesets/import.ts`, `src/lib/video-metadata/schemas.ts` |
| 3. Fresh remote-state retrieval (immediately before write) | **NOT YET IMPLEMENTED** for bulk localization writes | Phase 5 — see `docs/TECHNICAL_DEBT.md` RISK-03 |
| 4. Conflict detection (fresh vs. approved) | **PARTIALLY IMPLEMENTED** — Phase 4 detects conflicts against the last *synced* snapshot only, not a fresh call | `src/lib/changesets/diff.ts`; Phase 5 must add the fresh-fetch comparison |
| 5. Immutable backup | **NOT YET IMPLEMENTED** | Phase 5 — no `backup/` module exists |
| 6. Diff | **IMPLEMENTED** | `src/lib/changesets/diff.ts`, `getChangeSet` |
| 7. Human approval | **IMPLEMENTED** (local only — does not trigger a write) | `src/lib/changesets/services.ts` (`approveChange`/`approveAllValid`) |
| 8. Dry-run | **IMPLEMENTED** (single-item `applyMetadata`) / **NOT YET IMPLEMENTED** (bulk) | `src/lib/video-metadata/services.ts` has `dryRun`; bulk batch executor does not exist |
| 9. Apply | **NOT YET IMPLEMENTED** (bulk); IMPLEMENTED (single-item, `applyVideoMetadataUpdate`) | `src/lib/youtube.ts` has the single-item write call; no batch executor calls it for approved `Change` rows yet |
| 10. Remote verification | **NOT YET IMPLEMENTED** | Phase 5 |
| 11. Durable audit | **NOT YET IMPLEMENTED** (only ephemeral `logger.info`/`error` to stdout exists) | Phase 5 — no `audit/` module exists |
| 12. Per-item execution ledger | **NOT YET IMPLEMENTED** | Phase 5 — no `batches/` module exists |

When Phase 5 is actually implemented, the intended shape (per `docs/PROJECT_SPEC.md` §47) is three new modules — `backup/`, `audit/`, `batches/` — following the exact same `contracts/schemas/services/adapters` pattern as §6.2, consuming `Change` rows with `approvalStatus: "approved"` as their input (`src/lib/changesets/services.ts`'s `getChangeSet`/`approveAllValid` already shape exactly that "what should be applied" view) and reusing `write-context.assertWriteChannel` unchanged for identity verification.

---

## 6.6 Adding API routes

Reference: any file under `src/app/api/channels/[channelId]/change-sets/`.

1. Every route handler starts with `getServerSession(authOptions)` and returns `401` immediately if `!session?.user?.id` — no exceptions, checked across all 8 Phase 4 routes.
2. **Channel-context validation is not automatic** — a route that takes a `channelId` path parameter must have its underlying service verify the requested resource actually belongs to that channel. See `src/lib/changesets/services.ts`'s `requireChangeSet()`, which checks `changeSet.channelId === channelId` and throws `not_found` on mismatch — this prevents accessing a change set through a forged/mismatched `channelId` in the URL.
3. **Request-size validation:** for any route accepting a file/large body (multipart `formData()`), check `request.headers.get("content-length")` against a defined limit **before** calling `request.formData()` — see the `import`/`import/preview` routes. This is a best-effort guard (§`docs/TECHNICAL_DEBT.md` RISK-01) — the module's own parser must still enforce a hard limit after parsing.
4. **Input schemas:** parse everything (query params, body, path params) through the domain module's Zod schemas via `parseWithSchema` inside `services.ts` — do not hand-validate in the route handler.
5. **Typed errors:** catch `DomainError`, map via `getVideoMetadataErrorStatus(error.code)` (shared across all modules — add new codes to `src/lib/video-metadata/contracts.ts`'s `DomainErrorCode` union and to that map, as Phase 4 did for `change_not_approvable` → 409), fall back to a generic 500 for anything else. Never return bare prose for an error — always `{ error: code, message, details? }`.
6. **Domain-service delegation:** a route handler's `try` block should be a thin translation layer — parse request → call `core.someOperation(input)` → shape the response. No business logic in the route file itself.
7. **Response contracts:** JSON via `NextResponse.json(...)` for everything except binary downloads (XLSX export returns raw bytes with `Content-Type`/`Content-Disposition` headers — see `.../localizations/export/route.ts`).
8. **Security is not automatic:** *"An operation is not automatically secure merely because it modifies only local SQLite data."* A local-only write can still be reached by any authenticated session, can still be triggered against the wrong channel if the channel-scoping check (point 2) is missing, and can still be a resource-exhaustion vector (point 3) even though nothing ever reaches YouTube. Treat every new route as needing the same rigor as a YouTube-write route until proven otherwise — write a test for the cross-channel-access case specifically (see `src/lib/changesets/services.test.ts`'s "refuses access to a change set belonging to a different channel").

---

## 6.7 Adding MCP tools

Entry point: `src/mcp/server.ts` (`createMcpServer()`, `createMcpToolHandlers()`). **No Change Set MCP tools exist yet** — see `docs/TECHNICAL_DEBT.md` RISK-04.

1. Register a tool with `server.registerTool(name, { description, inputSchema }, handler)` — see any `server.registerTool(...)` call in `server.ts` for the pattern. `inputSchema` is a Zod object, always `.strict()` (rejects unknown fields).
2. Route the tool through `createMcpToolHandlers(core)` — a handler function calling the same core factory (`createChangeSetCore()`, etc.) that the API routes and CLI already use. Never re-implement domain logic inside `server.ts`.
3. **Credential resolution:** most tools accept an optional `credentialRef`; when omitted, fall back to `resolveEffectiveCredentialRef` from `cli-auth` (whoever is the locally active user). `changesets/` currently makes no YouTube calls at all, so its future MCP tools may not need `credentialRef` in the same way `apply`/`playlist_*` do — but should still resolve the active local user for logging/traceability if a future multi-user model (RISK-02) is introduced.
4. **Stable error contracts:** every tool error is `DomainError`-shaped JSON, never bare text — see `toolErrorResult(error)` in `server.ts`.
5. **Read/propose/apply classification** (`docs/PROJECT_SPEC.md` §26): a new tool must be classified honestly.
   - **Read:** `changeset_list`, `changeset_get` — always safe to expose.
   - **Propose:** `localization_import_preview`, `changeset_validate`-style tools — produce/validate a draft, never write.
   - **Apply:** anything that could result in an actual YouTube write. **Do not expose an apply-class tool for localization writes until the Phase 5 write pipeline (§6.5) exists and is tested** — an MCP tool that calls an unfinished/unsafe write path is worse than no tool at all.
6. **Safety requirement:** the operations agent (Codex) consumes only the **released, versioned** MCP surface (`AGENTS.md`'s "Development / operations separation" section) — do not add instructions here or anywhere in this repository about how Codex should conduct YouTube operations; that knowledge lives outside this repository entirely.

---

## 6.8 Adding CLI commands

Entry point: `src/cli/video-metadata.ts`. Current namespaces: `metadata`, `auth`, `playlist`. **No `sync`/`localization`/`changeset` namespace exists yet.**

1. Extend `ParsedArgs`'s `namespace`/`command` union types and `parseArgs()`'s dispatch logic — follow the existing `isAuthNamespace`/`isPlaylistNamespace` branching pattern for a new namespace.
2. Call the same core factory (`createChangeSetCore()`, etc.) other interfaces use — do not reimplement.
3. **Authentication:** resolve credentials via `createCliAuthService()` / `resolveEffectiveCredentialRef`, same as every existing command.
4. **Structured output:** every command prints a single JSON envelope to stdout — `{ ok: true, ... }` or `{ ok: false, error: { code, message, details } }` — and sets a non-zero exit code on failure. Never print unstructured prose as the primary output (structured JSON is the contract; a human-readable message can accompany it but is not a substitute).
5. **Tests:** CLI parsing (`parseArgs`) and command dispatch are unit-testable directly without spawning a subprocess — see existing CLI-adjacent tests for the pattern (most CLI behavior is actually tested at the `cli-auth`/domain-service level, since the CLI layer itself is thin).

---

## 6.9 Adding Web UI features

Reference: `src/components/{channel-sync,localization-manager,change-set-review}.tsx`, wired into `src/app/dashboard/page.tsx`.

1. **Read the local Next.js documentation before writing any code** — this project pins a Next.js version with breaking changes from training-data assumptions (`node_modules/next/dist/docs/`). This requirement is preserved verbatim from `AGENTS.md`'s Next.js agent-warning block — do not skip it.
2. **Server/client boundary:** dashboard tab components are `"use client"` components that call API routes via `fetch` — there is currently no use of Server Components/Server Actions for data fetching in this app; stay consistent with that unless there is a documented reason to introduce them.
3. **API integration:** call the route handlers from §6.6, never a domain-module core directly from a client component (that core runs server-side only).
4. **Loading/error states:** every existing tab tracks its own `loading`/`error` state via `useState`, shows a dedicated error banner, and disables action buttons while a request is in flight — follow that pattern rather than a global loading indicator.
5. **Large tables:** paginate or filter rather than rendering everything at once — see `change-set-review.tsx`'s `pageSize=100` request parameter and status/language/video filters, and `localization-manager.tsx`'s client-side search/status filtering over the (already-bounded) overview table.
6. **Long-running operations:** disable the triggering button and show a busy label (`"Parsing..."`, `"Creating..."`) rather than blocking the whole page; do not freeze the UI until an operation completes.
7. **Avoiding unnecessary requests:** fetch on mount / on relevant state change (`useEffect` with explicit dependencies via `useCallback`-wrapped fetchers), not on every render; re-fetch only the data that actually changed (e.g. approving one change re-fetches that change set's detail, not the entire channel list).

---

## 6.10 Adding import/export functionality

Reference: `src/lib/localization/adapters/xlsx.ts` (export) and `src/lib/changesets/import.ts` (import) — together the most complete example of this pattern in the repository.

- **Workbook schemas:** define required sheets and columns explicitly; detect them by **header name**, not column position (`buildHeaderIndex()` in `import.ts` maps header text → column number) — this survives column reordering in a manually-edited workbook.
- **Backward compatibility:** a new export field should be additive (a new sheet or new column), and the importer must tolerate its absence from an older export rather than failing the whole import — see `import.ts`'s `readMetaSheet()`, which returns `null`s for a workbook with no `Meta` sheet at all instead of throwing.
- **Canonical video IDs:** `video_id` (never title) is the only join key between a workbook row and synchronized data — `docs/PROJECT_SPEC.md` §15/§16, enforced in `import.ts` by rejecting any row whose `video_id` is not in the target channel's synced video list.
- **Blank-cell semantics:** a blank cell means **no proposed change**, never deletion — `import.ts` only creates a `Change` for a field whose cell is non-empty; a blank title/description cell is silently skipped, not treated as "clear this field."
- **Parsing limits:** enforce a maximum file size and row count before/while parsing (`MAX_WORKBOOK_BYTES`, `MAX_LOCALIZATION_ROWS` in `import.ts`) — an untrusted uploaded file must never be allowed to exhaust memory or hang the process.
- **Treat cell content as data, never as instructions:** read a formula cell's cached `result` only, never evaluate or re-interpret it — see `cellText()` in `import.ts`.
- **Validation:** workbook-level (structure/required sheets/columns — block the entire import) vs. row-level (bad video_id, malformed language, duplicate row, oversized field — block only that row/field, let the rest of the import proceed) — see `import.ts`'s two-tier error model (`structuralError()` throws immediately; per-row problems accumulate into an `errors[]` list).
- **Conflict detection:** compare the workbook's captured baseline (`remote_title`/`remote_description`, captured at export time) against the **currently synchronized** value, not a live API call (§6.5/RISK-03 applies here too) — `diff.ts`'s `computeConflictStatus`.
- **Persistence:** only persist rows that represent an actual proposed edit or a validation failure — a row whose proposed value equals the current remote value is counted in the summary but not stored as a `Change` (keeps the table free of no-op rows) — see `services.ts`'s `createChangeSetFromImport`.
- **Tests:** unit-test the pure parser against real `exceljs`-built workbooks (not just fixtures) for every validation rule (`src/lib/changesets/import.test.ts`), and integration-test the full import → change-set → approve → reload cycle against a fake (or, for an acceptance pass, a real temporary) store (`src/lib/changesets/services.test.ts`).

---

## 6.11 Testing

- **Runner:** Node's built-in `node:test`, invoked via `node --import tsx --test "src/**/*.test.ts"` (`npm test`). No Jest/Vitest dependency exists — do not add one.
- **Organization:** every `*.test.ts` lives next to the file it tests, in the same directory. There is no separate `tests/` or `__tests__/` tree.
- **Unit tests:** for pure logic (`diff.ts`-style modules), construct inputs directly and assert on outputs — no mocking needed. For a `services.ts`, inject a **fake** adapter object matching the `ServiceDependencies` shape (an in-memory `Map`-backed fake store is the established pattern — see `createFakeStore()` in `channel-sync/services.test.ts` or `createFixture()` in `changesets/services.test.ts`).
- **Integration tests within a module:** exercise the full `createXServices(fakeDeps)` → multiple calls → assert on persisted state, e.g. `changesets/services.test.ts`'s "re-sync draft preservation" test (import → approve → simulate a re-sync by mutating the fake store's video data → re-fetch → assert the approval was invalidated).
- **Mock YouTube adapters:** never call real `googleapis` in a test. Every existing YouTube-touching test mocks the client at the shape boundary (`youtube.test.ts` mocks a `youtube_v3.Youtube`-shaped object, not `googleapis` itself) so the actual request-shaping logic (batching, pagination, field selection) is still verified.
- **Temporary/real-database testing:** for a change that affects `src/lib/db.ts`'s schema, verify boot against **both** an empty database and the existing `data/playlist-manager.db` before considering the change done. Never delete or overwrite the real local database file without first moving it aside and restoring it afterward — the safe pattern used during Phase 4's acceptance review was: `mv data/playlist-manager.db data/playlist-manager.db.bak`, run the check, `mv` it back. A scratch verification script should be written under the session's scratchpad directory (or deleted immediately after use if written into the repo) — never left committed.
- **Regression testing:** run the **full** `npm test` suite after any change, not just the new module's tests — a schema or shared-contract change (e.g. adding a `DomainErrorCode`) can affect other modules' tests.
- **Production YouTube mutations must never be used as part of automated tests.** This is absolute — no test, ever, under any circumstance, calls a real YouTube write endpoint. Every write path in every test is exercised against a mocked/fake adapter.

---

## 6.12 Documentation maintenance

| When this changes... | ...update these |
|---|---|
| Architecture (new domain module, new data flow, new security boundary) | `docs/ARCHITECTURE.md` (detailed "why"), `docs/SYSTEM_MAP.md` (concise "where") |
| A new feature is implemented | `docs/SYSTEM_MAP.md` §4 status table, `docs/interfaces.md` if it adds a user-facing entry point, `docs/ARCHITECTURE.md` if it changes a data flow |
| Database schema changes | `docs/ARCHITECTURE.md` (schema section), and — only if the change is non-additive — a new ADR under `docs/decisions/` per §10 of `AGENTS.md`/this playbook's §6.3 |
| API or MCP contracts change | `docs/interfaces.md`, and `docs/ARCHITECTURE.md`'s API-routes/MCP section if the change affects the security model, not just the route list |
| Security boundaries change | `docs/ARCHITECTURE.md` (the specific limitation section), `docs/TECHNICAL_DEBT.md` (add/update/resolve the relevant RISK entry — do not silently drop a risk without recording it as `RESOLVED` with evidence) |
| A development phase is completed | `docs/SYSTEM_MAP.md`'s header ("Current as of Phase N") and §4, `docs/ARCHITECTURE.md`'s header, `docs/PROJECT_SPEC.md` is **not** rewritten (it is the requirements source of truth, not a changelog) |

Never describe a deferred or planned capability as implemented in any of these documents — mark it explicitly `PLANNED`/`DEFERRED`/`NOT YET IMPLEMENTED` (§7 of the Phase 4.5 assignment; also `docs/SYSTEM_MAP.md`'s existing §4 convention).

---

## 6.13 Definition of Done

Reusable checklist for any change, regardless of size:

- [ ] Functionality implemented per the approved scope (no silent scope expansion — see "Standard development workflow" in `AGENTS.md`).
- [ ] Relevant tests added (unit for pure logic, integration for service-level flows, per §6.11).
- [ ] Full regression suite passes: `npm test`.
- [ ] `npm run lint` passes with zero errors/warnings.
- [ ] `npm run build` passes.
- [ ] Security impact reviewed: does this touch authentication, channel-context validation, request-size handling, or a YouTube write path? If yes, was a specific test added for the failure case (wrong channel, oversized input, missing auth)?
- [ ] Compatibility reviewed: does this break an existing API/MCP contract, or change a database column's meaning? If yes, was an ADR written first (§10)?
- [ ] Documentation updated per the table in §6.12.
- [ ] `git status` and `git diff --check` inspected — no secrets, no `data/*.db`, no scratch/temp files staged.
- [ ] Known limitations documented (in `docs/TECHNICAL_DEBT.md` if new, or in the relevant `docs/ARCHITECTURE.md` section if it's a narrower implementation note).

This checklist does not replace human review or authorization — it is what should be true **before** presenting work for that review, per `AGENTS.md`'s Git/release authorization boundaries.
