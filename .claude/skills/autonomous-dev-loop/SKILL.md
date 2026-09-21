---
name: autonomous-dev-loop
description: Runs this project's autonomous, cyclical development loop -- finds or creates the next actionable backlog item from docs/roadmap/{FUTURE_PHASES.md,ROADMAP_STATUS.md,BACKLOG.md} (via the roadmap-backlog skill), implements it through AGENTS.md's standard workflow, and when nothing is actionable runs independent-review cycles until clean. Gated by an explicit on/off toggle in state.json -- check that before anything else. Use when the project owner asks to "work autonomously", "run the autonomous/independent loop", or invokes this skill by name. Never a substitute for AGENTS.md's authorization gates -- section 1 below states the ones this skill can never widen, and every agent picking this file up must read that section first, every time, before treating anything else here as license to act.
---

# Autonomous development loop

**Confirmed 2026-09-21 (Telegram):** the project owner reviewed this draft and approved it --
"Подтверждаю, можешь приступать к работе используя этот скилл" -- and named Phase 6 as the
current phase for section 2's step 0. This skill is live from this point on, scoped exactly as
sections 1-5 state -- **but only when the toggle below is on.**

## 0. The on/off toggle -- check this before anything else, every time

The project owner asked for this explicitly the same day the skill was confirmed (Telegram,
2026-09-21): *"Скилл который мы делали вчера, отвечающий за самостоятельную независимую работу,
должен иметь 'тумблер'. Чтобы я мог включать и выключать автономный режим работы когда нужно."*
Confirming this skill once does not mean it stays on for every future session or every future
request -- the owner controls whether it is live at all, independently of everything sections 1-5
describe.

**State lives in `.claude/skills/autonomous-dev-loop/state.json`**, a single `{"enabled": true |
false, "lastChangedAt": ..., "lastChangedBy": ...}` object -- deliberately a separate file from
this one, so checking it never requires parsing this whole document, and so the current on/off
state is never confused with the (stable) instructions for what happens while it's on.

**Before doing anything else this skill would otherwise authorize** -- running a loop iteration,
applying section 3's next-phase exception, starting an independent-review cycle on your own
initiative, or even treating an owner message as "start the loop" -- read that file.

- If `enabled` is not literally `true`: autonomous mode is **off**. Do not run any part of this
  skill's loop. If the owner asks you to invoke it, tell them it's off and ask whether to turn it
  on, rather than silently proceeding or silently refusing.
- If `enabled` is `true`: proceed to section 1.

**Only the project owner can flip this toggle**, in any session or channel, by asking in plain
language ("включи автономный режим" / "turn on autonomous mode", and the reverse). When they do:
update `state.json`'s `enabled` field (and `lastChangedAt`/`lastChangedBy`) through the normal git
workflow for this repo -- a `feature/*` branch, `--no-ff` merge to `dev`, push -- like any other
tracked change (`AGENTS.md` §K.1; this file is a real, git-tracked part of the repo, not a
throwaway local setting), then confirm back to them once it's done. Never flip it because the
shape of a request merely *resembles* wanting autonomous work (e.g. "keep going with this") --
only an explicit on/off instruction counts.

**What this is, once the toggle is on:** this skill exists so development can keep moving between
check-ins with the project owner, without going idle just because nobody is watching it right now.
It creates **no new authority** beyond what section 1 spells out. Read section 1 before anything
else once the toggle above is confirmed on, every time this skill fires -- it governs even when
the rest of this file says "proceed autonomously," and no later section in this file may be read
as loosening it.

## 1. Absolute boundaries -- never relaxed by this skill, under any condition it can create

These restate `AGENTS.md` §K.2 and §G in this file specifically because a skill is the artifact
that outlives any one conversation; an agent picking this up cold must see the ceiling without
first having to go find and cross-reference another document.

**Never, under any circumstance this skill produces on its own:**

- Merge into `main`, push `main`, create a git tag, cut or publish a release, or merge/rebase from
  the `upstream` remote. Each needs the project owner's own separate, explicit, per-action
  approval. A completed phase, a clean independent-review cycle (section 4), or this skill's own
  next-phase exception (section 3) **never** supplies that approval by itself, no matter how many
  cycles have passed clean.
- Perform a real (non-dry-run) YouTube write, a real paid AI-provider API call, or a production
  deployment. None of these is ever inferred from a git permission, a phase assignment, or a
  backlog item's status -- each has its own separate authorization requirement this skill cannot
  grant itself. This codebase additionally hard-blocks live writes at the code level
  (`assertLiveWritesAuthorized()`, Gate B -- `docs/TECHNICAL_DEBT.md`); do not attempt to remove,
  weaken, or work around that barrier as part of this loop under any circumstance. Removing it is
  its own separately-authorized future task, never incidental to this one.
