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
  agent_api_version TEXT,                 -- owner spec §22 provenance pair with created_via; NULL for a Web-UI-created row
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_at INTEGER,                    -- when it left 'pending'
  resolved_reason TEXT,                   -- human's own stated reason for approve/reject (required on reject)
  candidates_found INTEGER,               -- filled from discoverChannels's own return value on a successful execution
  candidates_new INTEGER,                 -- filled from discoverChannels's own return value on a successful execution
  execution_error TEXT                    -- set only on execution_failed
);
CREATE INDEX IF NOT EXISTS market_research_requests_status_idx ON market_research_requests(status);
```

**Widened from the first draft of this plan (advisor review, before implementation): added
`agent_api_version` (mirrors `content-proposals`' own `{createdVia, agentApiVersion}` provenance
pair, owner spec §22 -- the original draft only had `created_via`) and `candidates_found`/
`candidates_new` (so a successful execution's own outcome is recorded on the request row itself,
not only inferable by cross-referencing `market_discovery_runs` separately). Adding these now, before
any code exists, avoids a second migration purely to catch up on an audit-trail gap the very next
slice to touch this table would otherwise have to open.**

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
- **`approveMarketResearchRequest(input, callOrigin)`** -- `{id, credentialRef}`. Sequence, corrected
  from this plan's first draft (advisor review found the original design left every approval ending
  in `execution_failed` on a fresh install -- see the callout below):
  1. **Existence check first, via a plain read** (`getMarketResearchRequestById`) -- a genuinely
     unknown id throws `RESEARCH_REQUEST_NOT_FOUND` immediately, before any quota check runs.
  2. **Quota/reads preconditions, BEFORE touching `status` at all** -- the exact same checks
     `discoverChannels` already runs first (budget unset -> `MARKET_INTELLIGENCE_QUOTA_DISABLED`;
     budget exhausted -> `MARKET_INTELLIGENCE_QUOTA_EXCEEDED`; Data API reads disabled -> its own
     error), extracted into one shared internal helper (`assertDiscoveryPreconditions(deps, now)`)
     both `discoverChannels` and this action call, never duplicated inline. **If either check fails,
     the request is left exactly as it was (still `pending`)** -- so the owner can set/raise the
     budget in Settings and approve again, rather than the request being permanently burned into
     `execution_failed` by a precondition that was never really about THIS request.
  3. **One atomic conditional update** (`UPDATE market_research_requests SET status='approved',
     resolved_at=?, ... WHERE id=? AND status='pending' RETURNING *`, the exact shape
     `claimStaleResearchChannelsForCollection` already uses in this codebase) -- a double-click or
     two-tab race can never approve (and therefore never spend quota) twice, mirroring the lesson
     RISK-68/69 already taught this module. Zero rows returned here (the id existed in step 1 but
     is no longer `pending` -- resolved by a concurrent call, or already resolved earlier) ->
     `RESEARCH_REQUEST_NOT_PENDING`.
  4. **Only after that transition succeeds**, call `discoverChannels` with the request's own `query`
     and the approving human's own resolved credentials (`credentialRef` resolved from the Web UI
     session the same way `discover/route.ts` already does: `{ userId: session.user.id }`) --
     going through `discoverChannels`'s own existing budget check/quota ledger/
     `assertReadsAvailable` gate a second time (intentional, cheap, defense-in-depth against a race
     between step 2's pre-check and step 3's transition -- mirrors 9B's own "recompute remaining
     after the claim" discipline), never a second, parallel quota-accounting path.
  5. Records the outcome back onto the now-`approved` row: `status: "executed"` +
     `candidates_found`/`candidates_new` (from `discoverChannels`'s own return value) on success;
     `status: "execution_failed"` + `execution_error` on failure. A failure here does NOT revert
     `status` back to `pending` or `approved` -- the approval itself already happened (step 3) and
     is not undone by a downstream execution failure; the row's own `execution_error` makes the
     failure visible for a human to act on (e.g. by manually running Discover again from the
     existing UI). **Known, accepted, recorded gap (not fixed here):** a crash between step 3 and
     step 5 leaves a request stuck in `approved` forever, the same class of problem RISK-72 already
     tracks for `discoverChannels`'s own audit-row write -- tracked as its own new
     `docs/TECHNICAL_DEBT.md` entry once implemented, not solved in this slice.

  **Why the original draft was wrong (advisor review, before implementation):** the owner has never
  set `marketIntelligenceDailyQuotaBudgetUnits` (owner decision: no hardcoded default, `null` until
  explicitly configured). Under the original design (transition first, call `discoverChannels`
  second, with no pre-check), the FIRST approval this application ever processes -- on this machine,
  today -- would unconditionally hit `discoverChannels`'s own `MARKET_INTELLIGENCE_QUOTA_DISABLED`
  throw and permanently land the request in `execution_failed`, with no path back to `pending`. The
  corrected sequence above makes a missing/exhausted budget a **precondition failure that never
  touches the request's own status at all**, exactly like `discoverChannels` itself already treats
  it as a precondition failure that spends nothing and changes nothing.
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
- **CLI: `agent create-research-request`** -- parity with the MCP tool. **Server-stamping: `createdVia:
  "cli"` + `agentApiVersion: null`**, corrected from this plan's first draft, which assumed the CLI
  also stamps a real `agentApiVersion` -- direct inspection of `agent create-content-proposal`'s own
  CLI dispatch branch found the established convention is `agentApiVersion: null` for CLI, since MCP
  is the one transport this interface's own version actually mediates (owner spec §22); `interfaces.md`
  already documents this correctly, only this plan's own text was stale. Same `READ_ONLY_CLI_COMMANDS`
  exclusion (it mutates, so it must NOT be added there). **Zoning enforced the same way every other zoned CLI
  command already does it** (found by direct inspection of `agent create-content-proposal`'s own
  dispatch branch, corrected into this plan -- the first draft omitted CLI-side zoning entirely): an
  inline `await agentConnectionsCore.assertAgentAllowedForCapability({ capabilityId:
  CAPABILITY_MARKET_RESEARCH_REQUEST_CREATE, callerConnectionId })` call at the top of this
  command's own dispatch branch (`callerConnectionId` resolved the same way every other zoned
  command already does: `--agentConnectionId` flag, falling back to
  `resolveAgentConnectionIdFromEnv`). Unlike every existing zoned CLI command, this one needs no
  `channelId` at all (global data) -- its dispatch branch is placed alongside `competitors`/
  `market-intelligence`/`market-records` (before the generic channelId-requiring section), with the
  zoning check added at the top of its own branch, since none of those three siblings are zoned.
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
  this is the domain's first DRAFT-class capability). **The existing exact-list `market_intelligence`
  capability test (`src/lib/agent-operations/services.test.ts`) currently asserts every capability
  in this domain is `"READ"` -- that assertion must change to a per-id permission check (the two
  existing entries stay `"READ"`, the new one is `"DRAFT"`), per `AGENTS.md` §L's own "changing a
  previously-approved acceptance test requires... which requirement changed" (the requirement did:
  this domain now has a DRAFT-class capability, which it never had before).**
- `AGENT_API_VERSION`: `0.12.0` -> `0.13.0`.
- `ZONED_CAPABILITIES`: one new entry (§5 above), `CAPABILITY_MARKET_RESEARCH_REQUEST_CREATE`.
  **Authority for adding this entry:** `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9G definition
  states plainly: "Any DRAFT-class 'create research request' capability... follows the Change Set
  approvalStatus pattern... A new `ZONED_CAPABILITIES` entry is added at that point" -- this is the
  "that point," already anticipated and authorized when Phase 9 Part II was assigned, not a fresh
  zoning decision requiring separate owner sign-off. The existing data-driven
  `EXPECTED_ZONE_CAPABILITY_IDS`/`ZONED_MCP_TOOL_NAMES` loop in `src/mcp/server.test.ts` (§6.7's own
  established pattern) picks up both the "actually wired through agent-zone enforcement" and
  "passes exactly its own capabilityId" tests automatically from one new map entry for the MCP side;
  the CLI side needs its own hand-written pair (§5, mirroring `agent create-content-proposal`'s own
  two CLI zoning tests -- the CLI's zoning tests are not data-driven the way MCP's are).

