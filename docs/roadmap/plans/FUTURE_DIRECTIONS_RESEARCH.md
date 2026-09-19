# Future Directions — Feasibility Research Notes

Covers backlog items `BL-006` and `BL-007` (`docs/roadmap/BACKLOG.md`), both sourced from
`docs/roadmap/FUTURE_PHASES.md` §7 ("future directions — not yet numbered phases"). That section
is explicit these are "recorded as future opportunities only, not approved implementation work,
and not to be implemented during Phases 7-10 unless separately approved" — so unlike
`PHASE_7_PLAN.md`/`PHASE_8_PLAN.md`/`PHASE_9_PLAN.md`/`PHASE_10_PLAN.md`, this document does not
propose implementation slices or acceptance criteria. It answers a narrower question for each:
*is there anything concrete enough here yet to even plan, or is more groundwork needed first?*

## BL-006 — Application-managed concurrent multi-device sync

**What exists today:** `src/lib/device-handoff/` (`docs/ARCHITECTURE.md` §13,
`docs/RELEASE_LAYOUT.md`) implements Variant A — one active device at a time, snapshot
export/import over Syncthing, with a live-recomputed recovery mode for imported unresolved
execution state. This is explicitly, by design, not concurrent multi-device sync — a second
device cannot safely write while the first is active, and the handoff protocol assumes exactly
one device holds write authority at any moment (the operation lock, `src/lib/operation-lock/`,
enforces this at the SQLite level).

**Why this isn't ready to plan yet:** genuine concurrent multi-device sync is a different problem
class from handoff — it needs either (a) a conflict-resolution strategy for concurrent writes to
the same SQLite database from two devices (CRDT-style merge, last-writer-wins with a defined
tiebreak, or a server-mediated single-writer model), or (b) moving off local SQLite entirely
toward a networked database, which `docs/PROJECT_SPEC.md`'s local-first, single-operator model
was deliberately built around. Either path is a foundational architecture decision, not a
vertical slice — `docs/decisions/` doesn't have an ADR for this yet, and one would need to exist
*before* any planning document like `PHASE_7_PLAN.md`'s style would be useful, since the
9-step planning sequence assumes a "smallest useful vertical slice" exists to find, and here the
foundational choice itself is still open.

**What research would need to happen first:** whether any current or planned feature actually
needs true concurrency (vs. handoff being sufficient for the single-operator model this product
targets), and if so, which of the two architectural directions above the project owner prefers,
before any schema or protocol work is worth doing.

**Disposition:** left as a recorded future opportunity, not advanced to a plan document. Revisit
once there's a concrete driving need for concurrency beyond what handoff already covers, or the
project owner wants to make the underlying architecture decision independently of any specific
feature need.

## BL-007 — Automated media production feasibility

**What exists today:** nothing. No audio/video generation, rendering, publishing automation, or
livestream management exists anywhere in this codebase, and nothing in the current architecture
(`docs/ARCHITECTURE.md`) anticipates it — the entire current product is a metadata/localization
operations tool, not a content-production tool.

**Why this isn't ready to plan yet:** this isn't one capability but at least four largely
unrelated ones (audio generation + QC, video generation + rendering, automated publishing,
livestream management), each with its own vendor landscape, cost model, and safety
considerations (e.g. automated publishing directly touches YouTube write-safety in a much larger
way than a metadata edit — publishing new content is a fundamentally bigger action than editing
an existing video's title). `docs/PROJECT_SPEC.md`'s write-safety model (`AGENTS.md` §G) was
designed around editing existing videos' metadata, not creating and publishing new ones — this
would need its own safety-model extension before any of the four sub-capabilities could follow
the existing identity/validation/backup/diff/approval/dry-run/audit/verification pattern
meaningfully.

**What research would need to happen first:** which of the four sub-capabilities (if any) the
project owner actually wants to pursue — they don't need to be planned or built together, and
conflating them into one "Phase" would violate `AGENTS.md` §C's smallest-safe-slice principle at
the planning level already. Once one sub-capability is chosen, that one would get its own
`PHASE_N_PLAN.md`-style document following the same 9-step sequence as Phases 7-10.

**Disposition:** left as a recorded future opportunity, not advanced to a plan document — there
is no single vertical slice to identify yet because there is no chosen sub-capability to slice.

## Where this is recorded

This document lives here, not in `docs/roadmap/BACKLOG.md` or `docs/roadmap/FUTURE_PHASES.md`,
per `FUTURE_PHASES.md` §9 step 9 (the same convention `PHASE_7_PLAN.md` through
`PHASE_10_PLAN.md` follow). `BL-006` and `BL-007` point at this document once marked `done` —
"done" here means "the requested research/feasibility pass was performed," not "the feature is
now planned for implementation."
