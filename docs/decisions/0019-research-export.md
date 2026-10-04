# 0019. Research export: the Manager writes script-ready files into the channel workspace

Status: Accepted

**Date:** 2026-10-04.

**Assigned by** the owner (chat, 2026-10-04, BL-119) after the operations agent reported that research data could only be read inline
(15-20k tokens per channel) and had to be retyped by hand to build a table. Plan: `docs/roadmap/plans/RESEARCH_EXPORT_PLAN.md`. Owner
decisions: (A) only rows inside the 30-day policy window are exported and the Manager deletes its own expired files, (B) an agent with
READ + DRAFT may trigger the export, (C) no workspace folder means a refusal, never a fallback location.

## Context

`channel-workspaces` (Phase 11, `docs/roadmap/plans/PHASE_11_PLAN.md`) deliberately never opens anything inside the operator-set folder: the
agent uses its own filesystem tools, and "no agent filesystem authority" is a standing rule. The agent's only way to get a large research
data set was therefore the tool response itself. The CLI is the operator's tool only (ADR 0013), so it is no route for agents.

## Decision

1. New module `src/lib/research-export/` (AGENTS.md §M: its own module, not part of `channel-workspaces`, which keeps its contract). Tool
   `agent_export_research_data` (permission DRAFT, channel-bound, passes the mutation gate) writes flat files into `<workspace>/99 Data Exchange/From YTM/` (see the amendment below):
   `research_channel_snapshots`, `research_video_snapshots` and our own channel's public videos as `own_video_snapshots` (same columns as the
   video file). CSV (RFC 4180, formula guard on the `title` column only) and/or JSON (values exactly as stored). The caller chooses neither the
   folder nor any file name (strict input; names are dataset + UTC time + random suffix, never a title or handle). The response is only paths,
   row counts, sizes and `expiresAt`.
2. **Reads only through existing cores**: market-intelligence's `getWatchlistEntryContext` (already limited to the 30-day window) and the
   market-assignment confinement (`filterForAgent` / `assertAvailableToAgent`), so an export can never show more than `query_competitors` /
   `query_market_intelligence` show an agent.
3. **Path safety at export time**, not only at set time: the workspace is re-validated, `99 Data Exchange/From YTM/` must be a plain folder (not a symlink) whose
   real path stays strictly inside the workspace's real path, files are written to a temp name and renamed, and a failure part-way removes what
   that call wrote.
4. **Retention (YouTube policy III.E.4.d, ADR D1 = a)**: a file holding other channels' API-sourced rows expires 30 days after the oldest such
   observation in it. Every written file is recorded in `workspace_export_files` (schema v46, device-local, classified `not_api_data`); a
   scheduled sweep (`src/instrumentation.ts`, every 6 h and 75 s after boot, skipped while the device may not mutate) deletes expired files **by
   ledger only** -- never a scan or glob of the operator's folder, never a symlink or a file that is no longer a plain file. Own-channel files
   have no expiry.
5. **No derived competitor metrics (III.E.4.h, Phase 13 D1)**: the bulk read `query_market_overview` and the exports carry raw stored values
   and plain row counts only. Medians, percentiles, rates and ratios over other channels' statistics were requested and are NOT built.
6. Same change, small additions the agent asked for: `agent_query_channel_reach` gains `videoId` and `groupBy: video_day`;
   `agent_query_video_analytics` gains `format: wide`; `channel_video_list` gains `fields`, `limit`, `offset`.
7. `AGENT_API_VERSION` 3.0.0 -> **3.1.0** (MINOR: new capabilities `market_intelligence.export_research_data` and
   `market_intelligence.query_market_overview`; the field additions are backward compatible).

## Consequences

- A script (or an agent's own script) can read files the Manager produced; the agent still cannot write anywhere or choose a path.
- A copy of a research file the agent makes outside `99 Data Exchange/From YTM/` is outside the Manager's control; the tool description and `retentionNote` say
  to treat copies as short-lived (RISK-98).
- The expiry sweep runs only while the app runs; a file can outlive its expiry by the time the app was off, deleted at the next start.

## Amendment 2026-10-04 — fixed destination «99 Data Exchange/From YTM» (owner decision, BL-123)

The operations agent's updated request set a boundary: the Manager must not touch the agent's project files. The owner approved ONE deliberate exception
(Telegram, 2026-10-04: «Да, вместо» / «мы добавляем осознанное исключение, что в эту папку мы можем делать записи»): the export folder is the fixed name
`99 Data Exchange/From YTM` directly inside the stored workspace path, **replacing** `exports/` (nothing had ever been exported, so there is nothing to migrate).
Limits: the stored workspace setting is never changed; the Manager writes only research exports there and only creates `99 Data Exchange/From YTM` itself; it never
modifies or deletes anything it did not create (the expiry sweep acts on the ledger only); if the folder cannot be created the call fails with
`RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE` and nothing is written or recorded. Everything after the export (what scripts or agents do with the files, copies,
figures derived from them) is outside the application's scope; the response and tool description state only the 30-day rule. The agent's other asks were
settled in the same pass: no CLI for agents (ADR 0013), no competitor summaries (III.E.4.h/III.E.2.a); the optional read-only HTTP route (slice 2 of
`docs/roadmap/plans/RESEARCH_DATA_INBOX_PLAN.md`) is **not built** — the owner's answer was that the application's work ends with the export into the folder.

## Amendment 2026-10-04 (owner): `99 Data Exchange/From YTM` and `Sent to YTM`

The folder `99 Data Inbox` is replaced by `99 Data Exchange` with two fixed subfolders: `From YTM` (the Manager writes research exports here) and `Sent to YTM` (reserved for future inbound material such as videos to upload; the Manager only creates the empty folder and writes nothing there yet). All three are created on first use. They are a hand-over buffer, not storage: the receiving side deletes what it has processed. The Manager's own expiry sweep (30-day API-policy rule) stays as a safety net for research files it wrote; ledger rows written under the old `99 Data Inbox` path are still swept. A pre-existing `99 Data Inbox` folder is left untouched.
