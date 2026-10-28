# BL-231 — «Собрать неделю»: the factory's weekly build from the Web UI (FO-REQ-0046)

**Assigned by** the owner, Telegram msg 3748 («ок» to the plan in msg 3747; the Operator's request was OK'd in TG 3082/3084).
Backlog: BL-231. Builds on BL-225 (`WEEKLY_PUBLISHING_PLAN.md`, the Manager's own weekly plan) and Phase 11's channel
workspaces. The factory side (bundle 2.5.42) is the Operator's: `13 Weekly_Plan v1 auto`, `status --json`, the launcher's
`start --json` and `check`.

## Why

The owner wants a person, not only an agent, to make a week of videos from what already exists (music library, scene loops,
overlays, assembly rules) from YT Manager. The agent is woken only for packaging (title, description, translations,
thumbnail). New music generation is out of scope.

## What is built

1. **A feature module `src/lib/weekly-build/`** (AGENTS.md §M: the rest of the app keeps working without it; it imports only
   the shared `channel-workspaces` and `local-path-validation`). It runs the channel's own launcher
   `<workspace>/06 Workflows/factory_launch.py` with the Python of this computer and reads its JSON:
   - `check` (exit 0 = the pinned bundle matches its manifest and this launcher is the bundle's own copy);
   - `run "13 Weekly_Plan v1" status --json` — the open plan, its slots, the newest job, the packaging request, STOP;
   - `run "13 Weekly_Plan v1" auto --days N --dry-run --json` — the steps a start would take (the confirmation);
   - `start "13 Weekly_Plan v1" auto --days N [--wake] --json` — one background job (it survives a server restart:
     the launcher detaches it);
   - `run "13 Weekly_Plan v1" stop` — STOP: the current video is finished, then the run ends;
   - `run "13 Weekly_Plan v1" go` — before a start when STOP is set (otherwise the new run would stop at once).
2. **Readiness before any run** (each a code the card explains):
   - `workspace_missing` — the channel has no workspace folder on this computer (Settings → Channels);
   - `launcher_missing` — no regular file `06 Workflows/factory_launch.py` inside the workspace (after symlinks);
   - `bundle_too_old` — `06 Workflows/factory.json` → `workflow_bundle` is below 2.5.42 (no `auto` / `--json` there);
   - `python_missing` — no Python 3.9+ found (the configured path, then the usual folders, then PATH);
   - `launcher_check_failed` — `check` did not exit 0 (its output is shown).
   `check` is cached per channel while the launcher file and `factory.json` keep their size and mtime, for 5 minutes.
3. **How a script is run:** `execFile(python, ["-B", launcher, ...args])`, never a shell; cwd = the channel workspace; a
   minimal environment (PATH with the usual tool folders, HOME/USERPROFILE, TMPDIR/TEMP, LANG, SystemRoot on Windows,
   `PYTHONIOENCODING=utf-8`) — none of the server's own variables (secrets) reach the script; timeouts 60 s (`check`,
   `status`, `stop`, `go`, `start`) and 180 s (dry run); stdout is one JSON object (the last non-empty line is tried when
   other lines precede it). One start / stop at a time per channel.
4. **Routes (Web session, active channel; no MCP tool):** `GET /api/channels/[channelId]/weekly-build` (readiness + status),
   `POST …/dry-run` `{days}`, `POST …/start` `{days, wake?}`, `POST …/stop`; `GET/PUT /api/weekly-build/settings`
   `{pythonPath}` (this computer's database, like the ffmpeg folder).
5. **The card «Сборка недели»** on Content → Week plan, above the plan panel: the factory's one-line status, days (1–14,
   default 7), «Собрать неделю» → the confirmation lists the dry run's steps → «Запустить»; while the job runs: its state and
   «Стоп»; the slot table (date, status, video, length, problems of a failed slot); built slots → «Нужна упаковка» with
   «Разбудить агента» (`auto --wake`); the Python path field. Refreshes every 30 s while visible and a job runs, otherwise on
   open and «Обновить». All text en + ru.

**Not built (decided):** the plan still reaches the Manager through the channel worker (`13 push` →
`agent_publishing_plan_save`); the Manager only shows the factory's state (FO-REQ-0046 item 4, option a — one writer of the
plan). Packaging by hand without an agent is a later item if the owner asks. No restart-when-idle reason: the job is detached
and survives a restart.

## Security

The server runs a Python file from a synced, agent-writable folder. Mitigations: the button exists only in the Web UI (session +
active channel; a source-scan test proves no MCP/agent module names the module); `check` must pass (launcher hash = the pinned
bundle's template, bundle = its manifest) and the bundle must be ≥ 2.5.42 before each run; the Python path comes only from
this computer's settings; no shell, fixed arguments (days is an integer 1–14), a minimal environment. What remains (a tampered
registry that still matches its own manifest, or an agent that rewrites both) is RISK-138 — the same trust the agents already
have when they run these scripts themselves.

## Acceptance (written before the code)

Unit (fake runner, temporary folders):
1. No workspace → `{ready:false, code:"workspace_missing"}`; nothing is run.
2. `factory.json` `workflow_bundle: "2.5.39"` → `bundle_too_old`; `"2.5.42"`, `"2.5.100"`, `"2.6.0"` → ready; missing or
   malformed → `bundle_too_old`.
3. `06 Workflows/factory_launch.py` a symlink to a file outside the workspace → `launcher_missing`.
4. `check` exit 1 → `launcher_check_failed`; dry run / start / stop refused with `weekly_build_unavailable` and that code.
5. Start with days 7 and STOP not set runs exactly `[python, "-B", <launcher>, "start", "13 Weekly_Plan v1", "auto",
   "--days", "7", "--json"]` with cwd = the workspace; with `wake` adds `--wake` before `--json`; with STOP set runs
   `run "13 Weekly_Plan v1" go` first.
6. Days 0, 15, 7.5, "7" → `validation_failed`; nothing is run.
7. Start answering exit 1 + `{"error":"job_running","jobId":"J","device":"D"}` → `weekly_build_job_running` (409) with jobId J.
8. Status stdout not JSON → the view carries `status: null` and `statusError`; the readiness stays ready.
9. The environment passed to the script has none of the server's variables except the allowed ones (a fake `YTM_SECRET`
   set in `process.env` is absent).
10. Routes: no session → 401; not the active channel → 403.
11. No file under the MCP / agent modules imports `@/lib/weekly-build`.

Live (needs the channels on bundle 2.5.42, the Operator's pin): on Japan or Tropico, the dry run shows the steps; a start
builds the planned slots; Stop finishes the current video; built slots show «Нужна упаковка»; «Разбудить агента» writes a new
request and the worker packages. Windows: the same on the Windows computer with its Python path.
