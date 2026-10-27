# 0053. Owner commands in the HUB "System" topic: one Telegram gateway, a fixed grammar, factory config, one-time approvals

Status: Accepted for building (owner, Telegram msg 3598, 2026-10-27). Plan: `docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md` (BL-228).

## Context

FO-REQ-0042: agents in Claude Code cannot act on the owner's Telegram «да» (auto mode trusts only the terminal). The owner wants
to stop/start factory jobs and approve paid calls from the HUB group's "System" topic, executed by the Manager.

## Decision

1. **A new gateway `src/lib/telegram-bot-gateway/`** is the only caller of the Telegram Bot API (the single-gateway rule for
   every external API). The bot is a dedicated one, not the Developer chat's bot; its token lives in `device-secrets` only.
2. **One listening computer.** `getUpdates` is polled only where the owner turned the per-computer switch on, and the switch is
   refused off the Mac service (two pollers would steal each other's updates). Off by default; the rest of the app does not
   depend on it (AGENTS.md §M).
3. **Only the owner, only the topic, only six commands.** Messages are accepted from one user id in one chat and one thread.
   No text is ever executed; commands map to fixed runners.
4. **Factory knowledge stays out of the repository (AGENTS.md §B).** Script paths, the workflow name and channel short names
   come from the factory-owned `commands.json`. The Manager runs its argv without a shell, inside the channel's own workspace
   root, which must match the Manager's own workspace path for that channel.
5. **Stopping fails closed.** A process is signalled only when its record's device, `pidStartedAt` and `cmdline` match the
   live process; the process group is signalled, never the Manager's own.
6. **Approvals are one-time, owner-only and hash-bound.** A request file is posted once with the Manager's own cost estimate
   and a hash of `{action, args}`; `approve` runs that exact call through the same service code as the MCP tool, within a
   per-approval cap and the existing limits, at most once and within 2 h. The state is in the DB. The owner's `approve` is
   the explicit authorization of that one paid call (AGENTS.md §K.2); there is no other way to start a paid call through
   System.

## Consequences

- A stolen Telegram account can approve calls up to the caps (owner decides the mitigation; TECHNICAL_DEBT entry).
- `stop` is useful only once the factory records carry `pidStartedAt` and `cmdline` (bundle 2.5.41).
- The Manager gains a process-spawning surface; it is bounded by the fixed grammar, the factory config and the workspace root.
