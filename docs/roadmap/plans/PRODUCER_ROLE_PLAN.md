# Agent tokens shared between devices, and a read-only Producer role (BL-160, BL-161; FO-REQ-0012)

**Requested** by the Factory Operator in FO-REQ-0012 (2026-10-09): a "Producer" agent role that reads every channel and
writes nothing. **Assigned** by the owner in Telegram on 2026-10-09:

- msg 2195 "Да" (look at it), msg 2198 (tokens live in synced folders, so "я ожидаю что эти токены везде будут одинаковы";
  the Producer works from the channel list in Settings and learns the channel folders there);
- msg 2200 "Да, можно сделать чтобы токены всех агентов работали одинаково" — every agent token (channel, Factory Operator,
  Producer) is accepted on every device without a manual import, and a revocation reaches every device.

One branch `feature/producer-role-synced-tokens`, two backlog items: BL-160 (tokens shared between devices) first, BL-161
(Producer) on top of it.

## 1. What exists today

- **Tokens** (ADR 0013, 0022, 0024): `agent_channel_tokens` (`ytom_ch_<channelId>.<secret>`, Google user recorded at issue),
  `factory_agent_tokens` (`ytom_fo_<secret>`, one active, partial unique index). SHA-256 of the whole token only. Device-local:
  not in the snapshot, not in any sync family. A token works on a second device only after "Use an existing token" there
  (BL-130); revoke and rotate act on one device (RISK-108). Disconnecting a channel revokes its token
  (`src/app/api/channel-connections/disconnect/route.ts`). `verifyToken` reads only the local table; a channel token also needs
  the channel connected on this device under the Google account recorded at issue (`users.id` = Google `sub`, the same on
  every device).
- **Sync** (ADR 0012, 0028, 0030): the sync runner (`src/lib/sync-gateway`) exchanges one file per device per family through
  the Syncthing-shared "YT Manager Data" folder, every 60 s (`run-all-families.ts`, `src/instrumentation.ts`). Per-device report
  families (`per-device-report`): each device writes only its own strict-JSON report and keeps every peer's latest one; a report
  naming another device than its file, or dated more than 5 min ahead, is refused. Nothing in the folder is signed.
- **Agent endpoints**: `/api/mcp` (channel-bound, enters the agent scope per request, `createMcpServer`), `/api/mcp/factory`
  (own server, never enters the scope). Every channel read tool confines itself through the per-request scope
  (`src/lib/agent-session`: `getSelectedChannelId`, `resolveEffectiveCredentialRef`, market-assignment and decision-engine
  filters). The capability registry (`src/lib/agent-operations/services.ts`) gives each tool a permission class.
- **No per-call audit**: agent calls are only counted (`gateway_call_events`, category `mcp_tool_calls`, 7 days).

## 2. BL-160 — agent tokens shared between devices

### Design

- **A new per-device report family `agent-tokens`** in `src/lib/sync-gateway` (mirrors `media-sessions`): each device publishes
  every token record it knows; nothing is merged inside the family. Record: `{hash, role: channel|factory|producer,
  channelId|null, userId|null, label|null, createdAt, revokedAt|null}`. Never the token itself.
- **A new module `src/lib/agent-token-sync`** owns the rules (AGENTS.md §M: shared by three token modules, owned by none).
  Each token module exposes a small sync port (list its records; adopt records; revoke by hash) and keeps owning its table.
- **The rules** (a pure function; every device computes the same result from the same records):
  1. Records are joined by hash. A hash seen as revoked anywhere is revoked (earliest `revokedAt`). Revocation never undoes.
  2. The same hash with a different role, channel or Google user than this device's own row is ignored (the local row wins).
     Two peers disagreeing about a hash this device does not know: the hash is skipped.
  3. One active token per slot (each channel; the factory; the producer). Among a slot's unrevoked records the newest
     `createdAt` wins (tie: the larger hash); the others are revoked with the winner's `createdAt` as their `revokedAt`.
  4. A learned record is stored in its role's table with its own `createdAt`, `label` and (for a channel) Google user. Losers
     are revoked before a winner is inserted, in one transaction (the factory and producer one-active indexes never trip).
- **Verification is unchanged and local**: the tables stay device-local for the snapshot; the family only fills them. A token
  this device knows keeps working when the shared folder is unavailable.
