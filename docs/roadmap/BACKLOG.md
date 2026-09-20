# BACKLOG.md — Tracked Backlog Items

Discrete, in-flight tasks derived from `docs/roadmap/FUTURE_PHASES.md`. This is neither the
strategic backlog (that's `FUTURE_PHASES.md`) nor the execution log (that's
`docs/ROADMAP_STATUS.md`) — it is the tracked middle state between "this capability is on the
roadmap" and "this is done and recorded in ROADMAP_STATUS.md". A row here reaching `done` should
also produce (or point at) a `ROADMAP_STATUS.md` entry; `ROADMAP_STATUS.md` remains the sole
record of what actually happened.

**No status here is an authorization.** Per `AGENTS.md` §C, a phase begins only with the project
owner's own explicit assignment — a row marked `assigned` records that an assignment already
happened (and must say where/when), it never substitutes for one.

See `.claude/skills/roadmap-backlog/SKILL.md` for the full format, status definitions, and
workflow this file follows.

## Items

| ID | Title | Source | Status | Opened | Notes |
|---|---|---|---|---|---|
| BL-001 | Phase 7: draft the API/MCP error-shape and versioning contract for Codex-facing endpoints | FUTURE_PHASES.md §3 (Phase 7) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Delivered as `docs/roadmap/plans/PHASE_7_PLAN.md` — a plan, not implementation; no code written. See `docs/ROADMAP_STATUS.md`'s Phase 7 planning row. |
| BL-002 | Phase 7: design the isolated Codex operations workspace boundary (permissions model, read-only data access, zero dev-repo access) | FUTURE_PHASES.md §3 (Phase 7) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Same delivery as BL-001 — `docs/roadmap/plans/PHASE_7_PLAN.md` §4/§5. Actual workspace implementation remains unassigned. |
| BL-003 | Phase 8: research YouTube Analytics API scope and design a minimal scheduled-sync + metric-definition model | FUTURE_PHASES.md §4 (Phase 8) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Delivered as `docs/roadmap/plans/PHASE_8_PLAN.md` — plan only; no Analytics API call, no OAuth, no schema change made. |
| BL-004 | Phase 9: design the research-watchlist data model (source attribution, freshness/confidence fields, no fixed competitor-count limit) | FUTURE_PHASES.md §5 (Phase 9) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Delivered as `docs/roadmap/plans/PHASE_9_PLAN.md` — plan only; no table, code, or public API call made. Discovery logic itself remains a later, separate slice requiring its own assignment. |
| BL-005 | Phase 10: design the hypothesis/experiment/decision data model, kept explicitly distinct from the existing Change Set entities | FUTURE_PHASES.md §6 (Phase 10) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Delivered as `docs/roadmap/plans/PHASE_10_PLAN.md` — plan only; no table or code written. Explicitly notes this phase depends on Phase 8/9 actually existing to have real evidence to reason about. |
| BL-006 | Investigate application-managed concurrent multi-device sync as a Syncthing-handoff replacement/extension | FUTURE_PHASES.md §7 (future directions) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Delivered as `docs/roadmap/plans/FUTURE_DIRECTIONS_RESEARCH.md` — concludes a foundational architecture decision (conflict resolution vs. networked DB) is needed before any vertical slice can be planned; not advanced to a plan document. |
| BL-007 | Feasibility research for automated media production (audio/video generation, rendering, publishing, livestream management) | FUTURE_PHASES.md §7 (future directions) | done | 2026-09-20 | Assigned 2026-09-19 (Telegram msg 60). Delivered as `docs/roadmap/plans/FUTURE_DIRECTIONS_RESEARCH.md` — concludes this is 4 unrelated sub-capabilities needing an owner choice of which one (if any) to pursue before a plan is possible; not advanced to a plan document. |
| BL-008 | Implement `channel_sync`/`channel_list`/`channel_video_list` MCP tools, closing the remainder of RISK-04's MCP portion | `docs/TECHNICAL_DEBT.md` RISK-04 (not part of `PHASE_7_PLAN.md`'s own slice list — a gap found while updating that risk entry after Phase 7 slice 1) | done | 2026-09-20 | Self-initiated during Phase 7 slice 1 implementation, per the project owner's Telegram msg 67 ("При необходимости по результатам анализа создавай новые задачи в бэклог и реализуй их"). Delivered: 3 MCP tools + 5 tests, `channel_sync` gated (local-mutating), `channel_list`/`channel_video_list` ungated (read-only). `docs/TECHNICAL_DEBT.md` RISK-04 updated. |
| BL-009 | Rework the CLI's `ParsedArgs["command"]` flat string union and `READ_ONLY_CLI_COMMANDS`/`AUTH_SESSION_EXEMPT_CLI_COMMANDS` gate Sets to key on the `(namespace, command)` pair instead of a bare command string | `src/cli/video-metadata.ts` — found by independent review (`/code-review high`, review cycle 1, 2026-09-20) during the CLI-parity task | proposed | 2026-09-20 | Currently fail-safe by construction (an un-listed command defaults to gated, never the reverse), so no live bug — but a future namespace reusing "list"/"get" for a genuinely mutating command would silently skip the device-availability gate purely because that string happens to already be in the read-only Set from an unrelated namespace. MCP's own equivalent gate is immune to this (keyed per fully-qualified tool handler). Deliberately not fixed inline during review cycle 1 — a real refactor of the namespace/command type design, not a one-line fix. |
| BL-010 | Extract a shared "get batch with its ledger rows" helper (`requireBatchForChannel` + `listLedgerRows` + `{batch, ledgerRows}`) instead of the same 3-line composition duplicated in the Web API route, the MCP `batch_get` tool, and the CLI `batch get` command | `src/lib/batches/services.ts` (natural home) — found by independent review (`/code-review high`, review cycle 1, 2026-09-20) during the CLI-parity task | proposed | 2026-09-20 | Not a live bug (all three call sites are currently identical and correct), but `AGENTS.md` §D's "no parallel implementation" spirit is stretched by three independent copies of the same composition — a future change to this read (extra field, ledger pagination) must be applied three times by hand. Deliberately not fixed inline during review cycle 1 (small refactor, better scoped as its own task with its own test). |

Rows were seeded on 2026-09-20 when the `roadmap-backlog` skill was created, as a first pass at
turning `FUTURE_PHASES.md`'s Phase 7-10 and future-directions sections into trackable slices.
All seven were assigned the same day per the project owner's explicit Telegram instruction (msg
60, 2026-09-19: "Приступай к разбиению future phases на таски backlog. После чего приступай к их
выполнению. Автоматический режим работы.") — each item's own Notes column records this. Every
item's *current* scope is a design/research artifact (a planning document under
`docs/roadmap/plans/`), never a live YouTube write, paid AI call, OAuth login, or deployment —
those remain separately gated by `AGENTS.md` §G/§K regardless of this assignment. Should any of
these design efforts surface a need for actual feature implementation, that implementation is its
own new backlog item requiring its own assignment — this one covers the design/research slice
only, per `AGENTS.md` §C's "smallest safe implementation phase" principle.
