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
3. **One build rule, accepted branches only.** `service-run.mjs` builds through `build-if-stale.sh`, the rule `start.sh`
   uses too (extracted from it), then runs `npm run start` in the foreground. When the server exits, the run exits and
   launchd starts the next one, which rebuilds first when the checked-out commit changed. So `stop.sh` is the restart.
   Nobody watches these builds, and a build migrates the real database, so the runner builds and runs only when the
   repository folder is on `dev` or `main` (a folder without git builds as before); on any other branch it logs why and
   retries every 5 minutes. A start, check or build that fails also waits 5 minutes before the next run.
4. **Idleness ends the session, not the process.** `YTOM_SERVICE_MODE=1` (set only by the daemon's runner) makes the
   idle watcher call its handler once per idle period and keep watching. The handler resets Live writes. This keeps the
   Gate B rule that Live writes live only as long as a session (RISK-09): the same 10 minutes without an open window or
   an agent request that used to stop the server now end the session. Running work defers it exactly as before.
   Generation pods keep running under the media watcher's own caps (they no longer need stopping because the process
   stays). The handler is `createIdleHandler` in `idle-shutdown.ts`, tested per action.
5. **The launcher scripts know the service.** With the service installed, `start.sh` never starts a second server and
   never builds under a running one: it restarts the service when the build is stale, waits, and opens the browser.
   `stop.sh` reports the old process gone (the port does not stay free). `update.sh` refuses.
6. **Install and remove are explicit, one admin password each.** `install-service.command` / `uninstall-service.command`
   (double-click). Both first wait for a running export/import/migration (as `stop.sh` does) and change nothing if it does
   not finish; a reinstall waits until the old instance is gone before loading the new one, and never replaces a service
   installed for another account. launchd gives the server 5 minutes after SIGTERM before killing it (`ExitTimeOut`), so
   a stop drains like `stop.sh`'s. The job's working directory is the home folder, not the repository, so launchd can
   enter it without node's Full Disk Access. After uninstalling, `start.command` works as before.

## Consequences

- The server runs all the time on the Mac. The second account works without the owner logged in.
- Full Disk Access is granted to node's binary. The daemon runs node through Homebrew's `/opt/homebrew/bin/node` link,
  so after a node upgrade it runs the new binary, which has no grant yet: node then cannot load the runner ("EPERM ...
  service-run.mjs" in `~/Library/Logs/YouTubeOperationsManager/service.log`). Granting the new binary is enough; no
  reinstall. RISK-115.
- Live writes once enabled stay on while anyone keeps a window open or an agent keeps working, and switch off 10 minutes
  after the last activity, as before.
- External drives mount only at the first login. Until someone logs in after a restart, sync reports the folder as
  unavailable and retries; the app itself runs.
- The second account working on the Mac while the owner works on Windows is the same as two computers working at once:
  the existing rules for that apply (sync families, review claims and confirmation, ADR 0029/0031).
- A window left open in a background account (fast user switching) keeps sending the heartbeat, so the session does not
  end and Live writes stay as they are until that window closes — the same as a window the owner leaves open today.
- Windows is unchanged.

## Alternatives rejected

- **Moving the repository to the shared drive** (the owner's first idea): the data is per account, not in the
  repository, so the second account would still get an empty app. The drive also disconnects (it did on 2026-10-08) and
  mounts only at login.
- **A LaunchAgent / login item:** runs only while the owner is logged in; the owner chose power-on.
- **Automatic login of the owner's account:** needs FileVault off and leaves the owner's desktop open to anyone at the Mac.
- **Disabling the idle check outright:** would leave Live writes on indefinitely (RISK-09).
