---
name: roadmap-backlog
description: Manages this project's task backlog -- turning the strategic phases in docs/roadmap/FUTURE_PHASES.md into discrete, trackable backlog items in docs/roadmap/BACKLOG.md, and updating each item's status (proposed/assigned/in_progress/done/dropped) as work actually happens. Use this whenever the user (or the assistant, when idle-planning per FUTURE_PHASES.md §9) wants to add a backlog item, list open backlog items, check a backlog item's status, mark one assigned/in_progress/done/dropped, or asks anything about "backlog", "бэклог", "задачи из roadmap", "трекинг задач" for this repository. Also consult it before starting any AGENTS.md §C phase-authorization check, since a backlog item's status is evidence for (but never a substitute for) that authorization.
---

# Roadmap backlog management

This project already has two roadmap documents with a strict division of labor
(see `AGENTS.md` §A/§H and the header of each file):

- **`docs/roadmap/FUTURE_PHASES.md`** — the strategic *why* and *what might happen*. Phases,
  capabilities, constraints. Never marks anything as implemented, never itself authorizes
  starting a phase.
- **`docs/ROADMAP_STATUS.md`** — the execution *log*. What has actually been done, in which
  commit, as of when. Corrected to match reality, never rewritten to match a plan.

Neither document is a good place to track *individual, bite-sized, in-flight tasks* — that's
what's missing, and what `docs/roadmap/BACKLOG.md` (created by this skill the first time it's
needed) is for. Think of it as sitting between the other two: a backlog item starts life as a
concrete slice of something `FUTURE_PHASES.md` describes at the capability level, and ends life
as a row in `docs/ROADMAP_STATUS.md` once it's actually done — `BACKLOG.md` is the tracked,
in-progress middle state, not a third source of truth competing with either.

**The one rule everything else here serves:** creating or updating a backlog item is bookkeeping,
never authorization. `AGENTS.md` §C requires an explicit project-owner assignment before any phase
begins, and recording a phase as complete in `docs/ROADMAP_STATUS.md` never authorizes the next
one. This skill must never let a backlog item's existence, or its status field, be mistaken for
that assignment. If you catch yourself about to start implementing something *because* a backlog
item says "assigned," stop and check: did the project owner actually say so, or did the item just
get created that way? Only the former counts.

## docs/roadmap/BACKLOG.md format

If the file doesn't exist yet, create it with this header (adjust the intro paragraph's wording,
but keep the substance — future readers, human or agent, need the same warnings the other two
roadmap docs already carry):

```markdown
# BACKLOG.md — Tracked Backlog Items

Discrete, in-flight tasks derived from `docs/roadmap/FUTURE_PHASES.md`. This is neither the
strategic backlog (that's `FUTURE_PHASES.md`) nor the execution log (that's
`docs/ROADMAP_STATUS.md`) -- it is the tracked middle state between "this capability is on the
roadmap" and "this is done and recorded in ROADMAP_STATUS.md". A row here reaching `done` should
also produce (or point at) a `ROADMAP_STATUS.md` entry; `ROADMAP_STATUS.md` remains the sole
record of what actually happened.

**No status here is an authorization.** Per `AGENTS.md` §C, a phase begins only with the project
owner's own explicit assignment -- a row marked `assigned` records that an assignment already
happened (and must say where/when), it never substitutes for one.

## Items

| ID | Title | Source | Status | Opened | Notes |
|---|---|---|---|---|---|
```

Each row:

- **ID** — `BL-NNN`, zero-padded, monotonically increasing, never reused (mirrors the `RISK-NN`
  convention in `docs/TECHNICAL_DEBT.md` — consistent numbering styles make cross-referencing
  between these documents easier for whoever reads them next).
- **Title** — short, specific, describes a *slice*, not a whole phase. "Phase 7: stable
  MCP/API contract for Codex" is too big for one item; "Phase 7: draft the API error-shape
  convention for Codex-facing endpoints" is a reasonable item. If a phase needs breaking down,
  add several rows with the same Source rather than one oversized row — this mirrors
  `AGENTS.md` §C's own "identify the smallest safe implementation phase" instinct, just applied
  one level more granularly.
- **Source** — a pointer into `FUTURE_PHASES.md`, e.g. `FUTURE_PHASES.md §3 (Phase 7)` or
  `FUTURE_PHASES.md §7 (future directions — multi-device sync)`. Every item must trace back to
  something already recorded there; if the user describes a new idea that isn't in
  `FUTURE_PHASES.md` yet, add it there first (that's the strategic-backlog document's job), then
  reference it here — don't let `BACKLOG.md` accumulate ideas `FUTURE_PHASES.md` doesn't know
  about, or the two will drift.
- **Status** — one of the five values below.
- **Opened** — the date the row was added (not the date the underlying phase was first
  described in `FUTURE_PHASES.md`).
- **Notes** — free text: current blocker, who assigned it and when (quote or paraphrase the
  actual instruction), branch name once one exists, `ROADMAP_STATUS.md` row/commit once done.
  Keep this short (`AGENTS.md` §H, added 2026-09-21) — a few sentences plus the commit hash, not
  a full paragraph re-narrating implementation detail that the commit message already records.

## Status values and what each one actually means

