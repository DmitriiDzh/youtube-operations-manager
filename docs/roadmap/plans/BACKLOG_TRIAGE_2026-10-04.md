# Backlog triage — the «big proposed items» (owner request 2026-10-04)

Analysis only; no row has been changed. Facts below were checked against the code, the real database (read-only) and the roadmap documents on 2026-10-04.

## Findings per item

| Item | State today | Recommendation |
|---|---|---|
| **BL-033** Languages redesign | Stale. E1–E4b shipped (BL-037), E5a tracked-language columns (BL-039), E5b deletion proposal (BL-040), Sync-now + add-column menu (BL-041), hard allowlist (BL-042) — all `done`. What the row still calls open is E5's second write path (BL-035 Open Question 2, deliberately waiting for real Gate-B tests) and E6 (AI-recommended languages, an empty placeholder by owner decision). | Mark `done` and split the two leftovers into their own `proposed` rows with their blocker named, or drop E6. No code. |
| **BL-017** Analytics stub tab | Obsolete: the Analytics tab is real (Studio-parity, Reach, BL-120). | `dropped` (superseded). |
| **BL-021 / BL-023** Sync-tab channel dropdown / auto-resync | Written for a standalone Sync tab; the dashboard now has Home, Content, Analytics, Languages, Batches, Research, Decisions, Settings, Merge (no Sync tab; «Sync» is a Settings sub-tab for device sync). Channel sync lives in Content. | Verify once in the UI that Content has no leftover channel dropdown; then `dropped` (superseded). Auto-resync freshness is not lost: analytics/auto-collect already runs on dashboard open. |
| **BL-105 / BL-106** Phase 9 live verification / Opportunities tab | Blocked by policy, not by time: velocity, breakout and emerging-channel values for other channels are **withheld** (`withheld_by_policy`, YouTube III.E.4.h, Phase 13 D1) and other channels' API data is kept ≤30 days. The real database holds 38 watchlist channels but snapshots from a single day. Niche discovery over competitor statistics would be exactly the derived/aggregated metric the policy forbids. | `dropped` with the policy as the reason; keep the raw watchlist/exports (BL-119). |
| **BL-075** replace XLSX | The agent path already exists (BL-078: `ai_localization_*` MCP/CLI). What is left is one product question: does the human-edited spreadsheet still have value? XLSX export also captures the conflict-detection baseline, so removing it is not free. | **Owner decision needed** (below). Recommendation: keep XLSX as an optional human path, close BL-075 as «decided: keep». |
| **BL-010** shared «batch with ledger rows» helper | Small, real duplication in three call sites. | Do it (≈ half a day): one helper in `batches/services.ts`, three callers, a test. |
| **BL-009** CLI gate keyed by (namespace, command) | No live bug today (fail-safe by construction), a latent trap for a future command named `list`/`get`. | Do it after BL-010 (≈ 1 day): re-key the two gate sets, add a test that every namespace's mutating command is gated. |
| **BL-100** test-suite duplication | Large test files with byte-identical helpers; risk is weakening tests while refactoring (AGENTS.md §L). | Lowest priority; do last, one file group per commit, test counts must not drop. |

## Proposed execution plan

1. **Housekeeping (docs only, same day):** apply the dispositions above, fix BL-117/BL-118 rows that still say «in_progress» although merged. Small docs-only merge.
2. **BL-010 → BL-009** on one branch (`feature/cli-and-batch-read-cleanup`): small, no behaviour change, tests first; independent review once; owner's «yes» to merge.
3. **BL-075 closure** after the owner's decision (a docs edit).
4. **BL-100** later, only if the owner wants it (no product value, only maintenance).

## Decisions needed from the owner

1. Approve the dispositions: drop BL-017, BL-021, BL-023, BL-105, BL-106; mark BL-033 done with the two leftovers split out.
2. BL-075: keep XLSX as an optional human path (recommended) or deprecate it?
3. Start BL-010 + BL-009 now (recommended) and leave BL-100 for later?
