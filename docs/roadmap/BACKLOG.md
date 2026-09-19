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
| BL-001 | Phase 7: draft the API/MCP error-shape and versioning contract for Codex-facing endpoints | FUTURE_PHASES.md §3 (Phase 7) | proposed | 2026-09-20 | Smallest first slice of Phase 7's "standardized error shapes and operation results" + "explicit compatibility rules" goals. Not assigned. |
| BL-002 | Phase 7: design the isolated Codex operations workspace boundary (permissions model, read-only data access, zero dev-repo access) | FUTURE_PHASES.md §3 (Phase 7) | proposed | 2026-09-20 | Design-only slice; no implementation until explicitly assigned. |
| BL-003 | Phase 8: research YouTube Analytics API scope and design a minimal scheduled-sync + metric-definition model | FUTURE_PHASES.md §4 (Phase 8) | proposed | 2026-09-20 | Precedes any actual analytics collection code. |
| BL-004 | Phase 9: design the research-watchlist data model (source attribution, freshness/confidence fields, no fixed competitor-count limit) | FUTURE_PHASES.md §5 (Phase 9) | proposed | 2026-09-20 | Design-only; discovery logic itself is a later, separate slice. |
| BL-005 | Phase 10: design the hypothesis/experiment/decision data model, kept explicitly distinct from the existing Change Set entities | FUTURE_PHASES.md §6 (Phase 10) | proposed | 2026-09-20 | Must keep observed evidence, hypotheses, proposals, approvals, and outcomes as separate categories per the phase's own constraint. |
| BL-006 | Investigate application-managed concurrent multi-device sync as a Syncthing-handoff replacement/extension | FUTURE_PHASES.md §7 (future directions) | proposed | 2026-09-20 | Explicitly not covered by the current one-active-device-at-a-time handoff (`docs/RELEASE_LAYOUT.md`, Variant A). Research slice only. |
| BL-007 | Feasibility research for automated media production (audio/video generation, rendering, publishing, livestream management) | FUTURE_PHASES.md §7 (future directions) | proposed | 2026-09-20 | Recorded as a future opportunity only per FUTURE_PHASES.md's own framing — not approved implementation work. |

Rows were seeded on 2026-09-20 when the `roadmap-backlog` skill was created, as a first pass at
turning `FUTURE_PHASES.md`'s Phase 7-10 and future-directions sections into trackable slices.
None are assigned; adding a row here changes nothing about `AGENTS.md` §C's requirement that the
project owner assign a phase explicitly before implementation begins.
