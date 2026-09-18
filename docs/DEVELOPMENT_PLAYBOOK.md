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

This section documents the **mandatory future pipeline** for bulk localization writes. As of the Phase 5 completion task (2026-09-18, following Slice 5): all 12 steps have a real (non-fake) implementation, all three gaps Slice 4 found and flagged (configurable concurrency, batched preliminary fetch, the full 100-video resume scenario) are closed, and the two remaining automated-acceptance gaps Slice 5 itself left open (`AC-CONCURRENCY-03`'s full two-batch race, `AC-E2E-01`'s single integrated scenario) are now closed too — see `docs/TECHNICAL_DEBT.md` RISK-09's progress notes for exact scope and honest caveats (the quota-batching fix reduces the preliminary pass's own call count, not the mandatory per-video fresh-fetch count; see RISK-13 for a documented tension in AC-QUOTA-01's own wording). A minimal, dry-run-only Web UI/API for Batches now exists (`src/app/api/channels/[channelId]/batches/**`, `src/components/batch-manager.tsx`) — so `src/lib/batches/` **is** now legitimately imported from API routes, unlike before. **No code path in this repository can reach a real `videos.update` call regardless** — the real `WriteExecutor` (`src/lib/batches/adapters/write-executor.youtube.ts`) exists but is gated by a two-layer barrier: `src/lib/batches/index.ts` never constructs it, and no API route, MCP tool, or CLI command references `executeBatch`/`executeWithRetry`/`recoverBatch`/`resolveUnknownLedgerRow`/`WriteExecutor`/`createYoutubeWriteExecutor` (the only symbols that can ever reach a real write) — verified by an automated repository-wide regression test (`write-path-inventory.test.ts`, revised to check for these specific symbols now that importing the module itself is legitimate) rather than a manual grep. Its own `attemptWrite` additionally, independently, unconditionally throws via a hard-coded `assertLiveWritesAuthorized()` before ever touching a client, independent of `dryRun` or any parameter. Lifting that throw is its own future, separately-authorized activation procedure after Gate B (`AGENTS.md` §K).