## 7. Mechanical enforcement of approval integrity (the actual point of this slice)

Two mechanical tests, together, close this: a new `PHASE9-INV-03`
(`market-research-request-approval-inventory.test.ts`, styled after `PHASE9-INV-02`/the
write/read-gateway inventory tests, `AGENTS.md` §G's own "enforce mechanically, not by convention"
discipline) asserts by direct inspection that **no file under `src/mcp/**`, `src/cli/**`, or
`src/lib/agent-operations/**` references the `approveMarketResearchRequest`/
`rejectMarketResearchRequest` service actions by name**. That alone does not stop a raw SQL
`UPDATE market_research_requests SET status='approved' ...` bypassing those named actions entirely
-- **the existing `PHASE9-INV-02` (widened to add `market_research_requests` to its own literal
raw-table-name list) is what actually closes that gap**, since it already fails the suite if any
file outside this module references any of its raw table names or db.ts symbols from anywhere in
the codebase, not just the three directories INV-03 itself scans. The two tests are complementary,
not redundant: INV-03 names the specific service-layer actions an agent-facing surface must never
call; INV-02 backstops it against a lower-level bypass of those actions altogether. (Corrected from
this plan's first draft, which incorrectly attributed the raw-table-name guard to INV-03 itself.)

**Widened from this plan's first draft (advisor review, before implementation): scans directories,
not two hardcoded filenames.** Grepping only `src/mcp/server.ts`/`src/cli/video-metadata.ts` by
literal path would let the guarantee silently disappear the day a future refactor adds e.g.
`src/mcp/tools/research-requests.ts` -- this test would keep passing while the actual invariant it
exists to prove had already been broken. `src/app/api/**` (where the real Web-UI-only approve/reject
routes live) is explicitly excluded from the scan -- that is the one place these functions are
SUPPOSED to be called from.

**Also corrected: this plan document itself must never write the literal function names
`approveMarketResearchRequest`/`rejectMarketResearchRequest` inside a comment placed under any of
the scanned directories once implementation starts** -- `PHASE9-INV-02` was hit by exactly this
false-positive earlier in this same phase (a doc comment in `discovery-candidates/[channelId]/
promote/route.ts` naming a forbidden symbol in prose tripped its own plain-substring scanner).
Implementation must describe the invariant in scanned-directory comments without spelling out the
two function names verbatim (e.g. "the approve/reject actions" instead).

## 8. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- **AC-9G-B-01:** `createMarketResearchRequest` rejects an empty `query`/`rationale` before storage
  (schema-level `.strict()` + `min(1)`).
- **AC-9G-B-02:** `createdVia` cannot be supplied via the public input -- schema is `.strict()`,
  server-stamped only via `callOrigin`, mirroring AC-MI-03's own established pattern.
- **AC-9G-B-03:** a successful create makes zero calls to any `youtubeApi`/`authResolver` dependency
  and writes zero rows to `market_intelligence_collection_runs`/`market_discovery_runs` -- proven by
  a fake store/API surface that throws if either is ever touched during `createMarketResearchRequest`.
- **AC-9G-B-04:** a new request always starts `status: "pending"`, regardless of input.
- **AC-9G-B-05:** `approveMarketResearchRequest`/`rejectMarketResearchRequest` on a genuinely unknown
  id throws `RESEARCH_REQUEST_NOT_FOUND` (from the upfront existence read, step 1), distinctly from
  an id that exists but is already `approved`/`rejected`/`executed`/`execution_failed`, which throws
  `RESEARCH_REQUEST_NOT_PENDING` (from the atomic conditional update's zero-row result, step 3) --
  both never advance any state. (Corrected from this plan's first draft, which conflated the two
  into one error code -- advisor review found this contradicted §4's own two-step design.)
- **AC-9G-B-05b:** a missing/unset `marketIntelligenceDailyQuotaBudgetUnits`, or a budget already
  exhausted for today, or Data API reads disabled, each throw their own existing error
  (`MARKET_INTELLIGENCE_QUOTA_DISABLED`/`_EXCEEDED`/reads-disabled) from `approveMarketResearchRequest`
  BEFORE touching `status` at all -- the request is verified to still read `status: "pending"`
  afterward, in every one of these three cases. This is the specific defect advisor review found in
  the first draft (every approval on a fresh install, where no budget is ever set by default, would
  otherwise permanently land in `execution_failed`).
- **AC-9G-B-06 (real concurrency, not just a fake store):** in `db.test.ts`, against the real libsql
  driver, two literally-concurrent calls (`Promise.all`) to the atomic conditional-update function
  for the same `pending` row: exactly one resolves with the updated row, the other resolves `null`.
  (Corrected from this plan's first draft, which only proposed a fake-store-level test -- RISK-70's
  own resolution already demonstrated a fake store proves nothing about real atomicity.) A second,
  service-level test (fake store is acceptable here, since the atomicity claim itself is proven at
  the `db.test.ts` layer above) confirms this translates into exactly one `discoverChannels` call
  when two `approveMarketResearchRequest` calls race.
- **AC-9G-B-07:** a successful approval calls `discoverChannels` with exactly the request's own
  `query`, sets `status: "executed"` plus `candidates_found`/`candidates_new` from its return value,
  and never writes a second, independent quota-ledger entry outside `discoverChannels`'s own
  existing one.
- **AC-9G-B-08:** a `discoverChannels` failure occurring AFTER the atomic transition (step 4, e.g. a
  race where the pre-check in step 2 passed but the budget was exhausted by a concurrent call before
  step 4 ran) sets `status: "execution_failed"` + `execution_error` -- never silently reverts to
  `"pending"` or `"approved"`, never silently swallows the error.
- **AC-9G-B-09:** `rejectMarketResearchRequest` requires a non-empty `reason`, transitions
  `pending -> rejected`, and is rejected the same way as approval (AC-05) for a non-pending/unknown
  id.
- **AC-9G-B-10 (the core one):** the mechanical inventory test (§7) fails if any file under
  `src/mcp/**`, `src/cli/**`, or `src/lib/agent-operations/**` references
  `approveMarketResearchRequest`/`rejectMarketResearchRequest` -- proven by a temporary probe
  addition during implementation under each of those three directory roots (mirrors this session's
  own established verification discipline for every other mechanical inventory test), removed before
  commit. `src/app/api/**` is explicitly exempt (the real Web-UI-only routes live there).
- **AC-9G-B-11:** `agent_create_market_research_request` (MCP) is rejected while the operation lock
  is held (device-availability gate), and while agent-zone enforcement denies it (generated
  automatically by the existing data-driven `ZONED_MCP_TOOL_NAMES` loop in `src/mcp/server.test.ts`
  once `agent_create_market_research_request` is added to `EXPECTED_ZONE_CAPABILITY_IDS`).
- **AC-9G-B-11b:** `agent create-research-request` (CLI) is rejected while agent-zone enforcement
  denies it, and passes exactly `CAPABILITY_MARKET_RESEARCH_REQUEST_CREATE`/`--agentConnectionId` to
  `assertAgentAllowedForCapability` -- hand-written pair mirroring `agent create-content-proposal`'s
  own two CLI zoning tests (not data-driven on the CLI side, unlike MCP).
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
- **Recorded for a future slice, not built here (advisor review):** letting an agent see whether its
  own request was later approved/rejected/executed -- e.g. adding `"research_requests"` as a fourth
  `kind` to `agent_list_market_records` (9G part A) would be a cheap, composable extension, but is
  not needed for THIS slice's own core requirement (an agent creating a draft) and would widen scope
  beyond what §29 actually asks for.
- **Recorded as a new `docs/TECHNICAL_DEBT.md` entry once implemented, not fixed here:** a crash
  between the atomic approve transition (step 3) and recording the execution outcome (step 5) leaves
  a request stuck in `approved` forever -- the same class of gap RISK-72 already tracks for
  `discoverChannels`'s own audit-row write.
- **Web UI review panel, when built, must:** show `query`/`rationale`/provenance
  (`createdVia`/`agentApiVersion`) and make the real cost of approving visible (approving spends
  ~100 real quota units via `discoverChannels`) before the human commits; put the approve action
  behind `ConfirmDialog` (never `window.confirm`, per this project's own standing UI convention);
  and the panel itself is Web UI, so it is **browser-unverified** (`docs/TECHNICAL_DEBT.md` RISK-05)
  the same way every other panel this session has shipped already is, honestly stated at merge time,
  not silently implied as tested.
