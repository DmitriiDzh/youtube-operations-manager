# BL-123 — Research data for scripts: «99 Data Inbox» destination and a read-only HTTP path

Raised by the operations agent (updated request 2026-10-04, «дополнен пожеланиями о процессе передачи файлов») and forwarded by the owner (Telegram, 2026-10-04: «Изучи и составь план выполнения»). **Status 2026-10-04: slice 1 assigned by the owner («Да, вместо») and implemented on `feature/research-data-inbox`; slice 2 (HTTP read route) NOT built — the owner: the application's work ends with the export into the folder.** Builds on BL-119 (ADR 0019, Agent API 3.1.0).

## What the update asks

1. **Boundary (user rule):** the Manager must not read, create or change anything inside the agent's projects, including the per-channel workspace folder it stores. Data should reach project scripts as **responses to calls**; the scripts write their own files.
2. **One deliberate, user-approved exception:** `agent_export_research_data` writes into `<stored workspace path>/99 Data Inbox/` (exact, fixed name), created on first export, instead of today's `exports/`; stored workspace setting untouched; the Manager writes only research exports there and never modifies or deletes what it did not create; files keep `expiresAt` and are deleted by the Manager; the response stays paths/row counts/`expiresAt`; if the folder cannot be created → a clear error and nothing written. Asked: state whether it **replaces** `exports/` or sits inside as `99 Data Inbox/exports/`.
3. **Still open per the agent:** a machine-readable read path for scripts with no writes into projects (item 1), server-side summaries (item 4), reach per video per day (item 5), output control for existing reads (item 6). Items 2–3 are addressed by 3.1.0, pending its retest (the tools were not loaded in its session).
4. A question to answer: does the CLI work for agents, how does it authenticate, and the exact invocation; and the stated rule for the 30-day constraint.

## Analysis (against the current code)

| Agent item | State today | Plan |
|---|---|---|
| Destination `99 Data Inbox` | Export writes `<workspace>/exports/` (constant `EXPORTS_DIR_NAME`), after re-validating the path, refusing a symlinked folder, atomic temp-file + rename, ledger-only expiry sweep. `mkdir` failure is not mapped to a named error yet. No export has ever been written (ledger empty), so nothing to migrate. | **Slice 1** (below). |
| Read path without writes (item 1) | The in-app MCP endpoint `POST /api/mcp` is plain HTTP: `Authorization: Bearer <channel token>` + JSON-RPC `tools/call`, stateless (no handshake needed, the endpoint test calls `tools/call` directly), loopback only. A script can already call `query_market_overview` / `query_market_intelligence` and write its own file, but the result is nested JSON wrapped in MCP `content[].text`, and the flat CSV exists only as files. **The CLI is the operator's tool only** (ADR 0013): it runs only while «Operator CLI access» is on and is not a path for agents; tool descriptions that mention `agent …` CLI commands do not apply to them. | **Slice 2:** a read-only HTTP route returning the flat data as CSV/JSON in the response body. |
| Flat outputs, own channel, bulk read (2, 3) | Done in 3.1.0 (`research_channel_snapshots`, `research_video_snapshots`, `own_video_snapshots`; `query_market_overview`). | Retest only. |
| Server-side summaries (4) | **Not built, deliberately:** medians/percentiles/ratios over other channels' statistics are derived metrics (YouTube III.E.4.h) and cross-channel aggregation (III.E.2.a); owner decisions 2026-10-04. Allowed for OUR channel only — still unrequested for it. | No change; repeat the reason in the answer. |
| Reach per video/day, wide, field selection (5, 6) | Done in 3.1.0 (`videoId` + `groupBy: video_day`; `format: wide`; `fields`/`limit`/`offset`). | Retest only. |
| 30-day rule (design constraint) | Rows older than 30 days (other channels' API data) are never returned; `observedAt` is in every row; files carry `expiresAt`. | State the rule in the answer; unchanged. |

## Slice 1 — destination `99 Data Inbox` (small)

- Replace `exports/` by the fixed folder `99 Data Inbox` **directly inside the workspace** (recommended: one level, as written in the request; no nested `exports`). All safety checks stay (workspace re-validated, folder must be a plain directory not a link, real path strictly inside the workspace, atomic write, ledger-only deletion, nothing but our own files).
- `mkdir`/permission failure → `RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE` with a clear message, nothing written (new test).
- Update: tool description, `retentionNote`, ADR 0019 (amendment: the owner-approved exception and its limits), `docs/interfaces.md`, plan BL-119 text.
- Tests (hand-derived): first export creates exactly `<workspace>/99 Data Inbox/` and files only there; nothing else appears in the workspace; a pre-existing user file in that folder is never touched or deleted by the sweep; unwritable workspace → error and no folder; the stored workspace path is unchanged.

## Slice 2 — read-only HTTP data route (the «no writes anywhere» path)

- `GET /api/agent/research-data?dataset=research_channel_snapshots|research_video_snapshots|own_video_snapshots&format=csv|json[&researchChannelIds=a,b]` → the response body is the flat data (same columns, same row builder as the export, so counts equal the tool output). Header `X-Data-Expires-At` (30 days after the oldest API-sourced row for competitor datasets).
- Auth and scoping are the same as the MCP endpoint: loopback only, «MCP connection» toggle on, `Authorization: Bearer <channel token>` (token read by the caller from its own token file — never in command arguments), agent-session confinement (only watchlist records assigned to the token's channel; own channel = the token's channel). Read-only: no file, no ledger row, nothing written anywhere.
- Extract the shared bearer/loopback/toggle/verify steps of `agent-mcp-endpoint` into one function used by both routes (AGENTS.md §M — shared logic gets its own owner, not copied).
- Not an MCP tool on purpose: a route is invisible to the LLM, so a bulk response cannot flood the model's context; scripts call it, agents do not.
- Documentation: exact `curl`/script invocation (with the token from a file) in `docs/AGENT_ISOLATION_SETUP.md`/`docs/interfaces.md`; answer to the CLI question.
- Tests: row counts equal `listResearchOverview`/export rows for a fixture (The Neiro: 1 channel snapshot, 50 video snapshots); another channel's agent token never sees unassigned records; missing/invalid token → 401, toggle off → 403, non-loopback → 403; CSV is RFC 4180 with the title guard; response writes nothing (no ledger row).

## Order and size

Slice 1 → Slice 2 → docs/answer to the agent. One branch (`feature/research-data-inbox`), independent review once, owner's yes to merge, then restart. Slice 1 ≈ half a day, slice 2 ≈ one day.

## Retest for the agent (acceptance)

- A project script, run once with no token in arguments, gets the channel and video snapshots of all watchlist channels over the HTTP route and writes its own files; counts equal the tool output; own channel in the same columns; the Manager touches no project file on that path.
- First `agent_export_research_data` creates `99 Data Inbox` and no file appears anywhere else in the project.

## Decisions for the owner

1. Replace `exports/` with `99 Data Inbox/` (recommended), or nest `99 Data Inbox/exports/`?
2. Build the HTTP read route (slice 2) in addition to the file export? (recommended: yes — it is the only path with zero writes into projects.)
3. Anything to add for the agent's answer: the summaries stay off for other channels (policy) — confirm the wording.
