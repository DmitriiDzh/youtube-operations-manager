# 0034. The Producer role: a read-only agent that reads every channel, one channel per call

Status: Accepted

**Date:** 2026-10-09.

**Requested** by the Factory Operator (FO-REQ-0012, from its accepted design "Producer", option C of its research R-0002) and
**decided** by the owner (Telegram, 2026-10-09, msgs 2195–2207): the Producer works from the channel list in Settings and learns the
channel folders there; read only in this version; analytics tools as for a channel agent. Plan: `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md`
§3 (BL-161).

## Context

A channel token sees one channel; the factory token sees no channel data. The Producer compares channels side by side, so it needs
every channel's reads without a worker per channel, and nothing else.

## Decision

1. **Own token, table, endpoint**: `ytom_pr_<secret>` (`producer_agent_tokens`, schema v72, hash only, one active, no channel, no
   Google identity), `POST /api/mcp/producer` (loopback, the MCP connection switch, re-verified on every call). Channel and factory
   tokens are refused there and a producer token on the other two endpoints (prefix and table). Shared between devices by ADR 0033.
   The token logic is shared with the factory role (`src/lib/role-agent-tokens`).
2. **A producer mode of `createMcpServer`**, chosen only by the producer endpoint after verifying a producer token, never by the
   caller. ADR 0022 kept the factory out of `createMcpServer` because "a flag would make isolation depend on one missing check"; here
   the mode exists to reuse the channel tools unchanged, and the isolation is pinned three ways: the closed list
   `src/mcp/producer-tools.ts` (each entry names its capability, which a test requires to be READ), a test that `tools/list` equals
   the list exactly, and a test that a channel session never lists a `producer_*` tool. The SDK registration still happens in one
   place.
3. **Per-call scope**: every channel tool takes a required `channelId`. The server resolves that channel's connected Google account
   on this device (none: `CHANNEL_NOT_ACTIVE`, nothing read) and runs that one call inside the existing agent scope for that channel
   (`runInAgentSession`), so it sees exactly what the channel's own agent sees, through the same checks (selected channel, credential
   override refusal, market-assignment and decision-engine filters). The scope wraps the call, never the request.
4. **Tools** (Producer API 1.0.0): 26 READ tools of the channel agent (channel and video context including the editorial profile,
   analytics incl. the three that may read YouTube Analytics live as for a channel agent, reach, data quality, weekly reports, asset
   performance, comparable videos, market reads, proposals, hypotheses, generation plans, the channel workspace), plus
   `producer_get_capabilities`, `producer_list_channels` (the Settings channels with this device's folder) and
   `producer_portfolio_overview` (KPIs side by side from local data only, `src/lib/portfolio-overview`). `query_market_intelligence`'s
   watchlist channel is `watchlistChannelId` there.
5. **Every answer names its channel** (`forChannelId`) and **every call is logged** (`producer_call_log`, v72, device-local, 90 days),
   shown on the Producer card in Settings → AI Agent.

## Consequences

- No DRAFT, WRITE, quota-spending research request, media session or job for the Producer; a future capability is a new entry in the
  closed list with its own test, or a new decision.
- The Producer sees every channel connected on the device, whichever Google account connected it, including a second Mac user's
  accounts (owner msg 2198: the Settings list is the boundary).
- Same residual as the other roles (RISK-105): a process running as an OS account that can read the token file can use it.
- This ADR records the interface; it contains no operating instructions for the role (AGENTS.md §B).
