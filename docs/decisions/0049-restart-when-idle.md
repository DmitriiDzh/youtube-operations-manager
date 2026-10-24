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
- A media session awaiting the owner's approval (`pending`) counts as unfinished, as the plan says, so it keeps a restart waiting
  until it is decided or the request expires.