| Step | Status | Where |
|---|---|---|
| 1. Identity verification | **IMPLEMENTED** (for single-item metadata/playlist writes) | `src/lib/write-context/service.ts` (`assertWriteChannel`) — reuse this unchanged for Phase 5, do not reimplement |
| 2. Input validation | **IMPLEMENTED** (Phase 4 import validation; single-item apply validation) | `src/lib/changesets/import.ts`, `src/lib/video-metadata/schemas.ts` |
| 3. Fresh remote-state retrieval (immediately before write) | **PARTIALLY IMPLEMENTED** (Slice 2: `fetchFreshVideoContext`, single-video, used for merge/conflict/backup during batch *preparation*; not yet exercised immediately before an actual send, since no send exists until Slice 4) | `src/lib/batches/adapters/youtube-api.ts`, `services.ts`'s `prepareLedgerRow` |
| 4. Conflict detection (fresh vs. approved) | **PARTIALLY IMPLEMENTED** (Slice 2: `detectPreWriteConflict` in `merge.ts`, wired into `prepareLedgerRow`, compares approval baseline against the Slice-2 fresh fetch — closes RISK-03 for the *preparation* pipeline; post-write verification, AC-CONFLICT-02, is still Slice 3) | `src/lib/batches/merge.ts` |
| 5. Immutable backup | **PARTIALLY IMPLEMENTED** (Slice 2: `src/lib/backup/` — item-level capture + infrastructure health check, filesystem adapter, never overwrites) | `src/lib/backup/{contracts,services,index}.ts`, `adapters/filesystem-store.ts` |
| 6. Diff | **IMPLEMENTED** (Phase 4, single-item) + **PARTIALLY IMPLEMENTED** (Slice 2: `buildSafeLocalizationsPayload` for the bulk localization pipeline) | `src/lib/changesets/diff.ts`, `getChangeSet`; `src/lib/batches/merge.ts` |
| 7. Human approval | **IMPLEMENTED** (local only — does not trigger a write) | `src/lib/changesets/services.ts` (`approveChange`/`approveAllValid`) |
| 8. Dry-run | **IMPLEMENTED** (single-item `applyMetadata`) + **PARTIALLY IMPLEMENTED** (Slice 2: bulk `prepareBatchExecution` fully supports dry-run end to end — identity/fetch/merge/backup run, nothing is sent, ledger rows land on a dedicated `DRY_RUN_COMPLETE` state) | `src/lib/video-metadata/services.ts`; `src/lib/batches/services.ts` |
| 9. Apply | **IMPLEMENTED, but gated** (bulk: `executeBatch`/`executeWithRetry` drive real attempt cycles with bounded retry against the real `WriteExecutor`, which itself reuses `applyVideoMetadataUpdate` — but is unconstructed in production and unconditionally self-refuses via `assertLiveWritesAuthorized`, per the live-write barrier); IMPLEMENTED (single-item, `applyVideoMetadataUpdate`) | `src/lib/batches/services.ts`, `adapters/write-executor.youtube.ts`; `src/lib/youtube.ts` has the single-item write call |
| 10. Remote verification | **IMPLEMENTED** (bulk: every SUCCESS is re-verified via a fresh fetch before being trusted, AC-VERIFY-01/02/AC-CONFLICT-02; also runs on crash recovery) | `src/lib/batches/services.ts`'s `executeWithRetry`/`recoverLedgerRow` |
| 11. Durable audit | **IMPLEMENTED** (bulk: PREPARATION/ATTEMPT/RESULT/CONFLICT/VERIFICATION/DRY_RUN/RECONCILIATION events, append-only, causation-aware per AC-AUDIT-05) | `src/lib/audit/{contracts,services,index}.ts`, `adapters/store.ts`; `audit_events` table in `src/lib/db.ts` |
| 12. Per-item execution ledger | **IMPLEMENTED** for the states this repository can reach without a real adapter (Slice 1 data model + Slice 3's `AWAITING_EXECUTION`/`APPLYING`/`UNKNOWN`/crash-recovery lifecycle); a 2026-09-17 Foundation-safety-verification correction added a persistent `active_attempt_id` slot on the ledger row (not just the attempt-number UNIQUE constraint) enforcing "at most one active attempt per row" | `src/lib/batches/{contracts,schemas,services,merge,index}.ts`, `adapters/store.ts`; tables in `src/lib/db.ts` (`batches`, `batch_ledger_rows`, `batch_attempts`, `video_execution_locks`, `audit_events`) |

`backup/` and `audit/` (per `docs/PROJECT_SPEC.md` §47) now exist, added in Slices 2 and 3 respectively of the approved implementation plan, following the same `contracts/schemas/services/adapters` pattern as §6.2. `src/lib/batches/` re-checks each `Change`'s `approvalStatus`/`validationStatus` both at batch-creation time and again immediately before send (`AC-MERGE-04`, `AC-BATCH-03`), and reuses `write-context.assertWriteChannel` unchanged for identity (`AC-GUARD-01`) — both landed in Slice 2. `src/lib/batches/contracts.ts` defines a single abstract `WriteExecutor` port; as of Slice 4, both a fake implementation (`adapters/write-executor.fake.ts`, tests only) and a real one (`adapters/write-executor.youtube.ts`) exist — but no code path in the repository can reach a real `videos.update` call, per the two-layer live-write barrier described above (§6.5's step-9 row). `PreparedPayload` (`contracts.ts`) gained a `videoId` field in Slice 4 — a real `attemptWrite(payload)` genuinely cannot address a specific video without it, and this was missing through Slices 1-3 since no real executor existed yet to need it; `videoId` is attached once, at the single point the payload is constructed in `services.ts`'s `runSafetyPipeline`, not threaded as a second parallel argument to `attemptWrite`.

