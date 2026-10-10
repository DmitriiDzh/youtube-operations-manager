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
5. **Every channel-tool answer names its channel** (`forChannelId`) and **every call is logged** (`producer_call_log`, v72,
   device-local, 90 days), shown on the Producer card in Settings → AI Agent: the server logs each call that reaches a tool; the
   endpoint logs each `tools/call` that never reached a tool, matched by tool and channel (`TOOL_NOT_FOUND` for an unknown or
   non-Producer tool, `INVALID_PARAMS` for a refused input, e.g. a missing `channelId` or a `credentialRef`, which the Producer's schemas
   leave out, `REQUEST_REJECTED` when the transport rejected the whole request).
   The log is best effort: a failed log write does not fail the read (fail-open, like the traffic counter).
6. **The portfolio overview** reads the stored data of every connected channel directly (channel-level analytics, synced videos,
   freshness; Reach through the channel's scope) -- it is the Producer's own read of what the device stores, not a channel tool. A
   figure with nothing stored behind it is null; analytics days are YouTube's reporting days, uploads are counted by UTC date.

## Consequences

- No DRAFT, WRITE, quota-spending research request, media session or job for the Producer; a future capability is a new entry in the
  closed list with its own test, or a new decision. (Amendment 1 below adds the Producer's proposal tools, its only DRAFT ones.)
- The Producer sees every channel connected on the device, whichever Google account connected it, including a second Mac user's
  accounts (owner msg 2198: the Settings list is the boundary).
- Same residual as the other roles (RISK-105): a process running as an OS account that can read the token file can use it.
- This ADR records the interface; it contains no operating instructions for the role (AGENTS.md §B).

## Amendment 1 — proposals (BL-163, FO-REQ-0014 §C, owner 2026-10-09, Telegram msg 2311)

- **The Producer may propose; it still cannot change anything.** Producer API 1.1.0 adds three tools of its own: `producer_propose` (DRAFT),
  `producer_list_proposals` (READ) and `producer_mark_proposals_done` (DRAFT). A proposal is a row in `agent_proposals` (schema v74,
  `src/lib/agent-proposals`), one of our channels per proposal; it changes nothing until the owner approves it in the Web UI
  (Research → Inbox). Then the system makes the change through the same services the UI uses. Spec §26: AI may propose, a human approves,
  the system applies.
- **Kinds (v1):** watchlist add / unfollow / pause / resume / delete, and hypothesis add. A hypothesis created this way (`createdVia: "mcp"`)
  supersedes PHASE_10_SLICE_2_PLAN's "hypothesis creation is Web-only" for this approved path only; the Web route still performs the creation.
- **Pinned by tests:** `producer_get_capabilities` reports `permissions: ["READ", "DRAFT"]` and exactly these two `draftTools`; the channel
  tools of the closed list are still READ only; an inventory test fails if `src/mcp`, `src/cli`, `src/lib/agent-operations` or
  `src/app/api/mcp` names the owner's approve / reject / apply side, and only the Web routes build the review core.
- **Not changed:** no WRITE tool, no YouTube call, no quota spent by a proposal; channel agents do not get these tools.

## Amendment 2 — upload milestones (BL-166, FO-REQ-0015 items 1 and 8, owner 2026-10-09, Telegram msgs 2381, 2414)

- Producer API 1.2.0 adds two READ tools: the channel tool `agent_get_video_milestones` (closed list, capability
  `analytics.query_video_milestones`) and its own `producer_upload_milestones` (every connected channel's uploads in a range of at most 92
  days, each with its stored day-7 / day-28 totals and the Reach of the same window). Both read stored data only.
- The Producer session's real deps moved from the route file to `src/lib/producer-mcp-endpoint/session-deps.ts` (a route may export only
  its handlers), so they are tested on a real database; the approval inventory scan covers that directory too.
- **Not changed:** the DRAFT tools, the permissions, the per-call channel scope.

## Amendment 3 — stored traffic sources and devices (BL-168, FO-REQ-0015 item 2, owner 2026-10-10, Telegram msg 2435)

- Producer API 1.3.0 adds one READ channel tool to the closed list: `agent_get_stored_breakdowns` (capability
  `analytics.query_stored_breakdowns`), stored data only, in the named channel's scope like every other channel tool.
- **Not changed:** the Producer-only tools, the DRAFT tools, the permissions, the per-call channel scope.

## Amendment 4 — stored search terms (BL-169, FO-REQ-0015 item 5, owner 2026-10-10, Telegram msg 2473)

- Producer API 1.4.0 adds one READ channel tool to the closed list: `agent_get_stored_search_terms` (capability
  `analytics.query_stored_search_terms`), stored data only, in the named channel's scope like every other channel tool.
- **Not changed:** the Producer-only tools, the DRAFT tools, the permissions, the per-call channel scope.

## Amendment 5 — experiment arms (BL-170, FO-REQ-0015 item 3, owner 2026-10-10, Telegram msg 2482)

- Producer API 1.5.0 adds one READ channel tool to the closed list, `agent_get_experiment_results` (capability
  `decision_engine.query_experiment_results`), and one proposal kind, `experiment.link_video` `{ experimentId, videoId, arm }`.
- The kind follows `hypothesis.add`: it is checked against the proposal's own channel when submitted (the Producer is not in that channel's
  scope then), approved only while that channel is the owner's active one, and applied through the decision engine's own link function,
  recorded as `producer_proposal`.
- **The Producer may propose experiments** (owner, Telegram 2026-10-10 msg 2485, option 1 of three: this tool, a new Inbox proposal kind, or
  none): the channel agent's DRAFT tool `create_experiment_proposal` is on the Producer's endpoint by name (`PRODUCER_DRAFT_CHANNEL_TOOLS`,
  exactly one, its capability pinned to DRAFT by the test). Like every channel tool it runs per call in the named channel's agent scope,
  so the hypothesis must be that channel's. The experiment it creates is always `proposed`; approving, running and abandoning stay the
  owner's (Web UI). This amends "the Producer's only DRAFT tools are its proposal tools": `draftTools` lists three.
- **Not changed:** the Producer-only tools, the permissions (`READ`, `DRAFT`), the per-call channel scope.

## Amendment 6 — own-video comments (BL-171, FO-REQ-0015 item 7, owner 2026-10-10, Telegram msg 2491)

- Producer API 1.6.0 adds one READ channel tool to the closed list: `agent_get_video_comments` (capability
  `video_context.query_video_comments`), stored data only, in the named channel's scope like every other channel tool.
- **Not changed:** the Producer-only tools, the DRAFT tools, the permissions, the per-call channel scope.
