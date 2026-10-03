# BL-119 — Research export and bulk reads for scripts

Raised by the operations agent (2026-10-04, `2026-10-04-research-data-not-scriptable`) and assigned by the owner the same day. ADR 0019.

## Owner decisions (2026-10-04)

- A: other channels' API data in exports follows the 30-day rule; the Manager deletes its own expired files.
- B: an agent with READ + DRAFT may trigger the export; it chooses neither path nor file name.
- C: no workspace folder for the channel → refuse with a named error.
- Slice 3 (server-side medians/percentiles of competitor statistics) is NOT built: it is a derived metric under YouTube policy III.E.4.h and
  Phase 13 D1. Awaiting the owner: summaries for our own channel only, or none. (The agent's own computation of such figures from raw files is
  the same kind of derived metric; flagged to the owner.)

## Slices (one branch, `feature/research-data-export`)

1. Export tool `agent_export_research_data` + `workspace_export_files` ledger (v46) + scheduled expiry sweep.
2. Bulk read `query_market_overview` (several channels per call, paged, raw newest snapshot + counts).
4. `agent_query_channel_reach` (`videoId`, `groupBy: video_day`), `agent_query_video_analytics` (`format: wide`), `channel_video_list`
   (`fields`, `limit`, `offset`).

## Acceptance criteria (written from the agent's retest, before the code)

- AC-RE-1: one watchlist channel with 1 channel snapshot and 50 video snapshots → files with 1 and 50 data rows, inside `<workspace>/99 Data Inbox/`.
- AC-RE-2/3: CSV is RFC 4180 with the fixed column order, a hostile title is guarded and quoted; JSON keeps the text as stored.
- AC-RE-4: our own channel (public videos only) has exactly the competitor video columns and no expiry.
- AC-RE-5: research files expire 30 days after the oldest API observation; every file is in the ledger.
- AC-RE-6: no workspace folder → `RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED`, nothing written.
- AC-RE-7/8: an unavailable/unassigned channel is never exported (request fails before any file is written; the default list is the caller's).
- AC-RE-9: a `99 Data Inbox` symlink out of the workspace is refused, nothing lands outside.
- AC-RE-10: a write failure part-way leaves no file and no ledger row.
- AC-RE-11: `path`/`fileName` and any unknown input are rejected.
- AC-RE-12/13: the sweep deletes exactly the expired recorded files, never a symlink, never an unrelated file, never an own-channel file.
- AC-RE-14..16: bulk read pages correctly, keeps order, rejects bad limits.
- Reach, wide and field-selection additions: hand-computed expected rows in the module tests; legacy shapes unchanged when the new inputs are absent.

**Amendment 2026-10-04:** the destination folder is the fixed `99 Data Inbox` (ADR 0019 amendment, BL-123); every `exports` above reads as that folder.