| Status | Meaning | Who/what can set it |
|---|---|---|
| `proposed` | A candidate slice worth doing, not yet assigned. | Anyone — the project owner, or the assistant during idle planning (`FUTURE_PHASES.md` §9). This is the only status the assistant may set on its own initiative. |
| `assigned` | The project owner has explicitly assigned this specific slice. | Only after an actual owner instruction. The Notes column must say what was said and when (or point at where) — never inferred from silence, from `FUTURE_PHASES.md`'s ordering, or from "they'll probably want this next." |
| `in_progress` | Work has actually started on a real branch. | Set together with recording the branch name in Notes, following `AGENTS.md` §K.1 (a `feature/<name>` branch cut from `dev`'s tip). |
| `done` | Merged, verified, and reflected in `docs/ROADMAP_STATUS.md`. | Set together with adding/updating the corresponding `ROADMAP_STATUS.md` row — do this in the same pass, not as a separately-forgotten follow-up (same discipline `AGENTS.md` §C already asks for when a phase completes). |
| `dropped` | Decided against, or superseded. | Requires a one-line reason in Notes (e.g. "superseded by BL-014" or "owner decided not to pursue, 2026-10-02"). Never delete a dropped row — it's useful history, exactly like a `RESOLVED` risk entry stays in `docs/TECHNICAL_DEBT.md` instead of being removed. |

The only transition this skill is ever allowed to make *unprompted* is creating a new row as
`proposed`. Every other transition needs a concrete trigger: an explicit owner instruction
(`assigned`), a branch that actually exists (`in_progress`), a merge that actually happened
(`done`), or an explicit decision (`dropped`). If you're not sure which bucket a request falls
into, treat it as `proposed` and say so, rather than guessing upward.

## Turning a FUTURE_PHASES.md phase into backlog items

1. Read the phase's section in `docs/roadmap/FUTURE_PHASES.md` — objective, planned
   capabilities, constraints, deliverable.
2. Look at what already exists (`docs/SYSTEM_MAP.md`, the actual `src/**` tree) so proposed
   items describe real next steps, not something already built or something that skips a
   missing dependency.
3. Break the deliverable into a handful of vertically-sliceable items — each one should be
   independently describable as "done" without the whole phase being done, similar to how
   `docs/DEVELOPMENT_PLAYBOOK.md` §6.13's Definition of Done applies to one change, not one
   phase.
4. Add each as a `proposed` row. Do not add `assigned` rows this way, even if the phase itself
   was mentioned favorably in conversation — favorable mention is not an assignment.
5. If this is being done during idle planning (`FUTURE_PHASES.md` §9), the resulting proposal
   still belongs in whatever planning document that section already calls for ("record the
   proposal in an appropriate planning document... not this file") — `BACKLOG.md` rows are the
   short trackable summary, a fuller written plan (if one exists) is linked from Notes, not
   duplicated into the table.

## Updating status day-to-day

- **"Mark BL-014 assigned"** — only act on this when there's an actual owner instruction behind
  it (in the current conversation, or the user is directly telling you one was given elsewhere).
  If asked to mark something assigned with no stated instruction behind it, ask what the
  assignment was rather than setting it anyway — this is exactly the kind of boundary
  `AGENTS.md` §C exists to protect, and it's worth a clarifying question even under a general
  bias toward not stopping to ask.
- **"Mark BL-014 in progress"** — check a `feature/*` branch for it actually exists (or create
  one, per the standard workflow, if starting the work now); record the branch name.
- **"Mark BL-014 done"** — this is the one status change that has a second document to touch.
  Add or update the matching `docs/ROADMAP_STATUS.md` row in the same pass (status, date,
  commit hash(es), summary — that file's own established format), then flip the `BACKLOG.md`
  row, with Notes pointing at the `ROADMAP_STATUS.md` row. Never mark `done` on the strength of
  "the code looks complete" alone — the same validation discipline `AGENTS.md` §E/§K.3 requires
  for any phase applies here too (tests/lint/build actually run, not assumed).
- **"What's in the backlog?" / "what's open?"** — read the table and summarize; grouping by
  status is usually more useful than reading it row by row.

## Git handling

`docs/roadmap/BACKLOG.md` is a document like any other in this repository — it follows
`AGENTS.md` §K exactly like `FUTURE_PHASES.md` and `ROADMAP_STATUS.md` already do: no direct
commits on `dev` or `main`, changes go on their own `feature/*` branch and merge in with
`--no-ff`. A backlog-only update is small and low-risk, but it still isn't the named
`published/<version>/` exception in §K.1 — don't treat "it's just docs" as license to commit
straight to `dev`. When a backlog update rides along with the actual feature work it tracks
(e.g. flipping a row to `done` as part of the same commit that finishes the feature), that's
fine and often better than a separate follow-up commit — use judgment, but never skip the
branch structure entirely.

## What this skill must never do

- Never set `assigned` without a real instruction behind it, and never treat a `proposed` row's
  mere presence as implying anyone wants it done soon.
- Never let `BACKLOG.md` duplicate `FUTURE_PHASES.md`'s phase descriptions in full — reference,
  don't restate; if `FUTURE_PHASES.md` changes, don't silently let `BACKLOG.md`'s Source pointers
  go stale.
- Never mark something `done` without a corresponding `docs/ROADMAP_STATUS.md` update — that file
  stays the sole execution-log source of truth, exactly as `AGENTS.md` §H already requires.
- Never use this skill's existence as a reason to start autonomous Phase 7+ work — per
  `FUTURE_PHASES.md` §8, that still requires no higher-priority task being pending and, for
  actual implementation (not planning), an explicit assignment.