**Gaps found while re-inspecting Slices 1-3 during Slice 4, closed in Slice 5 (2026-09-18) — see `docs/TECHNICAL_DEBT.md` RISK-09 for full detail and honest caveats:** `AC-CONCURRENCY-01`'s configurable-`K`-greater-than-1 half is now implemented (`runWithConcurrencyLimit`, a bounded worker pool inside `executeBatch`); `AC-QUOTA-01`'s batched preliminary fetch (`fetchPreliminaryBatchContext`) is now called once per batch from `prepareBatchExecution` (informational only — the mandatory per-video fresh fetch immediately before each write remains unbatched, by design, per RISK-03); `AC-RESUME-01`'s full 100-video/5-state-class scenario now runs and passes (`resume-100-video.acceptance.test.ts`) — building it surfaced and fixed a real bug where `executeBatch` never prepared a still-`PENDING` row on a resumed (non-fresh) batch.

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
5. **Classify every tool honestly by what it actually mutates — a tool being read-only with respect to YouTube does not make it automatically safe to expose.** There are three distinct categories, not two:
   - **Read-only:** returns data, mutates nothing anywhere (e.g. `changeset_list`, `changeset_get`, `whoami`). Still requires the same authentication/authorization/channel-scope checks as any other tool (point 7 below) — a read tool that leaks another operator's channel data, or another user's change-set contents, is a real exposure even though nothing was written anywhere.
   - **Local state mutation:** writes to this application's own SQLite, never to YouTube (e.g. a future `changeset_approve`/`changeset_reject`, or the existing `write_channel_select`/`auth_user_select`). **This is a mutation and must be treated as one** — it needs input validation, channel-context scoping, and a clear audit trail, exactly like `docs/DEVELOPMENT_PLAYBOOK.md` §6.6 requires of a local-only API route (*"an operation is not automatically secure merely because it modifies only local SQLite data"* applies identically to MCP tools). Do not classify a local-approval tool as "propose" or "read" just because it never reaches YouTube.
   - **Remote YouTube mutation:** anything that could result in an actual `videos.update`/playlist write reaching YouTube (e.g. `apply`, `playlist_create`, and any future `changeset_apply`-class tool once Phase 5 exists). **Do not expose a remote-mutation tool for localization writes until the Phase 5 write pipeline (§6.5) exists and is tested** — an MCP tool that calls an unfinished/unsafe write path is worse than no tool at all.

   `docs/PROJECT_SPEC.md` §26's "read / propose / apply" model maps onto this: "propose" tools (e.g. a future `localization_import_preview`) are local-state-mutation or read-only depending on whether they persist anything — classify by the rule above, not by the READ/PROPOSE/APPLY label alone.
