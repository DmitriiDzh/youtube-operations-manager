# Agent-initiated competitor collection, approved by a human — plan

Status: PLAN, owner decisions recorded 2026-10-04 (section 7); implementation on `feature/agent-collection-request`. Source: operator request in `2026-10-04-research-data-not-scriptable.md` ("Feature request 2026-10-04"), owner direction 2026-10-04 ("add the ability for the agent to request research collection through MCP; we can compute the estimate ourselves; I approve such requests on the Research tab").

## 1. What exists (code facts, verified by reading)
- Competitor snapshots are created only by `runCollectionIfStale` (fire-and-forget `POST /api/market-intelligence/collect-if-stale`, once per dashboard mount) and the manual "fetch public snapshot". No timer. Needs `market_intelligence_daily_quota_budget_units` set (owner set 1000). Unit = YouTube quota unit (not model tokens).
- Closest precedent: `agent_create_market_research_request` — DRAFT tool, local insert only (`createMarketResearchRequest`), human approve/reject in the Research tab (`market-research-requests-panel.tsx`), atomic `UPDATE … WHERE status=… RETURNING` transitions in `db.ts`, approve checks preconditions + credentials BEFORE the transition, execution failure is recorded as `execution_failed`. Approval symbols are fenced by `market-research-request-approval-inventory.test.ts`.
- `search.list` (discovery) has its own bucket; collection spends the units pool. Collection claims channels atomically (`claimStaleResearchChannelsForCollection`: stale >24 h, not claimed, not failed in last 24 h) — there is no way to collect an explicit list of channels today.
- Credentials need only a stored user id with a refresh token, not an open browser; the approve route has the approver's session.

