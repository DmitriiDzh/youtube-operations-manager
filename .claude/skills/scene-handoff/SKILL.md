---
name: scene-handoff
description: The coordinator's fixed procedure for a Scene change, from brief to merge to telling the Producer (the scene-dev brief, checking the report and the gate, the --no-ff merge into scene main, worktree cleanup, the Producer note). Use whenever a Scene branch is started, comes back from a scene-dev agent, or is merged. The developer-side rules are in scene's own AGENTS.md and the scene-dev agent, not here.
---

# scene-handoff

A procedure, not new rules: the rules are `S/AGENTS.md` (`S` = `/Volumes/Samsung T9/YouTube/00 Tools/scene`), §1–§9,
and the `scene-dev` agent. Channel workers run `S` live: nothing is edited or built in `S` itself, only in worktrees.

## 1. Brief (scene-dev agent)

Give the agent the following:
- the task in your own words;
- the topic, which becomes `feat|fix|perf/<topic>` in `../scene-wt-<topic>`;
- the PLAN.md / PLAN_DEPTH.md section to read;
- for a new lint rule, the next free id from `S/AGENTS.md` §5 (check it is not reserved or burnt);
- whether a picture change is allowed. The default is no: scenes without the new keys must render byte-equal.

## 2. Check the report yourself

The agent's word is not evidence. Run each of these:
1. `"S/tools/gate.sh" "<worktree>"` must print `GATE: OK`. If it is `TESTS FAILED` only on
   `tests.test_p1.AudioMeasureTest.test_music_rises_in_pauses`, rerun that test alone before calling it a failure.
   For `HASHES CHANGED`, see §3.
2. `git -C "<worktree>" diff --name-only main...HEAD`: a new key or rule touches code, `schema/*.schema.json`,
   `scene/schemahelp.py` (plus `fxdocs.py` for fx keys) and `README.md` together.
3. New lint ids are added to the used list in `S/AGENTS.md` §5, and its "Next free" is moved on.
4. Tests for each rule cover a firing case, a silent case and the boundary, with hand-computed values.
5. Russian commits with no AI trailer: `git -C "<worktree>" log --format=%B main..HEAD | grep -i co-authored` finds
   nothing.

## 3. A picture change

`HASHES CHANGED` means old scenes now look different. Never update `research/baseline_hashes.txt` to get past it.
Either the agent fixes the change, or the owner decides on the picture change (ask with owner-report, attaching
before/after frames). Only after a yes is the baseline updated, in its own commit that says why.

## 4. Merge

1. `git -C "S" merge --no-ff <branch> -m "Влить <branch>: <summary>"`.
2. `"S/tools/gate.sh" "S"` on main after the merge must print `GATE: OK`.
3. `git -C "S" worktree remove "../scene-wt-<topic>"` and `git -C "S" branch -d <branch>`.
4. Scene main is local. Never push it without the owner's explicit yes.
5. A branch the owner rejected stays parked and unmerged. Its lint ids stay burnt: add them to §5 "Burnt".

## 5. Tell the Producer (and whoever asked)

Run `ListAgents` and SendMessage the `00-yt-producer-*` session. The name changes; never reuse an old one. Send:
- the merge sha;
- what a worker now writes (the new keys, with a 2–4 line JSON example);
- what `bin/scene lint` now says (rule id, severity, fix hint, `allow` path);
- open limits.

Write it so the Producer can turn it into a channel rule without reading the code. If the Operator or a channel
worker asked for the change, send them the same note. Then update the open-items memory line: the sha and the next
free lint id.
