# ROADMAP_STATUS.md

**Execution log**, not a requirements document. `docs/PROJECT_SPEC.md` remains the unmodified source of truth for *what* the product must do and in what order; this file records *what has actually happened* — which phase is complete, when, in which commit, and what is blocking the next one. When the two would ever seem to disagree on sequencing, `docs/PROJECT_SPEC.md` wins; this file is corrected to match reality, never the other way around.

Update this file whenever a phase completes — see `AGENTS.md` §C. **Completing a phase and recording it here does not authorize starting the next phase.** The next phase begins only when the project owner explicitly assigns it.

---

## Phase status

| Phase | Status | Completion date | Commit(s) | Summary |
|---|---|---|---|---|
| Phase 0 — Analyze upstream | COMPLETED | 2026-09-15 | `bab2432` | `docs/UPSTREAM_ANALYSIS.md` — architecture inventory of the TubeMaster-derived baseline. |
| Phase 1 — Independent baseline | COMPLETED | 2026-09-15 | `bab2432` | `docs/UPSTREAM_BASELINE.md` — verified install/test/lint/build against baseline commit `e8f5bae`; documented as "READY FOR PHASE 2". |
| Phase 2 — Channel/video synchronization | COMPLETED | 2026-09-15 | `259d9a1`, `17880a4` | Read-only `channel-sync` module, `channels`/`videos` tables, uploads-playlist enumeration, batched `videos.list`. |
| Phase 3 — Localization Manager (read-only) + XLSX export | COMPLETED | 2026-09-15 | `137c9ab` | `localization/` read model, XLSX export (Videos + Localizations sheets). |
| Phase 4 — XLSX import, draft state, Change Sets, diff/approval | COMPLETED | 2026-09-16 | `6a561ea` | `changesets/` module, `change_sets`/`changes` tables, import/validate/diff/approve-reject, conflict detection against synced state, Web UI + API. No YouTube writes anywhere in this phase. |
| Phase 4.5 — Development autonomy, documentation & security gates | COMPLETED | 2026-09-16 | `19df1fb`, `f54ffbf` | `docs/DEVELOPMENT_PLAYBOOK.md`, `docs/TECHNICAL_DEBT.md`, `docs/decisions/` (ADR policy), `AGENTS.md` rewritten as the primary persistent instruction file, specification-driven/independent testing standards (`AGENTS.md` §L, `docs/DEVELOPMENT_PLAYBOOK.md` §6.14). Documentation-only — no application code changed. |
| Phase 5 — Safe YouTube localization writes | **IN PROGRESS** (Slices 1-3 of 5) | Slices 1-3: 2026-09-17 | *(uncommitted as of this entry)* | `src/lib/batches/`, `src/lib/backup/`, `src/lib/audit/` — batch entity, per-video execution ledger, durable attempt-intent model, safety preparation (identity/conflict/merge/backup), dry-run, crash recovery, durable audit trail, post-write verification. **No real YouTube write adapter exists yet** — `WriteExecutor` has only a test fake; no production code path can reach a real `videos.update` call. See `docs/SYSTEM_MAP.md` §2.9a and `docs/TECHNICAL_DEBT.md` RISK-09 for full detail. |

---

## Next assignment

**Phase 5, Slice 4** (real YouTube adapter behind the `WriteExecutor` port) is the next piece of the already-assigned Phase 5 work, per `docs/PROJECT_SPEC.md` §64 (Fifth Agent Assignment) and the approved five-slice plan in `docs/acceptance/PHASE_5_ACCEPTANCE.md`. Building the adapter is in scope; wiring it into any production code path that could perform a **real, non-dry-run** write still requires separate authorization per `AGENTS.md` §K before that path is exercised outside tests. Slice 5 (API routes / UI wiring for batch execution) follows once Slice 4 lands.

**Still open, not yet done:** apply the `next@16.3.5` / `next-auth@4.24.15` patches (`docs/TECHNICAL_DEBT.md` RISK-06) — isolated, low-risk, removes two critical `npm audit` findings before write-capable code goes further into the authentication flow they touch.

`docs/TECHNICAL_DEBT.md`'s **Gate A** (before implementing Phase 5) is satisfied as of Phase 4.5 — see that document for the checklist.

**Acceptance contract:** `docs/acceptance/PHASE_5_ACCEPTANCE.md` — status **APPROVED** (fifth review round, 2026-09-17). OQ-1..OQ-6 answered; this approval authorizes Phase 5 preparation/implementation work (including mocked tests) but is not itself authorization for any real, non-dry-run YouTube write (`AGENTS.md` §K).

## Open blockers before Phase 5 writes may go live (Gate B)

Per `docs/TECHNICAL_DEBT.md`'s Gate B, none of the following may be waived by risk acceptance — each must be actually implemented and tested:

- **RISK-03** — fresh remote conflict detection (Phase 4 only checks the last synced snapshot, not live YouTube state).
- **RISK-09** — immutable backup, durable audit log, per-item execution ledger with idempotent resume, post-write verification (none exist yet for bulk localization writes).

Also tracked, not blocking Phase 5 *development* but blocking later gates (see `docs/TECHNICAL_DEBT.md` for full detail): RISK-04 (no CLI/MCP Change Set interfaces — blocks Gate C, operations handoff), RISK-05 (no live browser/OAuth verification — blocks Gate C), RISK-06 (dependency advisories — blocks Gates C and D), RISK-01/02/07 (deferred, accepted for the current single-operator local model, blocking only Gate D / network deployment).

---

## How to keep this file current

1. When a phase's Definition of Done (`docs/DEVELOPMENT_PLAYBOOK.md` §6.13) is satisfied and the project owner has accepted the work, add or update its row in the table above with the actual completion date and commit hash(es) — do this as part of the phase's own final commit or immediately after, not as a separately-forgotten follow-up.
2. Update "Next assignment" to name whatever the project owner assigns next; do not guess ahead or pre-announce a phase that has not been explicitly assigned.
3. Re-check "Open blockers" against the current state of `docs/TECHNICAL_DEBT.md` — a risk closed there should be reflected here, and vice versa.
4. This file is part of the documentation-maintenance table in `docs/DEVELOPMENT_PLAYBOOK.md` §6.12 ("a development phase is completed" row) — keep both in sync.
