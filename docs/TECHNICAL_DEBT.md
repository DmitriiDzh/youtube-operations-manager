# TECHNICAL_DEBT.md

Engineering risk register for YouTube Operations Manager. Created in Phase 4.5 (`docs/PROJECT_SPEC.md`-driven governance consolidation), covering issues identified during the Phase 0/1 baseline and Phases 2–4.

**Purpose:** make known limitations visible, classified, and gated — not to fix them all now. See `docs/PROJECT_SPEC.md` for product requirements and `docs/ARCHITECTURE.md` §12 for the corresponding architecture-level limitations checkpoint; the release-readiness checkpoints (Gates A–D) enforcing these gates are defined below in this document.

A risk being documented here is **not** the same as it being resolved. Status only changes to `RESOLVED` when the acceptance criteria below have actually been verified — not when the risk is merely written down.

## Gate legend

| Gate | Meaning |
|---|---|
| `BLOCKS_PHASE_5_WRITES` | Must be resolved (or explicitly accepted via a documented decision) before any real `videos.update` localization write is enabled |
| `BLOCKS_OPERATIONS_RELEASE` | Must be resolved before a versioned release is handed to the operations agent (Codex) |
| `BLOCKS_NETWORK_DEPLOYMENT` | Must be resolved before this application runs anywhere other than a trusted operator's own machine (`localhost`) |
| `DEFERRED_WITH_DOCUMENTED_REASON` | Currently acceptable for the single-operator, local-first deployment model; the triggering condition for revisiting it is stated explicitly |

A risk may carry multiple gates simultaneously.

## Release-readiness checkpoints

Four separate checkpoints, each with its own required conditions. Passing an earlier one does not imply passing a later one — development-ready is not the same as safe-for-real-writes, which is not the same as ready-for-operations-handoff, which is not the same as safe-for-network-deployment.

### GATE A — Before implementing Phase 5

- Phase 4 committed and validated (`npm test`/`npm run lint`/`npm run build` all green).
- Architecture documentation current (`docs/ARCHITECTURE.md`, `docs/SYSTEM_MAP.md`).
- Write-safety design for the Phase 5 pipeline reviewed against `docs/PROJECT_SPEC.md` §19–25 and `docs/DEVELOPMENT_PLAYBOOK.md` §6.5.
- Security advisories assessed (RISK-06, this document) — not necessarily patched, but reviewed and a remediation timing decided.
- Existing `Change`/`ChangeSet` contracts (`src/lib/changesets/contracts.ts`) understood by whoever implements Phase 5, since they are the write pipeline's input.

**Status as of Phase 4.5: satisfied** — see the final report accompanying this phase.

### GATE B — Before enabling real YouTube writes

**These eight mechanisms are non-negotiable. Each must be actually implemented and covered by a passing automated test — not merely designed, not merely documented, and not "accepted" as a residual risk through an ADR or a risk-acceptance sign-off. A generic ADR or risk-acceptance decision cannot substitute for any of them; risk acceptance is a tool for residual risk (see below), not a way to waive a core safeguard.**

1. **Identity verification** — reusing `write-context.assertWriteChannel` unchanged (already implemented for single-item writes; must be reused, not reimplemented, for the bulk pipeline).
2. **Fresh remote conflict detection** — a live YouTube fetch immediately before constructing the write payload, compared against the approved proposal (closes RISK-03; Phase 4's SQLite-snapshot-based check does **not** satisfy this).
3. **Immutable backup** — captured before any write batch begins, per targeted video, before that video's write is attempted (closes part of RISK-09; see the RISK-09 entry below for how this differs from a rollback capability).
4. **Approval integrity** — an approval must be provably tied to the exact payload it authorized (already implemented for local state, §6.9 of `docs/ARCHITECTURE.md`; must extend to the write payload itself so a write can never apply something other than what was approved).
5. **Dry-run** — the batch pipeline must support a no-write preview mode, exercising every step (identity, conflict check, payload construction) except the actual `videos.update` call.
6. **Durable audit log** — a queryable, persistent record of every write attempt and its outcome (closes part of RISK-09; ephemeral `logger.info`/`logger.error` to stdout does not satisfy this).
7. **Per-item execution ledger** supporting idempotent resume after an interruption (closes part of RISK-09).
8. **Post-write remote verification** — confirming the actual resulting YouTube state matches what was requested, not just that the API call returned without a transport error.

**Residual-risk acceptance applies only beyond this list** — e.g. accepting RISK-01's best-effort upload-size guard, or RISK-06's non-critical transitive advisories, for the *scope this gate covers*, via an explicit documented decision. It never applies to the absence of mechanisms 1–8 above.

Additionally:

- **No test may modify a production/real YouTube channel** — every acceptance test in `docs/PROJECT_SPEC.md` §53–57 runs against mocked adapters.

**Status: NOT satisfied** — this is Phase 5's primary deliverable.

### GATE C — Before operational handoff to Codex

- A versioned release exists (see "Release boundary" below — a commit is not a release).
- MCP/API contracts for the released capabilities are validated and documented (`docs/interfaces.md`).
- The necessary Change Set MCP capabilities exist (closes RISK-04) with a validated read/propose/apply split.
- Authentication and permissions tested against the released build.
- Reproducible OAuth/browser verification performed and recorded (closes RISK-05).
- The MCP `apply` tool's `dryRun` default is fail-safe, not fail-live (closes RISK-12 — **done, 2026-09-18**).
- This gate's own security review completed (this document, current as of the release).
- A documented deployment procedure exists.
- A rollback/recovery plan exists.
- Codex consumes only the released product's MCP/API surface — it must never interact with this development repository directly.

**Status: NOT satisfied.**

### GATE D — Before network or multi-user deployment

- Per-user authorization implemented (closes RISK-02).
- Channel ownership isolation implemented (closes RISK-02).
- Upload size enforcement hardened to actual bytes received, not just declared headers (closes RISK-01).
- CSRF protections applied where applicable (none of the current POST routes have them — matches the rest of the app today, but must be addressed before network exposure).
- Secure credential storage (closes RISK-07).
- A network-exposure review performed (what is reachable, from where, with what auth).
- Applicable dependency security fixes applied (closes RISK-06 at minimum for network-facing paths).
- The exact deployment assumptions documented (who can reach this instance, over what network, with what identity).

**Status: NOT satisfied — and not currently planned.** The product's deployment model today is, and is expected to remain, local-first/single-operator (`docs/PROJECT_SPEC.md` §37) unless the project owner makes an explicit product decision to change it.

## Release boundary

A **Git commit** is not automatically a **release**. A successful **build** is not automatically **production-ready**. Four distinct states:

```text
development source        → whatever is on a branch, may be incomplete or unreviewed
        ↓
validated build            → npm test + npm run lint + npm run build all pass, on a specific commit
        ↓
versioned release          → a validated build, explicitly tagged, with release notes and
                              a recorded security review (Gate C requirements)
        ↓
operational deployment     → a versioned release actually running somewhere and handling
                              real requests/writes (subject to Gate B and/or Gate D depending
                              on whether it performs real YouTube writes and/or is network-exposed)
```

A released product must have: passing tests, passing lint, a successful build, compatible MCP/API contracts, documented schema changes, a security review, release notes, recovery considerations, and **explicit release authorization** from the project owner (`AGENTS.md` §K). No release was created in Phase 4 or Phase 4.5, and none should be created without a separate, explicit request.

## Technical debt policy

Not every issue in this register must be fixed immediately. It must, however, always be: visible (listed here), classified (a gate assigned), owned (an "approval required from" role stated), linked to a concrete remediation gate (not "fix later" with no trigger), and verifiable (a stated acceptance criterion). A security-relevant issue is never silently carried forward without being recorded here — if a task discovers a new one, add it to this document as part of that task, not as a follow-up someone might forget to do.

---

## RISK-01 — XLSX upload size enforcement is best-effort, not absolute

- **Affected components:** `src/app/api/channels/[channelId]/localizations/import/route.ts`, `.../import/preview/route.ts`, `src/lib/changesets/import.ts` (`MAX_WORKBOOK_BYTES`).
- **Current behavior:** Both import routes reject a request whose `Content-Length` header already exceeds `MAX_WORKBOOK_BYTES` (25MB) + a small margin, before calling `request.formData()`. `parseAndValidateWorkbook()` additionally checks the actual buffered size after parsing. Next.js App Router Route Handlers have no built-in request-body size cap (unlike Server Actions), and `request.formData()` in this runtime has no streaming byte-limit option — a request sent **without** a `Content-Length` header (e.g. chunked transfer) is still fully buffered into memory before either check can reject it.
- **Actual risk:** An authenticated client (must already hold a valid NextAuth session) could send an oversized or chunked upload to exhaust server memory. Severity is low today: the only way to reach this endpoint is an authenticated session on the operator's own machine.
- **Existing mitigation:** `Content-Length` pre-check (rejects the common case — every normal browser file upload sends this header) before `request.formData()` is called. **This mitigation only helps when it rejects the request before parsing begins; it does not protect the request that passes the header check.** `parseAndValidateWorkbook()`'s post-parse `MAX_WORKBOOK_BYTES`/`MAX_LOCALIZATION_ROWS` checks run **after** `request.formData()` has already read the entire multipart body into memory — by the time those checks execute, the memory has already been consumed, whether or not they subsequently reject the file. A post-parsing size check bounds *how large a change set can be persisted*, but it does **not** bound *how much memory a single request can force the server to allocate while parsing* — those are two different guarantees, and only the first one currently exists after the point where `Content-Length` is absent, wrong, or the body is delivered as multiple large chunks under the declared limit's margin.
- **Required remediation:** Actual upload protection requires limiting the number of bytes *received* before the full body is buffered — i.e. capping consumption at the `ReadableStream`/transport level, not only validating the size of the object that results after parsing completes. Determine whether Next.js's underlying request architecture (the Web `Request`/`ReadableStream` it wraps) supports bounded, streaming body consumption in this version (`node_modules/next/dist/docs/` per the project's Next.js agent-warning block). If not directly supported by `request.formData()`, implement a manual streaming reader that counts bytes as they arrive and aborts the connection once `MAX_WORKBOOK_BYTES` is exceeded, before handing any data to `exceljs` — the check must happen during reception, not after reception completes.
- **Acceptance criteria:** A test that sends a multipart request with **no** `Content-Length` header and a body larger than `MAX_WORKBOOK_BYTES` is rejected without fully buffering the oversized body in memory (verifiable via a bounded-memory assertion or a mocked streaming reader that proves early termination).
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON` (current single-operator localhost model), `BLOCKS_NETWORK_DEPLOYMENT`.
- **Approval required from:** project owner (Gate D sign-off, see "Release-readiness checkpoints" above).
- **Status:** OPEN.

---

## RISK-02 — No per-user channel ownership boundary

- **Affected components:** `src/lib/channel-sync/services.ts` (`listChannels`), `src/lib/localization/services.ts`, `src/lib/changesets/services.ts` — every read/write path that takes a `channelId`.
- **Current behavior:** Any authenticated NextAuth session can list, sync, export, import, and approve/reject change sets for **any** locally synchronized channel, regardless of which Google account originally connected it. `channels.connectedUserId` is recorded for traceability only, explicitly documented as "not an ownership boundary" (`docs/ARCHITECTURE.md` §7.1). This predates Phase 4 — `channel-sync`'s `listChannels()` already has no per-user filter.
- **Actual risk:** If more than one person is ever authenticated against the same running instance, one operator could read/modify another operator's channel data. Not exploitable today under the documented single-operator model.
- **Existing mitigation:** The whole application is designed and documented as a **single local operator** tool (`docs/PROJECT_SPEC.md` §37); a `changeSetId` is still scoped to its `channelId` to prevent cross-channel access via a forged path parameter, which is a different (already-covered) concern from per-user ownership.
- **Required remediation:** Before any multi-operator or hosted deployment: add a `connectedUserId`-based (or role-based) authorization check to every channel-scoped read/write path, decide whether channels can be shared between operators by design or are strictly 1:1, and add tests proving a session cannot access another user's channel.
- **Acceptance criteria:** An authenticated session for user A receives `403`/`404` (not channel data) when requesting a channel/change-set connected to user B, with a test covering at least `GET /api/channels`, `GET /api/channels/[channelId]/change-sets`, and one write action.
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON` (current single-operator model), `BLOCKS_NETWORK_DEPLOYMENT`.
- **Approval required from:** project owner (product decision: is multi-operator ever in scope?).
- **Status:** OPEN. **Cross-reference (Pre-Release Cross-Platform Persistence task):** `users.id` was confirmed by inspection to be the Google OAuth `sub` claim (a stable, provider-issued identity — `src/lib/auth.ts`'s `session()` callback, `src/lib/db.ts`'s `upsertUserOAuthOnSignIn`), not a locally-generated artifact. This means a device-handoff snapshot importing `channels.connectedUserId`/`rules.userId` values never creates a *new* instance of this risk — the exposure (any authenticated session sees any locally synced channel) is exactly the same, pre-existing, already-accepted one described above, whether the channel was synced locally or arrived via an imported snapshot. Not resolved by that task; only confirmed not worsened.

---

## RISK-03 — Conflict detection is bounded by the last channel sync, not live YouTube state

