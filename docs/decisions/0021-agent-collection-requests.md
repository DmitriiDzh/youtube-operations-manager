# 0021. Agent-created collection requests, approved by a human

Status: Accepted

**Date:** 2026-10-04.

**Assigned by** the owner (Telegram, 2026-10-04: "add the ability for the agent to request research collection through MCP; we can compute the
estimate ourselves; I approve such requests on the Research tab"). Plan and owner decisions: `docs/roadmap/plans/AGENT_COLLECTION_REQUEST_PLAN.md`
(section 7 overrides the rest).

## Context

Competitor snapshots are only created by `runCollectionIfStale`, which runs when the dashboard is opened, plus the manual "fetch public snapshot".
An agent that wants fresh data had no way to ask. The closest precedent is `agent_create_market_research_request` (agent drafts, human approves in
the Research tab, atomic status transitions, approval symbols fenced from `src/mcp`, `src/cli`, `src/lib/agent-operations`).

## Decision

1. **Agent surface (Agent API 3.2.0):** `agent_create_collection_request` (DRAFT, channel-bound, mutation-gated), `agent_get_collection_request` and
   `agent_get_collection_limits` (READ). Creating makes zero YouTube calls and writes no quota ledger row; the estimate is computed locally.
   There is no `force` flag and no channel-count cap; the only limit is the owner's own daily unit budget.
2. **Table `market_collection_requests` (schema v49, additive):** `pending -> approved -> running -> done | failed`, `pending -> rejected`, each an
   atomic `UPDATE ... WHERE status = <expected> RETURNING`. At most one open (pending/approved/running) request per channel.
3. **Estimate = upper bound** per channel `{ mode, expectedUnits, worstCaseUnits }` (YouTube quota units, not model tokens) plus totals, budget, spent
   today, remaining and `fitsToday` (worst case <= remaining). A request that does not fit is still created; collection stops at the budget and
   resumes from the saved cursor.
4. **`not_needed` is a result, not a record:** a channel collected successfully within 24 h, or failed within 24 h, is left out and reported with the
   hours since; with nothing left, `created: false` and no row.
5. **Approval is Web-only and BLOCKING** (`POST .../collection-requests/[requestId]/approve`, session user is the credential, progress pop-up like
   "Send to YouTube"). Preconditions (budget set and not used up, Data API reads on, credentials resolve) run BEFORE any transition, so a failure leaves
   the request pending. The run is the REGULAR collection (`collectStaleChannels`, shared with `runCollectionIfStale`: same 24 h stale window, same 24 h
   failed-channel pause, same budget gate, same claim/charge/ledger rules) restricted to the request's channels. No bypass exists: the approval only
   removes the wait for a dashboard visit. The per-channel outcome (`completed | partial_budget | failed | skipped_*`), videos stored, observed-at and
   units spent are recorded. The background-reserve guard of the automatic refresh does not apply (a person approved this run).
6. **Fenced:** `runApprovedCollectionRequest` / `rejectCollectionRequest` and the db transitions are not reachable from `src/mcp`, `src/cli`,
   `src/lib/agent-operations` (`market-research-request-approval-inventory.test.ts`); the MCP/CLI core subsets list only create/list/limits.
7. **Recovery:** a boot-time sweep (run at boot, no age cutoff: at boot of the single server process no run can be alive) turns every approved/running request into `failed` ("interrupted") so its channels stop being blocked. A long run renews the claim of its not-yet-processed channels before each channel, so the 15-minute claim expiry cannot let a dashboard run take them mid-run; a throw mid-run records the units actually charged and the results so far.
8. **A request can end `done` with every channel `skipped_*`** (fresh, in the failure pause, or no budget); an agent must read the per-channel results. Estimates: incremental refresh about 2, at most 5 units; `alreadyRequested` discloses a requestId only for a request the agent owns.

## Consequences

Not built (separate decisions): recurring requests (a human-enabled schedule that only CREATES a pending request, never runs one), forced runs.
Real YouTube behaviour is unverified until the owner's first approved request on a small channel set.
