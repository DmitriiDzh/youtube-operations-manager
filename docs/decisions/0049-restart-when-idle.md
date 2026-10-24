# 0049. The server restarts itself when nobody works with it

Status: Accepted

**Date:** 2026-10-24. **Requested** by the Factory Operator (FO-REQ-0038; owner, Operator Telegram 2532–2536). **Plan:**
`docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md` (BL-220), sent as DEV-RESP-0042; owner answers, Developer msg 3424.

## Context

- A restart (to load a new build) interrupts whatever runs: a media session's pod is terminated and its queued jobs fail, an upload
  pauses, a live-stream start or a segment switch is cut. Today the developer asks around before every restart (AGENTS.md §N,
  owner msg 3420), and `stop.sh` only refuses during a media session or a held operation lock.
- Under the macOS system service (BL-158) a stopped server is started again by launchd, rebuilding first if `dev` moved, so a
  graceful stop *is* a restart there.

## Decision

1. **One request at a time** (`restart_requests`, schema v108): from the owner's button in Settings → О программе or from the
   developer's `scripts/macos/restart-when-idle.sh`, which writes `restart-request.json` into the app-data folder (the same trust as
   `stop.sh`: the OS user). A second request joins the open one; the owner can cancel it; after 24 h it becomes `expired`.
2. **The check** (every 15 s, in the server process, only with `YTOM_SERVICE_MODE=1`) lists every reason to wait: an unfinished
   media session, a media job queued/submitted/generating/transferring, a Gemini job queued/submitting/running, an upload being sent,
   a live stream starting/stopping/switching (a running stream is not a reason), the operation lock, a running in-process operation
   or Batch, an active hold, an MCP call within the quiet minutes (1–30, default 3). A check that cannot be read is itself a reason
   (fail closed). With none left the request becomes `restarting` (version with its commit, schema, minutes waited) and the process
   sends itself SIGTERM once. Elsewhere a request is refused with `restart_needs_service`.
3. **Holds** (`restart_holds`): 1–60 minutes with a reason, by `factory`, `worker:<channelId>` or `owner`; several at once; a worker
   and the Operator release only their own, the owner any. A worker's hold and release are in its worker log (ADR 0048).
4. **On boot** a request left `restarting` — or still `open`, since the server has just started again — becomes `done` with the new
   version and schema (the card's "last restart"); a request file written before the start is satisfied by it and removed.
5. **The status reads do not count as MCP calls** (`factory_restart_status`, `agent_restart_status`), so an agent polling them never
   keeps the quiet window open. The Settings traffic counter misses those calls; hold and release are counted.
6. No Telegram note from the app (owner answer 1): the developer reports restarts.

## Consequences

- Factory API 1.30.0 and Agent API 4.4.0 (additive). AGENTS.md §N changes only after this is live.
- The module only reads other modules' state (`src/lib/live-streams` exposes `listLiveStreamTransitions`); removing it leaves
  every other module working (AGENTS.md §M).
- A media session still awaiting the owner's approval (`pending`) does NOT hold a restart: it runs nothing on the server and
  survives one (holding on it could block every restart for up to 24 h). Every later non-terminal session state does.

## Review additions (2026-10-24)

- **A stop that hangs.** The graceful stop can hang on a connection a browser keeps open (2026-10-13). 90 s after its own stop signal a
  process that is still running exits by itself (the shutdown hooks already ran at the signal), so launchd starts the next run --
  unless the operation lock is held (an import started meanwhile): then it waits, re-checking every 10 s, so the lock is never left behind. The
  Settings card does not ask the server anything for 2 minutes after the stop signal.
- **Only the service finalizes at boot.** Another server on the same database (a worktree's dev server) never marks the live server's
  request done or takes its request file.
- **One open request** is enforced by a unique index; a racing second request joins the first.
- **At most 3 active holds per holder.**
- **Known limits.** The quiet window counts MCP calls by their start, so a single MCP call or Web request that runs longer than the
  quiet minutes and touches none of the checked sources can still be cut by the restart. The owner's own Web activity (for example
  approving a session at the same second) is not counted; the window between the last check and the stop is under 15 s.