6. **Every MCP tool — read, local-mutation, or remote-mutation alike — enforces authentication, authorization, and channel scope**, the same way every API route must (§6.6, point 2 and point 8). Resolve the active identity (`credentialRef`/`resolveEffectiveCredentialRef`) before returning or mutating anything scoped to a channel, and verify the requested `channelId` actually owns the resource being read or mutated (e.g. a `changeSetId` must be checked against its `channelId`, mirroring `requireChangeSet()`'s check in `services.ts`) — an MCP tool is a network-adjacent entry point exactly like an API route, not an inherently trusted internal call.
7. **Safety requirement:** the operations agent (Codex) consumes only the **released, versioned** MCP surface (`AGENTS.md`'s "Development / operations separation" section) — do not add instructions here or anywhere in this repository about how Codex should conduct YouTube operations; that knowledge lives outside this repository entirely.

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
- **Schema-initialization testing uses isolated temporary databases, never the operator's real `data/playlist-manager.db`.** For a change that affects `src/lib/db.ts`'s schema, verify `initializeDatabase()` boots correctly against **both** a brand-new empty database file and a database file that already has the pre-change schema (to prove the additive `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS` path is still idempotent). Do this by pointing a throwaway libSQL client at a file under the session's scratchpad directory (or an `os.tmpdir()` path), never by touching the file at `data/playlist-manager.db` — that file may hold the operator's real local state (connected channels, synced videos, in-review change sets) and **must never be renamed, moved aside, overwritten, or deleted by a test or a verification script, under any circumstance, including "temporarily" with an intent to restore it afterward.** A rename-and-restore approach was used once during Phase 4's acceptance review and is retracted here — it is not safe practice and must not be repeated: a crash, an interrupted session, or a forgotten restore step would silently destroy the operator's data.
  - **SQLite WAL/SHM:** libSQL/SQLite in WAL mode keeps in-flight data in sidecar `-wal` and `-shm` files next to the main `.db` file, not only in the `.db` file itself. A test database is therefore three files, not one (`test.db`, `test.db-wal`, `test.db-shm`) — clean up all three when a temporary test database is done with, and never assume the main `.db` file alone reflects the complete on-disk state (this also means a "verify by copying just the `.db` file" approach is unreliable; use a fresh client against a fresh path instead of file-copying a live database).
  - A throwaway verification script (if one is needed beyond what `*.test.ts` already covers) must be written under the session's scratchpad directory and never committed; if it must briefly exist inside the repository working tree for tooling reasons, delete it before the task is considered done and confirm via `git status` that it was never staged.
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
| A development phase is completed | `docs/ROADMAP_STATUS.md` (status, completion date, commit hash, next assignment, open blockers — the canonical execution log), `docs/SYSTEM_MAP.md`'s header ("Current as of Phase N") and §4, `docs/ARCHITECTURE.md`'s header, `docs/PROJECT_SPEC.md` is **not** rewritten (it is the requirements source of truth, not a changelog) |

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

**For safety-critical work specifically** (write-safety, channel identity, conflict detection, approval integrity, data preservation — see §6.14 below), the checklist above is necessary but not sufficient. Completion additionally requires:

- [ ] Acceptance criteria documented **before** implementation (§6.14 Step 1–2), not reconstructed afterward to match what was built.
- [ ] Expected results defined independently of the implementation (§6.14 Step 3) — not copied from the implementation's own output.
- [ ] Both positive and negative tests present for the behavior in scope.
- [ ] The relevant safety invariants from §6.14 verified, not merely assumed to still hold.
- [ ] Full regression suite passing (already covered above, restated because safety-critical work must never skip it).
- [ ] No prohibited side effect occurs — in particular, no test performs a real YouTube mutation (§6.11), and no code path introduced reaches a YouTube write method it should not (§6.5's IMPLEMENTED/PLANNED table still accurately reflects reality after the change).
- [ ] Adversarial review completed (§6.14 Step 6) — someone (or a separate review pass) actively tried to find an incorrect implementation that would still pass the tests.
- [ ] Mutation testing performed where practical (§6.14 Step 7) for the specific module changed.

**A 100% test pass rate alone is not sufficient evidence of correctness for safety-critical work.** Tests that were written by reading the implementation and recording its behavior can pass at 100% while verifying nothing about whether that behavior is correct. The checklist above exists specifically to catch that failure mode.

---

## 6.14 Specification-Driven and Independent Testing

**Purpose:** prevent tests from being written merely to confirm what the implementation already does. A test suite built by reading the code and recording its behavior proves the code is self-consistent — it proves nothing about whether the code is *correct*. This section defines the workflow that keeps a test's expected behavior anchored to the requirement it verifies, not to the implementation under test. See `AGENTS.md` §L for the mandatory rule this section implements.

This workflow applies in full to **substantial or safety-critical changes** — write-safety, channel identity, conflict detection, approval integrity, and data-preservation logic (`docs/PROJECT_SPEC.md` §21/§27/§30, `docs/TECHNICAL_DEBT.md`'s Gate B list). For a small, low-risk change, apply it proportionately: Steps 1-5 always apply in spirit (know what you're building before you build it, test the requirement not the code); Steps 6-7 (adversarial review, mutation testing) are most valuable exactly where the cost of being wrong is highest.

### Step 1 - Requirements extraction

Before writing any test or implementation code, identify the actual requirement from an authoritative source: `docs/PROJECT_SPEC.md`, a documented API/MCP contract (`docs/interfaces.md`), an ADR (`docs/decisions/`), or an official external specification (the current YouTube Data API v3 documentation for anything touching request/response shape or field limits - `AGENTS.md`'s Development rules already require verifying YouTube API behavior against official docs rather than assumption). Write down which requirement is being implemented, in your own words, before looking at any existing code that might already do something similar.

### Step 2 - Acceptance matrix

From the extracted requirement, define explicitly:

- **Inputs** - the range of values the behavior must handle, including ones outside the obvious happy path.
- **Expected outputs** - stated from the requirement, not computed by running a draft implementation.
- **Invariants** - properties that must hold across every input (see "Safety invariants for YouTube metadata workflows" below for the standing set that applies to this project's write paths).
- **Failure scenarios** - inputs that must be rejected, and what the rejection must look like (a specific `DomainError` code, not just "it should fail somehow").
- **Prohibited side effects** - what must demonstrably *not* happen (e.g. "no YouTube write call occurs," "no unrelated localization is touched," "no change set row is created for an unchanged value").

Write this matrix down (in the task's working notes, the PR description, or directly as comments guiding the test file) before Step 3 - it is the artifact Step 8 compares results against.

### Step 3 - Independent test design

Write the tests - and any fixed expected-value fixtures - **before** implementing the feature, directly from the acceptance matrix, not from a draft implementation's output. A fixed expected value in a test must be something a human could compute or state by hand from the requirement (e.g. "a title of 101 characters must be rejected because the YouTube API limit is 100" - see `src/lib/changesets/diff.ts`'s `YOUTUBE_TITLE_MAX_LENGTH` for where that constant itself needs to trace back to the official API docs, not to a guess). **Never derive an expected value by calling the function under test and copying its return value into the assertion** - that produces a test that can only ever confirm the implementation agrees with itself.

If the feature already has a draft or prior implementation (e.g. this is a refactor, not new work), design the tests from the requirement anyway, then run them against the existing code as a check - do not let the existing code's behavior silently become the specification.

### Step 4 - Implementation

Implement the smallest solution that satisfies the contract defined in Step 2, following the established patterns in §6.2-§6.10. Do not expand scope to also handle inputs or cases the acceptance matrix did not define - if implementation reveals the matrix was incomplete, that is new information requiring Step 2 to be revisited (and, if it changes a previously-agreed acceptance test, follow "Test changes during implementation" below), not a reason to silently implement beyond what was specified.

### Step 5 - Verification

Run the full test suite: positive cases (the input is handled correctly), negative cases (invalid/malicious/out-of-contract input is rejected correctly), boundary cases (values exactly at a documented limit, one past it, one before it), and the full existing regression suite (`npm test`) to confirm nothing else broke.

### Step 6 - Adversarial review

Actively search for an incorrect implementation that would still make the current tests pass. Concretely: could a version of this code that silently skips the channel-identity check still pass every test? Could a version that approves a conflicted change still pass? Could a version that treats a blank cell as a deletion instruction still pass? If such a gap is found, it means a test is missing or an existing test's assertion is too weak (e.g. asserting `result.ok === true` instead of asserting the specific fields that prove the safety property held) - add the missing test or strengthen the assertion; do not treat the adversarial pass as merely academic.

### Step 7 - Mutation testing

For safety-critical modules specifically, evaluate (manually, if no mutation-testing tool is introduced - this policy alone introduces no new testing dependency) whether the existing tests would actually detect a deliberate, small, realistic mistake:

- flip a validation condition (`>` to `>=`, `===` to `!==`);
- skip the channel-identity guardrail call;
- swap which side of a conflict comparison is "baseline" vs. "current";
- drop the "preserve other locales" merge step and overwrite the whole object instead.

If a test suite would still pass 100% after one of these mutations, the suite has a coverage gap at exactly the place safety depends on - this is the single most concrete way to discover that a test is checking the wrong thing.

### Step 8 - Acceptance

Compare the actual results against the **original** acceptance matrix from Step 2 - not a version of the matrix revised to match what got built. **Do not redefine success based on the implementation.** If the implementation's actual behavior differs from the matrix, that is a discrepancy to resolve explicitly (fix the implementation, or follow "Test changes during implementation" below if the matrix itself was wrong) - it is never resolved by silently updating the matrix (or the tests) to describe whatever the code does.

### Safety invariants for YouTube metadata workflows

Every safety-critical test suite touching YouTube metadata (existing or future write paths) should, where applicable, verify these standing invariants - they come from `docs/PROJECT_SPEC.md`'s write-safety model and this project's established safe-merge/guardrail patterns, not from any specific implementation:

- Existing unrelated localizations remain unchanged (a write targeting one locale must not touch any other locale's stored title/description).
- Wrong-channel writes are impossible (`write-context.assertWriteChannel` must fail closed before any write call is reachable).
- Blank spreadsheet cells never cause deletion (`docs/PROJECT_SPEC.md` §8 - a blank cell means "no proposed change," never "clear this field").
- Approval applies only to the exact approved payload (`Change.approvedValue` must be invalidated, not silently reused, if the underlying proposal or remote state changes after approval - `docs/ARCHITECTURE.md` §6.9/§6.7).
- Conflicting changes cannot be silently applied (a `conflictStatus: "conflict"` change must be blocked from approval/application until the conflict is resolved).
- Dry-run produces no remote mutations (a `dryRun: true` code path must be provably free of any YouTube write call - not just "didn't call it this time," but structurally incapable of reaching one).
- Retried operations do not duplicate completed work (idempotent resume - re-running a batch must not re-apply an already-successful item).
- Failed operations preserve recovery information (see `docs/TECHNICAL_DEBT.md` RISK-09's backup-vs-rollback distinction - a failure must not leave the system with less recovery information than it had before the attempt).
- No test performs real YouTube mutations (absolute, per `docs/DEVELOPMENT_PLAYBOOK.md` §6.11 - every write path in every test runs against a mocked/fake adapter).

### Independent test review

For substantial or safety-critical features, use a separate review - a distinct agent session, a fresh subagent with no prior context on the implementation, or (when working solo) a deliberately isolated review pass - rather than relying solely on the same session/context that wrote the implementation to also judge it. Give the reviewer the specification and the tests **before** it inspects the implementation, so its read of "does this test verify the requirement" is not anchored by having already seen how the code satisfies it.

The reviewer's task is to identify:

- missing scenarios (a requirement with no corresponding test);
- circular test logic (a test whose expected value was derived from the implementation, per Step 3's prohibition);
- shared incorrect assumptions (the same misunderstanding of the requirement baked into both the code and the test, so they agree with each other and disagree with the spec);
- missing negative tests (only happy-path coverage exists);
- unverified side effects (the test checks the return value but never checks what else changed - or didn't - as a result);
- weak assertions (e.g. `assert.ok(result)` where `assert.equal(result.field, expectedValue)` was actually needed to prove the property in question);
- tests that merely reproduce implementation behavior (Step 3's failure mode, caught late).

**If a separate reviewer is genuinely unavailable, say so explicitly in the work presented for approval - do not claim independent review occurred, and do not claim self-review provides the same guarantee.** A self-review can still be useful (re-reading Steps 1-2 against the actual tests before presenting the work), but it is not a substitute for this section's independence requirement, and must not be described as one.

### Test changes during implementation

If implementation reveals a genuine ambiguity or error in an already-written acceptance test (not "the implementation doesn't match the test," which is normally a bug in the implementation, but "the test itself encodes a requirement that turns out to be wrong or ambiguous"):

1. Identify the specific conflicting requirement - quote or cite the exact source (a `docs/PROJECT_SPEC.md` section, an official API doc, an ADR) that the test's original assumption conflicts with.
2. Explain the proposed correction - what the test should assert instead, and why that is what the requirement actually demands.
3. **Preserve the original expectation for review** - do not delete or silently overwrite the old assertion; show both (e.g. in the diff, or explicitly in the report presented for approval) so the change is auditable.
4. **Request approval for material changes** before proceeding - per `AGENTS.md` §L, changing a previously-approved acceptance test requires explicit justification and, for anything non-trivial, the project owner's sign-off, exactly like any other substantial/security-relevant decision under `AGENTS.md` §K.

**Do not silently rewrite an acceptance test.** A failing test is evidence requiring investigation of the implementation - it is not, by itself, an instruction to change the test.
