# 0011. Retire agent capability zones (BL-091) in favour of channel-bound agent tokens

- **Status:** Accepted, 2026-09-30.
- **Decided by:** the project owner, Telegram, Phase 12 decision D4. Msg 1051: "D4 нет"; clarified
  in msg 1053, *"один агент отвечает за все на одном канале"* ("one agent is responsible for
  everything on one channel"), and again in msg 1055.
- **Context:** `docs/roadmap/plans/PHASE_12_PLAN.md`.

## Context

BL-091 (`docs/roadmap/plans/AGENT_ZONES_PLAN.md`) split *capabilities* between agent
connections, for example "Claude does translations, Codex does the rest".
- Identity was a self-declared `AGENT_CONNECTION_ID`, with no secret.
- Zoning covered 8 mutating actions, no reads, and no channel dimension.

Phase 12 replaces the split with channel binding. Each agent holds an operator-issued channel
token, and one agent does *all* the work of its one channel (owner decisions D3/D4).

## Decision

- Remove capability zoning from the MCP server and the CLI.
- Remove the `src/lib/agent-connections` module, its `/api/agent-connections*` routes, the
  Settings UI card, the `AGENT_CONNECTION_ID` / `--agentConnectionId` identity, and the
  `AGENT_ZONE_VIOLATION` / `AGENT_CONNECTION_*` error codes.
- The only agent identity is now the channel token (`src/lib/agent-tokens`,
  `src/lib/agent-session`).
- **Tables are kept.** `agent_connections` and `agent_capability_zones` (SCHEMA_MIGRATIONS v20)
  stay in the schema, inert, with nothing reading or writing them. Dropping tables is a
  subtractive schema change that `docs/decisions/0001-additive-idempotent-schema-strategy.md`
  does not allow as an incidental part of another task. Any real cleanup needs its own
  migration and ADR.

## Consequences

- **Breaking for agent clients.** A client configured with `AGENT_CONNECTION_ID` must switch to
  `YTOM_AGENT_TOKEN`. This is part of Phase 12's MAJOR `AGENT_API_VERSION` bump.
- **Existing data:** zone assignments stored in the database are ignored from now on.
- **Tests:** zone-wiring tests and `server.zone-enforcement*.e2e` were removed with the feature.
  The requirement they verified no longer exists. The channel-binding inventory tests (AC-P12-08)
  replace them as the "every agent surface is gated" guarantee.
