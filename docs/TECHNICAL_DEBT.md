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
- **Status:** OPEN.

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
- **Status:** OPEN — by design, not a defect; must be closed before Gate B.

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

- **Affected components:** `next`, `next-auth`, and transitive dependencies (see table).
- **Current behavior (fresh `npm audit`, run during Phase 4.5, see final report for exact command output):**

  | Severity | Count |
  |---|---|
  | Critical | 2 |
  | High | 10 |
  | Moderate | 11 |
  | Low | 2 |
  | **Total** | **25** |

  Critical findings:

  | Package | Installed | Issue | Fixed version | Bump type |
  |---|---|---|---|---|
  | `next` | 16.2.2 | DoS via Server Components; middleware/proxy segment-prefetch bypass | `16.3.5` | non-major |
  | `next-auth` | 4.24.13 | Email-normalizer homoglyph `@` bypass (critical); `getToken()` uncaught exception on malformed Bearer header (high); OAuth state/nonce/PKCE cookies not bound to originating provider (moderate) | `4.24.15` | non-major |

  High findings (10 total): `postcss`, `sharp` (both fixed transitively by the `next` bump above), plus `brace-expansion`, `browserslist`, `fast-uri`, `hono`, `ip-address`, `js-yaml`, `nanoid`, `ws` (transitive dev/build tooling — `drizzle-kit`, `eslint-config-next`, `tsx` dependency chains).

  This is consistent with the historical baseline recorded in `docs/UPSTREAM_BASELINE.md` §6a (24 findings, 2 critical/10 high/10 moderate/2 low) — one additional moderate finding appeared since, from newly-added `exceljs`'s transitive `uuid` dependency (Phase 3). **Note:** `npm audit`'s suggested fix for `exceljs`'s and `drizzle-kit`'s moderate findings is a **major downgrade** (`exceljs@3.4.0`, `drizzle-kit@0.18.1`) — this is `npm audit`'s automatic-fix heuristic picking the nearest version with no known advisory, not a real upgrade path, and must not be applied blindly.

- **Actual risk:** `next`/`next-auth` are both directly reachable at runtime (the live web server and the entire OAuth flow this project's channel-identity guardrails depend on). The transitive high/moderate findings are in dev-only tooling (`drizzle-kit`, `eslint-config-next`, `tsx`) or build-time paths, not reachable from a running deployed instance.
- **Existing mitigation:** None applied — deliberately, per this phase's constraint against dependency upgrades without approval.
- **Required remediation:** Apply the `next@16.3.5` and `next-auth@4.24.15` patches (both non-major semver bumps) as a small, isolated task, re-run `npm test`/`npm run lint`/`npm run build` afterward to confirm no regression. This was already recommended as a "should not be deferred indefinitely" item after the Phase 0/1 baseline and is still open.
- **Acceptance criteria:** `npm audit` reports 0 critical findings for `next`/`next-auth`; full test/lint/build suite still passes after the bump.
- **Gate(s):** `BLOCKS_OPERATIONS_RELEASE`, `BLOCKS_NETWORK_DEPLOYMENT`. Not `BLOCKS_PHASE_5_WRITES` outright (Phase 5 code can be developed locally before this patch lands) but should not be deferred past it.
- **Approval required from:** project owner (dependency upgrade approval, even though non-major).
- **Status:** OPEN — recommended as the first small task of (or immediately before) Phase 5, per the original Phase 0/1 recommendation.

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
- **Status:** OPEN — accepted tradeoff for now, not silently forgotten.

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
- **Status:** OPEN, monitored — not currently actionable.

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
- **Status:** OPEN — this is the primary scope of Phase 5 itself, not a Phase 4.5 deliverable.

---

## Summary table

| ID | Title | Gates | Status |
|---|---|---|---|
| RISK-01 | XLSX upload size enforcement is best-effort | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-02 | No per-user channel ownership | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-03 | Conflict detection bounded by last sync | BLOCKS_PHASE_5_WRITES, BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-04 | No CLI/MCP Change Set interfaces | BLOCKS_OPERATIONS_RELEASE | OPEN |
| RISK-05 | No real browser/OAuth verification | BLOCKS_OPERATIONS_RELEASE, BLOCKS_PHASE_5_WRITES | OPEN |
| RISK-06 | Dependency security advisories (2 critical) | BLOCKS_OPERATIONS_RELEASE, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-07 | Plaintext OAuth tokens | DEFERRED, BLOCKS_NETWORK_DEPLOYMENT | OPEN |
| RISK-08 | Migration strategy will not scale indefinitely | DEFERRED | OPEN, monitored |
| RISK-09 | Phase 5 write-safety infrastructure absent | BLOCKS_PHASE_5_WRITES, BLOCKS_OPERATIONS_RELEASE | OPEN |

No risk in this register is marked RESOLVED as of Phase 4.5 — Phase 4.5 is a documentation/governance phase and made no functional remediation beyond RISK-01's `Content-Length` pre-check (already applied in Phase 4's acceptance review, and still only a partial mitigation, hence still OPEN here).
