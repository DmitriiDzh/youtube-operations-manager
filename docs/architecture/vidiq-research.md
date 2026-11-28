> Index: ../ARCHITECTURE.md

## BL-278 — vidIQ research through one gateway (ADR 0077)

Stage 1 of `docs/roadmap/plans/VIDIQ_INTEGRATION_PLAN.md`: the gateway, the key, the credits ledger and budget, the Settings card.
Owner answers TG 4961 (2026-11-26): earnings estimates shown as vidIQ estimates; credits are not a BL-228 paid call (the budget and
the ledger are the only gate); the key on the Mac only.

- **Data flow.** Settings card → `/api/vidiq/*` (Web session) → `createVidiqResearchCore()` (one per process on `globalThis`) →
  `getVidiqGateway()` (one per process; its live `tools/list` cache is shared) → vidIQ's MCP server over Streamable HTTP. Nothing
  else imports either module (inventory and boundary tests); `src/instrumentation.ts` starts nothing for them.
- **Gateway boundary.** Only `src/lib/vidiq-gateway/` names `mcp.vidiq.com` or imports `@modelcontextprotocol/sdk/client`; callers
  use its barrel, and only `src/lib/vidiq-research/` may (so the switch, the budget and the ledger sit in front of every call). The
  URL is a constant; `createVidiqGateway({ endpoint })` accepts only a loopback URL (tests). Neither module imports `write-context`,
  `youtube-write-gateway` or `youtube-read-gateway`: there is no YouTube writer here (`docs/WRITE_AUTHORIZATIONS.md` unchanged).
- **Pinned contract, fail closed.** `contract.ts` reads the 18 allowlisted tools from the dated fixture and pins each cost (and
  `comment_insights` per mode) and TTL. A call is refused with no network for a tool off the list, an unknown property, a handle or URL
  where a canonical id belongs, or a pinned-schema failure (`userGoal` is stripped first). With the live list (kept an hour, re-read
  once before any drift refusal) it is refused for a missing tool, a live schema that requires more or rejects the arguments, a
  changed or unreadable Cost sentence, or `readOnlyHint` false (except `comment_insights`). Pinned and live schemas are compiled by
  separate validator instances, with `$id`/`$schema` dropped. A charge above the pin (from the ledger) marks the tool drifted until
  the owner acknowledges it (`vidiq_overcharge_ack_at`; ADR 0077 amendment 1): older overcharges stop blocking, a later one blocks
  again, the rows keep counting.
- **Transport and errors.** One fresh SDK client per operation; one operation in flight per process (queue on `globalThis`).
  `tools/call` goes through `client.request` with `CallToolResultSchema`, never `client.callTool` (which validates against a cached
  output schema and could throw after vidIQ charged). A wrapped `fetch` records the HTTP status, `Retry-After` and whether the
  `tools/call` POST left: a timeout or lost connection after it left is `vidiq_outcome_unknown`; an HTTP 4xx or JSON-RPC error answer
  to it is `vidiq_answered_error`; before it, `vidiq_unavailable`. Only a `tools/call` can report `requestSent: true`: a failed free
  `tools/list` or handshake never does ("nothing was charged"). The services send the call `checkLive` passed (`callChecked`, which
  takes only an object `checkLive` issued for the same key, once), so no list is read between the check and the send. Every
  error has a fixed message; SDK/transport text (which embeds the response body) is never logged or returned. A result that quotes the
  key is scrubbed in the gateway. Results over 256 KB are refused but still report `_credits.used`.
- **Budget arithmetic.** Spent in the period = Σ over the period's rows of `credits_used` where vidIQ reported it, else the stated
  cost (pending, unknown, job_pending). Refused rows and failures before sending record 0; a 5xx or timeout after sending records
  `unknown` and counts the stated cost (never over-spends). An answered error records `failed` at the stated cost, settled to 0 only
  when the free balance read after it equals the pre-call snapshot (total and renewal date); a timeout is never settled. A `pending`
  row older than 15 minutes (a process that ended mid-call) becomes `unknown` before the status or a call reads the ledger. The period ends at the snapshot's `renewableResetsAt` (rolled forward by
  whole months once past) and starts one calendar month earlier; without a snapshot, the UTC month. The preflight runs under one lock
  per process, so two calls cannot both pass it.
- **Key handling.** Device-secret slot `vidiq` (ADR 0042), hint = last 4 characters, saved only after a free `vidiq_balance` with it
  succeeds; never in a log, an answer, an error, the ledger, `app_settings` or browser code (sentinel tests). The snapshot carries the
  slot's version, so a new key discards it. The key route is Mac-only (`src/proxy.ts`).
- **Limits of stage 1.** No Producer tools, no cache, no job status transitions (a `job_pending` row counts its stated cost until stage
  2 polls it), no Research sub-tab. The fixture is the 2026-11-26 contract; a vidIQ change refuses the affected tool until a new dated
  fixture and reviewed pins land.
