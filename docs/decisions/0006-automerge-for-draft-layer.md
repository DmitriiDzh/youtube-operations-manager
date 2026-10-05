# 0006. Adopt Automerge (CRDT) as the source of truth for the draft/change-set layer

Status: Accepted

Decided directly with the project owner over Telegram, 2026-09-21, resolving the foundational
architecture question `docs/roadmap/plans/FUTURE_DIRECTIONS_RESEARCH.md`'s BL-006 entry left open
("genuine concurrent multi-device sync... is a foundational architecture decision, not a vertical
slice... one would need to exist before any planning document... would be useful").

## Context

BL-006 (2026-09-20) investigated whether this application's device-handoff model (`src/lib/
device-handoff/`, Variant A — one active device at a time, whole-database snapshot export/import
over an operator-configured Syncthing folder) could be extended into genuine concurrent
multi-device sync. That investigation concluded the underlying model — a full SQLite snapshot,
checksummed and lineage-checked, imported as a wholesale replace of most tables — is structurally
incompatible with two devices safely writing at the same time, and that closing this gap requires
a real architecture decision (CRDT-style conflict resolution vs. a networked database) before any
vertical slice is worth planning.

The trigger for actually making that decision now: the project owner asked, independently of any
specific feature request, how the current device-handoff scheme should be evaluated given the
project's own stated future needs — genuine multi-device sync, ideally with true concurrent
editing, for a tool that manages several YouTube channels, not one. A dedicated research pass
(this session, 2026-09-21) compared CRDT-based sync engines (Automerge, Yjs, cr-sqlite) against
Postgres-backed sync platforms (PowerSync, ElectricSQL, Zero) and the project's own existing
libSQL/Turso vendor's offline-writes feature. The owner then asked for a migration plan to
Automerge specifically, which is the decision this ADR records.

## Problem

Two things needed deciding:

1. **Does this application need a networked backend at all**, or can genuine concurrent editing be
   achieved while staying local-first (data usable and writable without any server being
   reachable), consistent with `docs/PROJECT_SPEC.md`'s existing local-first, single-operator
   design center?
2. **How much of the existing data model does a concurrency fix actually need to touch?** The
   safety-critical send pipeline (`batches`/`batch_ledger_rows`/`batch_attempts`/`audit_events`) is
   extensively tested against `docs/acceptance/PHASE_5_ACCEPTANCE.md` and is not the part of the
   system that actually needs concurrent multi-device editing — only the *draft* data operators
   propose and refine before approval (`change_sets`/`changes`) does.

## Decision

- **Automerge** (a CRDT library, not a hosted platform) becomes the source of truth for the draft
  layer that today lives in the `change_sets`/`changes` SQL tables — per-video, per-language,
  per-field title/description proposals and their approval status. This directly targets problem 1:
  Automerge is peer-to-peer by design, requires no server to merge two devices' changes, and keeps
  the application local-first.
- **The scope is deliberately narrow.** `batches`/`batch_ledger_rows`/`batch_attempts`/
  `audit_events` — the actual YouTube-write pipeline — are explicitly **not** touched by this
  decision and remain exactly as they are today: relational SQLite, fed by a single clean read of
  approved data at the moment a Batch is created, unchanged in every other respect. This directly
  targets problem 2: the part of the system with the least tolerance for a new failure mode
  (`AGENTS.md` §G's identity/validation/backup/diff/approval/dry-run/audit/verification pipeline)
  stays outside the blast radius of this migration entirely.
- **One Automerge document per channel.** This reuses the project's own existing per-channel
  identity concept (`write-context`, `channels` table) as the natural sync/conflict boundary —
  edits to two different channels' drafts never interact or conflict with each other, regardless
  of which devices make them.
- **A read-only SQL projection is maintained locally**, regenerated whenever the local Automerge
  document changes (on a local edit or after merging in a remote one), so the existing Web UI, API
  routes, MCP tools, and CLI commands that list/filter/search Change Sets keep working against SQL
  as they do today — none of them need to become Automerge-aware directly. Automerge itself is not
  meaningfully queryable the way SQL is; the projection is what makes this migration compatible
  with the existing query-heavy surface without rewriting it.
- **Transport (how Automerge's binary changes actually move between machines) is deliberately left
  undecided by this ADR.** Two materially different options exist — reusing the existing
  Syncthing-shared folder (no new infrastructure, but async/coarser sync and its own conflict
  behavior for opaque binary files) versus a small live sync-relay server (real-time, but a new
  always-on infrastructure component this project has never required before). This is recorded as
  an explicit required owner decision in `docs/roadmap/plans/AUTOMERGE_MIGRATION_PLAN.md` §8, not
  decided here, since it has real cost/infrastructure implications independent of the data-model
  decision this ADR makes.

## Rationale

Automerge over a Postgres-backed sync platform (PowerSync/ElectricSQL/Zero): all three researched
platforms require adopting Postgres as a new networked source-of-truth server, and none of them
actually deliver automatic conflict resolution for concurrently-edited structured fields — they
reduce to last-write-wins or hand-rolled server-side merge logic, so they do not clearly outperform
simpler options for what this project actually needs, while costing real new infrastructure.
Automerge over cr-sqlite (a CRDT extension directly on SQLite, which would have been an even
closer fit to the existing stack): cr-sqlite is meaningfully less mature/proven than Automerge as
of this research pass, and the safety-conscious posture this codebase already holds toward its
data (`AGENTS.md` §G, the extensive Phase 5 acceptance contract) argues for the more battle-tested
option for a foundational data-model change. Narrow scope (draft layer only, not the whole
database) follows `AGENTS.md` §C's smallest-safe-slice principle applied at the architecture
level — the send pipeline doesn't have the problem this decision solves, so it shouldn't inherit
this decision's risk.

## Consequences

**Easier:** genuine concurrent multi-device editing of localization drafts becomes possible for
the first time, without introducing a mandatory server dependency or abandoning the project's
local-first model. The existing conflict-detection philosophy this codebase already trusts for the
actual YouTube write (compare against a fresh state immediately before acting, surface a conflict
rather than silently overwriting) extends naturally to Automerge's own "surface the conflict,
never silently pick a winner" behavior for same-field concurrent edits.

**Harder / follow-up work this decision creates, not yet done:**

- A one-time data migration of every existing local `change_sets`/`changes` row into an initial
  Automerge document per channel, with zero data loss, is required before this can go live on an
  existing installation.
- Every current reader/writer of `change_sets`/`changes` (Web UI, API routes, MCP tools, CLI
  commands) needs to be re-pointed at a new Automerge-aware service layer instead of the SQL tables
  directly — a real, multi-surface refactor, not a drop-in library swap.
- The project takes on a genuinely new dependency and data model (Automerge) with its own
  operational characteristics and learning curve, distinct from anything else in this codebase
  today.
- Whichever transport option is eventually chosen (§ above) has its own new cost: file-based sync
  over Syncthing needs its own verification that two independently-changed Automerge files merge
  safely through a tool (Syncthing) that has no awareness of Automerge's format; a live relay
  server is new infrastructure this project has never needed before.
- See `docs/roadmap/plans/AUTOMERGE_MIGRATION_PLAN.md` for the full slice breakdown, acceptance
  criteria, and the specific owner decisions still required before any implementation slice may be
  assigned (`AGENTS.md` §C — this ADR authorizes a *direction*, not implementation).

## Compatibility / migration impact

No implementation exists yet as of this ADR — see the migration plan for the proposed one-time
data migration approach. The existing `change_sets`/`changes` tables are not deleted as part of
adopting this direction; the plan's proposed rollout (dual-write, then cutover) keeps them as a
safety net during the transition rather than committing to an irreversible schema change on day
one. The device-handoff/snapshot mechanism for every *other* table (`channels`, `videos`,
`batches`, `audit_events`, etc.) is unaffected and continues exactly as documented in
`docs/RELEASE_LAYOUT.md`.
