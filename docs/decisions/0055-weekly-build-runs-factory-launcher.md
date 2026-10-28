# 0055. «Собрать неделю»: the Manager runs the channel's factory launcher, guarded, from the Web UI only

Status: Accepted for building (owner, Telegram msgs 3747/3748, 2026-10-28). Plan: `docs/roadmap/plans/WEEKLY_BUILD_BUTTON_PLAN.md`
(BL-231, FO-REQ-0046).

## Context

The owner wants a person, not only an agent, to start the factory's weekly build (`13 Weekly_Plan v1 auto`, bundle 2.5.42) from
YT Manager. Until now the Manager never ran a factory script (ADR 0054 decision 1 for the music library): agents ran them in the
channel folder. The launcher lives in a synced, agent-writable folder.

## Decision

1. **One feature module `src/lib/weekly-build/` runs the channel's own launcher** (`<workspace>/06 Workflows/factory_launch.py`)
   with fixed arguments: `check`, `status --json`, `auto --dry-run --json`, `start … auto [--wake] --json`, `stop`, `go`. It
   reads the factory's JSON and writes nothing of its own; it is the only place in the Manager that runs a factory script.
2. **Guards before every run:** the launcher must be a regular file inside the workspace after symlinks; `factory.json` must pin
   bundle 2.5.42 or newer; `check` must pass (launcher = the bundle's template, bundle = its manifest; cached while the files keep
   size and mtime, 5 minutes); Python only from this computer's settings or the usual install folders/PATH; `execFile`, never a
   shell; a minimal environment without the server's variables.
3. **Web UI only.** Session + active channel routes; no MCP tool; a source-scan test keeps agent modules from importing it.
4. **The plan still reaches the Manager through the channel worker** (`13 push` → `agent_publishing_plan_save`): one writer of
   the Manager's plan. Packaging without an agent would be a separate decision.

## Consequences

- The Manager trusts the factory registry as far as `check` proves it (RISK-138).
- A build job is detached by the launcher, so a server restart does not stop it and restart-when-idle does not wait for it.
- Acceptance needs the channels pinned to 2.5.42 (the Operator's step).