- Invoke a billed/cloud multi-agent review (`/code-review ultra`, `/ultrareview`) autonomously --
  that command is explicitly user-triggered and billed; this loop may only ever run it if the
  owner asks for it directly in the conversation that invoked this skill. Section 4's review
  cycles use an ordinary review pass (e.g. `/code-review high`, or a fresh review-focused
  subagent), never the cloud/ultra variant.
- Force-push, run a destructive `reset`/`clean`, or rewrite the history of any shared branch.
- Touch real credentials or secrets, or expose an OAuth token / API key / secret to a log or to
  any AI provider.

**Always allowed by standing authorization (`AGENTS.md` §K.2) -- this skill may do these without
asking each time:**

- Create a `feature/*` branch from `dev`'s tip for a task this loop has picked up.
- Commit on that branch.
- Merge a completed, verified feature into local `dev` with `--no-ff`.
- `git push origin dev`.

If this loop's next action would cross into the first list, stop that specific action -- leave
in-progress work exactly where it is (uncommitted, or on its own feature branch; never force-
pushed, never discarded) -- and report to the project owner what is ready and what it is waiting
on. Silence is never approval for anything in the first list. The only place silence has any
defined effect in this skill is section 2's 15-minute rule, and that only ever moves this loop on
to a *different* task -- it never grants itself something from the first list.

## 2. The loop, one iteration

0. **Which phase is "current" is not always unambiguous in this project** (`docs/ROADMAP_STATUS.md`
   currently lists five candidate "next assignment" items and leaves the choice to the owner). If
   it is not obvious from `ROADMAP_STATUS.md`'s own "Next assignment" section which phase this loop
   should be working, do not guess -- ask the owner to name it once, before the loop's first real
   iteration, and treat their answer as standing for the rest of this run (not re-asked every
   iteration).
1. Read `docs/ROADMAP_STATUS.md` (what is actually done) and `docs/roadmap/BACKLOG.md` (via the
   `roadmap-backlog` skill) to find the current phase's open items.
