# 0032. macOS: the server as a system service started at power-on

Status: Accepted

**Date:** 2026-10-08.

**Decided** by the owner in Telegram on 2026-10-08 (BL-158):
- msg 2150: the goal is that the second account on the Mac can use the app ("переносим как раз чтобы у второго пользователя был доступ");
- msg 2152: the second user has the Google accounts too;
- msg 2154: the server starts when the Mac is switched on ("при включении мак"), not only at the owner's login.

This ADR extends BL-116 (detached server, presence-based shutdown; `docs/roadmap/plans/DETACHED_SERVER_PLAN.md`).

## Context

- The app keeps its database, channels and Google sign-in in the data folder of the macOS account that runs the server
  (`~/Library/Application Support/YouTubeOperationsManager/`). A second account starting its own server gets an empty app.
- Only one server can listen on `127.0.0.1:3000`, and the loopback port is shared by every account on the Mac. A browser
  in any account reaches whichever server runs.
- The launcher-started server (BL-116) belongs to the owner's login session and stops after 10 minutes without an open
  window. The second account then has nothing to open.
- macOS privacy protection (TCC) blocks a launchd job from the owner's `~/Documents` (where the repository lives) and from
  the external drive (where the sync folder lives) unless the job's executable has Full Disk Access. This was measured on
  the Mac: a launchd-started `node` got `EPERM` on `~/Documents`, a launchd-started `/bin/ls` got `EPERM` on the drive.
  The Syncthing daemon already on this Mac has Full Disk Access for the same reason.

## Decision

1. **One server, run by launchd as the owner's account.** A LaunchDaemon (`/Library/LaunchDaemons/local.ytom.server.plist`,
   `UserName` = the owner) starts at power-on (with FileVault: once anyone unlocks the Mac) and is restarted whenever it
   stops (`KeepAlive`, `ThrottleInterval` 30 s). Every account uses `http://localhost:3000` and signs in with Google in its
   own browser. The data stays in the owner's account; the repository is not moved.
2. **node is the job's executable.** The daemon runs `node scripts/macos/service-run.mjs`, so the Full Disk Access the
   owner gives node covers the job and everything it starts (the build script, npm, the server). A shell as the
   executable would make that grant useless.
3. **One build rule.** `service-run.mjs` builds through `build-if-stale.sh`, the rule `start.sh` uses too (extracted from
   it), then runs `npm run start` in the foreground. When the server exits, the run exits and launchd starts the next one,
   which rebuilds first when the checked-out commit changed. So `stop.sh` is the restart.
4. **Idleness ends the session, not the process.** `YTOM_SERVICE_MODE=1` (set only by the daemon's runner) makes the
   idle watcher call its handler once per idle period and keep watching. The handler resets Live writes. This keeps the
   Gate B rule that Live writes live only as long as a session (RISK-09): the same 10 minutes without an open window or
   an agent request that used to stop the server now end the session. Running work defers it exactly as before.
   Generation pods keep running under the media watcher's own caps (they no longer need stopping because the process
   stays).
5. **The launcher scripts know the service.** With the service installed, `start.sh` never starts a second server and
   never builds under a running one: it restarts the service when the build is stale, waits, and opens the browser.
   `stop.sh` reports the old process gone (the port does not stay free). `update.sh` refuses.
6. **Install and remove are explicit, one admin password each.** `install-service.command` / `uninstall-service.command`
   (double-click). Uninstalling waits for a running export/import/migration, stops the server and removes the daemon;
   `start.command` then works as before.

## Consequences

- The server runs all the time on the Mac. The second account works without the owner logged in.
- Full Disk Access is granted to node's binary. A Homebrew node upgrade changes the binary, so the grant must be given
  again; until then the service cannot read the repository (logged in `~/Library/Logs/YouTubeOperationsManager/service.log`).
  RISK-115.
- Live writes once enabled stay on while anyone keeps a window open or an agent keeps working, and switch off 10 minutes
  after the last activity, as before.
- External drives mount only at the first login. Until someone logs in after a restart, sync reports the folder as
  unavailable and retries; the app itself runs.
- Windows is unchanged.

## Alternatives rejected

- **Moving the repository to the shared drive** (the owner's first idea): the data is per account, not in the
  repository, so the second account would still get an empty app. The drive also disconnects (it did on 2026-10-08) and
  mounts only at login.
- **A LaunchAgent / login item:** runs only while the owner is logged in; the owner chose power-on.
- **Automatic login of the owner's account:** needs FileVault off and leaves the owner's desktop open to anyone at the Mac.
- **Disabling the idle check outright:** would leave Live writes on indefinitely (RISK-09).
