> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## BL-237 — disk hygiene (owner msgs 3864–3866)

- **Test temp folders:** `npm test` → `scripts/run-tests.mjs` creates `<os.tmpdir()>/ytm-test-run-<pid>-<ms>`, sweeps stale run
  folders (> 2 h and pid gone, or > 48 h), links tsx's cache folder (`tsx-<uid>`) into it, spawns `node --import tsx --test …` with
  `TMPDIR`/`TMP`/`TEMP` = the run folder (every test process inherits it, so every `os.tmpdir()` — including the test-runner
  database singleton `youtube-ops-manager-test-singleton-<pid>` — lands inside), and removes the folder when the runner exits.
- **Build cache cap:** `prebuild` → `scripts/next-cache-trim.mjs`: `.next/cache` over 5 GB (`YTOM_NEXT_CACHE_LIMIT_GB`) and turbopack
  alone over half of it → remove `.next/cache/turbopack` only; a failure never stops the build.
- **Migration backup retention:** `db-backup.pruneMigrationBackups(dir, { keep = 5, prefixes = [pre-migration, pre-auto-import],
  protect })` sorts each prefix by the millisecond timestamp in the name and deletes all but the newest 5 per prefix, never a
  protected path, and never the upgrade's first copy named in `.last-successful-migration` (JSON: `pendingUpgradeCopy`,
  `lastSuccessAt`, `lastProtectedCopy`) -- migrations are not transactional and a failing one is retried with a new copy each
  time, so that first copy is the clean one from before the upgrade; kept by NAME, so a clock set back cannot lose it.
  `db.ts` follows `createMigrationBackups`: `takeCopy({ fromVersion, toVersion })` in `beforeMigrations` (copies, then records
  the name with both versions once the copy is complete; a recorded first copy is replaced only when its file is gone or this
  start upgrades from at or above its recorded target -- that upgrade finished without its success being recorded; never prunes), `succeeded()` only after `initializeDatabaseSchema` went through (prune when a copy was taken, protecting this
  start's copy and the first copy, then the record; written on every successful start that finds it missing or stale); `device-sync` prunes after an automatic import, protecting the backup it just wrote (`importHandoff` returns `backupPath`). Per prefix, not one pool: frequent automatic imports must not push out the last copy
  taken before a schema migration.
- **Disk guard:** `src/lib/disk-guard/` — `services.ts` (pure rule `decideDiskAlert`: not alerting + below → raise; alerting + ≥
  threshold + 2 GB → clear; alerting + below + ≥ 24 h since the last alert → raise again; state saved before the message goes out),
  `adapters/fs.ts` (`readVolumes`: statfs per place, merged by `stat.dev`; `folderSize`: async walk, links not followed, time budget →
  `complete: false`), `index.ts` (this computer's places; settings/state in `app_settings`). `src/composition/disk-guard.ts` posts
  through `system-topic`'s `enqueue` only when its `view().active` is true. Loop: `instrumentation.ts`, 15 min, gated by
  `assertDeviceAvailableForMutation`. The bell polls `/api/disk-guard/notice` (stored state, no disk read); the «Диск» card reads
  `/api/disk-guard` (statfs now; folder sizes only with `?measure=1`, one measurement at a time per process — a second request
  shares the running one).
- **Limitations:** RISK-145.