## 2. Design
**Tool (MCP, DRAFT, zero YouTube calls, zero quota):** `agent_create_collection_request { researchChannelIds?: string[] (default: all watchlist channels the agent may see), reason?: string (≤ 500), force?: boolean }`.
- Confinement: every id through `assertAvailableToAgent("research_channel", id)`; ownership recorded like research requests (`recordAgentOwnership`, new kind `collection_request`).
- Rules: at most one OPEN request (pending/approved/running) per channel — otherwise refused with the existing request id; a channel collected successfully inside the 24 h stale window is reported `not_needed` (no record for it) unless `force`; at most N channels per request (proposal: 50); `reason` is shown to the human verbatim.
- Result: request id, per-channel estimate, total, `dailyBudgetUnits`, `unitsSpentToday`, `remainingTodayUnits`, `fitsToday`.
**Estimate (local, no API):** per channel from `resolveCollectionDepth` (cap, publishedAfter), stored distinct count and `needsBackfill` state: backfill = `1 + pages` expected where pages = ceil(max(0, cap − stored) / 50) (+1 for page 1 refresh), worst case `1 + 2 × pages` (each page's `videos.list` fallback); steady state 2–3. Reported as `{expectedUnits, worstCaseUnits}`. The deeper pages' real count is unknown until YouTube answers (a channel may have fewer videos than the cap), so it is an upper bound and labelled so.
**Table `market_collection_requests` (migration v49, additive):** id, channel_ids_json, reason, force, status (`pending|approved|running|done|rejected|failed`), estimate_json, created_via, agent_api_version, created_at, approved_at, approved_by_user_id, resolved_at, resolved_reason, result_json (per channel: `completed|partial_budget|failed|skipped` + videos stored, `observedAt` of new snapshots, units spent), units_spent_total, error. Transitions are atomic `UPDATE … WHERE status = expected` like the research-request ones; `approved → running → done|failed`.
**Approve & run (human, Web only):** `POST …/collection-requests/[id]/approve` (session) — preconditions (budget set, Data API reads on, credentials resolve) BEFORE the transition (a failure leaves it pending), atomic `pending→approved→running`, then a FORCED collection for the listed channels: new store function `claimResearchChannelsForCollection(ids)` keeps only the "not currently claimed" condition (drops stale + failed-backoff, because a person explicitly approved), the per-channel loop of `runCollectionIfStale` is extracted into one helper used by both entry points so budget gate, post-claim budget recompute, charge-before-call, success-row-before-mark, claim release in `finally` stay identical. Unfinished backfills keep their cursor; the next `collect-if-stale` (or a new request) continues them — the request is `done` with `partial_budget` per channel, never silently "complete". Runs in the server process in the background with progress shown in the panel (collection can be long); a boot-time sweep turns an orphaned `running` row into `failed (interrupted)`.
**Reject:** with a reason, collects nothing. The agent can neither approve nor run: the MCP subset exposes create + read only; approve/reject/run symbols stay out of `src/mcp`, `src/cli`, `src/lib/agent-operations` (inventory test extended to the new names).
**Follow-up (READ):** `agent_get_collection_request` (by id or list; status, per-channel result, new snapshots' `observedAt`, units spent) and a pointer field in `query_market_overview` (`openCollectionRequestId`). No auto-approval of anything an agent creates, ever.
**UI (Research tab):** new "Collection requests" panel (or a second section in the existing requests panel): pending list with reason, estimate per channel and total, remaining budget today; Approve opens `ConfirmDialog` stating the cost; Reject asks a reason; running shows progress; resolved rows show per-channel result and units. English text, no native dialogs.
**Versioning/docs:** Agent API 3.1.0 → 3.2.0 (new capability; assertion in `server.test.ts`), `tool-classification` = `bound`, capability entry DRAFT, `AGENT_OPERATIONS_INTERFACE.md`, `interfaces.md`, `SYSTEM_MAP.md`, short ADR 0021 (collection requests; the forced-claim path and why the human approval replaces the stale window).

## 3. Slices (ONE branch, per AGENTS §K.1)
1. Migration v49 + store functions + service (create/estimate/approve/reject/run) + tests (hand-computed estimates, atomic transitions, one-open-per-channel, not_needed, budget refusal, forced claim ignoring stale/backoff, claim release on failure).
2. MCP tool + read tool + classification + capability + version bump + CLI parity (`agent create-collection-request`, like `create-research-request`) + tests.
3. Web routes + panel + route tests.
4. Background execution, progress, boot recovery of `running` rows.
Independent review before the merge approval (touches quota accounting and a new approval path). Real YouTube behaviour stays unverified except by the owner's first approved request on a small channel set.

## 4. Deferred — recurring requests (operator item 5)
Not in the first slice. A series approved once ("daily for N days, stop button") means a timer calling YouTube with a stored user id; `db.ts` and spec §29 say agents must not create unlimited collection jobs and `monitorDurationDays` is metadata only. It needs its own ADR: human-set recurrence with a hard expiry and max runs, stored approver user id and refresh token, visible stop, and the same daily budget cap. Decision requested separately.

## 5. Open decisions for the owner
1. Estimate = upper bound of units (`expected` and `worstCase`), labelled as such. OK?
2. `not_needed` is returned in the tool result and creates no record. OK?
3. Run in the background with progress (recommended) vs. a blocking pop-up like Send-to-YouTube?
4. Max channels per request (proposal 50) and `reason` length (500).
5. Recurring requests: not in v1 (recommended). OK?
6. A forced run bypasses the 24 h stale window and the failed-channel backoff because a person approved it. OK?

## 6. Answers recorded for the operator's open points (same day)
- How the cap is set: Settings → API → "Competitor collection depth" (global default) and per channel in an opened watchlist entry (override); both `maxVideosPerChannel` (1–2000) and `publishedAfter` (`YYYY-MM-DD`). A collection starts when the dashboard is opened (stale channels, budget set) — or, after this plan, by an approved request.
- `collection.complete`: true when a deep collection finished under the settings in force; `completeReason` `exhausted` (whole uploads list read), `cap`, or `date`. A channel never collected under the new logic has `complete=false` and null reason even if everything is stored (the state columns are NULL until the first collection, e.g. Silent Temple with 44 of 44). Its first collection under the new logic sets `complete=true`, `exhausted`.
- Stale tool descriptions after `/mcp` Reconnect: descriptions are static strings built per request by a stateless endpoint, no server cache; the live build contains the new text. A stale view comes from the client's own tool-list cache (or another app instance on another machine/port). Capabilities come from a different, always-fresh call.

## 7. Owner decisions (2026-10-04, Telegram) — they override sections 2/4/5 where they differ
1. Estimate = upper bound (`expectedUnits`, `worstCaseUnits`): OK.
2. A channel collected successfully inside the 24 h window is reported `not_needed` in the tool result (variant A: other channels still go into the request); no record for it.
3. Approval runs as a BLOCKING pop-up in the Web UI (like "Send to YouTube"), not a background job; a boot-time sweep still turns an orphaned `running` row into `failed (interrupted)`.
4. No fixed channel cap: the limits are the owner's own daily limits (`market_intelligence_daily_quota_budget_units`); the agent gets a READ tool for the current limits and remaining budget (`agent_get_collection_limits`). An estimate above today's remaining budget is still created (`fitsToday: false`); collection stops at the budget and resumes next day from the saved cursor.
5. Recurring requests: not in v1; later as an internal feature a human can switch on, which only CREATES a pending request every N days (never runs one); never more than one open request per channel (no stack of missed requests); value is the moment of approval, not of creation. Needs its own ADR.
6. NO `force` and NO bypass: an approved request runs the REGULAR collection rules for the listed channels (24 h stale window, 24 h failed-channel pause, daily budget) — it only removes the wait for a dashboard visit.
