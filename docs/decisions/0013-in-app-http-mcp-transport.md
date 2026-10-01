# 0013. Serve MCP over HTTP from the app; remove stdio and CLI agent mode

- **Status:** Accepted, 2026-10-01.
- **Decided by:** the project owner (chat). Reverses Phase 12 decision D0(b) of
  `docs/roadmap/plans/PHASE_12_PLAN.md`. Plan: `docs/roadmap/plans/HTTP_MCP_SERVER_PLAN.md`.

## Context

Phase 12 kept MCP as a **stdio child spawned by the agent** (D0(b)), because separate OS users per
agent were rejected. Consequences: the agent's launch configuration had to contain the project
path (`cwd`/`npm run`), the server process opened `data.db` itself as the agent's OS user, the
"MCP connection" toggle applied only on the next spawn, and every released agent setup depended on
the agent's own Node/`tsx` environment (RISK-87).

The owner wants the opposite shape ("as in Blender"): the server runs on our side; Codex/Claude only
connect and receive what we allow.

## Decision

- MCP is served by the running app at `POST /api/mcp` (Streamable HTTP, stateless, loopback only).
  The channel token is the bearer credential.
- stdio MCP and the CLI agent mode (`--agentToken`, `YTOM_AGENT_TOKEN`) are **removed**, not kept
  as a fallback. The operator CLI is unchanged.
- The channel scope becomes per request (`AsyncLocalStorage`); the process-wide
  `enterAgentSession` is removed.
- Missing/invalid token and a disabled MCP connection produce **explicit errors** (401/403) instead
  of an empty tool list (owner instruction), amending AC-P12-01's "zero tools".
- The whole web server binds to `127.0.0.1`.
- `AGENT_API_VERSION` → 2.0.0 (breaking for every released agent configuration).

## Consequences

- The agent's configuration holds a URL and a token only — no project path.
- The toggle, token revocation and rotation take effect on the next request.
- The app must be running for an agent to connect.
- The web process now evaluates agent calls, so "no scope" means operator mode there; a guard
  asserts the scope immediately before every tool handler (fail-closed), and a concurrency test pins
  scope isolation.
- **Unchanged residual risk (RISK-87):** an agent running as the same OS user can still open
  `data.db` if it finds it. This decision removes the pointer from the agent's configuration; it
  does not add OS-level isolation.
- The app is no longer reachable from other devices on the network (loopback bind).
