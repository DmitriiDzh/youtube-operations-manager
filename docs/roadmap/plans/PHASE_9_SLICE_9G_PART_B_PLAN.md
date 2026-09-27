# Phase 9 slice 9G, part B — agent-created research requests (approval integrity)

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§29 and `docs/roadmap/plans/PHASE_9_SLICE_9G_PLAN.md` §7's own explicit deferral of this part. This
touches approval integrity (`AGENTS.md` §A/§L), so acceptance criteria are drafted below BEFORE any
code, from the requirement and from this codebase's own existing approval precedent
(`src/lib/changesets/`'s Change Set `approvalStatus` model), never copied from a draft
implementation.

## 1. Requirement, read directly from the owner spec

> §29. Allow an operational agent to create structured research/discovery drafts. Example:
> "Monitor Japanese countryside night ambience for 30 days." This must not automatically create
> unlimited collection jobs.

Two hard constraints follow directly from this text:

1. **A create-only DRAFT, never a self-approving one.** The agent creates a *draft*; something else
   approves it. Nothing in the spec text grants the agent any approval authority over its own
   request.
2. **No unlimited/recurring collection jobs.** "Monitor for 30 days" is a *description* of intent,
   not an instruction this codebase may act on literally -- there is no scheduler anywhere in this
   application (`PHASE_9_PLAN.md` §10's own finding, still true), and building one now would be
   scope creep no slice has been assigned. An approved request triggers **exactly one** real
   `discoverChannels` run, once, at approval time -- never a recurring job.

## 2. Template chosen, and the one deliberately rejected

**Rejected: `content-proposals`'s own pattern.** That module is deliberately write-once -- create,
get, list, no status field, no approval workflow at all (its own contracts.ts doc comment: "the
owner spec describes no approval/review workflow for proposals, unlike Change Sets"). Copying it
here would ship a DRAFT with no gate at all, contradicting §29's own "must not automatically create"
constraint.

**Chosen: `src/lib/changesets/`'s `approvalStatus` model**, confirmed by direct inspection to already
have the exact shape needed and the exact invariant this slice needs to preserve:

- Every `Change` has its own `approvalStatus: "pending" | "approved" | "rejected"`.
- `approveChange`/`rejectChange`/`approveAllValid`/`rejectAllPending` exist in
  `src/lib/changesets/services.ts` -- but **none of the four is registered as an MCP tool or a CLI
  command** (confirmed by direct grep of `src/mcp/server.ts`/`src/cli/video-metadata.ts` -- zero
  matches). Approval is reachable ONLY through the Web UI's own API routes (e.g.
  `src/app/api/channels/[channelId]/change-sets/[changeSetId]/changes/[changeId]/approve/route.ts`),
  a plain session-checked, no-agent-facing-surface route.

This is the load-bearing precedent for this slice: **an agent can create a Change record, but only a
human, through the Web UI, can move it out of `pending`.** Market research requests copy this exact
shape, not the DB-level `approvalStatus` enum type itself (research requests are their own resource,
`market_research_requests`, not a `Change`).

## 3. Schema (new migration, v27 — never v26, per `docs/TECHNICAL_DEBT.md` RISK-63's own rule)

```sql
CREATE TABLE IF NOT EXISTS market_research_requests (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,                    -- fed to discoverChannels's own search.list query on approval
  rationale TEXT NOT NULL,                -- why the agent thinks this is worth researching
  monitor_duration_days INTEGER,          -- metadata only, spec §29's own example -- NEVER read by any scheduler
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed | execution_failed
  created_via TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,                    -- when it left 'pending'
  resolved_reason TEXT,                   -- human's own stated reason for approve/reject (required on reject)
  execution_error TEXT                    -- set only on execution_failed
);
CREATE INDEX IF NOT EXISTS market_research_requests_status_idx ON market_research_requests(status);
```

`monitor_duration_days` is deliberately **write-only-as-metadata** -- stored, returned in reads,
never consulted by any code path that decides whether/when to run anything (there is nothing in
this codebase that could consult it; no scheduler exists). This is the concrete, structural answer
to "must not automatically create unlimited collection jobs": the field literally cannot cause a
second run, because nothing reads it for that purpose.

No FK to anything -- a research request is not about one specific already-watchlisted channel (its
`query` may discover several, or none), mirroring `market_discovery_runs`'s own FK-less shape for
the identical reason.

## 4. Service actions

- **`createMarketResearchRequest(input, callOrigin)`** -- `{query, rationale, monitorDurationDays?}`.
  `createdVia` server-stamped from `callOrigin`, never caller-supplied (mirrors
  `createContentProposal`'s own discipline). Always inserts `status: "pending"`. Makes **zero**
  YouTube calls and writes **zero** ledger rows -- this is pure local bookkeeping, no quota spent
  until a human approves.
- **`listMarketResearchRequests()`** -- all requests, for the Web UI's own review queue.
- **`getMarketResearchRequest(id)`** -- one request, `RESEARCH_REQUEST_NOT_FOUND` if absent.
- **`approveMarketResearchRequest(input, callOrigin)`** -- `{id}`. **One atomic conditional update**
  (`UPDATE market_research_requests SET status='approved', resolved_at=?, ... WHERE id=? AND
  status='pending' RETURNING *`, the exact shape `claimStaleResearchChannelsForCollection` already
  uses in this codebase) -- a double-click or two-tab race can never approve (and therefore never
  spend quota) twice, mirroring the lesson RISK-68/69 already taught this module. Zero rows
  returned -> `RESEARCH_REQUEST_NOT_PENDING` (covers both "already resolved" and "never existed,"
  same non-distinguishing-error-shape discipline `updateDiscoveryCandidateStatus` already uses for
  its own analogous case). **On successful approval, triggers exactly one `discoverChannels` call**
  with the request's own `query`, using the approving human's own resolved credentials
  (`credentialRef` resolved from the Web UI session the same way `discover/route.ts` already does:
  `{ userId: session.user.id }`) -- going through `discoverChannels`'s own existing budget
  check/quota ledger/`assertReadsAvailable` gate unchanged, never a second, parallel quota path.
  Records the outcome back onto the request row: `status: "executed"` on success, `status:
  "execution_failed"` + `execution_error` on failure (a failure here does NOT revert `status` back
  to `pending` or `approved` -- the approval itself already happened and is not undone by a
  downstream execution failure; the row's own `execution_error` makes the failure visible for a
  human to act on, e.g. by manually running Discover again from the existing UI).
- **`rejectMarketResearchRequest(input, callOrigin)`** -- `{id, reason}`. Same atomic
  conditional-update shape, transitioning `pending -> rejected`. `reason` required (mirrors every
  other reason-requiring action in this module, e.g. `promoteDiscoveryCandidate`).

**No service action for an agent to approve or reject its own request exists at all** -- not gated,
not permission-checked, simply absent from this module's own action set. The absence itself is what
`AGENTS.md` §A's own approval-integrity concern requires, verified mechanically in §7 below.

## 5. Interfaces

- **MCP: `agent_create_market_research_request`** (DRAFT permission) -- the only agent-facing tool
  for this feature. Server-stamps `createdVia: "mcp"`/`agentApiVersion` (owner spec §22, mirrors
  `agent_create_content_proposal`). Gated by `assertMcpDeviceAvailable` inside
  `wrapMcpHandlersWithMutationGate` (a real local-state mutation, per
  `docs/DEVELOPMENT_PLAYBOOK.md` §6.7's three-way classification). **Zoned** -- a new
  `CAPABILITY_MARKET_RESEARCH_REQUEST_CREATE` constant, added to `ZONED_CAPABILITIES`
  (`src/lib/agent-connections/contracts.ts`), passed as `registerTool`'s 4th argument, mirroring
  `agent_create_content_proposal`'s own zoning exactly. **No `agent_approve_...`/`agent_reject_...`
  MCP tool exists, ever** -- this is the core of this slice.
- **CLI: `agent create-research-request`** -- parity with the MCP tool, same server-stamping
  discipline, same `READ_ONLY_CLI_COMMANDS` exclusion (it mutates, so it must NOT be added there).
  **No CLI approve/reject command exists, ever.**
- **Web UI only: approval surface.** New API routes, plain session-checked (no `channelAccess`
  check -- global data, same as every other market-intelligence route):
  - `GET /api/market-intelligence/research-requests` -- list (for a new "Research requests" review
    panel on the Research tab).
  - `POST /api/market-intelligence/research-requests/[id]/approve` -- `{}` (no body needed --
    approving human's own session supplies the credentials).
  - `POST /api/market-intelligence/research-requests/[id]/reject` -- `{reason}`.
  - Gated by `src/proxy.ts` like every other real mutation (approve/reject only -- the MCP-facing
    create path is a separate concern, gated by its own device-availability check).

## 6. Agent capability / version bookkeeping

- `AGENT_CAPABILITIES` (`src/lib/agent-operations/services.ts`): one new entry,
  `market_intelligence.agent_create_market_research_request`, `permission: "DRAFT"` (not `READ` --
  this is the domain's first DRAFT-class capability).
- `AGENT_API_VERSION`: `0.12.0` -> `0.13.0`.
- `ZONED_CAPABILITIES`: one new entry (§5 above). The existing data-driven
  `EXPECTED_ZONE_CAPABILITY_IDS`/`ZONED_MCP_TOOL_NAMES` loop in `src/mcp/server.test.ts` (§6.7's own
  established pattern) picks up both the "actually wired through agent-zone enforcement" and
  "passes exactly its own capabilityId" tests automatically from one new map entry -- no new test
  boilerplate needed beyond that one line.

## 7. Mechanical enforcement of approval integrity (the actual point of this slice)

A new test, `market-research-request-approval-inventory.test.ts`, styled after `PHASE9-INV-02`/the
write/read-gateway inventory tests (`AGENTS.md` §G's own "enforce mechanically, not by convention"
discipline): asserts by direct inspection that **no MCP tool name and no CLI command name calls
`approveMarketResearchRequest`/`rejectMarketResearchRequest`** anywhere in `src/mcp/server.ts` or
`src/cli/video-metadata.ts` (a plain source-text grep for the two function names, mirroring
`write-path-inventory.test.ts`'s own regex-over-file-contents technique). This is the difference
between "we didn't happen to add an approve tool" (true today, but silently reversible by a future
edit) and "no approve tool can exist without this test itself changing" (a structural guarantee).

## 8. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- **AC-9G-B-01:** `createMarketResearchRequest` rejects an empty `query`/`rationale` before storage
  (schema-level `.strict()` + `min(1)`).
- **AC-9G-B-02:** `createdVia` cannot be supplied via the public input -- schema is `.strict()`,
  server-stamped only via `callOrigin`, mirroring AC-MI-03's own established pattern.
- **AC-9G-B-03:** a successful create makes zero calls to any `youtubeApi`/`authResolver` dependency
  and writes zero rows to `market_intelligence_collection_runs`/`market_discovery_runs` -- proven by
  a fake store/API surface that throws if either is ever touched during `createMarketResearchRequest`.
- **AC-9G-B-04:** a new request always starts `status: "pending"`, regardless of input.
- **AC-9G-B-05:** `approveMarketResearchRequest` on an unknown id, or an id already `approved`/
  `rejected`/`executed`/`execution_failed`, is rejected with `RESEARCH_REQUEST_NOT_PENDING` (or
  `RESEARCH_REQUEST_NOT_FOUND` for a genuinely unknown id -- both never advance any state).
- **AC-9G-B-06:** two concurrent `approveMarketResearchRequest` calls for the same `pending` request
  (simulated via a fake store whose conditional update can only ever match once) result in exactly
  one `discoverChannels` call, never two -- the second call observes the row already `approved`/
  `executed` and is rejected.
- **AC-9G-B-07:** a successful approval calls `discoverChannels` with exactly the request's own
  `query`, sets `status: "executed"`, and never writes a second, independent quota-ledger entry
  outside `discoverChannels`'s own existing one.
- **AC-9G-B-08:** a `discoverChannels` failure during approval (e.g. budget exceeded) sets `status:
  "execution_failed"` + `execution_error` -- never silently reverts to `"pending"`, never silently
  swallows the error.
- **AC-9G-B-09:** `rejectMarketResearchRequest` requires a non-empty `reason`, transitions
  `pending -> rejected`, and is rejected the same way as approval for a non-pending/unknown id.
- **AC-9G-B-10 (the core one):** the mechanical inventory test (§7) fails if any file outside this
  module's own service layer references `approveMarketResearchRequest`/
  `rejectMarketResearchRequest` from `src/mcp/server.ts` or `src/cli/video-metadata.ts` -- proven by
  a temporary probe addition during implementation (mirrors this session's own established
  verification discipline for every other mechanical inventory test), removed before commit.
- **AC-9G-B-11:** `agent_create_market_research_request` is rejected while the operation lock is
  held (device-availability gate), and while agent-zone enforcement denies it (mirrors
  `agent_create_content_proposal`'s own two tests, generated by the shared data-driven loop).
- **AC-9G-B-12:** the Web UI approve/reject routes are gated by `src/proxy.ts` like any other real
  mutation (mirrors every other market-intelligence route's own proxy-gate test).

## 9. Explicitly out of scope

- Any scheduler, recurring job, or actual use of `monitorDurationDays` beyond storing/returning it.
- Any agent-facing approve/reject capability, now or ever, without a fresh, explicit owner
  instruction that directly overrides this slice's own core design decision (§2/§7) -- not
  something a future slice may quietly add.
- Editing an already-created request's `query`/`rationale` (create, approve, reject only -- no
  update action, mirrors `content-proposals`' own write-once discipline for the fields it does
  allow mutation of at all).