- **When**: the family runs with the others every 60 s, plus once 5 s after start; an issue, rotate or revoke publishes this
  device's report at once (best effort: a failure to share never fails the action). A revocation reaches another running
  device in about 1–2 minutes plus Syncthing's delivery; a device that is off accepts the token until it syncs.
- **Disconnecting a channel no longer revokes its token** (it would revoke it on every device). The token stops working on that
  device because the channel is no longer connected there, and works again if the channel is reconnected under the same Google
  account. Revoke is the one action that stops it everywhere.
- **"Use an existing token" stays** (needed while a device is on an older build or has no shared folder); its texts and the
  revoke texts change from "this device only" to "every device after sync".

### Acceptance criteria (written before the code)

- **AC-ST-01** A token issued on device A is accepted on device B after B receives A's report — no import.
- **AC-ST-02** Revoke on A: refused on B after the exchange. Rotate on A: the old token refused and the new one accepted on B.
- **AC-ST-03** Revocation is monotonic: no report, including one listing a revoked hash as active, makes it active again.
- **AC-ST-04** Two different active tokens for one slot on two devices: after the exchange both devices keep the newer one
  (expected by hand: `createdAt` 10:00 vs 10:05 → the 10:05 one; equal times → the larger hash) and both refuse the other.
  The same for the factory and the producer slot.
- **AC-ST-05** A peer record whose hash this device knows under another role, channel or Google user changes nothing.
- **AC-ST-06** With the shared folder unavailable, every token this device knows verifies exactly as before; a learned channel
  token still needs the channel connected here under the recorded Google account.
- **AC-ST-07** The report never contains the token: the issued token's text appears nowhere in the published bytes.
- **AC-ST-08** Disconnecting a channel does not revoke its token; while disconnected it is refused on that device; after
  reconnecting under the same account it is accepted; another device keeps accepting it throughout.
- **AC-ST-09** Issue, rotate and revoke publish at once; a publishing failure does not fail them.
- **AC-ST-10** Real database: adopting a winning factory/producer record when another is active locally never violates the
  one-active index; the loser ends revoked.
- **AC-ST-11** A peer on an older build (no report) changes nothing; import keeps working.
- Review round 1 additions: a revocation reaches a device that was off for more than a week (reports never go stale; an unchanged
  report is republished daily); a peer record dated more than 5 min ahead is ignored; a token's `createdAt` is the earliest any device
  knows (an imported copy is re-dated).

## 3. BL-161 — the Producer role

### Design

- **Token** `ytom_pr_<base64url of 32 bytes>`, table `producer_agent_tokens` (schema v72; hash only, one active, partial unique
  index), module `src/lib/producer-agent-tokens` (mirrors the factory module), `GET/POST/DELETE /api/producer-agent-token` and
  `/import`, a "Producer token" card in Settings → AI Agent. Shared between devices by BL-160.
- **Endpoint** `POST /api/mcp/producer` (`src/lib/producer-mcp-endpoint`): loopback only, the MCP connection switch, Bearer
  token, re-verified on every call; a channel or factory token is refused here, a producer token on the other two endpoints.
- **Server**: `createMcpServer` gains a `producer` mode with a closed tool list. The answer to ADR 0022's "a flag would make
  isolation depend on one missing check": the mode is chosen only by the producer endpoint after verifying a producer token
  (never by the caller), the list is closed and mechanically tied to the capability registry's READ class, and `tools/list` is
  tested to equal it exactly.
- **Per-call scope**: each producer call names `channelId`; the wrapper resolves that channel's connected Google user on this
  device (none → refused, fail closed) and runs that one call inside the existing agent scope for that channel. So a producer
  call sees exactly what that channel's own agent sees, through the same checks. The scope wraps the call, not the request.
