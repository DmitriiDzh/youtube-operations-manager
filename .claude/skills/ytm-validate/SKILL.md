---
name: ytm-validate
description: The coordinator's fixed procedure for validating a YT Manager branch in its worktree, merging it into dev and verifying dev afterwards (test/lint/build, diff check, generated-file check, real-DB schema check, push, worktree cleanup). Use whenever a YTM branch is checked before or after a merge into dev, or when a subagent's reported results need confirming. Not for Scene or PSD2Live.
---

# ytm-validate

A procedure, not new rules: the rules are AGENTS.md §E, §K.1–§K.3 and §N. This file only fixes the order and the
traps, each learned from a real incident. `M` = `/Users/Dima/Documents/YouTube_Manager` (the owner's LIVE folder,
launchd runs its `.next`), `W` = the branch's worktree.

## 1. Before merging: validate in the worktree

1. The branch lives in its own worktree, never in `M`:
   `git -C M worktree add -b <branch> ../YouTube_Manager-<topic> dev`. A build needs `node_modules` as a real APFS
   clone: `cd W && cp -Rc ../YouTube_Manager/node_modules .` (a symlink breaks the Turbopack build).
2. Tests, in the background (about 15 min), one exit only (no "still running" wake-ups):
   `cd W && "/Volumes/Samsung T9/YouTube/00 YT Operator/90 Scripts/bin/_slotrun.py" ytm-fulltest 1 1 -- nice -n 10 taskpolicy -b npm test -- --test-concurrency=2 > <scratchpad>/test.log 2>&1; echo exit=$?; grep -E "^ℹ (tests|pass|fail) " <scratchpad>/test.log`
   - Only one full suite runs on the Mac at a time (`_slotrun ytm-fulltest`). Subagents run only their own test files until the end.
   - Run it as a background Bash task and wait for its notification. No foreground sleep / until / pgrep loops (Operator 24.11).
     Factory jobs, restarts and renders: `ytm-wait` where it has a token, otherwise one background wait on the final marker.
   - Never set `NODE_TEST_CONTEXT` for `npm test`: with it, zero tests run and the exit code is still 0.
   - Cite only the counts from the `ℹ tests N` / `ℹ pass N` / `ℹ fail N` lines. No lines = no evidence; rerun.
3. `cd W && nice -n 10 taskpolicy -b npm run lint`, then `cd W && NODE_TEST_CONTEXT=1 nice -n 10 taskpolicy -b npm run build`.
   Without the variable the build migrates the owner's real DB. Never build in `M`: it overwrites the live `.next`.
   Once the build passed, `rm -rf W/.next` (1.3–2 GB per worktree on the Mac's small SSD; owner TG 4827). It is rebuilt
   when needed.
4. `git -C W diff --check dev...HEAD` and `git -C W status --short` (clean).
5. Generated files must not be in the branch:
   `git -C W diff --name-only dev...HEAD | grep -E '__pycache__|\.pyc$|(^|/)\.next/|node_modules/|data/.*\.db$|\.DS_Store$'`
   Anything found gets a fix commit before the merge.
6. After a subagent built or ran scripts, check that the real DB was not migrated:
   `sqlite3 -readonly "$HOME/Library/Application Support/YouTubeOperationsManager/playlist-manager.db" "select value from schema_meta where key='schema_version'"`
   It must still equal the schema of `dev`, not the branch's.

## 2. The merge gate

- Small/low-risk change (doc-only, narrow fix, single file or config): merge right away.
- Substantive feature: present it as finished and wait for the owner's explicit yes («да, мерджи», «да мердж»).
  «ок» alone is not a yes. While waiting, the branch stays committed and unmerged, and its worktree keeps no `.next`.
- If `dev` moved: `git -C M merge-base --is-ancestor dev <branch>` fails → merge `dev` into the branch in `W`, resolve
  there and repeat §1 steps 2–5.

## 3. Merge and verify dev

1. `git -C M merge --no-ff <branch> -m "Интегрировать <branch> в dev (<what>)"`: Russian, names the feature, no
   `Co-Authored-By` or any AI trailer.
2. `git -C M diff --quiet HEAD <branch> && echo tree-identical`: if identical, §1's results cover the merge commit;
   say that. Otherwise run `npm test` (as §1.2) and `npm run lint` in `M` (both are safe there), never the build.
3. `git -C M push -q origin dev` (standing approval), then `git -C M worktree remove W` and `git -C M branch -d <branch>`.
4. A merge is not a restart. If the change needs one, use restart-when-idle only (AGENTS.md §N) and say so.
5. Report with the owner-report skill. The report includes the merge sha, the counts actually seen and anything not
   rerun (for example "build verified on the branch, not rerun on dev").

## 4. Worktree hygiene (owner TG 4827, 24.11.2026)

Worktrees live on the Mac's 256 GB internal SSD. They must not pile up:
- After every merge, §3.3 removes the worktree and the branch, the same turn.
- A parked branch (waiting for the owner) keeps its worktree without `.next`. If it waits more than 7 days, remove the
  worktree too; the branch stays, and `git worktree add W <branch>` brings it back.
- At the start of each session and after a night restart: `git -C M worktree list`. Remove any clean worktree whose
  branch is already in `dev` (`git merge-base --is-ancestor <branch> dev`), plus harness `agent-*` worktrees that are
  left over. Never remove one with uncommitted changes; ask instead.

