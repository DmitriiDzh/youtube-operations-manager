> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 13. Pre-Release: Cross-Platform Persistence & Device Handoff (Variant A)

**Not a numbered product phase** — an explicit, separately-assigned pre-release task ("Pre-Release
— Cross-Platform Persistence & Syncthing Handoff"), distinct from and not authorizing Phase 7.
Full acceptance contract: `docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md`. Architectural
decision: `docs/decisions/0002-additive-schema-versioning.md`.

### 13.1 Purpose and scope

Makes the application safe to run alternately on Windows and macOS, with Syncthing as an
external file-transport only (never a database), under a strict single-active-device model
(Variant A — no simultaneous multi-device editing, no automatic database merging). Since
2026-10-01 the handoff itself is scheduled automatically (§23, ADR 0012), but it is still one writer
at a time and Syncthing is still the only transport. Four new leaf/near-leaf modules plus one small domain-adjacent module:

```text
src/lib/platform-paths/    — pure resolveAppPaths(platform, env, homedir); zero I/O
src/lib/bootstrap-config/  — device-local bootstrap-config.json (deviceId, syncthingRootPath)
src/lib/schema-versioning/ — schema_meta + reject-newer-before-mutation + ordered migrations
src/lib/db-backup/         — copyDatabaseConsistently() over VACUUM INTO (shared utility)
src/lib/operation-lock/    — app_operation_locks: real SQLite-level device-local exclusivity
src/lib/snapshot/          — scrub-then-checksum export/import pipeline, explicit table allowlist
src/lib/device-handoff/    — orchestration: exportHandoff/importHandoff/recovery-mode gate
```

`src/lib/db.ts` itself changed in three ways: its client now opens at
`getProductionAppPaths().dbPath` instead of `<cwd>/data/playlist-manager.db`; a one-time,
non-destructive migration copies a legacy database into the new location on first boot only;
`initializeDatabaseSchema` gained the version-check-first ordering described in §13.2.

### 13.2 Schema versioning ordering (docs/decisions/0002-*.md)

```text
initializeDatabaseSchema(client):
  1. PRAGMA busy_timeout / journal_mode = WAL           (non-schema-mutating)
  2. assertSupportedSchemaVersion(client, CURRENT)      (read-only; throws before any mutation
                                                          if the DB reports a newer version)
  3. existing additive baseline block, unchanged         (schema version 1, retroactively)
  4. runSchemaMigrations(...)                            (ordered, each stamps schema_meta only
                                                          on its own success)
```

A database reporting a version newer than `SCHEMA_CURRENT_VERSION` is rejected before step 3
ever runs — proven, not merely asserted, by a test that snapshots `sqlite_master` before and
after a rejected attempt and asserts byte-for-byte identity (`src/lib/db.test.ts`,
`src/lib/schema-versioning/services.test.ts`).

### 13.3 Snapshot format and the transfer allowlist

A published snapshot is a directory (`<snapshotId>/manifest.json` + `data.db` + implicit
per-file checksum inside the manifest) written first to a `.staging-<uuid>` directory and only
made visible under its final name via an atomic rename, after `manifest.json`'s `complete: true`
is the last thing written. `data.db` is produced by `VACUUM INTO` (a transactionally-consistent
snapshot, sidestepping the WAL/SHM-file problem entirely) and then scrubbed via an **explicit
transfer allowlist** (`SNAPSHOT_TRANSFERRED_TABLES`, `src/lib/snapshot/contracts.ts`) — any table
not on that list is dropped and the file `VACUUM`d again, fail-safe by construction: a future new
table is excluded by default unless a reviewer deliberately adds it to the allowlist. `users` and
`ai_connection_credentials` are never on it.

### 13.4 Import: per-table merge, not a whole-file swap

Import never replaces the live database file. It ATTACHes a migrated, verified, private working
copy of the snapshot's `data.db` to the live connection and, in one transaction, fully replaces
every table on `SNAPSHOT_REPLACE_ON_IMPORT_TABLES` — as of M6 (2026-09-23,
`docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`), the four Category D
write-pipeline tables (`batches`, `batch_ledger_rows`, `batch_attempts`, `audit_events`), **plus, as
of Phase 9 slice 9H part A (2026-09-27), all 12 Phase 9 market-intelligence tables** (`research_
channels`, `research_evidence`, `market_channel_snapshots`, `market_video_snapshots`, `market_
intelligence_collection_runs`, `market_discovery_candidates`, `market_discovery_runs`, `market_
topics`, `market_topic_assignments`, `market_trend_candidates`, `market_trend_evidence`, `market_
research_requests`) — closing RISK-52's market-intelligence portion per the owner's own 2026-09-26
decision (`docs/roadmap/plans/PHASE_9_PLAN.md` §12 point 5), which had been recorded as resolved
but never actually implemented until this fix. `SNAPSHOT_TRANSFERRED_TABLES` (the snapshot *file's*
own contents, §13.3) additionally includes
`schema_meta` — never touched by this replace loop, only read by `migrateStagedCopy` to migrate
the *staged* copy before merging. Everything this mechanism used to also carry, beyond today's
four, has since moved away by one of three routes: `channels`/`videos` to an independent
per-device resync from the real YouTube API (§2 Category A of the migration plan — there is no
local-only write path for either, so nothing to transfer); `rules` dropped outright, not resynced
anywhere, since its own feature (UI/API/Drizzle definition) was already removed 2026-09-20 and
there is nothing left to carry; and `change_sets`/`changes`/`channel_editorial_profiles`/
`ai_localization_generation_provenance`/`ai_connections` now propagate continuously via
`src/lib/sync-gateway/` instead — see §13.5 below. `ai_connections`'
own upsert-by-id special case (`INSERT OR REPLACE ... SELECT`, kept because `INSERT ... SELECT ...
ON CONFLICT DO UPDATE` was found unsupported by this `@libsql/client` build's SQLite) was removed
along with it; every remaining transferred table now goes through the same plain replace path.
`users` and `ai_connection_credentials` are never referenced by this code path at all — there is
no "exclude" branch to bypass, because no code path here can reach them structurally. `users.id`
was confirmed, by reading `src/lib/auth.ts`'s `session()` callback and `src/lib/db.ts`'s
`upsertUserOAuthOnSignIn`, to be the Google OAuth `sub` claim — a stable, provider-issued
identity, not a locally-generated artifact — which is why no identifier remapping is ever needed
for `channels.connectedUserId`/`rules.userId` across devices.

### 13.5 Why this mechanism still exists after `sync-gateway`: a narrow, explicit ownership handoff

Every table this mechanism used to carry that COULD move to `sync-gateway`'s continuous CRDT
propagation has (`docs/SYSTEM_MAP.md` §2.9h/§2.9m); this mechanism's remaining four tables physically cannot
(`docs/decisions/0009-defer-write-pipeline-sync-gateway-migration.md`: no CRDT equivalent for SQL
compare-and-set/UNIQUE-constraint concurrency guards or for `AUTOINCREMENT`-derived audit
ordering). Rather than deleting cross-device continuity for them outright, the owner chose (after
a web-research pass on 2026-09-23 confirming this shape is the industry-standard answer, not an
ad-hoc compromise — SQLite single-writer replication tools like LiteFS/Litestream use exactly this
"explicit, atomic primary handoff, never a live merge" pattern for primary failover, as do
distributed job schedulers for lease-based worker handoff) to keep this mechanism alive, scoped
down to exactly these four tables: an explicit, human-triggered, atomic whole-copy transfer of
write-pipeline ownership between devices, never a background/automatic sync.

### 13.6 Restricted recovery mode is computed, never cached

If the imported (migrated, merged) data contains any `batch_ledger_rows` row whose status is
`APPLYING` or `UNKNOWN` (a real YouTube write may have been sent with an uncertain outcome), the
device activates the import but every subsequent mutating action — local-state or
YouTube-write — is refused. This is implemented as a **live, uncached recomputation** on every
check (`isDeviceInRecoveryMode`/`assertDeviceAvailableForMutation`, re-querying
`batch_ledger_rows` each time), specifically so that no stored flag exists anywhere that an
operator action could accidentally or deliberately flip. The one operator action available
(`acknowledgeRecoveryDiagnostics`) writes only to a separate, append-only
`recovery_acknowledgements` table and never touches `batch_ledger_rows` — proven by a dedicated
test (`docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md` AC-HANDOFF-05) that asserts the
row is byte-identical before/after and the gate is still engaged immediately after. This task
builds no new recovery/reconciliation algorithm — the gate only lifts when Phase 5's existing,
unmodified mechanism (RISK-09 §0.F) resolves the underlying rows to a terminal state, which
currently has no in-app trigger (`docs/TECHNICAL_DEBT.md` RISK-16, tracked, not fixed here).

### 13.7 One gate, three call sites

`src/lib/device-handoff/services.ts`'s `assertDeviceAvailableForMutation` (operation-lock check,
then recovery-mode check) is the single implementation; it is called from three independent
choke points, not reimplemented at each: `src/proxy.ts` (Next.js 16's renamed `middleware.ts` —
confirmed via `node_modules/next/dist/docs/` to default to the Node.js runtime, which is what
makes querying the local libSQL database directly from it possible) for every mutating `/api/**`
request; `src/cli/video-metadata.ts`'s `runCliCommand`, for every CLI command outside an explicit
read-only allowlist; `src/mcp/server.ts`'s `createMcpToolHandlers`, wrapping every tool classified
as a local- or remote-mutation per `docs/DEVELOPMENT_PLAYBOOK.md` §6.7. `app_operation_locks`
itself is a real SQLite-level exclusivity mechanism (the `INSERT` against a fixed row id is what
actually enforces it, across any connection/process to the same file) — the three choke points
give the broader "no new work starts" product behavior for the whole export/import window, not
just the instant of the file copy.

### 13.8 Known limitations

- No macOS runtime validation — path-resolution logic is unit-tested for both platforms via
  injection; only Windows has actually been run (`docs/TECHNICAL_DEBT.md` RISK-17).
- No in-app way to leave restricted recovery mode yet — depends on RISK-04's CLI/MCP Batch
  tooling, which does not exist (RISK-16).
- No installer/auto-updater for a standalone `published/<version>/` release copy (no `.git`);
  release layout is documented (`docs/RELEASE_LAYOUT.md`) but not automated there, per that
  task's own explicit scope boundary. `scripts/{macos,windows}/start.{sh,bat}` never touch git,
  the network, or the working tree at all (an earlier version did run `git pull --ff-only`
  itself; removed 2026-09-21 at the project owner's explicit request — keeping a git checkout
  current is the operator's own responsibility now). They do detect a stale `.next` build when
  run from a git checkout, by comparing the checked-out commit against a marker file recording
  which commit was last built, and rebuild automatically — this is what makes the operator's own
  `git pull` actually take effect on the next launch, rather than silently continuing to serve a
  build from before that pull (`docs/FIRST_LOCAL_TEST_BUILD.md` §3/§4).

## 23. Automatic device sync (`src/lib/device-sync/`) — ADR 0012, in `dev` (`21bb583`)

**Purpose.** Removes the manual export/import from the §13 handoff without changing its
single-writer, whole-copy semantics. Plan and acceptance criteria:
`docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md` (AC-AS-01..15).

**Data flow (one tick, every 30 s, from `src/instrumentation.ts`):**

1. Gates:
   - the toggle (`device_auto_sync_enabled`) and a configured Syncthing folder that already
     exists. Automatic sync never creates it, so an unplugged or renamed external drive gives
     `folder_unreachable`, never snapshots written to a local folder no peer sees;
   - no live operation lock (a dead export's lock is cleared first) and no recovery mode;
   - an unfinished Batch in this computer's data pauses sync both ways, with a `batch_in_progress`
     notice. `hasUnfinishedBatch` checks for a `RUNNING` batch or rows
     `AWAITING_EXECUTION`/`APPLYING`/`UNKNOWN` (`CANCELLED` rows -- ADR 0016 -- are terminal and never count as unfinished). It is judged on transferred data, not on the
     device-local locks, which some abort paths leak (RISK-90). The same predicate refuses an
     unfinished copy (`refuseUnresolvedExecution`) and is re-checked inside the lock before every
     import and export.
2. The folder is scanned. Only UUID-named directories count, which excludes the sync-gateway
   folders. An unreadable or incomplete snapshot is "pending": it is retried silently and noticed
   after 10 minutes.
3. `hasUnpublishedLocalChanges`: the current content fingerprint is compared with
   `snapshot_lineage.content_fingerprint`.
   - **BL-270 (owner TG 4662/4665): the tick's dirty check is cached.** Each transferred table has
     insert/update/delete triggers (`ytom_transferred_change_<table>_<op>`) that bump its row in
     the device-local `transferred_change_counters`, so a write from any connection or
     process counts. The table and the triggers are created at run time, never by a migration (no
     schema version, so the computers need not update together). `createCachedContentFingerprint` (`snapshot/adapters/change-counter.ts`) reuses
     the last full fingerprint while the key -- `PRAGMA schema_version` plus every counter, read
     BEFORE the computation -- is unchanged and younger than 10 minutes. Missing triggers (a
     migration rebuilt a table) are re-installed by `ensureTransferredChangeTriggers` on the next
     tick and force a full computation; a missing counter table (a new, imported or staged database)
     is created the same way. The scrub drops the counter table and the triggers from every
     snapshot copy. The import (`applySnapshotToDatabase`) drops the triggers inside its
     `BEGIN IMMEDIATE` and restores them before COMMIT, bumping every counter once: with them in
     place the whole-table replace bumped a counter per row and lost the truncate optimisation
     (review finding 5, real 22 MB snapshot: ~160 ms without triggers, ~300 ms with them, ~180 ms
     with the drop/restore). The data-policy purges delete only expired rows (`WHERE`), so they keep
     the triggers. Only the tick's decision uses the cache;
     the in-lock checks before an export or an import (step 5) still compute in full. Measured on a
     real 22 MB snapshot: full fingerprint ~960 ms wall / ~580 ms CPU, cached check ~0.7 ms.
     `PRAGMA data_version` alone was rejected: it moves with every commit by another connection
     (the lease renewal, the status save, the family results), and not with this connection's own.
   - The fingerprint is a SHA-256 over every table `SNAPSHOT_REPLACE_ON_IMPORT_TABLES` names. Rows
     are sorted by all columns, and each row is hashed as its non-NULL `column=value` pairs. A
     missing table hashes like an empty one. So rowids and physical column order do not matter, and
     a migration that adds a nullable column or a new transferred table leaves it unchanged.
   - Export records the fingerprint of the exported file itself, so a write racing the copy stays
     dirty.
   - Import records it from the live DB inside the lock.
   - An unknown fingerprint (a pre-v36 lineage) counts as dirty. No lineage counts as clean only
     when every transferred table is empty.
4. `decideSyncAction` (pure):
   - "Known" is the local head plus its ancestry: recorded `ancestors_json`, `lineage.json`, and
     parent pointers through every manifest in the folder.
   - "Newer" means other devices' snapshots that are not known. Of those, only the tips count.
   - No tips: export if dirty, otherwise idle. An automatic export is debounced (BL-270 and its
     review): it runs once the content fingerprint has been unchanged for 90 s, counted from the last
     tick that still saw the old content, so 60–90 s after the change itself
     (`DEVICE_SYNC_EXPORT_QUIET_MS`), or after 10 minutes of continuous churn
     (`DEVICE_SYNC_EXPORT_MAX_DELAY_MS`), never within 60 s of the previous export
     (`DEVICE_SYNC_MIN_EXPORT_INTERVAL_MS`). The debounce state is in memory; the first observation
     in a process is not held back. "Sync now", the idle-shutdown flush and the restart-when-idle
     pre-stop flush (both call the runner directly, never through the in-flight tick) are forced.
   - One tip that is a fast-forward, with local clean: import.
   - A newer schema: `update_app`.
   - Anything else: divergence.
4a. **Identical-content divergence (BL-139, owner 2026-10-06; reworked after review round 1).**
   Each conflicting tip is staged exactly like an import (checksums, private copy, migration;
   fingerprint cached per snapshot id, `null` only for a newer schema).
   - A tip whose content equals the fingerprint recorded with this device's head holds nothing
     this device lacks: it and its ancestry are added to `ancestors_json` by compare-and-set on the
     head (`addLineageAncestorsIfHeadUnchanged`). Head, data and fingerprint stay, so every device
     keeps its OWN snapshot as head (retention protects it), and the decision is made again
     (export if dirty, else idle). The export carries that branch as an ancestor, so the peer
     fast-forwards.
   - A clean device with several tips that all hold the same data imports the newest one that
     continues its history (an ordinary import); the next tick absorbs the rest.
   - "This head's content" is the recorded fingerprint or, when the head is still in the folder,
     its staged file (an import purges expired API rows, so the file and the live data differ).
   - "Take theirs" carries absorbed branches into its marker's ancestors and `supersedes`, so they
     do not come back as conflicts after the choice.
   - Anything else (different content, a comparison that fails) is a divergence as before.
   An earlier version switched the head to the peer's snapshot instead; review round 1 showed it
   left the peer asking about an abandoned branch (where "take theirs" lost a row on both sides),
   a third device asking forever, and no device protecting the current snapshot.
5. Actions go through the existing `exportHandoff` / `importHandoff`. `assertStillSafe` re-checks
   the gates, and the fingerprint for an import, inside the operation lock, right before anything
   is written. In a divergence, local unpublished changes are still published on their own branch,
   so the other computer sees the conflict too.

**Resolution (human only, in the Merge tab → `POST /api/device-sync/resolve`):**
- The bell only links to the Merge tab. `DeviceSyncDivergenceCard` there shows both computers, the
  newest common snapshot, and per section (Batches/Audit/Research/Decisions/Other) the rows only
  here, only there, and changed (same primary key), from `GET /api/device-sync/divergence`
  (`runner.divergencePreview` → `diffTransferredContent`, read-only ATTACH of the staged copy).
- Both actions accept only a CURRENT conflicting peer tip.
- `keep_mine` exports with `supersede` (parent = the named tip; ancestry = every current peer tip
  and its history, plus the local one), so every peer fast-forwards.
- `take_theirs` imports with `acceptDivergentLineage`, using its own backup prefix
  `pre-take-theirs-`, which is never pruned. If this device had already published its own branch,
  it then publishes a marker: the adopted state again, with that branch as ancestors. So the peer
  sees a fast-forward.
- Resolutions never delete from the shared folder. A deletion propagates asynchronously and looks
  like "not arrived yet". Review round 2 showed two opposite resolutions made at the same time then
  left both computers "synced" with swapped data. Markers fail closed instead: both computers ask
  again.
- `lineage.json` `supersedes` lists what a resolution replaces: the peer tips for `keep_mine`, the
  own abandoned branch for a marker. It never widens the fast-forward rule. It only makes the
  receiving import keep a `pre-superseded-*` backup, which is never pruned, when its head is
  replaced.
- **Import atomicity (round 2).** Three things run inside `applySnapshotToDatabase`'s
  `BEGIN IMMEDIATE`, via hooks:
  1. "Live content still equals the pre-import backup's", plus the caller's re-checks, before
     the first DELETE.
  2. The merged content's fingerprint.
  3. The lineage pointer, before COMMIT.

  A write that lands between the backup and the merge aborts the import with
  `snapshot_local_changed_during_import`, and nothing is replaced.
- A snapshot whose data fails schema migration is remembered in the status and reported as
  `update_app`, never retried.
- All actions on one runner are serialized. The runner is a `globalThis` singleton shared by the
  scheduler and the routes.
- The decision uses exactly the fast-forward rule `verifySnapshotForImport` enforces. An
  older-build chain without `lineage.json` is caught up one direct child at a time.
- `src/lib/device-sync/convergence.test.ts` runs the resolution matrix with one folder per device
  and delayed propagation:
  - {keep, take} on A × {keep, take, none} on B;
  - sequential and simultaneous;
  - with and without further work;
  - plus a third device.

  The invariant: identical content and no notices, or someone is asked; never lost without a
  backup.

**Retention.**
- This device's own snapshots: the newest 5 plus the head.
- `pre-auto-import-*` backups: the newest 10.
- Another device's files are never touched, since Syncthing would propagate the deletion.

**Why a dedicated DB connection.** `importHandoff`'s `BEGIN IMMEDIATE` on the shared
`rawSqlClient` would absorb any unrelated in-process write issued meanwhile, such as the Live-writes
lease renewal or a draft cycle. On its own connection, such a write just waits for the busy
timeout.

**Draft cycle.** `runAllSyncFamiliesOnce` (sync-gateway) is shared by the "Sync now" route and
the scheduler. It runs every 60 s under the same gate the route gets from `src/proxy.ts`, and it is
NOT tied to the device-sync toggle (§M). Instrumentation and route bundles may not share module
state, so these are held per process via `globalThis`:
- the run-all single-flight guard;
- the three production sync cores, which keeps the existing "adopt peer" vs cycle exclusion real.

**BL-270: an unchanged document or report is not rewritten.** Every family's cycle saved each document and pushed it to the
sync folder even when nothing had changed (tmp file, fsync, rename; a fresh mtime and a Syncthing rescan per file per minute).
`writeFileAtomicIfChanged` (`atomic-json-file`) compares with the file ON DISK and skips identical bytes; automerge-core's
`saveDocumentBytes` and `writeDeviceFile` and per-device-report's `writeLocal`/`writePeer` use it. `Automerge.save` is deterministic,
so a merge that brings nothing new saves byte-identical bytes (tested). Reports that carry `updatedAt` = now (generation plans,
live streams, uploads, media sessions) still change at each publish and are still written. The storyboards core keeps `read`'s
plain storyboards per channel under the sha256 of the document's bytes (badge, review-notify, cost loop). The load and merge of each
document each minute remain (~0.6 s CPU per cycle over the live Mac's 17 documents).

**BL-203: browser tabs no longer start draft cycles; unchanged documents are not reworked.**
- Since BL-203 (`docs/roadmap/plans/FAST_NAVIGATION_PLAN.md`) the `(app)` layout no longer POSTs the route, either on mount or
  every 60 s. The scheduler alone runs the cycle; "Sync now" still uses the route.
- `sync-gateway/change-drafts` keeps one process-wide `ChangeDraftsCache` (`cache.ts`, held via `globalThis`). It is keyed by
  the sha256 of document bytes:
  - `listConflicts` and `exportBytes` reuse what they computed for the same bytes;
  - `mergeIncoming` returns at once when the local bytes already contain the incoming ones (identical bytes, or a pair merged
    before) and the local projection last succeeded with no failed row. A failed projection or cleanup is never recorded, so the
    next cycle repairs it.
- The transport does not rewrite a device file whose content is unchanged.
- An unchanged cycle takes ~30 ms instead of ~5.8 s. A real merge still blocks the thread (RISK-133).

**BL-204: the channel's document stays loaded.** (FAST_NAVIGATION_PLAN.md §4)
- `cache.documents` (channelId → `{hash, doc}`) holds the live document. A call checks it out, and `saveDocument` puts back the
  saved one. A read that ends normally gives it back; a call that throws drops it, so the next call reloads.
- Automerge clones share sub-objects with their source, so documents are never freed by hand, except the merge's throwaway trial
  clone.
- Merge: `loadIncremental(clone(live), peer)`, then `getChanges(live, trial)`. A root change (no deps) means divergent lineage and
  the live document is untouched; otherwise `applyChanges(live, added)`. Peer bytes must pass `assertCompleteAutomergeBytes`
  first, because `loadIncremental` silently ignores a truncated tail.
- Measured: a real merge takes 0.76 s (was 2.46 s), a local write 0.13 s (was 0.85 s).

**Boot.** `initializeDatabase` takes the migration lock only when a migration is due
(`acquireMigrationLockIfDue`). It waits for a busy lock and clears a dead export's lock. Around the
migrations, `createSyncPreservingMigrationHooks` (BL-139) moves the lineage fingerprint by
compare-and-set if the device was in sync before them: every computer applies the same migrations,
so a column added with a non-NULL DEFAULT is not a local change. Both fingerprints come from the
pre-migration backup (`after` from a private copy of it, migrated), never the live DB, so a write
another process makes during the migration window still reads as unpublished.

**Automatic writes wait for sync (BL-139).** The dashboard's Market Intelligence refresh
(`collect-if-stale`) first calls `runner.syncBeforeBackgroundWrite()` (one tick, 60 s bound) and
waits only while something from another computer is arriving (a pending entry younger than the
10-minute grace), while sync is paused (`busy`), while the folder is unreachable, while a
divergence notice is open, or while `update_app` says the other computer's data cannot be loaded
yet. A stuck transfer and `error` have their own notices and do not block it; any tick clears a
reason that no longer applies. A skip is saved as `backgroundWritesPausedReason` and shown in the bell; the next
dashboard load tries again. A device-sync failure never blocks it (§M).

**Stuck operation lock recovery (2026-10-01).** A migration/import killed mid-run leaves its
`app_operation_locks` row; by decision 2b it is never auto-released (only a dead *export*'s is), so
the next boot used to wait 30 s and then fail, with no UI to fix it. Now: (1) a boot whose holder
process is provably dead fails at once instead of waiting; (2) `instrumentation.ts` keeps the server
up when database initialization fails and starts the session work once a later attempt succeeds;
(3) `db.ts` initialization is a `createRecoverableInitializer` -- after a failure the next call
re-attempts (at most every 3 s), so clearing the lock needs no restart; (4) `/recovery`
and `/api/operation-lock` (exempt in `src/proxy.ts`) use `ungatedRecoveryClient`, independent of
initialization and session; (5) the same `OperationLockControl` is shown in the Merge tab and as a
dashboard banner for non-export locks; (6) `npm run operation-lock -- status|clear` works with the
app stopped; `wait-idle` is what `stop.bat`/`stop.sh` run before killing the server (and `start` runs `stop` when port 3000 is busy), so a server is never killed mid-operation. FO-MSG-0013: they then run `media-idle`, which refuses (unless the script gets `--force`) while a media session on this computer is `approved`/`starting`/`running`/`stopping` -- stopping the app terminates its pod (AC-P14-09) and fails its queued jobs. Clearing is always an explicit operator action, a compare-and-delete on the exact lock
shown; a holder that looks alive needs `force` plus the typed word CLEAR. See RISK-91.

**Not done, by design.**
- No export in SIGINT/SIGTERM handlers, because a killed export leaves a never-auto-released
  operation lock. The idle shutdown does flush, since nothing is in flight. Under the macOS system
  service (BL-158, ADR 0032) idleness only ends the session (Live writes reset) and the process
  stays, so there is no final flush; the regular sync tick keeps exporting.
- No concurrent editing.

See RISK-89.

## 30. Shared Production settings and the conflict screen (BL-150, ADR 0030)

- **Sync family.** `src/lib/sync-gateway/media-settings/` holds one global Automerge document, `{ format, version, settings: map }`.
  - The genesis is deterministic (`genesisDocument()`: fixed actor, time 0, loaded as a copy so each device writes with its own actor). Independently started documents therefore merge.
  - `scanForConflicts` drops values written identically on both sides.
  - API: `publishChanged` (an owner edit, may settle a conflict), `seedMissing` (never overwrites), `resolveConflict` (one of the conflicting values only), and the runner hooks.
  - It is registered in `run-all-families.ts` as `media_settings`.
- **Applying in Production.** `src/lib/media-generation/settings-sync.ts` holds `SHARED_SETTING_FIELDS`, `ACCOUNT_BOUND_FIELDS` and `planPeerApply`, which is pure. `createSettingsSync().tick()` does the following on the media watcher tick (`src/instrumentation.ts`):
  - seed;
  - read;
  - plan: conflicted fields are held, account-bound fields are held on another account;
  - apply through `base.updateSettings`: the whole patch first, then each field alone on failure. A busy volume is retried; an invalid value is held until the shared value changes;
  - record `settings_applied_from_peer`.
- **Publishing a local edit.** `media-generation/index.ts` wraps `updateSettings` to publish only the fields that save changed. A failure to share never fails the save.
- **UI.**
  - `components/conflict-center.tsx` (`useConflictCenter`, `ConflictCenter`) reads every family's conflicts plus the snapshot divergence, and resolves through each family's own route. Its display helpers are in `conflict-values.ts`: labels, units, word and list diff.
  - The `(app)` layout shows it blocking after the startup steps (`startup-progress.ts`, `loading-overlay.tsx`), and the Merge tab shows it non-blocking.
  - Setup shows `settings-sync-notice.tsx`.

## 31. Analytics and reach data shared between devices (BL-151)

Plan: `docs/roadmap/plans/ANALYTICS_DATA_SHARING_PLAN.md`; owner msgs 2004/2008.

- **Module.** `src/lib/analytics-data-sync/` is shaped like `quota-ledger-sync`.
  - **Files.** Each device writes only its own day files, `<Syncthing root>/analytics-data/<deviceId>/<YYYY-MM-DD>.json` (UTC day of collection). Each holds that day's rows from `exportAnalyticsShareRows`, in `db.ts`.
  - **Publishing.** Today and yesterday are rewritten only when changed; own files older than 45 days are deleted. The Syncthing folder is never created.
  - **Peer files.** They are read once per size/mtime. A file naming another device or day, an invalid file or an oversized one is skipped with a reason.
- **Import.** `importAnalyticsShareRows` runs in one transaction and never deletes. Its merge rules:
  - metrics and video history: the later `collected_at`/`updated_at` wins;
  - collection runs: added once (channel, window, `ran_at`);
  - the channel auto-collect stamp, the reach sync attempt and the job check time: only move forward;
  - report files: added once;
  - reach rows: replaced only by a later-created report;
  - a video metric for a video this device has not synced: skipped;
  - sync attempts: shared without error text.
- **When it runs.**
  - Every 2 minutes on the server (`src/instrumentation.ts`).
  - Before deciding what is stale: `auto-collect-all` and the automatic `reach/sync-all` first call `importPeersFirst()`, which waits at most 30 s and never fails the collection. Each publishes once its collection is done. Since BL-196 a load with nothing due skips this. For `reach/sync-all`, nothing is due when no channel is due. For `auto-collect-all`, the active channel is current and the import moves after the response.
  - The existing staleness checks are unchanged. They now see the other device's runs and stamps, so a channel it collected today is current here. The startup window then says "collected on the other computer".
- **Measured on a copy of the Mac's database (2026-10-07).**
  - Everything: 45,780 metric rows and 1,880 reach rows, 4.3 MB as JSON. One day: about 11,000 rows.
  - Export of a day: 35 ms. A full re-import into the same data: 1.1 s, and nothing changed.

