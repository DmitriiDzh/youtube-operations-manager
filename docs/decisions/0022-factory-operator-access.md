# 0022. Factory Operator access: a second agent role, separate from the channel agents

Status: Accepted

**Date:** 2026-10-05.

**Requested** by the Factory Operator role through the Developer Exchange (`FO-REQ-0001`, approved by the owner 2026-10-05) and decided by the owner
(Telegram, 2026-10-05): each machine configures only its own values; the Factory Operator needs MCP access but must not get the reads or commands of the
per-channel agents, and the per-channel agents must not get any function reserved for the Factory Operator. Plan and acceptance criteria:
`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md`.

## Context

Every MCP caller so far is a channel-bound agent (Phase 12, ADR 0013): its token is both its identity and its channel binding. A coordinating role that
is not tied to any channel needs to look up shared folders by name (the same folder has a different absolute path on each machine) and to list the
channels and their workspace folders. Giving it a channel token would bind it to one channel; giving it operator rights would hand it every tool; making
it a flag on the existing endpoint would make isolation depend on one missing check.

## Decision

1. **Registry of logical paths** (`src/lib/logical-paths/`, tables `logical_paths` and `logical_path_values`, schema v59 — numbered v50 on `dev`, renumbered at the Phase 14 merge): a stable name, an audience
   (`all_agents` or `factory_only`) and one validated path string per device. Seeded names only: `factory_shared` (`all_agents`),
   `developer_exchange` (`factory_only`). New paths are rows, not schema changes. Both tables are device-local (not in `SNAPSHOT_TRANSFERRED_TABLES`, not
   in sync-gateway); values are keyed on the bootstrap `deviceId`. The registry is paths-as-strings only: it never opens, lists or reads inside a path, and a
   read never creates the `deviceId`. Only the operator creates, sets or deletes (`/api/logical-paths`, Settings).
2. **Separate role, token, endpoint and server.** The Factory Operator has its own token (`ytom_fo_`, table `factory_agent_tokens`, schema v60 (v51 before the Phase 14 merge), SHA-256 hash
   only, one active, no channel, no Google identity), its own endpoint `POST /api/mcp/factory` and its own MCP server (`src/mcp/factory-server.ts`), not a
   subset of `createMcpServer`. A channel token is rejected on the factory endpoint and a factory token on `/api/mcp`, by prefix and by separate tables
   (both `AGENT_TOKEN_INVALID`). Shared safeguards are unchanged: loopback only, the master "MCP connection" switch, per-call re-verification, device-local
   hash-only storage. The factory endpoint never enters the channel agent scope (`src/lib/agent-session`) and reads no channel-scoped state.
3. **Four read-only factory tools, a closed list:** `factory_get_capabilities`, `factory_list_logical_paths`, `factory_get_logical_path`,
   `factory_list_channels` (channel id, title and this device's workspace path only: no account identity, tokens, videos or analytics). Factory API
   version `1.0.0`, independent of `AGENT_API_VERSION`. A path with no value on this device is the explicit error
   `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE`, never an empty path. The role has no write tool of any kind.
4. **Channel agents get two reads** (`agent_list_logical_paths`, `agent_get_logical_path`; `bound`; Agent API 3.2.0 -> 3.3.0, MINOR): the registry is pinned to the
   `channel` scope inside the handler, so only `all_agents` paths are visible; a `factory_only` name is indistinguishable from an unknown one.
5. **Mechanical enforcement:** an inventory test pins the factory server's tool names to the explicit list, forbids any `factory_*` name in
   `MCP_TOOL_CLASSIFICATION`, allow-lists what the factory server, route and endpoint may import (no YouTube gateway, database, analytics, change sets,
   batches, `agent-session`) and forbids channel-scope identifiers in those files.
6. **Stop switch and single active token.** Revoking the factory token is exempt from the recovery-mode gate (as for channel tokens, architecture audit H4), and the database enforces at most one active factory token with a partial unique index.
7. **Shared loopback guard** extracted to `src/lib/loopback-guard` (`AGENTS.md` §M); the channel endpoint's old path re-exports it.

## Consequences

- Additive: no existing behavior changes; two additive migrations; `AGENT_API_VERSION` MINOR bump. Nothing here writes to YouTube.
- Same residual limit as Phase 12 (`docs/AGENT_ISOLATION_SETUP.md` §5, `docs/TECHNICAL_DEBT.md` RISK-105): a process running as the same OS user can read
  the factory token from its client configuration or the database. The exposure is read-only (path strings and channel titles).
- A future Factory Operator capability needs a new tool in the closed list with its own test, never a widened channel tool.
- This ADR records the interface the Factory Operator consumes; it contains no operating instructions for that role (`AGENTS.md` §B).
