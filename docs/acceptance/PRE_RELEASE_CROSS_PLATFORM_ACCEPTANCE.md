# PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md

**Status: APPROVED for the scope below** (project owner's "Pre-Release — Cross-Platform Persistence &
Syncthing Handoff" assignment, Variant A, with three follow-up corrections resolved before
implementation — see `docs/decisions/0002-additive-schema-versioning.md` and the design decisions
recorded in this task's plan). Written once, before implementation, per `AGENTS.md` §L — a first-round
acceptance contract, not the product of multiple review rounds like `PHASE_5_ACCEPTANCE.md`.

Derived strictly from: the assignment message itself (Variant A, one active device at a time,
device-local SQLite, Syncthing as external transport only, immutable snapshots/manifests, no
simultaneous multi-device editing, no synced WAL/secrets/locks, no automatic database merging); the
three follow-up corrections (identity/FK safety, cross-process mutation enforcement, schema-version
check ordering, all resolved in the plan referenced above); `AGENTS.md` §F/§G (credential handling,
write-safety); `docs/TECHNICAL_DEBT.md` RISK-02/RISK-07/RISK-08/RISK-09/RISK-15 (pre-existing,
unchanged by this work unless stated otherwise).

---

## 1. Scope boundary

**In scope:** platform-aware app-data directory resolution (Windows/macOS); a device-local bootstrap
config; additive schema versioning layered on the existing `initializeDatabaseSchema()`; a
scrub-then-checksum snapshot export/import pipeline; a local instance/operation lock enforced at real
choke points; an explicit device-handoff workflow (export/import) with a restricted read-only recovery
mode for unresolved execution state; release-layout documentation.

**Out of scope (not implemented, not claimed as implemented):** Phase 7 (any kind); simultaneous
multi-device editing; application-managed sync (Syncthing replacement); automated database merging;
an installer/auto-updater; OS-keychain credential storage; closing RISK-07/RISK-02/RISK-08/RISK-15
(cross-referenced, not resolved); any change to Phase 5's write-safety pipeline, barrier, or recovery
algorithm; real YouTube writes; real paid AI calls; macOS *runtime* validation (path-resolution logic
is unit-tested for both platforms via injection; this development machine is Windows-only, so only
Windows is runtime-validated — stated explicitly, never implied otherwise).

## 2. Traceability

| Requirement | Scenario(s) |
|---|---|
| §3A platform-aware storage, bootstrap config, safe migration from `data/` | AC-PATH-01..06 |
| §3B schema versioning, skipped versions, reject-newer, backup-before-migrate | AC-SCHEMA-01..08 |
| §3C portable connections vs. device-local credentials, no plaintext | AC-CONN-01..05 |
| §3D snapshot format, staging/completion marker, checksums, no timestamp-only authority | AC-SNAP-01..08 |
| §3E explicit handoff, quiescence, divergence detection, no auto-resume | AC-HANDOFF-01..09 |
| Identity/FK correction | AC-IDENTITY-01..04 |
| Cross-process mutation-protection correction | AC-LOCK-01..04 |
| Schema-version-before-mutation correction | AC-SCHEMA-05..08 (see above) |
| §4 AI Connections/editorial data survive handoff unmodified | AC-SURVIVE-01..02 |
| §6 no external mutations on startup/import | AC-SAFETY-01..02 |

## 3. Safety invariants restated (must hold for every scenario below)

- **INV-CP.1** No snapshot, in any form (file on disk, in-transit, or staged), ever contains
  `users.accessToken`/`refreshToken`/`tokenExpiry` or any row of `ai_connection_credentials`.
- **INV-CP.2** Import never inserts, updates, or deletes a `users` row, under any circumstance.
- **INV-CP.3** Import never modifies a `batch_ledger_rows`/`batch_attempts` row's execution status
  (`UNKNOWN`/`INTENDED`/`APPLYING`/any other unresolved value) — these values are read-only to every
  module this task adds.
- **INV-CP.4** No code this task adds references `executeBatch`/`executeWithRetry`/`recoverBatch`/
  `resolveUnknownLedgerRow`/`WriteExecutor`/`createYoutubeWriteExecutor`/
  `createScriptedFakeWriteExecutor`/`performYoutubeWrite`, anywhere, including comments (verified by
  an inventory test mirroring `src/lib/batches/write-path-inventory.test.ts`).
- **INV-CP.5** A schema-version-reject outcome leaves the database file byte-for-byte unchanged (no
  `CREATE`/`ALTER`/`INSERT` of any kind executes before the version check passes).
- **INV-CP.6** A failed migration step never advances `schema_meta.schema_version` past the last
  step that actually completed.
- **INV-CP.7** No automated test ever touches `data/playlist-manager.db` or the operator's real
  app-data directory — every test uses an isolated temporary path.
- **INV-CP.8** No test performs a real YouTube write or a real paid AI call.

---

## 4. Acceptance scenarios

### AC-PATH-01 — Windows path resolution
**Input:** `resolveAppPaths({ platform: "win32", env: { APPDATA: "C:\\Users\\op\\AppData\\Roaming" }, homedir: "C:\\Users\\op" })`.
**Expected:** `appDataDir === "C:\\Users\\op\\AppData\\Roaming\\YouTubeOperationsManager"`, and
`dbPath`/`backupsDir`/`snapshotsDir`/`bootstrapConfigPath` all nested under it.
**Verification:** Automated, pure function, no filesystem I/O.

### AC-PATH-02 — macOS path resolution
**Input:** `resolveAppPaths({ platform: "darwin", env: {}, homedir: "/Users/op" })`.
**Expected:** `appDataDir === "/Users/op/Library/Application Support/YouTubeOperationsManager"`.
**Verification:** Automated (injection-only; not runtime-validated on real macOS — documented).

### AC-PATH-03 — Missing `APPDATA` on Windows falls back safely
**Input:** `platform: "win32"`, `env` without `APPDATA`, valid `homedir`.
**Expected:** Falls back to `<homedir>\AppData\Roaming\YouTubeOperationsManager` (the standard
Windows default), never throws, never resolves to a relative/`cwd`-based path.
**Verification:** Automated.

### AC-PATH-04 — First run with no existing data anywhere creates a fresh, empty, correctly-versioned database at the resolved location
**Preconditions:** Empty temp dir standing in for `appDataDir`, no `data/playlist-manager.db` at the
simulated old location.
**Expected:** Boot succeeds; `schema_meta.schema_version` equals the current baseline version; no
migration-from-old-location prompt appears.
**Verification:** Automated, isolated temp dirs.

### AC-PATH-05 — Migration from the legacy `data/` location is explicit, additive, and non-destructive
**Preconditions:** A populated legacy DB exists at the simulated old `data/playlist-manager.db`
location; no DB exists yet at the new app-data location.
**Expected:** The app offers/performs a one-time copy into the new location; the legacy file is left
completely untouched (byte-for-byte, verified by checksum) afterward — never moved, renamed, or
deleted.
**Verification:** Automated. **Prohibited side effect:** legacy file mutated or removed.

### AC-PATH-06 — An existing populated database at the new location is never overwritten by an empty one
**Preconditions:** New-location DB already has data; legacy `data/` DB also exists (with different
data).
**Expected:** Boot never triggers the migration-from-old-location flow when a DB already exists at
the new location, regardless of legacy file presence/content.
**Verification:** Automated.

### AC-SCHEMA-01 — Fresh database is stamped at the current baseline version
**Expected:** `schema_meta.schema_version === CURRENT_BASELINE_VERSION` after first boot against an
empty file.
**Verification:** Automated, temp file.

### AC-SCHEMA-02 — Existing pre-versioning database is stamped with the baseline version, not re-migrated
**Preconditions:** A temp DB built with exactly the pre-this-task table shapes (no `schema_meta`
table).
**Expected:** Boot succeeds, creates `schema_meta`, stamps it at the baseline version equal to that
existing shape; no data in any existing table is altered.
**Verification:** Automated; diff every pre-existing row before/after, assert identical.

### AC-SCHEMA-03 — Skipped versions apply in order
**Preconditions:** A temp DB stamped at baseline version `N`; two migrations registered for `N+1` and
`N+2`.
**Expected:** Boot applies `N+1` then `N+2` in order, ends stamped at `N+2`, both migrations' schema
changes present.
**Verification:** Automated.

### AC-SCHEMA-04 — A database reporting a version newer than this build supports is rejected before any mutation (INV-CP.5)
**Preconditions:** A temp DB with `schema_meta.schema_version` set to `CURRENT_BASELINE_VERSION + 1000`
(simulated future version).
**Expected:** Boot throws a typed `DomainError` (e.g. `schema_version_unsupported`) with an actionable
message; **zero** `CREATE`/`ALTER`/`INSERT` statements execute — verified by snapshotting
`sqlite_master` and every table's row count/content before the attempt and asserting byte-for-byte
identity after the rejected attempt (not merely "it threw").
**Verification:** Automated.

### AC-SCHEMA-05 — A migration step that fails partway through does not advance `schema_meta.schema_version` (INV-CP.6)
**Preconditions:** A temp DB stamped at version `N`; a migration for `N+1` deliberately made to throw
after its first statement succeeds but before its second does.
**Expected:** `schema_meta.schema_version` remains `N` after the failed attempt; the first statement's
effect may or may not be visible (idempotent-safe either way, since it's a `CREATE TABLE IF NOT
EXISTS`-shaped statement), but the version is never bumped to `N+1`.
**Verification:** Automated.

### AC-SCHEMA-06 — A retried boot after a failed migration step succeeds and reaches the correct final version
**Preconditions:** Continuation of AC-SCHEMA-05, migration no longer forced to fail.
**Expected:** Next boot attempt against the same file completes the `N+1` migration (idempotent
re-run) and stamps version `N+1` correctly.
**Verification:** Automated.

### AC-SCHEMA-07 — Interrupted migration simulation (process-restart style)
**Preconditions:** A migration's statements applied via one client, process "restarts" (fresh client
against the same file) before the version stamp is written.
**Expected:** The reopened client detects the un-stamped state and either (a) safely re-applies the
idempotent migration and stamps it, or (b) the stamp write itself is the observable commit point —
either way, no double-application side effect and no data loss.
**Verification:** Automated, two sequential real `@libsql/client` connections against one temp file.

### AC-SCHEMA-08 — Pre-migration backup exists before any migration beyond the baseline runs
**Preconditions:** A temp DB stamped below the current version, at least one pending migration.
**Expected:** A backup file exists under `<appDataDir>/backups/pre-migration-<ts>/` capturing the
pre-migration state, created before the migration's own statements execute.
**Verification:** Automated (inspect backup file's captured `schema_meta` value equals the
pre-migration version).

### AC-CONN-01 — A snapshot never contains any `ai_connection_credentials` row (INV-CP.1)
**Preconditions:** A source DB with at least one `ai_connections` row carrying a stored credential.
**Expected:** The published snapshot's `data.db`, opened directly, has zero rows in
`ai_connection_credentials`.
**Verification:** Automated — a dedicated scanning test, named per the plan's decision 2.

### AC-CONN-02 — A snapshot never contains `users.accessToken`/`refreshToken`/`tokenExpiry`, or any `users` row at all (INV-CP.1/CP.2)
**Preconditions:** Source DB with a populated `users` row including real-looking token values.
**Expected:** The snapshot's `data.db` has zero rows in `users`.
**Verification:** Automated, byte-scan the snapshot file for the exact token fixture values as an
additional adversarial check (not just row-count).

### AC-CONN-03 — `ai_connections` metadata travels; local credentials on the receiving device survive import untouched
**Preconditions:** Receiving device already has connection `conn-1` with a locally stored credential;
snapshot has an updated `conn-1` (different `displayName`) and a new `conn-2` with no local
credential info (excluded per AC-CONN-01).
**Expected:** After import, `conn-1`'s `displayName` reflects the snapshot's value, its
`hasCredential` stays `true`, and the underlying `ai_connection_credentials` row is byte-identical to
before import (never read or written by the import step). `conn-2` exists with `hasCredential: false`.
**Verification:** Automated.

### AC-CONN-04 — Bidirectional handoff preserves both devices' independently configured credentials
**Preconditions:** Device A has connection `a-1` with credential `secretA`; Device B has connection
`b-1` with credential `secretB`.
**Expected:** A→B import: B ends with both `a-1` (no credential, `hasCredential: false`) and `b-1`
(credential `secretB`, untouched). B→A import (of the post-import B state): A ends with `a-1` (its
own original credential `secretA`, untouched) and `b-1` (no credential).
**Verification:** Automated, full round trip against two isolated temp DBs.

### AC-CONN-05 — OAuth session on the receiving device is never disturbed by import
**Preconditions:** Receiving device has an active `users` row (its own real OAuth tokens, fixture
values).
**Expected:** Before/after import, that `users` row is byte-identical.
**Verification:** Automated.

### AC-SNAP-01 — A published snapshot always has a `complete: true` marker written last
**Expected:** Export writes every data file first, the manifest (with `complete: true`) last, and only
then atomically renames the staging directory into its final, discoverable name.
**Verification:** Automated — simulate a crash between "all files written" and "rename" by stopping
before the rename call; assert no snapshot is visible under its final id at that point.

### AC-SNAP-02 — Checksums cover the scrubbed file, not a pre-scrub copy
**Expected:** The manifest's checksum for `data.db` matches a checksum computed by the test
independently over the actual published (post-scrub) file — proving the checksum was computed after
scrubbing, not before.
**Verification:** Automated.

### AC-SNAP-03 — Import rejects a snapshot with an incomplete marker
**Preconditions:** A snapshot directory missing `complete: true` (simulated partial transfer).
**Expected:** Import refuses with a typed, actionable error; nothing is applied to the live DB.
**Verification:** Automated.

### AC-SNAP-04 — Import rejects a snapshot with a checksum mismatch
**Preconditions:** A complete-looking snapshot whose `data.db` bytes were altered after publish
(simulated corruption/tampering).
**Expected:** Import refuses with a specific checksum-mismatch diagnostic; nothing is applied.
**Verification:** Automated.

### AC-SNAP-05 — Import rejects a snapshot with a missing referenced file
**Preconditions:** Manifest references `data.db` but the file is absent.
**Expected:** Import refuses with a missing-file diagnostic; nothing is applied.
**Verification:** Automated.

### AC-SNAP-06 — Divergent lineage is detected and blocked, never resolved by timestamp
**Preconditions:** Local DB's last-known snapshot id is `S1`; incoming snapshot's `parentSnapshotId`
is neither `S1` nor a recognized ancestor of it (a genuine fork — e.g. two devices each exported
independently from the same ancestor without importing each other's work first).
**Expected:** Import refuses with a divergence diagnostic naming both snapshot ids and generations;
the local DB is untouched; **no code path picks a winner by comparing `createdAt` timestamps.**
**Verification:** Automated — a fixture with a newer-`createdAt`-but-diverged snapshot is not silently
imported.

### AC-SNAP-07 — Duplicate import of an already-applied snapshot is a safe no-op
**Preconditions:** Snapshot `S2` (child of local `S1`) already imported once.
**Expected:** Re-importing `S2` again is detected (matches the local DB's current lineage exactly) and
either refused as a no-op with a clear message, or safely re-applies identically — but never
duplicates rows or corrupts state either way.
**Verification:** Automated, assert row counts/content identical after the second import attempt.

### AC-SNAP-08 — The only valid snapshot is never overwritten
**Preconditions:** A single published snapshot exists; an export attempt is made with a colliding id
(simulated).
**Expected:** Export never overwrites an existing published (`complete: true`) snapshot directory —
a new snapshot always gets a new id/path.
**Verification:** Automated.

### AC-HANDOFF-01 — Export quiesces before producing the snapshot
**Expected:** Once export begins, a concurrent attempt to reach a mutating API/CLI/MCP entry point
(per AC-LOCK-01..03) is rejected until export completes or fails.
**Verification:** Automated, per AC-LOCK tests.

### AC-HANDOFF-02 — Export never claims to prove remote process termination
**Verification:** Documentation/UI copy review — the export completion message and
`docs/RELEASE_LAYOUT.md`/setup docs state "recorded as finished on this device," never "the other
device is stopped/safe." Checked as part of doc review, not an automated test.

### AC-HANDOFF-03 — Import with no unresolved execution state activates normal mutation capability
**Preconditions:** Snapshot's batch/ledger data contains no `UNKNOWN`/in-flight rows.
**Expected:** After successful import, all mutation-capable routes/commands/tools function normally
(no recovery-mode gate engaged).
**Verification:** Automated.

### AC-HANDOFF-04 — Import with unresolved `UNKNOWN`/in-flight rows leaves the device in restricted read-only recovery mode (INV-CP.3)
**Preconditions:** Snapshot's batch/ledger data contains at least one `UNKNOWN` row.
**Expected:** Import succeeds (data preserved), but every mutation-capable API route, CLI command, and
MCP tool classified as local-mutation or remote-mutation is refused with a typed
`device_in_recovery_mode`-style error; read-only routes/tools continue to work; diagnostics name the
affected batch/ledger-row/video ids and last known phase/outcome.
**Verification:** Automated — attempt at least one route from each interface, assert refusal; attempt
a read-only route, assert success.

### AC-HANDOFF-05 — Operator acknowledgement alone never lifts recovery mode or changes any row's status (the tightened correction)
**Preconditions:** Continuation of AC-HANDOFF-04; operator calls the acknowledgement action.
**Expected:** The `UNKNOWN` row(s) are byte-identical before/after acknowledgement; the recovery-mode
gate is still engaged immediately after acknowledgement (a mutating route is still refused); an
immutable `recovery_acknowledgement` record is appended.
**Verification:** Automated. **This is the single most safety-critical scenario in this document** —
mutation testing (per `AGENTS.md` §L step 7) is required: verify that a deliberately-wrong
implementation which lifts the gate on acknowledgement would fail this test.

### AC-HANDOFF-06 — Recovery mode lifts only when Phase 5's existing reconciliation independently resolves the rows
**Preconditions:** Continuation of AC-HANDOFF-04; the `UNKNOWN` row is externally resolved to a
terminal state (`SUCCESS`/`FAILED`) using Phase 5's own existing, unmodified test-level reconciliation
function directly (not through any code this task adds).
**Expected:** On the *next* boot/check, recovery mode is no longer engaged; mutating routes work
again.
**Verification:** Automated.

### AC-HANDOFF-07 — Full audit trail and durable intent records survive import unmodified
**Preconditions:** Source DB has `audit_events` and `batch_attempts` rows, including for the
unresolved batch.
**Expected:** After import, every such row is present and byte-identical (same count, same content) on
the receiving device.
**Verification:** Automated.

### AC-HANDOFF-08 — Temporary Syncthing unavailability is not an error condition
**Preconditions:** The configured Syncthing root path is temporarily missing/inaccessible.
**Expected:** The active device continues normal local operation (no snapshot-related error surfaces
outside the export/import workflow itself); only an explicit export/import action attempted during
that window fails with a clear "snapshots directory unavailable" message.
**Verification:** Automated (point `syncthingRootPath` at a nonexistent dir, assert normal operation
elsewhere).

### AC-HANDOFF-09 — Interrupted import is recoverable
**Preconditions:** Import simulated to fail after backup-of-current-state but before activation.
**Expected:** The pre-import local DB is intact/restorable from the backup taken in that step; no
partial/inconsistent live DB is left active.
**Verification:** Automated.

### AC-IDENTITY-01 — Import with no local session fails closed
**Preconditions:** Fresh device, no NextAuth session.
**Expected:** The import API route returns `401`, identical to every other protected route; nothing is
written.
**Verification:** Automated.

### AC-IDENTITY-02 — Import with a session matching the snapshot's `users.id`-referencing data
**Preconditions:** Imported `rules`/`channels.connectedUserId` reference a `sub` equal to the
receiving session's `session.user.id`.
**Expected:** That data is fully visible/usable through its normal (unmodified) query paths, exactly
as if created locally.
**Verification:** Automated.

### AC-IDENTITY-03 — Import with a session not matching the snapshot's referenced identity still succeeds, per RISK-02's existing model
**Preconditions:** Imported `rules`/`channels.connectedUserId` reference a `sub` different from the
receiving session's.
**Expected:** Import completes; `rules` rows referencing the mismatched id are simply invisible to
the current session's filtered query (not an error); `channels`/`videos` remain fully readable
(RISK-02 — no ownership boundary exists anywhere in this app, unchanged by this task).
**Verification:** Automated. Cross-referenced explicitly against `docs/TECHNICAL_DEBT.md` RISK-02 in
this document's own text (§1 above) so this is never read as a new gap this task silently introduced.

### AC-IDENTITY-04 — `users.id` stability proof
**Expected:** A dedicated test/documentation check confirms `src/lib/auth.ts`'s session callback sets
`session.user.id = token.sub` and `db.ts`'s `upsertUserOAuthOnSignIn` keys the `users` row by exactly
that same value — the basis for AC-IDENTITY-01..03's reasoning.
**Verification:** Code inspection recorded here + an existing/adapted unit test asserting the id
plumbing, not a new runtime behavior.

### AC-LOCK-01 — A concurrent Web mutation is rejected during export/import/migration
**Preconditions:** The instance/operation lock is held (export/import/migration in progress);
a second request hits a mutating `/api/**` route.
**Expected:** `src/middleware.ts` rejects it before the route handler runs, with a clear
"operation in progress" error.
**Verification:** Automated, two concurrent requests against one Next.js test harness/DB.

### AC-LOCK-02 — A concurrent CLI mutation is rejected during export/import/migration
**Preconditions:** Same as above; a CLI command classified as mutating is invoked via
`runCliCommand`.
**Expected:** Rejected before the command's domain logic runs.
**Verification:** Automated.

### AC-LOCK-03 — A concurrent MCP mutation is rejected during export/import/migration
**Preconditions:** Same as above; an MCP tool classified as local- or remote-mutation is invoked.
**Expected:** Rejected before the tool's handler runs.
**Verification:** Automated.

### AC-LOCK-04 — The database-level guarantee holds even if an interface check is bypassed
**Preconditions:** The three interface choke-point checks are stubbed out/bypassed in the test;
a second real connection attempts to write to the live DB while the snapshot-copy step's exclusive
transaction is open.
**Expected:** The second connection's write blocks or fails (`SQLITE_BUSY`/equivalent) — the copy
step never observes a partial/torn write, proven independent of app-level cooperation.
**Verification:** Automated, two real `@libsql/client` connections against one temp file.

### AC-SURVIVE-01 — Change Sets, Batches, and audit history survive a full export/import round trip
**Preconditions:** Source DB has representative rows in `change_sets`/`changes`/`batches`/
`batch_ledger_rows`/`batch_attempts`/`audit_events`.
**Expected:** All present, byte-identical, after import on a fresh receiving device.
**Verification:** Automated.

### AC-SURVIVE-02 — Channel Editorial Profiles and AI Localization provenance survive a round trip
**Preconditions:** Source DB has `channel_editorial_profiles`/`ai_localization_generation_provenance`
rows.
**Expected:** Present, byte-identical, after import.
**Verification:** Automated.

### AC-SAFETY-01 — No external mutation occurs on ordinary startup
**Expected:** Booting the app (schema check/migration included) against a valid, current-version DB
performs zero YouTube API calls and zero AI provider calls — structurally, not just "didn't happen
this run" (mirrors the existing `write-path-inventory.test.ts` pattern).
**Verification:** Automated inventory-style test over the new modules.

### AC-SAFETY-02 — No external mutation occurs during import
**Expected:** The full import procedure (verify → backup → stage → merge → gate check → activate)
performs zero YouTube API calls and zero AI provider calls.
**Verification:** Automated, same inventory pattern; also covered structurally by INV-CP.4.

---

## 5. Adversarial review checklist (to run before this task is reported complete)

- Could a version of the gate check that reads `handoff_log`'s acknowledgement flag instead of the
  actual row statuses still pass AC-HANDOFF-05? (It must not — the test must assert the row status
  directly, not just the gate's boolean output.)
- Could a version of the snapshot scrub that filters by column name string-matching (fragile) instead
  of an explicit, reviewed table/column allowlist still pass AC-CONN-01/02? (Prefer an explicit
  allowlist so a future new secret-bearing column doesn't silently leak by being unmatched by a
  loose filter.)
- Could a version of the schema-version check that runs the baseline `CREATE TABLE IF NOT EXISTS`
  block *before* reading `schema_meta` still pass AC-SCHEMA-04? (It must not — order matters, and the
  test must prove zero mutation, not just a thrown error.)
- Could a version of the instance lock that only checks in `src/middleware.ts` (Web only) still pass
  AC-LOCK-02/03? (It must not — CLI and MCP paths are tested independently.)
