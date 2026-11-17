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
   `cd W && npm test > <scratchpad>/test.log 2>&1; echo exit=$?; grep -E "^ℹ (tests|pass|fail) " <scratchpad>/test.log`
   - Never set `NODE_TEST_CONTEXT` for `npm test`: with it, zero tests run and the exit code is still 0.
   - Cite only the counts from the `ℹ tests N` / `ℹ pass N` / `ℹ fail N` lines. No lines = no evidence; rerun.
3. `cd W && npm run lint`, then `cd W && NODE_TEST_CONTEXT=1 npm run build`. Without the variable the build migrates the
   owner's real DB. Never build in `M`: it overwrites the live `.next`.
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
  «ок» alone is not a yes. While waiting, the branch stays committed and unmerged.
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