- **Tools** (Producer API 1.0.0): the channel agent's READ tools — `agent_get_channel_context` (includes the editorial profile),
  `channel_video_list`, `agent_get_video_context`, `agent_query_channel_analytics`, `agent_query_channel_breakdown`,
  `agent_query_channel_reach`, `agent_query_video_analytics`, `analytics_data_quality`, `analytics_comparable_age`,
  `analytics_weekly_reports_list`, `analytics_weekly_report_get`, `agent_list_asset_performance`,
  `agent_find_comparable_videos`, `query_competitors`, `query_market_intelligence`, `query_market_overview`,
  `agent_list_market_records`, `agent_get_collection_request`, `agent_get_collection_limits`, `agent_get_content_proposal`,
  `agent_list_content_proposals`, `agent_list_hypotheses`, `agent_get_hypothesis_trail`, `agent_list_generation_plans`,
  `agent_get_generation_plan`, `agent_get_channel_workspace` — each with a required `channelId` (added where the channel tool
  has none; `query_market_intelligence`'s watchlist id becomes `watchlistChannelId`). Plus three of its own:
  `producer_get_capabilities`, `producer_list_channels`, `producer_portfolio_overview`. No DRAFT, WRITE or YouTube-write tool.
- **Analytics reads**: the three analytics tools that may read YouTube Analytics live do so exactly as for a channel agent
  (the analytics reads switch applies; no Data API quota) — proposed in msg 2205; no objection, proceeded as proposed (msg 2208).
- **`producer_list_channels`**: every channel in Settings → Channels on this device (connected, any Google account) with its
  title and this device's workspace folder (or null).
- **`producer_portfolio_overview {startDate, endDate}`**: per channel, from local data only: views, watch minutes, subscribers
  gained and lost (`channel_metrics_daily`), impressions and CTR (reach reports), uploads published in the range (synced
  videos), and freshness (last video sync, last analytics collection, reach coverage).
- **Call log**: table `producer_call_log` (v72, device-local): time, tool, channel, outcome, error code; pruned after 90 days;
  the last calls shown on the Producer card. Producer calls also count in the MCP traffic counter.
- **Out of this version**: market-research and collection requests (they spend the 100-a-day search quota), any DRAFT or WRITE
  capability, media sessions and jobs.

### Acceptance criteria (written before the code)

- **AC-PR-01** Issue, rotate, revoke and import as for the factory token; shown once; hash only; one active.
- **AC-PR-02** `/api/mcp/producer` refuses non-loopback (403), non-POST (405), switch off (403), no token (401), a channel or
  factory token (401); a producer token is refused on `/api/mcp` and `/api/mcp/factory`.
- **AC-PR-03** `tools/list` equals the closed list; every channel tool in it maps to a READ capability; a channel session
  never lists a `producer_*` tool.
- **AC-PR-04** A call without `channelId` is refused at input; a channel not connected on this device is refused and nothing
  is read.
- **AC-PR-05** With two channels X and Y, a call for X never returns Y's rows (videos, analytics, proposals, market records
  assigned to Y, hypotheses of Y).
- **AC-PR-06** Every channel-scoped result names its `channelId`.
- **AC-PR-07** `producer_list_channels` returns exactly the connected channels with title and workspace path (or null).
- **AC-PR-08** `producer_portfolio_overview` totals equal hand-computed sums of fixture rows; it makes no live call.
- **AC-PR-09** Every producer call, allowed or refused, is logged with tool, channel and outcome; the log is device-local. (Review round 1:
  including the calls the MCP layer refuses before any tool runs -- an unknown tool, a refused input.)
- **AC-PR-10** `producer_get_capabilities` reports role `producer`, Producer API `1.0.0`, its tools, permissions `["READ"]`.
- **AC-PR-11** Channel tokens see exactly what they saw before (existing tests unchanged).

## 4. Risks and documents

- **RISK-108** resolved (revocation now reaches every device). **New risk**: the shared folder is trusted — whoever can write
  "YT Manager Data" can register a token or replace a report; on the Mac the T9 drive has ownership disabled, so every local
  account can also read the token files that the owner keeps in the channel folders, and the service answers loopback calls
  from every account (RISK-105 extended). Owner informed (msg 2205).
- Clocks: rule 3 trusts `createdAt`; a report more than 5 min in the future is refused.
- Amended: ADR 0024 §3 (superseded by the new ADR), `AGENT_TOKEN_IMPORT_PLAN.md` AC-TI-08 and AC-TI-10 (the requirement
  changed: owner msg 2200), the snapshot/data-policy reasons of the token tables, `docs/AGENT_ISOLATION_SETUP.md`,
  `docs/interfaces.md`, SYSTEM_MAP, ARCHITECTURE.
- Release note: a device on an older build neither sends nor receives tokens; update both computers.

No live YouTube call, no paid call in development or tests.