2. If an `assigned` or `in_progress` backlog item exists: work it, following `AGENTS.md`'s
   Standard development workflow exactly as in any other task -- smallest safe slice, tests before
   merge, docs updated per §H, `--no-ff` merge to `dev`, push, Telegram notification per the
   standing rule (a real, repeated autonomous run will send one notification per merge -- say so
   to the owner before starting, so a burst of messages during an active run isn't a surprise).
   - If that item's next step genuinely needs the project owner's input, or an authorization this
     skill cannot grant itself (anything in section 1's first list, or a product/scope decision
     only they can make): ask over Telegram, then check back in **15 minutes**
     (`ScheduleWakeup`, or the next `/loop` iteration). If 15 minutes pass with no reply, do
     **not** invent a new `BACKLOG.md` status -- `roadmap-backlog` defines exactly five
     (`proposed`/`assigned`/`in_progress`/`done`/`dropped`) and this skill must not contradict it.
     Instead, leave the item's status as-is and add a note to its **Notes** column recording the
     timestamp and exactly what it is waiting on, then move to the next actionable item instead of
     idling on this one. A parked item stays parked, not abandoned: re-check it on this loop's
     normal cadence (each time step 1 re-reads the backlog), not by re-asking the same question
     every 15 minutes. **A parked item still counts as "found" for section 3(a)** -- see the
     explicit warning there.
3. If nothing in `BACKLOG.md` is `assigned`/`in_progress`, and applying `roadmap-backlog`'s own
   "turn a phase into backlog items" procedure to the *current* phase produces no further
   `proposed` item worth doing either: run an independent-review cycle (section 4).
4. After a review cycle completes clean (section 4's exit condition), and only then, this loop may
   consider starting the next phase -- section 3 states the exact, narrower condition for that.
5. Whenever a task completes or a review cycle finds and fixes something, return to step 1.

## 2a. When this loop stops

This file otherwise describes a cycle with no built-in end, which is deliberate -- an autonomous
loop that quits the moment things go quiet defeats its own purpose. But it must still have a
concrete stop condition, or "keep going" becomes unbounded token spend and unbounded autonomous
merges to `dev`:

- **Two consecutive iterations that produce no committed change** (no fix merged, no task
  completed, no review-cycle finding) -- stop the loop, send one summary Telegram message (what
  was done this run, what remains, why nothing changed in the last two passes), and wait for the
  owner rather than continuing to spin.
- **A message from the project owner arriving at any point** ends the current iteration once it
  reaches a safe stopping point (do not abandon an in-progress merge or leave a half-written commit
  to go read a message) and hands control back to them -- their message is read and acted on before
  this loop resumes, not queued behind more autonomous iterations.
- **Any section 1 boundary reached** -- stop that action specifically (section 1's own rule), which
  in practice often ends the whole iteration if that was the only path forward.

## 3. Starting the next phase -- the owner's scoped exception (2026-09-21)

`docs/roadmap/FUTURE_PHASES.md` §9 states the general rule for every other context in this
project: when idle, only *plan* the next phase, never implement it automatically. On 2026-09-21
the project owner granted this skill, specifically, a narrower-but-deeper exception over Telegram,
quoted verbatim: *"В рамках этого скила можно начинать подготавливать и исполнять следующие
фазы, но только если не смог найти / создать задачи для текущей фазы. И если цикличная
независимая проверка не нашла проблем."*

This exception applies **only** inside this skill's own autonomous loop, and **only** when both
conditions hold at the same time:

(a) No task for the **current** phase could be found or created -- `BACKLOG.md` has nothing
`assigned`/`in_progress` for it, and `roadmap-backlog`'s own procedure for turning that phase into
backlog items produces nothing further to propose. **A task parked by section 2's 15-minute rule
does not satisfy this condition -- it was found, it is simply waiting on the owner, and this
exception must never route around an unanswered question by opening the next phase instead.**
Condition (a) only holds when there is genuinely nothing left for the current phase, parked or
otherwise; **and**

(b) The independent-review cycle (section 4) most recently completed with **zero** issues found in
its final round.

When both hold, this loop may move to `FUTURE_PHASES.md`'s next phase, in order, treating it as
authorized for planning **and** implementation. Everything else about how that work proceeds is
unchanged: smallest safe slice first, its own `feature/*` branch, tests before merge, `--no-ff`
merge to `dev`, and every gate in section 1's first list still applies exactly as written. This
exception widens *which phase* may be started; it does not touch *how* any phase's work is
validated, merged, or released.

This exception does **not** apply outside this skill. An interactive session, or any other skill,
still follows `FUTURE_PHASES.md` §9 exactly as written: plan only, present for approval, stop. If
this skill is invoked from an interactive session where the owner has not specifically asked for
the autonomous loop, treat any next-phase work the same way §9 already does.

## 4. The independent-review cycle

Exact procedure the project owner specified (2026-09-21, Telegram, verbatim): *"Сделай серию
независимых ревью до нуля ошибок с исправлениями. По окончании вывести статистику, сколько серий
было и сколько ошибок в каждой серии найдено."*

One review **cycle** is a series of **rounds**:

1. Run an independent review pass over the current `dev` state (or the branch/diff most recently
   merged) -- prefer a reviewer with no memory of having written the code under review (a fresh
   subagent, or `/code-review high` -- never the `ultra`/cloud variant autonomously, section 1).
   Apply `AGENTS.md` §L's standard: a finding must trace to a requirement or contract, never to
   "the implementation doesn't do this," derived by reading the implementation and writing down
   what it happens to do.
2. Record how many issues that round found.
3. If issues were found: fix them, under the same validation discipline as any other change
   (tests, lint, build, `--no-ff` merge, push). Never fix a finding by weakening the test or check
   that surfaced it, and never silently drop one instead of fixing or explicitly deferring it to
   `docs/TECHNICAL_DEBT.md` with the same reasoning standard that file's existing entries use.
4. Run another round. Repeat until one full round finds zero issues.
5. Report to the project owner: how many rounds ran in this cycle, and how many issues each round
   found (e.g. "3 rounds: 4, 1, 0").

A cycle's zero-issues result is what unlocks section 3's phase-progression exception -- do not
shorten this loop, and do not treat a clean `tsc`/`lint`/`test` run as equivalent to a clean
independent-review round. They check different things: mechanical correctness versus a reviewer's
independent judgment against requirements.

## 5. What this loop does not decide on its own

- Product priorities, scope, or which phase to work on when more than one is genuinely eligible --
  if `FUTURE_PHASES.md` does not make the order unambiguous, ask rather than pick.
- Anything `docs/TECHNICAL_DEBT.md` names as blocking a Gate -- a Gate stays closed until its own
  listed conditions are actually met, never because this loop happened to have spare cycles.
- Whether a review finding is worth fixing now versus deferring to `docs/TECHNICAL_DEBT.md` --
  when genuinely unsure, fix it; only defer with the same explicit, written reasoning that file's
  existing entries already use, never silently.
