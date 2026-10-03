# Detached Server & Presence-Based Shutdown Plan (BL-116)

Requested and assigned by the project owner 2026-10-03 (Telegram: "Составь план и приступай к реализации"), after
noticing that the server dies when the launcher's terminal window is closed.

## 1. Target behaviour (owner's description)

1. The user clicks a shortcut.
2. If the server is not running, a terminal shows the start-up progress (install/build, then "starting").
3. When the server answers and the browser window opens, the terminal closes; **the server keeps running**.
4. While an app window is open in a browser (even with no user action), it pings the server; that is the proof the
   server is still needed.
5. With no ping for N = 10 minutes the user has finished: the server may shut itself down.

## 2. What exists today (read from the code)

- `scripts/macos/start.sh` runs `npm run start &` and `wait`s: the server is a child of the terminal, so closing the
  terminal ends it. `scripts/windows/start.bat` opens a visible `cmd /k` window that must stay open.
- `src/lib/idle-shutdown.ts`: exits after 60 minutes without any `/api/*` request (`src/proxy.ts` calls
  `recordActivity()`); armed only in production; `onIdle` flushes an export, then `process.exit(0)`. It does **not**
  look at running work.
- `getOperationRegistry().hasActive()` (ADR 0015) knows running server-side operations (Fix all, syncs, analytics
  collection, generation); `getOperationLock` knows export/import/migration; a Batch run is a `batches.status =
  'RUNNING'` row (not in the registry).
- `stop.sh`/`stop.bat` find the listener by port, wait for the operation lock, and stop it. They do not rely on the
  launcher's PID file for the listener.

## 3. Design

- **Heartbeat.** A client component mounted in the root layout calls `GET /api/presence` every 60 s (and at once when
  the tab becomes visible again). `proxy.ts` already records every `/api/*` request as activity, so the ping is exactly
  the "a window is open" signal. It works on the login page too.
- **Timeout.** Default idle window 10 minutes (was 60); `YTOM_IDLE_SHUTDOWN_MINUTES` overrides it (fractions allowed;
  for verification).
- **Never exit during work.** The idle decision becomes a pure function: stay / defer / exit. While the operation
  registry has an active operation, the operation lock is held, or a Batch is `RUNNING`, the exit is deferred (checked
  again each interval), at most 2 hours, after which it exits anyway so a stale row cannot keep the server up forever.
  The existing flush-then-exit sequence is unchanged.
- **Tab learns the server is gone.** After 2 consecutive failed pings the heartbeat shows the shared blocking dialog
  "The server has stopped" with Retry (reload), and checks again immediately when the tab becomes visible or the
  network returns. A sleeping or frozen tab simply fails its first ping on wake-up and shows this, not a browser error.
- **Detached launch (macOS).** `start.sh` runs the server with `nohup`, output to `.launcher.log`, `disown`s it, shows
  build progress in the terminal, then a readiness poll with a short progress line; after the browser opens it exits.
  `start.command` closes its own Terminal window afterwards (AppleScript by tty, only after the shell has exited so no
  "terminate running process?" prompt). `PORT` is overridable (default 3000) so the launcher can be verified without
  touching a running instance.
- **Detached launch (Windows).** `start.bat` starts the server hidden (PowerShell `Start-Process -WindowStyle Hidden`,
  output to `.launcher.log`) and exits, closing its own console. **Not testable on this Mac**: flagged as unverified.
- `stop.sh`/`stop.bat` stay the way to stop it early (they already stop by port).

## 4. Not in scope

A system service / login item that starts the server at boot; changing what the MCP agent counts as activity (its
`/api/mcp` requests are `/api/*` requests, so they keep the server alive within the 10-minute window); background
work while no server is running (device sync, Analytics auto-collection and MCP all need the server, as before).

## 5. Acceptance criteria (before code, `AGENTS.md` §L)

- AC-1: with a ping at least every 10 minutes the server does not exit; with none for 10 minutes and no active work it
  exits (pure decision function, boundaries at exactly the timeout).
- AC-2: with an active registry operation, a held operation lock, or a RUNNING Batch, an expired idle window defers the
  exit; it exits once the work ends, and at the latest 2 hours after the idle window expired.
- AC-3: the idle exit still runs the existing publish-then-exit sequence (no behaviour change there).
- AC-4: `GET /api/presence` is answered without a session and without touching the database.
- AC-5: 2 consecutive failed pings show the "server stopped" dialog; one failure does not; a success clears the
  failure count; the dialog offers Retry and cannot be dismissed otherwise.
- AC-6 (live, macOS, `PORT=3100`): after `start.sh` returns, the server still answers; closing the launching shell does
  not stop it; `stop.sh` stops it; a repeat `start.sh` while running restarts cleanly.
- AC-7 (live): with `YTOM_IDLE_SHUTDOWN_MINUTES` small and no pings the process exits by itself; with a page open (pinging)
  it does not.
- AC-8: Windows scripts are changed and reviewed but explicitly reported as unverified on Windows.

## 6. Risks

- A background/frozen tab may stop pinging while open (browser memory-saver): the server may stop under it; the dialog
  explains and Retry/relaunch recovers. N = 10 min with 60 s pings tolerates normal background throttling.
- Detached server output goes to `.launcher.log` (gitignored): it can grow; truncated on every launch.
- Terminal-window closing depends on Terminal.app scripting permission; if it fails, the window simply stays (harmless).
