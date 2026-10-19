# 0044. "Live writes" is on by default and stays as the owner left it

Status: Accepted

**Date:** 2026-10-19. **Decided by** the owner, Telegram msg 3157. He chose option (2) of msg 3155, after the consequences were
spelled out: "Я думаю можем уже сделать (2). Мы достаточно потестили и не ожидаю пока ложных срабатываний / публикаций. Но тумблер
останется на случай если надо будет отключить." The request came up with FO-REQ-0032: automatic live-stream segments need writes
without the owner pressing a button.

## Context

Gate B (RISK-09, 2026-09-21) made the Settings toggle "Live writes" the first layer of every real YouTube write. It was off at the
start of every web-server session:
- `resetLiveWritesForNewServerSession` ran at boot and on SIGINT/SIGTERM;
- the macOS service's idle "end session" reset it after 10 minutes without a window;
- a lapsed session lease turned it off for good.

Every write path calls `assertLiveWritesAuthorized()` right before its gateway write: Batches, single-item apply, video details,
playlists, publishing uploads, live streams and the Operator over MCP.

## Decision

1. **Default on.** A toggle that was never set counts as on.
2. **No automatic reset.** Nothing turns it off by itself any more:
   - server boot and shutdown no longer reset it (`resetLiveWritesForNewServerSession` is removed);
   - the service's idle handler no longer resets it either; its "end session" action only logs.
3. **The owner's switch stays.** Turning it off persists until the owner turns it on again. `assertLiveWritesAuthorized()` and
   every call site are unchanged, so "off" stops every write path at once, as before.
4. **The session lease stays as a liveness check, no longer as a switch-off.** Writes are honored only while the web server keeps
   renewing its lease. This stops an orphaned MCP or CLI process from writing while the app is down. A lapsed lease refuses writes
   but no longer persists "off": once the server is back, writes work again without the owner's action.

## Consequences

- Every write path works without the owner switching anything on first. What guards a write is now:
  - each path's own checks: identity (`assertWriteChannel`), dry run and approval, backup, read-back;
  - Batches' second layer (a real `WriteExecutor` and Execute);
  - the owner's toggle when he turns it off.
- RISK-09's "off by default every session" mitigation is withdrawn by the owner's decision. `docs/TECHNICAL_DEBT.md` records this
  under RISK-09.
- Unattended live-stream segments (FO-REQ-0032) still need their own ADR for their scope. This one only stops the global switch
  from being a per-session gate.

## Alternatives rejected

- **A scoped standing approval only for segments (option (1) of msg 3155):** offered and recommended, but the owner chose the
  global default.
- **Removing the toggle:** the owner wants it kept, to switch everything off when needed.
