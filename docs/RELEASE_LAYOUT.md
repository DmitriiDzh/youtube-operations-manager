# RELEASE_LAYOUT.md

Technical release-layout and first-run/device-switching documentation for the Pre-Release
Cross-Platform Persistence work (Variant A, `docs/decisions/0002-additive-schema-versioning.md`
and `docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md`). **Technical setup content only**
— per `AGENTS.md` §B this file never contains channel-specific editorial guidance, YouTube SEO
strategy, or operations-agent instructions; that knowledge lives entirely outside this repository.

This document does **not** describe an installer or auto-updater — none exists, and none is
in scope for this task (task §5 explicitly excludes both).

---

## 1. Release layout on a Syncthing-shared folder

A Syncthing-shared folder may hold platform-specific release output for both supported
platforms side by side:

```text
<syncthing-shared-folder>/
  windows/
    <release build output for Windows>
  macos/
    <release build output for macOS>
```

The application resolves its own runtime and app-data location independently of which
platform folder it was launched from — see §2. **Do not sync `node_modules/` or native build
artifacts** (`.next/`, compiled native bindings) between platforms; they are platform-specific
and must be produced locally on each device via its own `npm install`/`npm run build`. This is
packaging guidance only — no build pipeline change is part of this task.

The Syncthing-shared folder's **root** (or a dedicated subdirectory within it — the operator
configures the exact path, see §3) is also where device-handoff **snapshots** are published and
read from (`src/lib/snapshot`, `src/app/api/device-handoff/**`). Snapshots are plain files
(`manifest.json` + `data.db` + checksum) — Syncthing treats them exactly like any other synced
file. Syncthing is never treated as a database and never carries the live application database,
its WAL/SHM files, or any secret.

## 2. App-data location (platform-aware)

`src/lib/platform-paths` (`resolveAppPaths`) resolves a per-device application-data directory,
independent of where the application binary/source was launched from:

| Platform | Location |
|---|---|
| Windows | `%APPDATA%\YouTubeOperationsManager\` |
| macOS | `~/Library/Application Support/YouTubeOperationsManager/` |

Inside it: `playlist-manager.db` (the live database), `backups/` (per-write-batch immutable
backups, `src/lib/backup/`, and `backups/migrations/` for pre-schema-migration/pre-import
backups), `snapshots/` (local fallback snapshot publish location when no Syncthing folder is
configured — see §3), `bootstrap-config.json` (device-local config, §3), `auth-context.json`
(CLI/MCP active-user pointer).

This location is never inside the release/source tree and is never synced by Syncthing itself
— only the snapshot files an operator explicitly exports travel, via the separately-configured
Syncthing folder (§3).

**Migration from the pre-this-task location:** if a database exists at the legacy
`<repo>/data/playlist-manager.db` location and none exists yet at the new app-data location, the
application performs a one-time, explicit, non-destructive copy on first boot (never deletes or
modifies the legacy file). If a database already exists at the new location, the legacy file is
never touched.

## 3. First-run setup

1. Start the application. If no `bootstrap-config.json` exists yet, one is created automatically
   with a freshly generated `deviceId` and `syncthingRootPath: null` (local-only mode).
2. Sign in with Google (unchanged from before this task — establishes this device's own OAuth
   session; OAuth tokens are never part of a snapshot, see §5).
3. Open the **Device** tab in the dashboard and set the Syncthing folder path — the local
   directory Syncthing already keeps in sync with the other device. Leaving it empty keeps the
   application in local-only mode (export/import still function, for testing, but nothing
   leaves the device).
4. If migrating from the pre-this-task single-location install, the legacy database is copied
   into the new app-data location automatically (§2) — no additional action needed.

## 4. Device-switching procedure (Variant A: one active device at a time)

**On the device finishing work:**

1. Open the **Device** tab → **Export handoff**.
2. The export: acquires a local operation lock (blocking any other mutating action on this
   device for its duration), takes a read-only snapshot of current execution state, produces a
   consistent, secret-scrubbed database copy (never OAuth tokens, never AI connection
   credentials, never runtime-only lock tables), checksums it, and publishes it atomically into
   the configured Syncthing folder.
3. The UI records that export finished on **this** device. It does **not**, and cannot, confirm
   that any other device's process has stopped — the operator is responsible for actually
   stopping work on the finishing device before treating a handoff as complete.

**On the device continuing work**, once Syncthing has finished copying the snapshot:

1. Open the **Device** tab → the new snapshot appears in the list → **Import**.
2. The import: acquires the local lock, verifies the snapshot (completeness marker, checksums,
   lineage continuity — a divergent/forked lineage is blocked with a diagnostic, never resolved
   by guessing from timestamps), backs up this device's current database, brings a private
   working copy of the snapshot up to this build's schema version, merges application state in
   (Change Sets, Batches, audit history, editorial profiles, AI connection metadata) while never
   touching this device's own OAuth session or AI connection credentials, and activates it.
3. If the imported data includes any batch execution row with an uncertain YouTube write outcome
   (`APPLYING`/`UNKNOWN`), the device activates but enters **restricted recovery mode**: every
   mutating action (local-state or YouTube-write) is refused until Phase 5's existing recovery
   mechanism resolves those specific rows. An "acknowledge" action is available to record that
   the operator reviewed the diagnostics — it is purely informational and does not lift the
   restriction by itself (see `docs/acceptance/PRE_RELEASE_CROSS_PLATFORM_ACCEPTANCE.md`
   AC-HANDOFF-04/05).

**Credentials on both devices:** AI Connections' metadata (name, adapter type, base URL, model
id) travels with the snapshot; each device's own encrypted credential for a given connection
stays exactly where it was — a connection new to a device simply shows "not configured on this
device" until the operator adds a credential locally. The same applies to OAuth: signing in on
the receiving device (step 2 above, first-run) is what establishes that device's own session;
nothing about it is carried by a snapshot.

**Temporary Syncthing unavailability:** the active device continues normal local operation —
only an export/import action attempted while the folder is unreachable fails with a clear
message; this is not otherwise treated as an error condition anywhere in the application.

## 5. What a snapshot never contains

- `users` (OAuth identity/tokens) — excluded entirely, re-established per device via sign-in.
- `ai_connection_credentials` (encrypted AI provider credentials) — device-local, key is
  per-device/per-environment.
- `video_execution_locks`, `app_operation_locks` — runtime-only, meaningless off-device.
- `handoff_log`, `recovery_acknowledgements`, `schema_meta`'s own history beyond the current
  stamped version — this device's own operational bookkeeping.

See `src/lib/snapshot/contracts.ts`'s `SNAPSHOT_TRANSFERRED_TABLES` for the authoritative,
explicit allowlist (fail-safe: a future new table is excluded by default unless a reviewer adds
it there deliberately).

## 6. Known limitation

Cross-platform behavior described here is unit-tested for both Windows and macOS path-resolution
logic via dependency injection (`src/lib/platform-paths/services.test.ts`). It has been
**runtime-validated on Windows only** — no macOS machine was available in the environment this
work was implemented in. Do not treat this document as evidence of a real macOS run; that
remains an open item for whoever first runs this build on macOS.