- **Affected components:** `src/lib/changesets/diff.ts` (`computeConflictStatus`, `revalidateChangeAgainstCurrentRemote`), `src/lib/changesets/services.ts` (`loadRevalidated`).
- **Current behavior:** A `Change`'s conflict status compares the workbook's export-time baseline (`remote_title`/`remote_description`) against the **currently synchronized SQLite snapshot** (`channel-sync`'s local mirror), refreshed only when someone re-runs a channel sync. It is never a live YouTube API call.
- **Actual risk:** If YouTube Studio (or another tool) changes a video's metadata after the last sync but before a Phase 5 write is applied, Phase 4's conflict detection cannot see it and will not flag a conflict — a write could silently overwrite a newer remote change.
- **Existing mitigation:** Every `getChangeSet` read and every approve/reject action re-validates against whatever the *latest* local sync snapshot is; re-syncing before reviewing narrows (but does not eliminate) the staleness window. This limitation is explicitly documented (`docs/ARCHITECTURE.md` §6.6) rather than silently assumed away.
- **Required remediation:** Phase 5's write pipeline must fetch fresh remote metadata for each targeted video **immediately before** constructing the write payload, and compare three states — exported baseline, current remote (fresh), and the approved proposal — refusing to write (marking `CONFLICT`) if the fresh remote value differs from what the approval was based on.
- **Acceptance criteria:** An automated test proves that a write is refused when a mocked "fresh remote fetch" returns a value different from the one the change was approved against, even though the local SQLite mirror is stale/unaware.
- **Gate(s):** `BLOCKS_PHASE_5_WRITES`, `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner (Gate B sign-off, see "Release-readiness checkpoints" above).
- **Status:** OPEN — by design, not a defect; must be closed before Gate B. **Progress (2026-09-17, Slice 2 of the approved Phase 5 implementation plan):** `src/lib/batches/merge.ts`'s `detectPreWriteConflict`, wired into `services.ts`'s `prepareLedgerRow`, now performs exactly this three-state comparison for the batch-preparation pipeline, against a fresh single-video fetch (`AC-CONFLICT-01`/`AC-LEDGER-04`, `prepare-batch.test.ts`). Not yet closed: this is exercised only during preparation, not immediately before an actual send (no send exists yet, Slice 4), and post-write verification (AC-CONFLICT-02) remains Slice 3.

---

## RISK-04 — No CLI/MCP interfaces for Change Sets

- **Affected components:** `src/cli/video-metadata.ts`, `src/mcp/server.ts` (neither has `changeset_*`/`localization_*`/`channel_sync` commands or tools yet).
- **Current behavior:** All Phase 2–4 capabilities (channel sync, localization overview/export, XLSX import, change-set review/approval) exist only through the Web UI and its underlying API routes. `createChannelSyncCore()`, `createLocalizationCore()`, and `createChangeSetCore()` are already interface-agnostic (same pattern as `createVideoMetadataCore()`), so this is additive work, not a redesign.
- **Actual risk:** The future operations agent (Codex) is meant to operate exclusively through MCP/API (`docs/PROJECT_SPEC.md` §26, this task's development/operations separation). Without `changeset_*` MCP tools, Codex cannot review or approve localization change sets at all — the entire Phase 4 workflow is currently human-Web-UI-only.
- **Existing mitigation:** None needed yet — Phase 4.5 does not hand off to Codex.
- **Required remediation:** Register MCP tools mirroring the existing `apply`/`playlist_*` read/propose/apply split (`docs/DEVELOPMENT_PLAYBOOK.md` §6.7): read tools (`changeset_list`, `changeset_get`), propose-adjacent tools (`localization_import_preview`), and — only once Phase 5's write pipeline exists — an apply-class tool with the same guardrails as `apply`. CLI parity is lower priority than MCP for the operations handoff but should follow the same namespace pattern as `metadata`/`auth`/`playlist`.
- **Acceptance criteria:** MCP tool tests exist proving stable JSON schemas, `DomainError`-shaped errors (never bare prose), and that no tool in the read/propose class can trigger a YouTube write.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner (scope/timing of Phase 5 vs. a dedicated CLI/MCP-parity phase).
- **Status:** OPEN — explicitly out of scope for Phase 4.5 per this assignment.

---

## RISK-05 — No real browser/OAuth end-to-end verification

- **Affected components:** Web UI (`src/app/dashboard/page.tsx`, `src/components/{channel-sync,localization-manager,change-set-review}.tsx`), NextAuth session flow (`src/lib/auth.ts`).
- **Current behavior:** Phase 4's acceptance testing ran the full domain-service pipeline (real XLSX export/import, real SQLite) end-to-end via a script, and 226 unit/integration tests pass against mocked adapters — but no session has performed a real Google OAuth sign-in through a browser and clicked through Sync → Export → Import → Approve in the actual UI.
- **Actual risk:** OAuth cookie handling, browser-side `fetch`/`FormData` behavior, and React state/rendering issues are not detectable by the current test suite; an integration bug could exist purely at the browser/session layer despite all automated checks passing.
- **Existing mitigation:** `docs/UPSTREAM_BASELINE.md` §6a already validated fail-closed behavior without credentials (CLI, MCP, Web UI boot). The Phase 4 domain-logic pipeline has strong automated coverage, which narrows what a live smoke test would actually be checking (session/browser integration, not business logic).
- **Required remediation:** Define and execute a reproducible smoke-test procedure (see acceptance criteria) once real Google OAuth credentials are available in a session with browser access.
- **Acceptance criteria:** A documented run (dated, with pass/fail per step) covering: app launch → OAuth login → channel selection → sync → XLSX export → XLSX import → Change Set creation → diff review → approve/reject → reload → state preserved. No real YouTube write performed during this check.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`, `BLOCKS_PHASE_5_WRITES` (a live write pipeline should not go live without ever having seen the surrounding UI/session flow work end-to-end).
- **Approval required from:** whoever performs the run must be the project owner or someone they explicitly designate, since it requires real credentials.
- **Status:** OPEN — environment used for Phases 0–4.5 has no browser + real Google OAuth credentials available.

---

## RISK-06 — Dependency security advisories (npm audit)

- **Affected components:** `next`, `next-auth` (patched, 2026-09-18); 20 remaining transitive advisories across `@modelcontextprotocol/sdk`, `googleapis`, `@libsql/client`, `exceljs`, `drizzle-kit`, `eslint`/`eslint-config-next` dependency chains (see triage table below).

### Critical findings — CLOSED 2026-09-18

  | Package | Installed before | Issue | Fixed version | Bump type |
  |---|---|---|---|---|
  | `next` | 16.2.2 | Critical DoS with Server Components, plus the full cluster of related advisories (RCE on Windows-hosted servers, RCE in Image Optimization/AVIF, middleware/proxy bypass, cache poisoning, XSS) in range `<=16.3.2` | `16.3.5` | non-major |
  | `next-auth` | 4.24.13 | Email-normalizer homoglyph `@` bypass (critical); `getToken()` uncaught exception on malformed Bearer header; OAuth state/nonce/PKCE cookies not bound to originating provider — all in range `<=4.24.14` | `4.24.15` | non-major |

  Fixed transitively by the `next` bump (no separate action needed): `postcss` (XSS/path traversal via `sourceMappingURL`, high), `sharp` (libvips/libheif CVEs, high), `nanoid` (high). Fixed transitively by the `next-auth` bump: its own `uuid` dependency now resolves to `11.1.1` (patched) instead of the vulnerable `8.3.2` it previously deduped to.

  **Result:** `npm audit` findings dropped from 25 (2 critical / 10 high / 11 moderate / 2 low) to 20 (**0 critical** / 7 high / 11 moderate / 2 low). Verified: `npm test` (288/288), `npm run lint`, `npm run build` all pass after the bump. Google OAuth browser sign-in flow was **not** re-verified live (no browser available in this environment) — this remains an explicitly open item, not silently assumed fine.

  One regression was found and fixed as a direct consequence of this bump: refreshing `node_modules` to match the lockfile (untouched by this change, but not previously fully materialized on disk) exposed a pre-existing, previously-cache-masked TypeScript error in `src/lib/localization/adapters/xlsx.test.ts` — `typescript@5.9.3` makes `Uint8Array`/`Buffer` generic, and `exceljs`'s own bundled (non-exported, module-scoped) `Buffer` typing stub (`declare interface Buffer extends ArrayBuffer {}`) does not have the newer resizable-`ArrayBuffer` members and is therefore structurally incompatible with the real Node `Buffer`. `src/lib/changesets/import.ts` already carried the identical `as any` + `eslint-disable-next-line @typescript-eslint/no-explicit-any` workaround for the exact same issue; the test file was given the matching treatment for consistency. This is a compile-time-only type assertion — the runtime value passed to `workbook.xlsx.load()` is unchanged, no test assertion, expected value, or test case was touched. `typescript`/`@types/node` versions themselves were not changed.

### Remaining 20 findings (0 critical / 7 high / 11 moderate / 2 low), triaged 2026-09-18

  | Package(s) | Severity | Direct/transitive | Prod/dev exposure | Vulnerable functionality actually used? | Patched version | Breaking upgrade required? | Relevance |
  |---|---|---|---|---|---|---|---|
  | `hono`, `@hono/node-server` | high, moderate | transitive via `@modelcontextprotocol/sdk` (prod dep) | Present in `node_modules`, but `src/mcp/server.ts` constructs only `StdioServerTransport` (verified: no `hono`/`express`/HTTP-transport import anywhere in `src/`) | **No** — the HTTP-transport code path these packages implement is never instantiated by this repo | non-major (`npm audit fix` without `--force`) | No | Dormant unless a future MCP HTTP transport is added (Slice 5/CLI-MCP work, `RISK-04`) or a real YouTube adapter (Slice 4) somehow pulls in an HTTP-based MCP transport — re-check at that point |
  | `express-rate-limit`, `ip-address` | moderate, high | transitive via `@modelcontextprotocol/sdk` → unused HTTP transport | Same as above — HTTP transport never started | **No** | non-major | No | Same as above |
  | `fast-uri` | high | transitive via `@modelcontextprotocol/sdk`'s `ajv` (JSON Schema validation) | `ajv` validates MCP tool input schemas, which **is** exercised over the stdio transport already in use | Likely yes, indirectly — `fast-uri` is `ajv-formats`' URI-format validator; only reachable if an MCP tool schema uses a `format: "uri"` string field with attacker-controlled input | non-major | No | Worth closing before Slice 5 (CLI/MCP interfaces) if any future MCP tool schema validates URIs from untrusted input; not currently blocking |
  | `qs` (via `@modelcontextprotocol/sdk`'s `express`/`body-parser`) | moderate | transitive, unused HTTP transport | Same as `hono` above | **No** | non-major | No | No |
  | `qs` (via `googleapis`) | moderate | transitive, **prod dep actively used** (all YouTube/Google API calls) | `googleapis` is exercised on every read of channel/video data and every existing write (playlists, single-item metadata) | Yes — `qs` serializes query strings for outgoing Google API requests; the DoS vectors are about parsing attacker-controlled query strings, which does not describe our own outgoing-request construction, but the dependency is genuinely in the production request path | non-major | No | Should be closed opportunistically (low effort, `npm audit fix` scope) — not itself a blocker, but do not defer indefinitely given active prod usage |
  | `ws` | high | transitive via `@libsql/client` → `@libsql/hrana-client` (prod dep) | `src/lib/db.ts` constructs the client with a `file:` URL (local SQLite) — the Hrana/WebSocket transport this pulls in is for **remote** libsql/Turso connections and is not exercised by the current local-file deployment | **No**, under the current local-only configuration | non-major | No | **Re-check immediately if the project ever moves to a remote libsql/Turso URL** — that would activate this exact code path; until then, dormant |
  | `uuid` (via `exceljs`) | moderate | transitive, prod dep (`exceljs` is used for XLSX export/import) | `exceljs` only calls into `uuid` from one narrow feature — extended conditional-formatting rule XML generation (`lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`) — not used by this project's `xlsx.ts`/`import.ts`, which do not emit conditional formatting | Practically no, given current usage, but the dependency is bundled and would activate if conditional-formatting export were ever added | Would require `exceljs@3.4.0` (**major downgrade** per `npm audit`'s own heuristic — not a real forward fix) | Yes (downgrade) | Not actionable without breaking `exceljs`; monitor for a real forward-fixed `exceljs`/`uuid` release instead |
  | `exceljs` (flagged only because of its `uuid` dependency) | moderate | direct | Same as above | Same as above | major downgrade only | Yes | Same as above — do not apply the suggested downgrade |
  | `esbuild`, `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `drizzle-kit` | moderate | `drizzle-kit` direct (devDependency only — no `package.json` script wires it in; run manually by a developer, never part of `next build`/`next start`/`npm test`) | Dev-machine only; the underlying `esbuild` CVEs are about `esbuild`'s own local dev server accepting cross-origin requests, which `@esbuild-kit/esm-loader` does not start (it only uses `esbuild` as an in-process transform for loading `drizzle.config.ts`) | No practical exposure under how this repo actually invokes `drizzle-kit` | Would require `drizzle-kit@0.18.1` (**major downgrade**) | Yes (downgrade) | Not actionable without breaking `drizzle-kit`; low real risk given it's a manually-run local dev tool with no exposed server in this repo's usage pattern |
  | `js-yaml`, `@humanfs/node` | high, moderate | transitive via `eslint`/`@eslint/eslintrc` (devDependency) | Dev-only — `eslint` runs against local trusted config/source files, never untrusted input | No | non-major | No | No |
  | `brace-expansion` | high | transitive — **two** vulnerable copies, both dev-only: `eslint`→`minimatch@3.1.5`→`brace-expansion@1.1.13`, and `eslint-config-next`→`typescript-eslint`→`minimatch@10.2.5`→`brace-expansion@5.0.5`. A **third**, separate copy exists via `exceljs`→`archiver`→`readdir-glob`→`minimatch@5.1.9`→`brace-expansion@2.1.7` — verified this version (`2.1.7`) falls **outside** every vulnerable range in the advisory (`<=1.1.17 \|\| 3.0.0-5.0.8`) and is not flagged by `npm audit` | Dev-only for the two flagged copies; the prod-path (`exceljs`) copy is unaffected | non-major (for the two dev copies) | No | No |
  | `browserslist`, `baseline-browser-mapping`, `@babel/core` | high, moderate, low | transitive via `eslint-config-next`'s Babel chain; `baseline-browser-mapping` is **also** pulled directly by `next@16.3.5` itself | Build/config-time only in both cases (browser-target resolution for lint tooling and for Next's own bundler); processes local trusted config, not untrusted network input, in either path | No | non-major | No | No |
  | `body-parser` | low | transitive via `@modelcontextprotocol/sdk`'s unused HTTP transport (same chain as `hono`) | Same as `hono` above | No | non-major | No | No |

- **Actual risk:** The two critical, runtime-reachable findings (`next`, `next-auth`) are closed. Of the 20 remaining: **14 have no practical exposure today** (unused MCP HTTP transport, dev-only tooling, build-time-only packages, or a dormant remote-libsql code path this deployment doesn't use); **2 (`qs` via `googleapis`, `fast-uri` via `ajv`) sit in an actively-exercised production code path** and should not be deferred indefinitely even though they are not acutely dangerous given current usage; **4 (`uuid`/`exceljs`, and the `esbuild`/`drizzle-kit` chain) can only be "fixed" via a major downgrade that `npm audit`'s own heuristic proposes and which must not be applied blindly** — these stay open until a genuine forward-compatible patched release exists.
- **Existing mitigation:** `next`/`next-auth` patched. All 20 remaining findings assessed for actual reachability (see table) rather than assumed harmless by virtue of being transitive or dev-only, per explicit instruction.
- **Required remediation:** (1) Opportunistically close `qs` (both chains) and `fast-uri` via a scoped, reviewed `npm audit fix` (non-`--force`) in a future small task — not blocking anything today. (2) Re-check the `ws`/`@libsql/client` finding before any move to a remote libsql/Turso URL. (3) Re-check the `hono`/`@hono/node-server`/`express-rate-limit`/`ip-address`/`body-parser`/`qs`(express) cluster before adding any MCP HTTP transport (Slice 5 / `RISK-04`). (4) Track `exceljs`/`uuid` and `drizzle-kit`/`esbuild` for a real forward-fixed release; do not downgrade.
- **Acceptance criteria:** `next`/`next-auth` show 0 critical findings (met). Before `BLOCKS_OPERATIONS_RELEASE`/`BLOCKS_NETWORK_DEPLOYMENT` gates are signed off, the two actively-exercised-production findings (`qs` via `googleapis`, `fast-uri` via `ajv`) must be closed or explicitly re-accepted with a documented reason.
- **Gate(s):** `next`/`next-auth` portion: **CLOSED**, no longer blocking. Remaining 20 findings: `BLOCKS_OPERATIONS_RELEASE`, `BLOCKS_NETWORK_DEPLOYMENT` for the two actively-used-production items (`qs`, `fast-uri`); `DEFERRED_WITH_DOCUMENTED_REASON` for the rest (dev-only, build-time-only, or dormant-code-path items) and for `exceljs`/`drizzle-kit` (major-downgrade-only fixes, explicitly not applied). **Does not block Slice 4** on its own — none of the remaining findings touch the code paths Slice 4 will add (a real YouTube adapter behind `WriteExecutor`) — but the `hono`/MCP-HTTP cluster and the `ws`/libsql cluster must be re-triaged if Slice 4 or a later slice changes transport/DB configuration in a way that activates them.
- **Approval required from:** project owner (dependency upgrade approval for any further action; already given for the `next`/`next-auth` bump).
- **Status:** `next`/`next-auth` portion **CLOSED** (2026-09-18). Remaining 20 findings **OPEN, triaged, not blocking Slice 4** — see table above; Google OAuth browser validation explicitly still **PENDING** (not performed in this environment).

---

## RISK-07 — OAuth tokens stored in plaintext

- **Affected components:** `src/lib/db.ts` (`users.accessToken`, `users.refreshToken`), `data/playlist-manager.db`.
- **Current behavior:** Access/refresh tokens are stored as plain SQLite text columns, no field-level encryption. `data/` is entirely `.gitignore`d (confirmed: `data/*.db`, `data/auth-context.json`, `data/oauth/`, `data/tokens/`, `credentials/`), and tokens are never logged or sent to an AI provider (`AGENTS.md` rule, verified: no `console.log`/logger call in `src/lib/auth.ts` or `db.ts` includes token fields).
- **Actual risk:** Anyone with filesystem read access to the operator's machine (or a backup of `data/playlist-manager.db`) can read live OAuth tokens in plaintext.
- **Existing mitigation:** Local-first, single-operator deployment model; `.gitignore` prevents accidental commit; no logging path exposes tokens.
- **Required remediation:** Before any shared-machine or hosted deployment: either encrypt token columns at rest (e.g. via an OS keychain-backed key, or `libsql`-level encryption if available) or integrate with the OS credential store (Windows Credential Manager / macOS Keychain / libsecret) instead of a plain SQLite column.
- **Acceptance criteria:** Reading `data/playlist-manager.db` directly (e.g. `sqlite3` CLI) no longer yields a usable access/refresh token without an additional secret not stored in the same file.
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON` (current single-operator local model), `BLOCKS_NETWORK_DEPLOYMENT`.
- **Approval required from:** project owner.
- **Status:** OPEN — accepted tradeoff for now, not silently forgotten. **Cross-reference
  (Pre-Release Cross-Platform Persistence task):** device-handoff snapshots (`src/lib/snapshot/`)
  never carry `users` rows at all, in either direction — this task does not close this risk, but
  ensures it is never propagated forward via a snapshot; see
  `docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md` AC-CONN-02.

---

## RISK-08 — Database migration strategy will not scale indefinitely

- **Affected components:** `src/lib/db.ts` (`initializeDatabase()`).
- **Current behavior:** See `docs/decisions/0001-additive-idempotent-schema-strategy.md` — every schema change to date (Phase 2's `channels`/`videos`, Phase 4's `change_sets`/`changes`) has been additive, and the idempotent `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE` pattern handles this correctly, re-verified for Phase 4 against both an empty and an existing database.
- **Actual risk:** No rollback mechanism exists; as more tables accumulate, the pattern becomes harder to reason about, and it cannot safely express a non-additive change (column type change, `NOT NULL` backfill, data transformation).
- **Existing mitigation:** ADR 0001 documents the explicit trigger condition for revisiting this.
- **Required remediation:** None today. When the first non-additive schema change is needed (a real candidate: Phase 5's audit/backup/ledger tables might need one), write a new ADR proposing Drizzle Kit migrations, including a plan for retrofitting migration files for the existing additive history.
- **Acceptance criteria:** N/A until triggered.
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON`.
- **Approval required from:** project owner, at the point the trigger condition is hit.
- **Status:** OPEN, monitored — not currently actionable. **Progress (Pre-Release Cross-Platform Persistence task):** `docs/decisions/0002-additive-schema-versioning.md` adds an explicit `schema_meta.schema_version` label and an ordered migration list on top of this same additive pattern — this closes the "no way to know what shape an existing database is in" half of the original concern, but does **not** close this risk's core trigger: the pattern still cannot express a genuinely non-additive change. The trigger condition and required remediation (a new ADR proposing Drizzle Kit) are unchanged.

---

## RISK-09 — Phase 5 write-safety infrastructure does not exist yet

- **Affected components:** none yet — this documents an absence, not a defect in existing code. Relevant future modules: a `write-context`-reusing localization-write path, plus new `backup/`, `audit/`, `batches/` domain modules (per `docs/PROJECT_SPEC.md` §47).
- **Current behavior:** Phase 4 ends at `Change.approvalStatus === "approved"` — a purely local database state. None of the following exist for **bulk localization writes** specifically: immutable pre-write backups, a fresh remote conflict check (RISK-03), a durable audit log, a per-item execution ledger, resumable/idempotent batch processing, or post-write remote verification. (Note: single-item `video-metadata/services.ts` `applyMetadata` already has identity check + diff + dry-run — see `docs/UPSTREAM_ANALYSIS.md` §3.2 — but not backup/audit/ledger either, and it is not the bulk-localization path.)
- **Actual risk:** Without this infrastructure, enabling real bulk localization writes would have no recovery information preserved before a destructive change, no tamper-evident record of what was changed and by whom, and no safe way to resume an interrupted batch without risking duplicate or inconsistent writes.
- **Backup is not rollback — these are two separate guarantees and must not be conflated:**
  - A **backup** is a captured snapshot of a video's remote metadata *before* a write, stored durably (per `docs/PROJECT_SPEC.md` §19: `metadata_before.json`/`batch_manifest.json` under `data/backups/<channelId>/<timestamp>/`). Its job is to **preserve recovery information** — it answers "what did this look like before we touched it?"
  - **Rollback** is a separate, additional capability: actually *using* that backup to restore the prior remote state via a new write. `docs/PROJECT_SPEC.md` §51 explicitly marks automated rollback **execution** as optional for the first write-capable milestone ("Full automated rollback is optional for the first milestone. However the data required to manually or programmatically restore previous metadata must exist.") — i.e. Phase 5 is only required to make rollback *possible* (durable, complete backup data), not to *ship* an automated one-click rollback feature.
  - **Recovery expectations for Phase 5, stated explicitly so this is not assumed implicitly:** every write batch must produce a backup sufficient for a human operator to manually reconstruct the prior state (title/description/localizations) for every affected video, even if no "restore" button exists yet. If an automated rollback feature is deferred, that deferral must be a conscious, documented decision at Phase 5 time (not a silent gap discovered later) — do not describe "we have backups" as equivalent to "we can safely undo a bad batch" without that decision being made explicit.
- **Existing mitigation:** No real writes are currently possible from the `changesets/` module — there is no code path that could cause this damage today.
- **Required remediation:** Implement the full pipeline from `docs/PROJECT_SPEC.md` §19–25 (immutable backup → diff → approval [done, Phase 4] → dry-run → apply → verify → audit) with a per-item ledger supporting idempotent resume, reusing `write-context.assertWriteChannel` for identity (`docs/ARCHITECTURE.md` §11). Decide and document, as part of that implementation (not after), whether automated rollback execution ships in the same phase or is explicitly deferred with the backup data alone as the interim safety net.
- **Acceptance criteria:** The five acceptance tests defined in `docs/PROJECT_SPEC.md` §53–57 (full happy path, interrupted-batch resume, wrong-channel fail-closed, conflict detection, existing-localizations-preserved) all pass against mocked YouTube adapters, with zero writes to a real channel in any automated test. Additionally, a dedicated test proves that for every video in a batch, a complete pre-write backup (sufficient to manually reconstruct title/description/localizations) exists **before** that video's write is attempted — independent of whether an automated rollback-execution feature ships in the same phase.
- **Gate(s):** `BLOCKS_PHASE_5_WRITES`, `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner (Gate B sign-off, see "Release-readiness checkpoints" above).
- **Status:** OPEN — this is the primary scope of Phase 5 itself, not a Phase 4.5 deliverable. **Progress (2026-09-17, Slices 1-2 of 5 of the approved Phase 5 implementation plan):** Slice 1: `src/lib/batches/` now exists with a `Batch` entity (immutable membership), a per-video execution ledger, durable two-phase (`INTENDED` → result) attempt-intent persistence, an explicit ledger/attempt state machine (with a 2026-09-17 correction: a persistent `active_attempt_id` slot, not only the attempt-number UNIQUE constraint, enforces "at most one active attempt per ledger row" under real concurrent connections), and cross-batch/cross-video concurrency locks (`docs/acceptance/PHASE_5_ACCEPTANCE.md` AC-BATCH-01/02, AC-LEDGER-01, AC-ATTEMPT-02/03, AC-CONCURRENCY-01/02/03). Slice 2 (SAFETY PREPARATION): identity check reusing `write-context.assertWriteChannel` (AC-GUARD-01), approval/payload-integrity re-check shared between batch-creation time and send-time preparation (AC-BATCH-03, AC-MERGE-04), a fresh single-video fetch distinct from a batched preliminary one (AC-MERGE-02), pre-write conflict detection against that fresh fetch (AC-CONFLICT-01/AC-LEDGER-04), safe locale-preserving merge (AC-MERGE-01/03, AC-MULTI-01), a new `src/lib/backup/` module with item-level/infrastructure-wide failure classification and non-overwrite guarantees (AC-BACKUP-01..04), and a dry-run path that runs the full preparation pipeline and lands on a dedicated `DRY_RUN_COMPLETE` state, never `SUCCESS` (AC-DRYRUN-01/02/03). **Progress continued (2026-09-17, Slice 3, RECOVERY AND AUDIT):** a durable, append-only audit trail (`src/lib/audit/`, `audit_events` table) distinguishing PREPARATION/ATTEMPT/RESULT/CONFLICT/VERIFICATION/DRY_RUN/RECONCILIATION events; §0.E bounded retry (4 attempts, transient/permanent classification supplied by the executor); the full §0.F reconciliation procedure (two bounded reads, never itself authorizing a retry); mandatory post-write verification before any `SUCCESS` is trusted (AC-VERIFY-01/02, AC-CONFLICT-02); causation-aware audit distinguishing an own-response-confirmed `SUCCESS` from a reconciliation-confirmed one (AC-AUDIT-05); crash recovery (`recoverBatch`/`recoverLedgerRow`) covering every interruption point from "before attempt-intent creation" through "after verification, before final ledger completion", proven against a real SQLite database reopened to simulate a restart, idempotent across repeated calls, never releasing a lock on a timeout, never inventing an unobserved API call; item-level failure isolation, systemic-abort handling (including quota exhaustion), and a downloadable error report. The ledger state model gained an explicit `AWAITING_EXECUTION` status (prepared, not yet attempted) so `APPLYING` now means exclusively "an attempt is genuinely active" — closing the project owner's "a blocked live operation must have an explicit, inspectable state" review finding. Two real Foundation-layer bugs were found and fixed while adding a *real*-SQLite crash-recovery test (not just fake-store tests): several `src/lib/db.ts` functions (`transitionLedgerRowStatus`, `markBatchTerminal`, `listStoredLedgerRowsByBatch`, `listStoredAttemptsByBatch`) silently ignored an isolated-database parameter and always wrote/read the production singleton; and `src/lib/db.ts` kept its own copy of the `LedgerStatus` type that had drifted out of sync with `src/lib/batches/contracts.ts` (see `docs/TECHNICAL_DEBT.md`'s new note on this below). **No** real YouTube write adapter exists yet (Slice 4 — the only remaining piece), and nothing in the repository can reach a real `videos.update` call — `executeBatch`/`executeWithRetry`/`recoverBatch` all operate against the abstract `WriteExecutor` port, which no production code constructs. Do not read this progress note as narrowing this risk's `OPEN` status or its release gates.

**Progress continued (2026-09-18, Slice 4, WRITE INTEGRATION):** `src/lib/batches/adapters/write-executor.youtube.ts` implements the real `WriteExecutor` by reusing `applyVideoMetadataUpdate` (`src/lib/youtube.ts`, the same single-item write call already used elsewhere — no parallel write path). Error classification (`classifyYoutubeWriteError`) is derived from the official YouTube Data API v3 reference (verified 2026-09-18, not from mocks): documented `videos.update` 400/403/404 reasons and the API-wide 403 `quotaExceeded` are `permanent` (quota additionally `systemic`, per AC-QUOTA-02); Google's documented general retry guidance (408/429/5xx = transient) matches this project's own AC-RETRY-01/03 fixtures; a genuine no-response condition (timeout/connection reset — no HTTP status ever received) is `UNKNOWN`, never a directly-retried `FAILED`, per DEC-OQ-6/§0.F. A **mandatory, two-layer live-write barrier** gates the only path to a real mutation: (1) `src/lib/batches/index.ts` still constructs no `WriteExecutor` at all — confirmed by grep, no API route or MCP tool references the batches module (AC-SCOPE-01 holds); (2) `attemptWrite` itself calls a hard-coded, parameter-free `assertLiveWritesAuthorized()` that unconditionally throws `live_writes_disabled` before the injected client is ever touched — not gated by `dryRun`, an env var, or any request field; lifting it requires editing this function's source, itself a future, separately-authorized activation procedure after Gate B. 12 new tests cover error classification (every documented status), the real request shape sent to `videos.update` (id/snippet/localizations preserved), and the barrier (asserted to reject before the client is constructed). Full validation (`npm test` 302/302, `npm run lint`, `npm run build`) passes.

**Gaps found during Slice 4's mandatory re-inspection of Slices 1-3 (not previously documented, none introduced by Slice 4, none fixed by it — out of Slice 4's scope, explicitly flagged rather than silently left implicit):**
- **AC-CONCURRENCY-01's "configured `K > 1`" half is not implemented.** `executeBatch` processes ledger rows in a single sequential `for` loop; the `Batch.concurrency` field (configurable 1–5 per DEC-OQ-4/§0.D) is persisted but never read by `executeBatch` at all. The default-concurrency-1 half of AC-CONCURRENCY-01 holds today only because execution is unconditionally sequential regardless of configuration, not because a bounded-parallelism mechanism was built and verified to respect a configured limit. Building this is Slice 5 (or a dedicated later task)'s job, not Slice 4's — this task was explicitly scoped to keep live execution sequential.
- **AC-QUOTA-01 (batched preliminary fetch, ≤50 ids/call) is not wired into the pipeline.** `adapters/youtube-api.ts`'s `fetchPreliminaryBatchContext` exists and is unit-tested in isolation, but no caller in `services.ts` ever invokes it — every video's mandatory pre-write fetch (`fetchFreshVideoContext`, correctly single-video per architectural decision #2) is the only fetch actually issued, so a 75-video batch issues 75 individual `videos.list` calls, not the ≤2 batched calls AC-QUOTA-01 requires. This is a quota-efficiency gap, not a safety one (no correctness/safety invariant depends on batching), but it must not be described as satisfied.
- **AC-RESUME-01's exact scenario (100 videos, 43 pre-interruption successes, 5 distinct per-video state classes, a complete non-omitting resume report) has not been run at that scale.** `recovery.integration.test.ts` proves every individual interruption-point mechanism AC-RESUME-01 depends on (1-5, `INTENDED`-with-no-result → `UNKNOWN` → reconciliation, idempotent `recoverBatch`, no blind retry), each at small scale (1-2 rows), but no single test yet assembles the full 100-video/5-state-class scenario the acceptance contract specifies verbatim, nor asserts the resume report's "no video omitted" property at that scale.

None of these three gaps block Slice 4 (the write executor and its barrier) and none involve `videos.update` correctness or safety directly — but do not report AC-CONCURRENCY-01, AC-QUOTA-01, or AC-RESUME-01 as fully PASSED until they are.

**Progress continued (2026-09-18, Slice 5, INDEPENDENT VERIFICATION AND COMPLETION):** all three Slice-4-documented gaps above are now closed at the mocked-adapter level:
- **AC-CONCURRENCY-01 (configured `K > 1`) — implemented.** `executeBatch` now runs ledger rows through a bounded cursor-based worker pool (`runWithConcurrencyLimit`), respecting `batch.concurrency` (1–5, validated at creation time). A systemic result halts only *not-yet-started* rows; rows already in flight when it occurs complete normally. New real-SQLite tests (`concurrency-execution.integration.test.ts`) prove: K=1 never exceeds 1 in-flight; K=3 genuinely parallelizes (observed in-flight > 1) while never exceeding 3; zero duplicate writes; correct per-video audit ordering despite cross-video interleaving; a systemic failure mid-batch leaves in-flight rows' real results intact, aborts only undispatched rows, and this is independently re-verified by re-querying the database directly (not just the in-memory summary).
- **AC-QUOTA-01 (batched preliminary fetch) — wired in, with an honest caveat.** `prepareBatchExecution` now calls the existing (previously-unused) `fetchPreliminaryBatchContext` once per batch, purely as an informational overview — its result is structurally incapable of feeding the per-video merge/conflict/backup decision (proven by `AC-MERGE-02`'s test, whose preliminary fixture lacks the fields the real payload needs). The adapter's own chunking (already existing, `getVideosMetadataContextBatch`) is independently verified against the exact approved 75-video fixture (2 calls: 50 + 25) in `src/lib/youtube.test.ts`. **Caveat, not to be glossed over:** this closes AC-QUOTA-01's literal call-count assertion for the *preliminary* pass, but the mandatory per-video fresh fetch immediately before each write (`fetchFreshVideoContext`, required by RISK-03/AC-MERGE-02, deliberately never batched) still issues one `videos.list`-equivalent call per video — a live 75-video batch's *total* API usage is not reduced to ~2 calls; only the new preliminary overview pass is. Reporting this AC as fully closed in the quota-*savings* sense it was originally motivated by (§28) would overstate what changed.
- **AC-RESUME-01 (= official test §54) — the exact 100-video/5-state-class scenario now runs.** `resume-100-video.acceptance.test.ts` constructs, via direct `src/lib/db.ts` calls against a real on-disk SQLite database, the precise pre-interruption fixture the acceptance contract specifies (43 SUCCESS, 54 PENDING, 1 crashed-and-actually-applied `APPLYING`, 1 crashed-and-undeterminable `APPLYING`, 1 pre-existing terminal `FAILED`), closes the database client, and reopens a fresh `createBatchServices` instance against the same file (simulating a real process restart) to call `recoverBatch` then `executeBatch`. Verified: zero additional writes for the 43+1 already-resolved videos; the 54 `PENDING` videos are each attempted exactly once; the `UNKNOWN` video never receives an automatic resend and keeps its video lock (by design, until an explicit operator decision); every one of the 100 videos is present in the final persisted ledger with a correct, non-omitted status (98 SUCCESS, 1 UNKNOWN, 1 FAILED); exactly one attempt record per ever-attempted video (no duplicates). **A genuine, previously-undetected bug in `executeBatch` was found and fixed while building this test:** the function only auto-prepared a batch via `prepareBatchExecution` when the *whole batch's* status was still `PENDING` (i.e. never-started) — a resumed batch (status `RUNNING`, with some individual rows still `PENDING` because they were never reached before the interruption) had no code path that ever brought those rows through preparation at all; they would have been silently reported "as-is" (`PENDING`) forever on every resume attempt. `executeBatch`'s per-row loop now calls `prepareLedgerRow` inline for any row it finds still `PENDING`, before the safety re-check/attempt cycle — this means **AC-RESUME-01 was not actually implementable correctly before this fix**, regardless of how many individual interruption-point tests existed.

**Do not read any of this Slice 5 progress as narrowing RISK-09's own `OPEN` status or Gate B's requirements** — Gate B is not being closed by this note; see "Remaining Gate B blockers" in the Slice 5 completion report for the current, non-exhaustive list (live validation for AC-MERGE-01/05/GUARD-01/CONFLICT-01/RESUME-01/E2E-01 in particular, per §4's automated-vs-live methodology, plus AC-CONCURRENCY-03's full two-batch-orchestration race scenario and AC-E2E-01's single assembled 23-step walkthrough, neither of which was built this session).

**Progress continued (2026-09-18, Phase 5 completion task, after the independent-review report):**
- **AC-CONCURRENCY-03 — now implemented and tested.** `concurrency-execution.integration.test.ts` adds a deterministic real-SQLite test: two distinct batches (`batchA`, `batchB`) both target the same video; `batchA`'s write is held genuinely in flight via a controllable gate while `batchB`'s full `executeBatch` call runs concurrently. `batchB`'s attempt is rejected (not raced) with a clear `video_locked` reason, while `batchA` completes normally with exactly one write. **Building this test surfaced two real, previously-undetected bugs, both fixed:** (1) `executeBatch`'s inline `PENDING`-row preparation (added for AC-RESUME-01) had no `try`/`catch` around `prepareLedgerRow` — a cross-batch lock conflict threw an uncaught `DomainError`, crashing the entire `executeBatch` call instead of reporting one clean `FAILED` row; (2) both that call site and `prepareBatchExecution`'s own pre-existing per-row `catch` block only pushed an in-memory `FAILED` outcome without ever calling `transitionLedgerStatus` — the database row silently stayed `PENDING` forever, so a resumed batch would retry a lock-conflicted video indefinitely rather than terminally failing it. Both are fixed in `src/lib/batches/services.ts` (the catch blocks now persist the `FAILED` transition, tolerating the rare case where the row already left `PENDING` via a concurrent path).
- **AC-E2E-01 — now implemented as one integrated automated scenario.** `e2e.acceptance.test.ts` walks: two videos each adding a new `pt-BR` locale while `es`/`de` survive (official test §57's own scenario) → dry-run batch → `DRY_RUN_COMPLETE` with a correct diff, zero writes → a second live batch (mocked executor) → `SUCCESS` for both, complete per-video audit sequence, non-empty backup, empty error report → re-running the same already-succeeded batch id issues zero additional `attemptWrite` calls (official test §53 step 23). This complements, and does not replace, the many individual component-level AC tests elsewhere in this directory.
- **RISK-11 fully resolved** (see its own entry above, updated) — the whitelist fix now covers the legacy single-item write path too, not only `src/lib/batches/`.
- **New Web UI/API for Batches** (the minimum Phase 5 scope, DEC-OQ-5): `src/app/api/channels/[channelId]/batches/**` (list/create/inspect/dry-run-prepare/errors/audit) and `src/components/batch-manager.tsx`. Every route is channel-scoped via a new `requireBatchForChannel` (AGENTS.md §F), and `POST .../batches` forces `dryRun: true` unconditionally regardless of request body content. There is no "Apply"/live-execution route or button anywhere in this surface. `src/lib/batches/write-path-inventory.test.ts` was revised accordingly: it no longer bans importing `src/lib/batches/` from API/MCP/CLI code (now legitimately used for the dry-run-only workflow), but still absolutely bans any reference to `executeBatch`, `executeWithRetry`, `recoverBatch`, `resolveUnknownLedgerRow`, `WriteExecutor`, `createYoutubeWriteExecutor`, `createScriptedFakeWriteExecutor`, or `performYoutubeWrite` anywhere in that surface (including comments) — verified passing after the new routes were added.
- **RISK-12 (new, then closed same day) — the pre-existing, live, MCP-reachable single-item write path defaulted to a REAL write when `dryRun` was omitted.** Escalated for project-owner decision per this task's own "if owner approval is necessary for a material change, stop that part and request it" instruction; the project owner approved the fix later the same day as a deliberate breaking behavioral change — see RISK-12's own entry (now marked CLOSED) for the applied fix, including a second unsafe-default site found in the CLI while re-verifying this path.
- **RISK-13 (new, then resolved same day) — AC-QUOTA-01's literal text and RISK-03/AC-MERGE-02's mandatory unbatched pre-write fetch were in tension.** A narrow acceptance-contract correction was proposed here and approved by the project owner later the same day — see RISK-13's own entry (now marked RESOLVED) for the applied split (AC-QUOTA-01a/b).
- **Video-lock leak found by a second, independent review round and fixed.** The two `catch` blocks added above (`prepareBatchExecution`'s per-row loop, `executeBatch`'s inline `PENDING` handling) persisted the `FAILED` transition but never released the video lock -- if `acquireVideoLock` (the first step of `prepareLedgerRow`) succeeded and a LATER step (e.g. `audit.record`) then threw, this batch would keep holding the video's lock indefinitely under a now-terminal `FAILED` row, unreleasable until an explicit `recoverBatch` pass. Both catch blocks now also call `releaseVideoLock` unconditionally (a safe no-op if the lock was never acquired, since `releaseVideoExecutionLock` only deletes a lock actually held by the calling batch). Regression test added in `prepare-batch.test.ts` (simulates `audit.record` throwing for one video, asserts the lock is released).

**RISK-11 — read-only snippet field echo-back — RESOLVED, 2026-09-18, for BOTH write paths.** Originally flagged during Slice 4 for `src/lib/batches/` only: the official YouTube Data API v3 docs never state what happens when a client resends an unchanged *read-only* `snippet` value (`publishedAt`, `channelId`, `channelTitle`, `thumbnails`, `liveBroadcastContent`, verified against `developers.google.com/youtube/v3/docs/videos`'s full per-property mutability table), and both write paths' snippet-sanitizing functions previously stripped only `.localized`. **Resolution:** `WRITABLE_SNIPPET_FIELDS`/`pickWritableSnippetFields` (the explicit whitelist of the six documented-writable fields) moved to `src/lib/youtube.ts` as the single canonical source; `src/lib/batches/merge.ts` re-exports it instead of keeping its own copy, and `src/lib/video-metadata/services.ts`'s `removeReadOnlySnippetFields` (used by `applyMetadata`/`/api/video-metadata/apply` and the MCP `apply` tool) now delegates to the same function. Both write paths now build every outgoing `snippet` from the same whitelist; no read-only field can reach `videos.update` through either path regardless of what a real `videos.list` response contains. Regression tests: `merge.test.ts`'s and `write-executor.youtube.test.ts`'s existing RISK-11 tests (batches path, unchanged), plus a new test in `video-metadata/services.test.ts` ("RISK-11 (legacy single-item path...)") proving the same for the legacy path's real request body. **Gate(s):** none — closed by design change for both paths. **Status:** RESOLVED.

---

## RISK-10 — `src/lib/db.ts` duplicated the `LedgerStatus`/`AttemptPhase`/`AttemptOutcome` type definitions instead of importing them from a canonical source — CLOSED 2026-09-18

- **Affected components:** `src/lib/db.ts` (persistence-layer type aliases), `src/lib/batches/contracts.ts` (the domain-facing re-export), `src/lib/batches/ledger-state.ts` (new canonical source).
- **Original behavior:** `db.ts` declared its own copies of these union types. The original investigation (2026-09-17) attributed this to a supposed circular-import constraint ("`db.ts` predates, and is imported by, `batches/contracts.ts`, so a direct import would be circular") — **this claim was re-checked on 2026-09-18 and found factually incorrect**: `batches/contracts.ts` imports only from `video-metadata/contracts.ts` (itself import-free); it never imports `db.ts`, so no cycle existed. The real, still-valid concern was architectural direction: `db.ts` is a domain-agnostic persistence layer (it imported zero domain modules before this fix, and still does) and should not start depending on one specific domain's `contracts.ts`. When Slice 2 added `DRY_RUN_COMPLETE` and Slice 3 added `AWAITING_EXECUTION` to `contracts.ts`, `db.ts`'s copy was not updated in the same edit and only failed at `tsc --noEmit` once a test happened to pass one of the new literal values through a `db.ts` function signature — not caught by `npm test` (does not typecheck) or casual review.
- **Resolution:** Created `src/lib/batches/ledger-state.ts` — a leaf module with **zero imports** — as the single canonical source of `LedgerStatus`/`AttemptPhase`/`AttemptOutcome`. `src/lib/batches/contracts.ts` imports and re-exports from it (no consumer of `./contracts` needed to change). `src/lib/db.ts` now imports the same three types from `@/lib/batches/ledger-state` directly — this preserves db.ts's existing pattern of depending on no domain-specific `contracts.ts`, since `ledger-state.ts` is a pure types leaf, not a domain module. The duplicated inline definitions in `db.ts` were deleted.
- **Regression tests added:** `src/lib/batches/ledger-state.test.ts` — (1) a compile-time mutual-assignability check between `db.ts`'s and `contracts.ts`'s re-exported types (fails `npm run build`'s `tsc` pass immediately if either ever imports from a different source again); (2) a real-SQLite round-trip proving every single literal value of all three types persists and reads back correctly through `db.ts`'s own functions (`createBatchWithLedger`, `transitionLedgerRowStatus`, `beginAttemptIntent`, `recordAttemptResult`) — the kind of check that would have caught the original incident via `npm test` alone, without waiting for a `tsc` pass.
- **Acceptance criteria:** A deliberately-reintroduced mismatch (e.g. temporarily removing one status from one of the two type unions) is caught by an automated check without requiring a human to notice a `tsc` error buried in unrelated output. Met by the compile-time assertion in `ledger-state.test.ts`.
- **Approval required from:** none -- this was an internal consistency fix, not a product/security decision.
- **Status:** CLOSED — verified via `npm test` (290/290 at the time of this fix), `npm run lint`, `npm run build`, all passing; no remaining duplicated definition exists anywhere in the repository (verified by repo-wide grep).

---

## RISK-12 — Legacy single-item `applyMetadata` defaulted to a REAL YouTube write when `dryRun` was omitted — FIXED 2026-09-18 (project-owner-approved breaking behavioral change)

- **Affected components:** `src/lib/video-metadata/schemas.ts`'s `applyMetadataInputSchema`; `src/mcp/server.ts`'s `apply` tool (description + registration); `src/cli/video-metadata.ts`'s `apply` command; `src/lib/video-metadata/services.test.ts`; `src/cli/video-metadata.test.ts`.
- **Original behavior:** `applyMetadataInputSchema` declared `dryRun: z.boolean().optional().default(false)` — omitting `dryRun` entirely triggered a live write, gated only by the identity guardrail. Verified reachable via the MCP `apply` tool (no UI caller existed). Contradicted `docs/PROJECT_SPEC.md` §20 and the already-established `AC-DRYRUN-02` pattern.
- **Fix, explicitly approved by the project owner as a deliberate, safety-first BREAKING BEHAVIORAL CHANGE (not a silent bug fix):**
  - `applyMetadataInputSchema`'s default is now `dryRun: z.boolean().optional().default(true)` — omitting `dryRun` is now a preview, never a write. A prominent code comment marks this as the breaking change it is and states what any existing caller must now do differently (pass `dryRun: false` explicitly to keep writing live).
  - The MCP `apply` tool's own registered `description` now states this explicitly ("dryRun defaults to true... pass dryRun: false explicitly to perform a real YouTube write") so any MCP client reading tool metadata (Codex included) can discover the new contract without reading source code.
  - **A second, independent unsafe-default site was found and fixed while re-verifying this path**, not previously flagged: `src/cli/video-metadata.ts`'s `apply` command computed `dryRun: parsedArgs.flags.dryRun === true`, which sent an **explicit** `dryRun: false` to the API whenever `--dryRun` was simply omitted — this bypasses any schema-level default entirely, since an explicit `false` always wins over a schema default. Fixed via a new `resolveDryRunFlag` helper: omitting `--dryRun` now omits the field from the request (letting the schema's own safe default apply); `--dryRun` alone means `true`; `--dryRun false` is the only way to request a live write from the CLI.
- **Fail-closed re-verification after the fix (this task's explicit requirement):** re-audited all three write-capable entry points for this path — Web UI (still zero callers, confirmed by grep), `/api/video-metadata/apply` (forwards the raw body unchanged, so the schema's new safe default applies untouched), MCP `apply` tool (already forwarded `undefined` correctly; only the description needed updating), CLI `apply` command (the second bug above, now fixed). All four are now fail-closed: an omitted `dryRun` field, from any of the four entry points, never reaches a real `videos.update` call.
- **Test changes (justified per `AGENTS.md` §L — the requirement itself changed, by explicit project-owner decision, not a "the implementation doesn't do this" rationalization):** `services.test.ts`'s pre-existing live-write assertions now pass `dryRun: false` explicitly (their own intent — exercising the live path — is unchanged, only the means of requesting it). Two new regression tests added: `services.test.ts` ("RISK-12... omitting dryRun... is a preview, never a real write") and `video-metadata.test.ts` (CLI) ("RISK-12... CLI apply omits dryRun from the request entirely..."), both asserting the real write adapter is never called when `dryRun` is omitted. `video-metadata.test.ts`'s pre-existing "keeps payload parity between dryRun and apply" test's live-write invocation now passes `--dryRun false` explicitly.
- **Gate(s):** was `BLOCKS_OPERATIONS_RELEASE` — now closed for this specific gap; Gate C's own checklist item is updated accordingly (see "Release-readiness checkpoints" above).
- **Approval required from:** project owner — given, 2026-09-18, explicitly as a deliberate, safety-first, breaking behavioral change (not requested to preserve backward compatibility with any existing caller's reliance on the old default).
- **Status:** CLOSED — verified via `npm test`, `npm run lint`, `npm run build`, all passing; the CLI's independent unsafe-default path was found and closed in the same pass.

---

## RISK-13 — AC-QUOTA-01's literal text conflicted with RISK-03/AC-MERGE-02's mandatory unbatched pre-write fetch — RESOLVED 2026-09-18 (project-owner-approved narrow editorial correction)

- **Affected components:** `docs/acceptance/PHASE_5_ACCEPTANCE.md`'s AC-QUOTA-01 scenario (now AC-QUOTA-01a/AC-QUOTA-01b); `src/lib/batches/services.ts`'s `runSafetyPipeline` (unchanged — the mandatory single-video `fetchFreshVideoContext` call); `src/lib/batches/adapters/youtube-api.ts`'s `fetchPreliminaryBatchContext` (unchanged).
- **The original conflict:** AC-QUOTA-01's text asked for "the fresh-fetch step" to issue ≤2 calls for 75 videos — written before Slice 2's implementation split a single fresh-fetch concept into two genuinely different mechanisms (a batchable informational overview vs. the mandatory, unbatched, per-video safety check `RISK-03`/`AC-MERGE-02` require). Read literally, the text could be misread as requiring the mandatory check itself to be batched.
- **Fix applied, per the project owner's 2026-09-18 approval of the exact narrow split proposed in this document's prior draft:** `docs/acceptance/PHASE_5_ACCEPTANCE.md`'s AC-QUOTA-01 is now two explicitly-named sub-scenarios (recorded there as a "sixth review round," a wording clarification that does not reopen or require re-approval of any other part of the document, per the project owner's own framing):
  - **AC-QUOTA-01a** — the preliminary batch-wide overview, batched (≤2 calls for 75 videos), never the source of any per-video decision (restates `AC-MERGE-02`'s existing guarantee for AC-QUOTA-01's own traceability).
  - **AC-QUOTA-01b** — the mandatory per-video fetch, restated explicitly as one call per video by design, never a quota-savings target, never satisfied from the preliminary overview or any cache.
- No code or test changed for this fix — the implementation and its tests (`src/lib/batches/prepare-batch.test.ts`'s AC-QUOTA-01 test, `src/lib/youtube.test.ts`'s exact-75-fixture test) already conformed to AC-QUOTA-01b's intent; only the acceptance document's own wording was clarified to match, closing the drift risk between the document and the tests.
- **Gate(s):** none — was always a documentation-consistency question, not a code defect; the underlying safety property (RISK-03) was never actually weakened.
- **Approval required from:** project owner — given, 2026-09-18, explicitly for this exact narrow split, with the explicit instruction that the requirement be clarified, not weakened.
- **Status:** RESOLVED — `docs/acceptance/PHASE_5_ACCEPTANCE.md` updated (§2 traceability matrix, §7 consistency log, §8 status); `npm test`/`npm run lint`/`npm run build` re-verified unaffected (no code changed).

---

## RISK-14 — AI Connections endpoint validation does not pin the outbound socket to the validated address (narrow DNS-rebinding TOCTOU)

- **Affected components:** `src/lib/ai-connections/endpoint-security.ts`'s `validateEndpointUrl`; `src/lib/ai-connections/adapters/openai-compatible.ts`'s `callOnce` (calls validation immediately before `fetchImpl`).
- **Current behavior:** Before every real outbound call, the connection's Base URL hostname is resolved and every resolved address is checked against private/loopback/link-local/reserved/metadata ranges (blocking unless the connection's `localInferenceMode` is explicitly on). The subsequent `fetch()` call, however, performs its own, independent DNS resolution — it is not pinned to the exact address `validateEndpointUrl` just checked.
- **Actual risk:** An adversarial or misconfigured DNS server could in principle return a public address for the validation lookup and a private/internal address for the immediately-following `fetch()`'s own lookup (classic DNS rebinding), reaching an internal host despite validation passing. This requires the operator to have configured a connection pointing at a hostname under an adversary's DNS control in the first place — not a remotely-triggerable attack against a passive user.
- **Existing mitigation:** Validation still blocks the overwhelmingly common cases (IP literals, already-known-private hostnames, cloud metadata address) outright; the residual gap requires an actively hostile DNS answer timed to this specific narrow window. Single-operator, locally-trusted deployment model (no untrusted party can configure a connection on the operator's behalf). **Update, 2026-09-19 (independent adversarial security review):** a related but distinct bypass — an already-validated public HTTPS endpoint issuing an HTTP redirect to a private/internal/metadata address, which the underlying `fetch` (undici) would otherwise follow automatically, requiring no DNS timing at all — was found and fixed the same day by adding `redirect: "manual"` to the outbound request (`adapters/openai-compatible.ts`), so a redirect now surfaces as an ordinary non-2xx `providerError` instead of being followed. This closes the *redirect* variant of the bypass; the narrower DNS-rebinding TOCTOU described above (no redirect involved, just a second DNS answer) remains open and is what this entry continues to track. A DNS-lookup timeout (10s, `raceDnsLookupAgainstTimeout`) was also added the same day so a hanging resolver can no longer block the pipeline indefinitely.
- **Required remediation (if ever needed):** Resolve the hostname once, then issue the HTTP request directly against the validated IP (e.g. via a custom `fetch` dispatcher/agent that pins the connection, with the original hostname preserved only for the `Host`/SNI), so validation and the actual request target are provably the same address.
- **Acceptance criteria:** A test demonstrating that a DNS answer which changes between the validation lookup and the request lookup cannot reach a blocked address.
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON` (current single-operator local model), `BLOCKS_NETWORK_DEPLOYMENT`.
- **Approval required from:** project owner, only if/when this application is ever deployed somewhere an untrusted party could influence which connections get configured.
- **Status:** OPEN (narrowed) — the redirect-based bypass is CLOSED; the pure-DNS-rebinding variant remains an accepted tradeoff for the current deployment model, documented per `docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md` AC-CONN-09's own stated limitation, not silently carried forward.

---

## RISK-15 — AI Connections credential encryption key has no rotation/backup procedure

- **Affected components:** `src/lib/ai-connections/crypto.ts` (`AI_CONNECTIONS_ENCRYPTION_KEY`); `ai_connection_credentials` table.
- **Current behavior:** A single, operator-supplied environment variable is the only key. There is no key-rotation procedure (re-encrypting existing rows under a new key) and no documented backup/recovery guidance — if the key is lost, every stored credential becomes permanently undecryptable (the connections themselves survive; only their credentials are lost, and can be re-entered).
- **Actual risk:** Operator inconvenience (re-entering API keys after losing the encryption key), not a security exposure — losing the key makes data *more* protected, not less.
- **Existing mitigation:** This mirrors the existing, already-accepted pattern for other secrets in this repository (`GOOGLE_CLIENT_SECRET` etc. — also single env-var, no rotation tooling). Encryption here is a strict improvement over RISK-07's current plaintext OAuth-token storage, and could later serve as the template for closing RISK-07 the same way, if the project owner chooses.
- **Required remediation (if ever needed):** A documented key-rotation script (decrypt-all-then-re-encrypt-under-new-key) if this becomes operationally painful.
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON`.
- **Approval required from:** project owner, only if rotation tooling is ever requested.
- **Status:** OPEN — low severity, documented rather than silently absent.

---

## RISK-16 — Restricted recovery mode has no in-app resolution path

- **Affected components:** `src/lib/device-handoff/services.ts` (`isDeviceInRecoveryMode`, `assertDeviceAvailableForMutation`); `src/proxy.ts`; `src/cli/video-metadata.ts`'s `runCliCommand`; `src/mcp/server.ts`'s `createMcpToolHandlers`.
- **Current behavior:** Importing a device-handoff snapshot whose `batch_ledger_rows` contain an `APPLYING`/`UNKNOWN` execution row (an uncertain YouTube write outcome) leaves the receiving device in restricted recovery mode: every locally-mutating or remote-mutating route/command/tool is refused. The gate lifts only when those specific rows are resolved to a terminal state through Phase 5's own, existing, unmodified reconciliation mechanism (RISK-09 §0.F) — this task's own explicit, project-owner-approved constraint (never build a new recovery algorithm, never let acknowledgement alone lift the gate). But **no CLI/MCP/Web trigger for that reconciliation mechanism exists yet** (RISK-04 — Batches has no CLI/MCP interface at all, and the Web UI's Batches tab is dry-run-only, `docs/SYSTEM_MAP.md` §2.10). A device that enters recovery mode via import therefore has no in-app action available to leave it.
- **Actual risk:** Operator inconvenience (a device stuck in read-only mode) rather than a safety defect — the alternative (letting acknowledgement lift the gate, or building a new ad hoc resolution path) was explicitly rejected as *less* safe during this task's design review. In the current build, real YouTube writes are barrier-disabled everywhere (RISK-09's two-layer barrier, still fully in place, unmodified) — so a real `APPLYING`/`UNKNOWN` row cannot actually occur yet from anything this application does today; this risk is forward-looking, for once Gate B is eventually passed and live batches can run.
- **Existing mitigation:** The full audit trail and durable attempt/intent records survive import unmodified (`docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md` AC-HANDOFF-07), so a human operator can always manually inspect and, if truly necessary, resolve the underlying rows directly against the database with full information available — this is a workflow gap, not a data-loss or safety gap.
- **Required remediation:** Once RISK-04 is addressed (CLI/MCP/Web tooling for `recoverBatch`/`resolveUnknownLedgerRow`), a device in recovery mode gains an actual in-app path out. Do not build a device-handoff-specific shortcut around RISK-09's existing reconciliation requirements to close this sooner.
- **Acceptance criteria:** N/A until RISK-04 is addressed for Batches generally.
- **Gate(s):** `DEFERRED_WITH_DOCUMENTED_REASON` (no real `APPLYING`/`UNKNOWN` row is reachable today, RISK-09's barrier unchanged), `BLOCKS_OPERATIONS_RELEASE` (once Gate B/live writes are ever enabled, this becomes load-bearing).
- **Approval required from:** project owner, when RISK-04 is scheduled.
- **Status:** OPEN — documented as part of the Pre-Release Cross-Platform Persistence task rather than left implicit.

---

## RISK-17 — Cross-platform behavior validated on Windows only

- **Affected components:** `src/lib/platform-paths/` (macOS branch of `resolveAppPaths`), the entire Pre-Release Cross-Platform Persistence feature set (`src/lib/snapshot/`, `src/lib/device-handoff/`, `src/lib/schema-versioning/`, `src/lib/operation-lock/`, `src/lib/db-backup/`).
- **Current behavior:** macOS path-resolution logic is unit-tested via dependency injection (`platform: "darwin"`, a fake `homedir`) — `src/lib/platform-paths/services.test.ts`. No macOS machine was available in the environment this feature was implemented in, so no part of this feature (path resolution, snapshot export/import, schema migration, the local operation lock, `src/proxy.ts`) has actually been run on real macOS.
- **Actual risk:** A macOS-specific behavior this task did not anticipate (file-locking semantics, case-sensitivity of the filesystem, a `VACUUM INTO`/libSQL native-binding difference from the Windows build this was developed against) could surface only on first real macOS use.
- **Existing mitigation:** The Windows-specific issues that *were* found during development (a `VACUUM INTO`-then-`ATTACH` "database is locked" race, and an `EBUSY` race on a staging-directory rename — both real, reproduced, and fixed, see the `feature/cross-platform-persistence` branch history) suggest the underlying `@libsql/client` native binding has real, platform-specific timing quirks around file handle release; a macOS-equivalent quirk cannot be ruled out without actually running there.
- **Required remediation:** A real macOS run of the acceptance scenarios in `docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md`, before this is treated as macOS-ready for an actual operator.
- **Acceptance criteria:** A dated, documented run (mirroring RISK-05's own format) on real macOS hardware covering at minimum: first-run app-data directory creation, a full export→import round trip, and one schema-migration boot.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE` (for a release that will actually be used on macOS).
- **Approval required from:** whoever performs the run must have access to real macOS hardware.
- **Status:** OPEN — explicitly and honestly not closed by this task; see the final task report for the exact same caveat stated to the project owner.

---

## RISK-18 — Device-handoff import: unvalidated `snapshotId` path traversal — FIXED, 2026-09-19

- **Affected components:** `src/app/api/device-handoff/import/route.ts` (`POST`, line ~43: `path.join(snapshotsDir, snapshotId)`).
- **Current behavior:** The route only checks that the client-supplied `snapshotId` is a non-empty string, then joins it directly into a filesystem path with no traversal/format validation. Every real snapshot id is an internally-generated `randomUUID()` (`src/lib/snapshot/services.ts`) — nothing in the chain (`resolveSnapshotsDir`, `verifySnapshotForImport`, `importHandoff`) checks the incoming id's shape.
- **Actual risk:** An authenticated session (this route requires `getServerSession`) supplying `snapshotId: "../../../../some/other/dir"` resolves outside the intended snapshots directory. If a `manifest.json`+`data.db` pair happens to exist there and passes checksum/lineage checks, `applySnapshotToDatabase` merges that arbitrary directory's data into the live production database. Confirmed directly by reading the route in this session (not only by the reporting review) — this is a real path-traversal defect (CWE-22), not a hypothetical.
- **Required remediation:** Validate `snapshotId` against the exact shape `randomUUID()` produces (or otherwise resolve it only against a known-good enumeration from `resolveSnapshotsDir`'s own listing) before it ever reaches `path.join`.
- **Acceptance criteria:** A test asserting a `snapshotId` containing `../`, an absolute path, or any non-UUID shape is rejected before any filesystem access.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`, `BLOCKS_NETWORK_DEPLOYMENT`.
- **Approval required from:** project owner, to schedule the fix as its own task (out of scope for the task that discovered it).
- **Fix applied:** `isValidSnapshotId` (`src/app/api/device-handoff/shared.ts`) rejects any `snapshotId` not matching `randomUUID()`'s exact shape before the route ever reaches `path.join`; the import route now calls it. Tests: `src/app/api/device-handoff/shared.test.ts` (traversal string, absolute path, a UUID embedded inside a longer traversal string, non-string, empty string — all rejected; a real UUID accepted).
- **Status:** FIXED — project-owner-assigned task, 2026-09-19 ("Начни с 1. Отработай найденные риски").

## RISK-19 — `readSchemaVersion` fails open on any read error, not only "table missing" — FIXED, 2026-09-19

- **Affected components:** `src/lib/schema-versioning/services.ts` (`readSchemaVersion`, `assertSupportedSchemaVersion`).
- **Current behavior:** `readSchemaVersion`'s `catch` returns `null` unconditionally, on any error from the `schema_meta` read — not narrowed to "table doesn't exist" the way sibling modules in the same feature (operation-lock's `isMissingTableError`, snapshot's lineage-store) explicitly do, after an earlier bare-catch pattern was found and fixed there specifically for failing open.
- **Actual risk:** A transient error (`SQLITE_BUSY`, disk I/O error, a corrupt row) is treated identically to a legitimate legacy/unversioned database, letting `assertSupportedSchemaVersion` — which exists specifically to reject a DB stamped with a newer, unsupported schema version — pass through and let migrations proceed against a DB that may actually be at an unsupported version.
- **Required remediation:** Narrow the catch to the same missing-table check already used by `isMissingTableError` elsewhere in this feature; rethrow anything else.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix.
- **Fix applied:** narrowed the catch to a new single shared `isMissingTableError` (moved to `src/lib/db-backup/services.ts` — previously duplicated verbatim in operation-lock and lineage-store; both now import it instead of keeping their own copy, `AGENTS.md` §D). Any other error now propagates. Test: `schema-versioning/services.test.ts` (closes the client mid-read, asserts the resulting `CLIENT_CLOSED` error propagates rather than becoming `null`).
- **Status:** FIXED — project-owner-assigned task, 2026-09-19.

## RISK-20 — Boot-time schema migration never acquires the operation lock — OPEN, 2026-09-19

- **Affected components:** `src/lib/operation-lock/contracts.ts` (`OperationType` includes `"migration"`); `src/lib/db.ts` (`initializeDatabase`/`initializeDatabaseSchema`/`runSchemaMigrations`).
- **Current behavior:** The operation lock's own doc comment describes covering "export/import/migration," and export/import correctly call `withOperationLock`. Boot-time schema migration never references the operation-lock module at all (confirmed by grep).
- **Actual risk:** A CLI process and the web app (or two app instances) starting concurrently against the same on-disk DB file, or a device-handoff export/import racing against an app instance still running its boot-time migration, has no lock-based serialization protecting that window.
- **Required remediation:** Acquire the operation lock (type `"migration"`) around `runSchemaMigrations`, consistent with export/import's existing pattern.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix.
- **Status:** OPEN — newly discovered by independent review, not yet independently re-verified beyond the cited file/line, not yet fixed.

## RISK-21 — Operation-lock acquisition misattributes lock ownership when the lock table is missing — FIXED, 2026-09-19

- **Affected components:** `src/lib/operation-lock/services.ts` (`acquireOperationLock`).
- **Current behavior:** When the lock `INSERT` fails, the catch path calls `getOperationLock`; if that (correctly) returns `null` because the `app_operation_locks` table doesn't exist yet (unmigrated schema, guarded by its own `isMissingTableError`), the code concludes "row disappeared between the failed INSERT and this read" and throws an `OperationLockError` whose `heldBy` is fabricated from the *calling* process's own not-yet-inserted lock object — misreporting the current process as the lock holder.
- **Actual risk:** A genuine "table missing / not migrated" condition is masked as ordinary lock contention, making it much harder to diagnose from the CLI/MCP/API error surface. Reported as independently flagged by two separate finder passes within the same review.
- **Required remediation:** Distinguish "table missing" from "row genuinely disappeared" before constructing the error, and surface the former as its own diagnostic.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix.
- **Fix applied:** `acquireOperationLock`'s catch now checks `isMissingTableError` first and rethrows the real error immediately, before falling through to the "row disappeared" contention-fallback logic. Test: `operation-lock/services.test.ts` (a fresh temp DB with no `app_operation_locks` table at all — asserts the rejection is the raw missing-table error, not an `OperationLockError`).
- **Status:** FIXED — project-owner-assigned task, 2026-09-19.

## RISK-22 — `writeJsonFileAtomic` has no Windows EBUSY/EPERM retry, unlike the sibling snapshot-publish path — OPEN, 2026-09-19

- **Affected components:** `src/lib/atomic-json-file/services.ts` (`writeJsonFileAtomic`); consumers `src/lib/cli-auth/storage.ts` (auth-context.json) and bootstrap-config's save path.
- **Current behavior:** This module's own doc comment cites the Windows EBUSY/EPERM retry-with-backoff fix already applied in `src/lib/snapshot/adapters/filesystem.ts`'s `publishSnapshot` as the pattern it consolidates, but `writeJsonFileAtomic`'s own `rename(tmpPath, targetPath)` has no such retry.
- **Actual risk:** On Windows — the primary platform for the just-shipped first local test build (`docs/FIRST_LOCAL_TEST_BUILD.md`) — a transiently-held file handle (antivirus, indexer, a just-closed handle) can make a bare `rename()` fail even with nothing genuinely holding a competing lock, throwing unhandled on every login (`auth-context.json`) or bootstrap-config save.
- **Required remediation:** Apply the same retry-with-backoff already used by `filesystem.ts`'s `publishSnapshot`, in the one shared `writeJsonFileAtomic` implementation rather than a second copy.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE` — directly relevant to Windows reliability given the current Windows-first test build priority.
- **Approval required from:** project owner, to schedule the fix.
- **Status:** OPEN — newly discovered by independent review, not yet independently re-verified beyond the cited file/line, not yet fixed.

## RISK-23 — `createActiveAuthStorage`'s single string parameter silently changed meaning (breaking change with no type signal) — OPEN, 2026-09-19

- **Affected components:** `src/lib/cli-auth/storage.ts` (`createActiveAuthStorage`).
- **Current behavior:** On `main`, the parameter is a base directory (`createActiveAuthStorage(baseDir = process.cwd())`, internally joined with `data/auth-context.json`). On this branch, the same parameter position now means "the full context file path" (`createActiveAuthStorage(contextPath = getProductionAppPaths().authContextPath)`), with no type-level signal that the meaning changed.
- **Actual risk:** A caller written against the old convention that still passes a directory would get a file written literally named after that directory, and reads would silently return `null`, making "no active user" indistinguishable from "context file genuinely absent." Currently only two in-repo call sites exist and both use the default, so this is latent rather than actively triggered.
- **Required remediation:** Rename the parameter/add a type distinguishing "directory" from "full path," or provide a migration note for any external caller.
- **Gate(s):** none blocking yet (latent).
- **Approval required from:** none required to leave open; project owner if a rename is scheduled.
- **Status:** OPEN — newly discovered by independent review, not yet independently re-verified beyond the cited file/line, latent (no known active trigger).

## RISK-24 — App-data directory no longer locked to `0700` on every boot for Web-UI-only installs — FIXED, 2026-09-19

- **Affected components:** `src/lib/db.ts` (unconditional `mkdirSync(appPaths.appDataDir, { recursive: true })` at module load).
- **Current behavior:** On `main`, `ensureDataDir` (`cli-auth/storage.ts`) did `mkdir` + `chmod(dataDir, 0o700)` on the directory holding the DB file. On this branch, that `chmod` only happens as a side effect of `writeJsonFileAtomic` (used for `auth-context.json`/`bootstrap-config.json`), reached only via CLI-auth flows — confirmed via grep that no file under `src/app/` (the Web/NextAuth login path) references cli-auth at all.
- **Actual risk:** `db.ts`'s unguarded `mkdirSync` now runs first on every boot, including pure-Web-UI-only installs. RISK-07's accepted plaintext-OAuth-token-storage tradeoff assumed directory-level (`0700`) protection; a Web-UI-only operator's app-data directory (holding that same plaintext-token DB) never gets locked down for the life of the installation.
- **Required remediation:** Apply the same `chmod(appDataDir, 0o700)` unconditionally in `db.ts`'s own directory-creation path, not only as an incidental side effect of an unrelated CLI-only write helper.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`, `BLOCKS_NETWORK_DEPLOYMENT` — directly weakens RISK-07's stated mitigation.
- **Approval required from:** project owner, to schedule the fix.
- **Fix applied:** `chmodSync(appPaths.appDataDir, 0o700)` added unconditionally right after `mkdirSync` in `src/lib/db.ts`, independent of any CLI-auth code path. Test: `src/lib/db.dir-permissions.test.ts` (POSIX only — Windows has no equivalent permission-bits concept; skipped there, not silently claimed).
- **Status:** FIXED — project-owner-assigned task, 2026-09-19.

## RISK-25 — Legacy database migration is one-shot and unretryable; a mid-copy failure permanently and silently orphans the operator's original data — OPEN, 2026-09-19

- **Affected components:** `src/lib/db.ts` (`migrateLegacyDatabaseIfNeeded`, `dbAlreadyExistedAtModuleLoad`).
- **Current behavior:** `dbAlreadyExistedAtModuleLoad` is computed once, before `createClient()` — which itself creates a stub file at the new app-data path as a side effect. If `copyLegacyDatabaseInto` throws mid-copy (legacy file locked by a still-running old process, a corrupt page, an exotic-filesystem `ATTACH` failure), that boot fails loudly, but the stub file at the new path already exists.
- **Actual risk:** On the *next* boot, `dbAlreadyExistedAtModuleLoad` is true, so the migration returns `{ migrated: false }` immediately and silently — the app boots normally with an empty/partial DB, and the operator's original data is permanently orphaned in the legacy file with no further error or hint. This directly contradicts `AGENTS.md` §F/§3's "never silently initialize an empty database in place of an existing database."
- **Required remediation:** Detect a stub/partial DB at the new path left behind by a failed migration (vs. a genuinely-already-migrated one) and retry, or at minimum surface a persistent, unmissable warning rather than booting silently.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix — this is high severity given it can cause perceived data loss for a real operator upgrading from a pre-cross-platform-persistence install.
- **Status:** OPEN — newly discovered by independent review, not yet independently re-verified beyond the cited file/line, not yet fixed.

## RISK-26 — `WRITABLE_SNIPPET_FIELDS` whitelist completeness against the live YouTube API is unverified — OPEN, 2026-09-19

- **Affected components:** `src/lib/youtube.ts` (`WRITABLE_SNIPPET_FIELDS`, `removeReadOnlySnippetFields` — see RISK-11, which this risk is the inverse of).
- **Current behavior:** RISK-11 closed by moving from a blacklist (delete only `.localized`) to an explicit whitelist of 6 fields. This is safe only if that list is a complete, currently-accurate enumeration of every snippet field YouTube's `videos.update` actually treats as writable — the new test suite only asserts the 6 listed fields survive, not that the list is exhaustive against the live API.
- **Actual risk:** Per this file's own documented semantics, a `videos.update` PUT overwrites all mutable snippet properties — omitting a writable field deletes it, it does not preserve it. Any snippet field YouTube currently allows writing that is missing from the whitelist would be silently cleared on every real `videos.update` call — exactly the kind of silent metadata loss `AGENTS.md` §G's write-safety rules exist to prevent. **Not currently reachable**: RISK-09's live-write barrier means no real `videos.update` call can happen yet.
- **Required remediation:** Cross-check `WRITABLE_SNIPPET_FIELDS` against `developers.google.com/youtube/v3/docs/videos`'s current per-property mutability table before Gate B (live writes) is ever passed; add this as an explicit Gate B pre-check.
- **Gate(s):** `BLOCKS_PHASE_5_WRITES` (specifically before Gate B, not before continued mocked development).
- **Approval required from:** project owner, as part of the Gate B live-validation planning.
- **Status:** OPEN — newly discovered by independent review, not yet independently re-verified beyond the cited file/line; not currently exploitable given RISK-09's barrier.

## RISK-27 — `importHandoff`'s pre-import backup file is never cleaned up on a failed import — OPEN, 2026-09-19

- **Affected components:** `src/lib/device-handoff/services.ts` (`importHandoff`, its `finally` block).
- **Current behavior:** The pre-import backup of the live DB (`copyDatabaseConsistently`) is taken before `migrateStagedCopy` verifies the staged copy's schema version. The `finally` block only removes `workingCopyPath` and its WAL/SHM sidecars — never the just-created backup file.
- **Actual risk:** Importing a snapshot from a newer, incompatible build throws `SchemaVersionError` after the backup is already written to `migrationBackupsDir`. Every retry of an incompatible import leaks one full extra DB-copy file with no bound — a disk-usage/cleanup gap, not a data-loss risk (the backup itself is harmless, just never removed).
- **Required remediation:** Remove the pre-import backup in the `finally` block too when the import did not proceed past the point that would need it, or document that these backups require periodic manual cleanup.
- **Gate(s):** none blocking (disk hygiene only).
- **Approval required from:** none required to leave open; project owner if a fix is scheduled.
- **Status:** OPEN — newly discovered by independent review, not yet independently re-verified beyond the cited file/line, not yet fixed.

---

## RISK-28 — Resuming a RUNNING batch skips the write-channel identity guardrail — OPEN, 2026-09-19

- **Affected components:** `src/lib/batches/services.ts` (`executeBatch`; `prepareBatchExecution`, which calls `deps.writeContext.assertWriteChannel`).
- **Current behavior:** `executeBatch` only calls `prepareBatchExecution` — the only call site of `assertWriteChannel` in this path — when `initialBatch.status === "PENDING"`. Resuming a batch already `RUNNING` (after a crash/restart, or a new process picking it up later) skips straight to `authResolver.resolve` and `processRow`, none of which re-check channel identity.
- **Actual risk:** If the local OAuth session is reauthenticated to a different YouTube channel while a batch sits `RUNNING`/pending-resume, writes on resume proceed against the wrong channel instead of failing closed — a direct violation of `AGENTS.md` §G's channel-identity requirement. **Not currently exploitable**: RISK-09's live-write barrier means no real write can happen through any path yet.
- **Required remediation:** Re-run (or otherwise re-check) `assertWriteChannel` on every resume, not only on initial `PENDING → RUNNING` transition.
- **Acceptance criteria:** A test resuming a `RUNNING` batch under a *different* active auth channel than the batch's `expectedChannelId`, asserting it fails closed.
- **Gate(s):** `BLOCKS_PHASE_5_WRITES` (before Gate B), `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix — the single most safety-relevant of this round's findings, given it is exactly the write-safety property `AGENTS.md` §G names first.
- **Status:** OPEN — found by a second independent review pass, not yet independently re-verified beyond the cited file/line; not currently exploitable given RISK-09's barrier.

## RISK-29 — Cross-device snapshot merge is positional, not column-name-aware, for tables with an `ALTER TABLE`-added column — OPEN, 2026-09-19

- **Affected components:** `src/lib/snapshot/services.ts` (`applySnapshotToDatabase`'s `DELETE FROM "t"; INSERT INTO "t" SELECT * FROM staged."t"` for `SNAPSHOT_REPLACE_ON_IMPORT_TABLES`); `src/lib/db.ts` (`batch_ledger_rows`' baseline `CREATE TABLE` declares `active_attempt_id` before `created_at`/`updated_at`, but a pre-existing DB got the same column via a later `ALTER TABLE ... ADD COLUMN`, which SQLite always appends at the physical end of the row).
- **Current behavior:** The merge is purely positional (`SELECT *`), not by column name.
- **Actual risk:** Two devices whose `batch_ledger_rows` table has a genuinely different physical column order (one built fresh from the current baseline, one upgraded via the `ALTER TABLE` path) exchanging a device-handoff or `published/` release snapshot get their columns positionally swapped on import — e.g. a value meant for `created_at` landing in `active_attempt_id` — silently corrupting the exact ledger table the crash-recovery safety mechanism (`scanForUnresolvedExecutionState`/`RecoveryModeError`) depends on.
- **Required remediation:** Merge by explicit column name list (`INSERT INTO "t" (col1, col2, ...) SELECT col1, col2, ... FROM staged."t"`), not `SELECT *`, for every table in `SNAPSHOT_REPLACE_ON_IMPORT_TABLES`.
- **Acceptance criteria:** A test simulating two DBs with the same table but different physical column orders (one via `ALTER TABLE`), asserting the merge preserves values by name.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix.
- **Status:** OPEN — found by a second independent review pass, not yet independently re-verified beyond the cited file/line, not yet fixed.

## RISK-30 — AI Localization's `generate` route is exempt from the device-availability/recovery-mode gate but can trigger a real, billable outbound AI call — OPEN, 2026-09-19

- **Affected components:** `src/proxy.ts` (`EXEMPT_READ_ONLY_PATH_SUFFIXES` includes `/ai-localization/generate`, on the stated rationale of "no local persistence writes, never calls YouTube"); `src/lib/ai-localization/services.ts` (`generateProposals` → `resolveConnectionProvider` → `openai_compatible` adapter's real outbound `POST`).
- **Current behavior:** `assertDeviceAvailableForMutation` (the operation-lock + recovery-mode check) is invoked only from `proxy.ts`, `mcp/server.ts`, and `cli/video-metadata.ts` — never from `resolveConnectionProvider`/`generateProposals` itself.
- **Actual risk:** The route's own exemption rationale ("never calls YouTube") is accurate but incomplete — it can still call a real external AI provider. During a device-handoff export/import (lock held) or post-crash recovery-mode window, a client can still trigger real external AI provider calls through this exempted endpoint, defeating the gate's intended "freeze external interactions" guarantee, and doing so during exactly the window when the local DB state is least trustworthy to record the result against.
- **Required remediation:** Either narrow the exemption to only the mock provider (no `connectionId`), or apply the device-availability gate to this route specifically when a real connection is used.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix.
- **Status:** OPEN — found by a second independent review pass, not yet independently re-verified beyond the cited file/line, not yet fixed.

## RISK-31 — `transitionLedgerRowStatus`'s discarded boolean result can let a batch's reported outcome silently drift from the ledger's actual persisted status — OPEN, 2026-09-19

- **Affected components:** `src/lib/batches/services.ts` (two call sites at the backup-health-check abort path and the systemic-halt branch of `processRow`, both calling the raw `batchStore.transitionLedgerRowStatus` directly instead of the service-layer `transitionLedgerStatus` wrapper used elsewhere, which checks the boolean and throws on failure).
- **Current behavior:** The raw store method's guarded `UPDATE` (matching on expected `from` status) can be a no-op if another concurrent worker already changed that row's status first — plausible given this file's own concurrency-limited worker pool (`batch.concurrency`, up to 5). Both call sites discard the returned boolean.
- **Actual risk:** The row's persisted status is left unchanged by the no-op, but the caller still records an `ABORTED_SYSTEMIC` outcome in the returned execution summary — the report drifts out of sync with what the ledger itself says, undermining the durable-audit-trail guarantee RISK-09's design relies on.
- **Required remediation:** Use the checked `transitionLedgerStatus` wrapper at both sites, or otherwise handle a `false` result explicitly.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the fix.
- **Status:** OPEN — found by a second independent review pass, not yet independently re-verified beyond the cited file/line, not yet fixed.

## RISK-32 — `proxy.ts`/CLI/MCP each independently classify "mutating" operations, with no shared registry, and have already diverged twice — OPEN, 2026-09-19

- **Affected components:** `src/proxy.ts` (HTTP method + path prefix/suffix sets), `src/cli/video-metadata.ts` (command-name sets), `src/mcp/server.ts` (manually wrapping ~11 named handler properties one at a time) — each maintaining its own independent list of what must be gated by `assertDeviceAvailableForMutation`.
- **Current behavior:** In-code comments in two of the three files already document that this exact divergence has caused real bugs, found and fixed twice by independent review.
- **Actual risk:** A future new mutating MCP tool, CLI command, or API route added to only one interface (e.g. an MCP handler left out of the manual wrap list) silently bypasses the device-availability/recovery-mode gate on that interface while the other two correctly enforce it — the same class of bug already found twice, still structurally possible a third time.
- **Required remediation:** A single shared registry/manifest of mutating operations that all three interfaces consult, rather than three independently-maintained classification lists.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the refactor (touches all three interface layers, `AGENTS.md` §D "one guardrail" pattern).
- **Status:** OPEN — found by a second independent review pass; the underlying divergence risk (not any specific instance of it) is new to this log, though its recurrence was already known well enough to be commented on in-code.

## RISK-33 — Minor latent/consistency gaps found alongside the above — PARTIALLY FIXED, 2026-09-19

Bundled as one entry — each individually low severity, none currently exploitable, none warranting its own full entry:

- `src/lib/snapshot/services.ts`: the `ai_connections` table's snapshot merge and SQLite's `PRAGMA foreign_keys` are never actually enabled anywhere in this codebase, so a dormant FK-enforcement gap would only matter if foreign keys are ever turned on. **Still OPEN** — not part of this round's fixes.
- `src/lib/device-handoff/services.ts` (~lines 48, 191): raw SQL inserts bypass the shared `src/lib/audit/services.ts` event-log abstraction used elsewhere, so device-handoff's own audit trail is written through a different path than the rest of the application's. **Still OPEN** — not part of this round's fixes.
- `src/lib/db.ts` (~line 676, and its two sibling `ALTER TABLE` migrations for `users`): the bare `try/catch` swallowed all errors unconditionally, not narrowed to "column already exists" — the same failing-open pattern as RISK-19, in a different function. **FIXED** — all three sites now check a local `isDuplicateColumnError` (message-matches `/duplicate column name/i`, empirically confirmed against this codebase's actual `@libsql/client` version) and rethrow anything else. Kept local to `db.ts` rather than added to the shared `isMissingTableError` module — it is a different error class (a `CREATE`/`ALTER` conflict, not a missing table) with exactly one caller site's worth of use, so a shared abstraction would be premature (`AGENTS.md` §D's "avoid parallel implementations" concern doesn't apply to genuinely different error classes). No dedicated test added — `initializeDatabaseSchema` already runs this exact idempotent-migration path on every test-runner boot via `src/lib/db.ts`'s own module-load side effects, so the "column already exists" branch is implicitly exercised by the rest of the suite on every run; a non-duplicate-column failure would now surface as a boot failure across the whole suite instead of being swallowed.

- **Gate(s):** none blocking (latent/consistency only).
- **Approval required from:** none required to leave open; project owner if the two still-open items are scheduled.
- **Status:** PARTIALLY FIXED — the `db.ts` bare-catch item fixed as part of the project-owner-assigned "отработай найденные риски" task, 2026-09-19; the other two bundled items remain OPEN.

## RISK-34 — The two "recovery-gate" test suites never actually test recovery mode — OPEN, 2026-09-19

- **Affected components:** `src/cli/video-metadata.recovery-gate.test.ts`, `src/mcp/server.recovery-gate.test.ts`.
- **Current behavior:** `assertDeviceAvailableForMutation` checks the operation lock first and only falls through to `assertNotInRecoveryMode` when no lock is held. Both test files, despite their name, exclusively acquire/release the lock and assert on `operation_lock_held` — zero references to `RecoveryModeError` or an unresolved `APPLYING`/`UNKNOWN` ledger row in either file.
- **Actual risk:** A regression that broke recovery-mode enforcement specifically at the CLI/MCP choke points (an early return, a swallowed exception, a wrong import) would pass both suites while the actual production safety property (`AGENTS.md` §G: a device in recovery mode must refuse mutations) silently fails at these two interfaces — false confidence from a misleadingly-named test file.
- **Required remediation:** Add an actual recovery-mode scenario (an unresolved `APPLYING`/`UNKNOWN` ledger row, no lock held) to both suites, asserting `RecoveryModeError` at the CLI/MCP choke points specifically.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`.
- **Approval required from:** project owner, to schedule the test addition.
- **Status:** OPEN — found by a second independent review pass, not yet independently re-verified beyond the cited file/lines, not yet fixed.

---

## Summary table

| ID | Title | Gates | Status |
|---|---|---|---|
| RISK-01 | XLSX upload size enforcement is best-effort | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-02 | No per-user channel ownership | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-03 | Conflict detection bounded by last sync | BLOCKS_PHASE_5_WRITES, BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-04 | No CLI/MCP Change Set interfaces | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-05 | No real browser/OAuth verification | BLOCKS_OPERATIONS_RELEASE, BLOCKS_PHASE_5_WRITES | OPEN |
| RISK-06 | Dependency security advisories (0 critical; 20 triaged, 2 prod-path) | BLOCKS_OPERATIONS_RELEASE, BLOCKS_NETWORK_DEPLOYMENT | next/next-auth portion CLOSED; remainder OPEN, triaged |
| RISK-07 | Plaintext OAuth tokens | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-08 | Migration strategy will not scale indefinitely | DEFERRED | OPEN, monitored |
| RISK-09 | Phase 5 write-safety infrastructure absent | BLOCKS_PHASE_5_WRITES, BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-10 | Duplicated LedgerStatus/AttemptPhase/AttemptOutcome type definitions can silently drift | none blocking yet | CLOSED |
| RISK-11 | Read-only snippet field echo-back | none (resolved by whitelist design) | RESOLVED (both write paths) |
| RISK-12 | Legacy `applyMetadata`/CLI/MCP `dryRun` default | none (was BLOCKS_OPERATIONS_RELEASE) | CLOSED |
| RISK-13 | AC-QUOTA-01 wording clarification | none | RESOLVED |
| RISK-14 | AI Connections endpoint validation TOCTOU (DNS rebinding) | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-15 | AI Connections encryption key has no rotation/backup procedure | DEFERRED | OPEN |
| RISK-16 | Restricted recovery mode has no in-app resolution path (needs RISK-04) | DEFERRED, BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-17 | Cross-platform persistence validated on Windows only, not macOS | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-18 | Device-handoff import: unvalidated `snapshotId` path traversal | none (fixed) | FIXED |
| RISK-19 | `readSchemaVersion` fails open on any read error | none (fixed) | FIXED |
| RISK-20 | Boot-time schema migration never acquires the operation lock | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-21 | Operation-lock misattributes ownership when the lock table is missing | none (fixed) | FIXED |
| RISK-22 | `writeJsonFileAtomic` has no Windows EBUSY/EPERM retry | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-23 | `createActiveAuthStorage` parameter meaning changed with no type signal | none blocking yet (latent) | OPEN |
| RISK-24 | App-data directory no longer locked to 0700 for Web-UI-only installs | none (fixed) | FIXED |
| RISK-25 | Legacy DB migration is one-shot/unretryable, can silently orphan data | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-26 | `WRITABLE_SNIPPET_FIELDS` completeness vs. live API unverified | BLOCKS_PHASE_5_WRITES | OPEN, not currently exploitable |
| RISK-27 | `importHandoff` never cleans up pre-import backup on failure | none blocking (disk hygiene) | OPEN |
| RISK-28 | Resuming a RUNNING batch skips the write-channel identity guardrail | BLOCKS_PHASE_5_WRITES, BLOCKS_OPERATIONS_RELEASE | OPEN, not currently exploitable |
| RISK-29 | Cross-device snapshot merge is positional, breaks on ALTER-added columns | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-30 | AI Localization `generate` bypasses device-availability gate for real AI calls | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-31 | Discarded `transitionLedgerRowStatus` result can drift ledger vs. reported outcome | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-32 | proxy/CLI/MCP independently classify mutating ops, no shared registry | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-33 | Minor latent/consistency gaps (dormant FK, audit-path bypass, bare catch) | none blocking | PARTIALLY FIXED |
| RISK-34 | "recovery-gate" test suites never actually test recovery mode | BLOCKS_OPERATIONS_RELEASE | OPEN |

No risk in this register is marked RESOLVED as of Phase 4.5 — Phase 4.5 is a documentation/governance phase and made no functional remediation beyond RISK-01's `Content-Length` pre-check (already applied in Phase 4's acceptance review, and still only a partial mitigation, hence still OPEN here).
