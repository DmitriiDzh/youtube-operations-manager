# Waiting for a long operation without spending tokens (BL-271)

Sources:
- The owner, Telegram msgs 3617/3618 (relayed by the Operator, 2026-11-17): background waits must not wake the LLM session while
  nothing has changed; a wait ends once, on the final result.
- The problem today: agents (the Factory Operator on `/api/mcp/factory`, the Producer on `/api/mcp/producer`, channel workers on
  `/api/mcp`, and shell scripts) poll `*_get_*` / status tools or run watcher loops that wake the session every minute ("still
  running"). Each wake-up re-reads the agent's whole context (~590k tokens).
- ADR 0075 (`docs/decisions/0075-wait-tools.md`, Proposed) records the decision.

This plan covers only planning. No production code is written until the owner assigns the build.

## 1. What exists (verified in `src/**`, dev `58fdfde5`)

- **MCP transport.** All three endpoints use stateless Streamable HTTP with `enableJsonResponse: true`
  (`src/lib/{agent,factory,producer}-mcp-endpoint/index.ts`). The server sends no byte and no progress notification until the
  handler returns, so the client's timeout covers the whole block.
- **Client limits** (checked 2026-11-17):
  - **Claude Code** 2.1.322: the hard limit `MCP_TOOL_TIMEOUT` defaults to 1e8 ms. A non-stdio server also has a **300 s idle
    limit** (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, default 300000). With JSON responses, nothing is sent while the call blocks, so
    any block over 300 s is killed.
  - **Codex** 0.164: `tool_timeout_sec` per `[mcp_servers.<name>]`, **default 60 s** according to the OpenAI Codex docs
    (developers.openai.com/codex/mcp). Not verified from the binary; stage 0 measures it.
  - **TS MCP SDK** 1.32.1 (`node_modules`): `DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` for any client built on it without its own
    timeout.
  - **Node `fetch`** (undici): `headersTimeout` is 300 s. This matters for our own CLI.
- **Restart when idle** (ADR 0049, `src/lib/restart-when-idle/`). The quiet window is `MAX(occurred_at)` of
  `gateway_call_events` in category `mcp_tool_calls`. A call is recorded when it **starts**, not while it runs. Status polls are
  exempt: `UNCOUNTED_TOOLS` holds `factory_restart_status` and `UNCOUNTED_CHANNEL_TOOLS` holds `agent_restart_status`. The
  Producer wrapper (`producerRegistration` in `src/mcp/server.ts`) has **no exemption list** and always records `allowed`. A restart
  is one SIGTERM; a forced `process.exit` follows 90 s later (`RESTART_FORCE_EXIT_MS`). In-flight HTTP requests are not among the
  things a restart waits for. On boot, `finalizeBoot` marks the request `done` with `toVersion` / `toSchema`.
- **Existing CLIs.** `npm run media` / `cli:video-metadata` run in process: they import `@/lib/db`, whose initialization
  migrates the DB. They are gated by the owner's "Operator CLI access" switch, and they have no channel identity.
  `npm run operation-lock` opens the DB file directly so that it works while the app cannot start. No `bin` exists in
  `package.json`.
- **Worker tools.** `src/mcp/worker-factory-tools.ts` reuses factory tools for a channel worker over channel-pinned deps
  (`WORKER_FACTORY_TOOLS`, `pinFactoryDepsToChannel`).
- **API versions.** `FACTORY_API_VERSION` 1.53.0 (`src/mcp/factory-server.ts`), `AGENT_API_VERSION` 4.24.0
  (`src/lib/agent-operations/contracts.ts`), `PRODUCER_API_VERSION` 1.26.0 (`src/mcp/producer-tools.ts`). Each bump is recorded in
  the history comment at the head of its file.

## 2. Targets

The poll interval is server-side. "SQLite row" means one indexed `SELECT` by primary key. "Automerge" means a document read,
which BL-270 made cheaper, so it is polled at most every 15 s.

| target | module (state) | id the agent already has | still running | final: success (exit 0) | final: failure (exit 1) | read, poll |
|---|---|---|---|---|---|---|
| `upload` | `src/lib/publishing/` (`publishing_uploads`, this computer) | Producer: `uploadId` (`producer_upload_queue_list` / `_add`). Factory / worker: none, only `channelId` + video code. So `id` = `uploadId` **or** the video code with `channelId`, which picks the newest row of that channel and video here. | `queued`, `uploading`, `processing`, `finishing`, `paused` (reason `quota_exceeded` / `upload_limit`, resumes by itself at `pausedUntil`) | `done` (after the translations, captions, thumbnail, read-back and date steps) | `failed`, `cancelled` | SQLite row, 10 s |
| `media_session` | `src/lib/media-generation/` (`media_sessions`) | `sessionId` from `factory_media_start_session` / `agent_factory_start_session` | `pending` (waiting for the owner), `approved`, `waiting_capacity`, `starting`; with `until: ended` also `running`, `stopping` | `until: ready` (default): `running`. `until: ended`: `done` | `failed`, `rejected`, `interrupted`, and with `until: ready` also `stopping` / `done` before it was ready | SQLite row, 5 s |
| `media_job` | `src/lib/media-generation/` (`media_jobs`) | `jobId` from `factory_media_create_job` | `queued`, `submitted`, `generating`, `transferring` | `done` | `failed`, `cancelled` | SQLite row, 5 s |
| `gemini_job` | `src/lib/gemini-media/` (`gemini_media_jobs`, kinds image / video / speech / voice_design) | `jobId` (`gm_…`) from `factory_gemini_create_job` / `factory_speech_create_job` (provider gemini) | `queued`, `submitting`, `running` | `done` | `failed` | SQLite row, 5 s |
| `speech_job` | `src/composition/speech.ts`, dispatched by prefix: `gm_` goes to gemini-media, `el_` to elevenlabs-speech | `jobId` from `factory_speech_create_job` | as the provider's job | `done` | `failed` | SQLite row, 5 s |
| `sound_job` (sfx, music) | `src/lib/elevenlabs-speech/` (`elevenlabs_speech_jobs`, kinds sfx / music). The speech surface answers "not found" for other kinds, so the port reads the provider's `getJob` | `jobId` (`el_…`) from `factory_sfx_create_job` / `factory_music_create_job` | `queued`, `submitting`, `running` | `done` | `failed` | SQLite row, 5 s |
| `translation_request` | `src/lib/localization-review/requests.ts` over `sync-gateway/change-drafts` (Automerge) | `requestId` (with `channelId`) from `*_localization_requests_list` | `requested`, `in_progress`; with `until: claimed` only `requested` | `done`; with `until: claimed`: `in_progress` or later | `failed`, `cancelled`, `partly_done` (Q3) | Automerge, 15 s |
| `storyboard_review` | `src/lib/storyboards/` (Automerge) | `storyboardId` (with `channelId`) after `factory_storyboard_submit` | `in_review` | `approved` | `changes_requested` (outcome `changes_requested`; the owner's note is in the result) | Automerge, 15 s |
| `storyboard_render` | `src/lib/storyboards/` (render verdicts, `renderStateOf`) | `renderId` (with `channelId` + `storyboardId`) from `factory_storyboard_attach_render` | `in_review` (no verdict yet) | `approved` | `changes_requested` | Automerge, 15 s |
| `restart` | `src/lib/restart-when-idle/` (`restart_requests`) | the request `id` from `*_restart_status`, or `current` (the request open or restarting when the wait starts; none = `no_restart_request`) | `open`, `restarting` | `done`, with `toVersion` / `toSchema` | `expired` (24 h), `cancelled` (the owner) | SQLite row, 5 s |
| weekly build | `src/lib/weekly-build/`. **No durable state in YT Manager.** The job lives in the factory launcher; every status read runs `factory_launch.py … status --json` (Python, up to 60 s). AC 11 (`no-agent.test.ts`) keeps every MCP path away from the module, and agents never get the `jobId` (only the owner starts the build). | none | — | — | — | **deferred (Q4)** |
| recode / rename | `factory_release_recode`, `factory_release_folder_rename`. **Synchronous**: they finish ("in one go") and answer inside the one call. No job, no id. | — | — | — | — | **not a target.** Their `release_recode_busy` reasons point at uploads and jobs, which are targets above (Q5) |

**This computer only.** A job, session or upload another computer runs answers `not_found`, which is exit 2. Peer reports
(`factory_jobs_list`) are out of scope.

## 3. Behaviour

### 3.1 One wait core
`src/lib/operation-wait/` is pure. It provides `waitUntilFinal(readOnce, { timeoutMs, pollMs, signal, clock })`, the result type
and the outcome mapping. Each target is a **port** (`read(id, scope) → { status, final, outcome, snapshot } | not_found`). The
ports are composed at the app layer in `src/composition/wait-targets.ts`, so no feature module imports another (AGENTS.md §M),
and disabling one module removes only its target (`target_unavailable`).

Every port uses an existing **read** function of its module. A new read is added only where none exists, for example a plain
`getUploadRow(id)` in publishing. It never reaches an upload writer: `no-agent-upload-tool.test.ts` stays unchanged.

### 3.2 MCP tools: `factory_wait`, `agent_wait`, `producer_wait`

**Input:** `{ target, id, channelId?, storyboardId?, until?, timeoutSeconds? }`.
- `timeoutSeconds` defaults to **50** and is clamped to **[1, 240]** (§3.4).

**Result**, always a success result:
```
{ target, id, final, outcome, status, snapshot, waitedSeconds, nextCallHint? }
```
- `outcome` is one of: `succeeded`, `failed`, `partly_failed`, `cancelled`, `rejected`, `changes_requested`, `expired`, `still_running`,
  `blocked`, `restarting`, `server_stopping`.
- `snapshot` is what the matching get tool shows, minus anything large.
- When `final` is false, `nextCallHint` names the CLI for long waits.

**Errors** (error results): `not_found`, `invalid_request`, `target_unavailable`, `no_restart_request`.

**Rules:**
- **Read-only.** No YouTube call, no write. It does not pass the device mutation gate: it is a read.
- **Not counted as MCP activity.** All three names are added to the uncounted sets. The Producer wrapper gets a new exemption
  for `producer_wait`. So a long or repeated wait never keeps the quiet window open.
- **Ends early.** The call returns at once with `final: false` when:
  - a restart request is `restarting` (outcome `restarting`);
  - the process received SIGTERM (outcome `server_stopping`). A process-level `AbortSignal` is set by the shutdown handler, so a
    blocked call never delays the graceful stop or the 90 s forced exit.
  - an upload is `paused` for `auth` or `live_writes_off`, which only the owner can fix (outcome `blocked`; Q2).
- **Polls from the start.** The first read happens at once; a target already final returns immediately.
- **Errors are not cached.** One failed read is retried at the next poll; three in a row return `target_unavailable`.

**Who gets which targets:**
- **`factory_wait`** (factory endpoint): every target in §2.
- **`agent_wait`** (channel endpoint): the same tool, collected through `WORKER_FACTORY_TOOLS` over pinned deps.
  - `channelId` is put in when left out. Any other channel → `CHANNEL_NOT_ACTIVE`.
  - Each port checks that the resource's own `channelId` is the token's channel. A resource of another channel answers
    exactly like a missing one (`not_found`), so a worker learns nothing about another channel's ids.
  - Media sessions follow the rule `agent_factory_get_session` already applies. `restart` is allowed: the worker already has
    `agent_restart_status`.
  - Class `bound`. It is not in `WORKER_FACTORY_WRITE_TOOL_NAMES`, so it writes no worker-log row.
- **`producer_wait`** (`producer-only`): `upload` for any channel, which is what `producer_upload_queue_list` already shows.
  `restart` too, if Q6 says yes. Nothing else: the Producer's tools do not see media, speech, storyboards or requests. Each call
  goes to the Producer's call log like any producer tool.

### 3.3 CLI: `npm run --silent wait -- <target> <id> [options]`

`src/cli/wait.ts`, script `"wait"` in `package.json`. The `ytm wait` name is Q1.

**Transport.** The CLI is a **thin HTTP client of the caller's own MCP endpoint**. It does not read SQLite. Why:
- channel scoping holds in exactly one place, the endpoint's token and the pinned deps (§F, playbook §6.6);
- no `@/lib/db` import, so no migration race with the server;
- it works the same from the operations side, through the interface only (§B);
- a restart is only a dropped connection to retry.

**Options:**
- `--token-env <VAR>`: the name of an environment variable holding the caller's bearer token, default `YTOM_TOKEN`. A token is
  never accepted as an argument value, never printed and never logged. The token prefix picks the endpoint: `ytom_ch_` →
  `/api/mcp`, `ytom_fo_` → `/api/mcp/factory`, `ytom_pr_` → `/api/mcp/producer`.
- `--url`: default `http://127.0.0.1:3000`, or `YTOM_URL`.
- `--channel <id>`, `--storyboard <id>`, `--until <ready|ended|claimed|finished>`.
- `--timeout <sec>`: default 14400 (4 h), at most 259200 (72 h).

**Loop.** One `tools/call` of `*_wait` per round, with plain `fetch`, `Accept: application/json, text/event-stream`, and an
`AbortSignal` at block + 30 s. Each round's `timeoutSeconds` is `min(240, remaining)`. A round that is not final starts the next
one at once. Nothing is printed between rounds.

**Connection loss** (refused, reset, 502/503, abort): retry every 5 s.
- `restart` target: retry until the deadline. Losing the server is the expected path. When it is back, the request is `done`
  with the new version: exit 0.
- Any other target: retry for up to 10 minutes of continuous loss. An upload resumes after a restart, so the wait does too.
  Past 10 minutes: `server_unreachable`.
- Server unreachable at the first round: 60 s grace, then exit 2.

**Output.** Exactly one JSON line on stdout, then exit:
```
{ target, id, final, outcome, status, snapshot, waitedSeconds, error? }
```

**Exit codes:**
- **0**: `succeeded`.
- **1**: `failed`, `partly_failed`, `cancelled`, `rejected`, `changes_requested`, `expired`.
- **2**: timeout (`still_running`), `blocked`, `not_found`, `invalid_request`, `server_unreachable`, `token_missing`,
  `target_unavailable`.

Usage errors also give one JSON line (`error: { code }`) and exit 2. stderr stays empty except for Node's own crashes.

**How agents use it:**
- Claude Code: `run_in_background`. It notifies on exit, with zero tokens while it waits.
- Codex and others: a background shell job.
- The MCP tool is for short waits or for clients without background shells.

### 3.4 The cap per MCP call: 240 s (default 50 s), and why

- **Claude Code's idle limit is 300 s.** With JSON responses nothing is sent while the call blocks, so 240 s leaves 60 s of margin
  for the last poll, the response and clock skew.
- **Codex's default `tool_timeout_sec` is 60 s.** The default block is therefore **50 s**, which works with every client
  unconfigured. A Codex agent that sets `tool_timeout_sec = 300` in its server table may pass up to 240.
  `docs/AGENT_ISOLATION_SETUP.md` gets that config line.
- **9–10 minutes is not safe** on either client without per-server configuration. A killed call also leaves the agent with nothing
  to show for the wait.
- Streaming progress over SSE (dropping `enableJsonResponse` for the wait tool) could extend the idle limit. It is out of scope:
  Claude Code's hard limit ignores progress, and the CLI already removes the need.
- A wait longer than about 4 minutes goes through the **CLI**. The tool's description says so, and the `nextCallHint` of a
  not-final result repeats it.

## 4. Acceptance criteria

Derived from the owner rule and §F, §G, §M and ADR 0049. Expected values are written from these rules, not from the code.

- **AC-WT-01** A wait whose target becomes final returns or exits **once**, with that final state. Before that, the caller gets
  no output and no intermediate tool result.
- **AC-WT-02** The CLI prints exactly one line of valid JSON on stdout for every ending, including usage errors, timeout and an
  unreachable server. Exit codes: 0 succeeded; 1 failed, cancelled, rejected, changes requested or expired; 2 everything else
  (§3.3).
- **AC-WT-03** Each target in §2 maps its statuses as in the table. Every listed status is checked as still running, success or
  failure. `media_session` follows `until` (`ready` default, `ended`). `translation_request` follows `until` (`finished` default,
  `claimed`).
- **AC-WT-04** A target already final when the wait starts returns at the first read, with no sleep.
- **AC-WT-05** `timeoutSeconds` defaults to 50 and is clamped to 1..240. Past it the tool returns `final: false`,
  `outcome: still_running` and the last status, never an error. The CLI's `--timeout` defaults to 14400 and accepts up to 259200.
- **AC-WT-06** No `*_wait` call is counted in `mcp_tool_calls`; the Producer wrapper is covered too. A restart request with
  `quietMinutes` 3 and an agent calling `*_wait` back to back still restarts: the restart-when-idle readers never see the wait.
- **AC-WT-07** A blocked call returns within 1 s of the process's SIGTERM (`server_stopping`), and within one poll after a restart
  request turns `restarting` (`restarting`). It never holds the graceful stop.
- **AC-WT-08** `npm run --silent wait -- restart current` across a real restart-when-idle cycle exits 0. Its JSON carries the
  request's `toVersion` / `toSchema`. The connection loss in between prints nothing.
- **AC-WT-09** For any other target, a connection loss shorter than 10 minutes is retried silently and the wait goes on. A longer
  one exits 2 (`server_unreachable`).
- **AC-WT-10** Channel worker: `agent_wait` refuses another `channelId` (`CHANNEL_NOT_ACTIVE`). A resource that exists but
  belongs to another channel answers `not_found`, the same code and shape as a missing id.
- **AC-WT-11** Producer: `producer_wait` accepts only `upload` (plus `restart` if Q6 is yes). Any other target is
  `invalid_request`. Each call is in the Producer's call log.
- **AC-WT-12** Read-only. No `*_wait` path reaches the YouTube read or write gateway, a paid provider, the device mutation gate or
  an upload writer. Pinned by a source scan; the gateway inventories are unchanged.
- **AC-WT-13** The CLI never accepts a token value as an argument and never prints or logs it. A missing variable gives
  `token_missing`, exit 2. The token prefix picks the endpoint.
- **AC-WT-14** An upload `paused` for `auth` / `live_writes_off` returns `blocked` at once (unless Q2 changes it). One paused for
  `quota_exceeded` / `upload_limit` keeps waiting.
- **AC-WT-15** Disabling or breaking one target's module affects only that target (`target_unavailable`). The others and the rest
  of each endpoint keep working (§M).
- **AC-WT-16** The API versions go up: Factory 1.54.0, Agent 4.25.0, Producer 1.27.0. Each has its history line, and
  `*_get_capabilities` lists the new tool. MCP, API and CLI texts are English. No Web UI change, so no `ui-text` keys.
- **AC-WT-17 (stage 0 probe)** A real `factory_wait` that blocks 240 s returns normally in Claude Code. With Codex the probe uses
  the default config (expected: 60 s kills a 240 s block, 50 s passes) and `tool_timeout_sec = 300` (expected: 240 s passes). The
  measured values are recorded in the ADR. If they differ, the cap and default change before stage 2.

## 5. Stages (one branch `feature/bl-271-wait`, one merge)

0. **Probe.** On a throwaway endpoint build in the worktree, never the live server: confirm AC-WT-17 and that a bare `tools/call`
   POST (no `initialize`) works on the stateless endpoint. Fix the cap and default in ADR 0075.
1. **Core and ports.** `src/lib/operation-wait/` with its pure tests, the shutdown `AbortSignal`, and
   `src/composition/wait-targets.ts` with one port per target and its own read. Any missing plain reads are added (upload row by
   id or by channel and video, render verdict by id).
2. **MCP tools.** `factory_wait`; `agent_wait` through `WORKER_FACTORY_TOOLS`; `producer_wait` as `producer-only`. Then the
   uncounted sets and the Producer exemption, `tool-classification.ts`, the capability lists and the version bumps.
3. **CLI.** `src/cli/wait.ts` and the `package.json` script, with tests against a fake HTTP endpoint: drops, restarts, timeouts,
   exit codes.
4. **Docs.** SYSTEM_MAP, ARCHITECTURE (MCP / CLI), `AGENT_OPERATIONS_INTERFACE.md` / `interfaces.md` (the tool contracts),
   `AGENT_ISOLATION_SETUP.md` (Codex `tool_timeout_sec`, the CLI's token variable), ADR 0075 → Accepted, ROADMAP_STATUS after
   acceptance.
5. **Live check after the merge**, on the owner's server through restart-when-idle: one `restart current` CLI wait (AC-WT-08) and
   one real job wait by the Operator.

## 6. Test plan (AGENTS.md §L)

Expected values come from §2 and §4, written by hand.
- **Core.** A fake clock and a scripted reader:
  - final at the first read → 0 sleeps;
  - final on read n → one result after n − 1 polls;
  - timeout → `still_running` with the last status;
  - abort → `server_stopping` within one tick;
  - three failed reads in a row → `target_unavailable`, while one failed read is retried.
- **Ports.** Each target over its real module with an in-memory or temp DB: every status of the table → its outcome. The table
  is the expected value. Boundaries:
  - the `until` variants;
  - `partly_done`;
  - an upload by video code with two rows (the newest wins);
  - `restart current` with no request.
- **Scoping.** The worker on another channel's job, upload, request, storyboard and render: `not_found`, byte-identical to a
  missing id. Another `channelId` → `CHANNEL_NOT_ACTIVE`. The Producer with a non-upload target → `invalid_request`.
- **Restart interplay.**
  - A source test that all three names sit in the uncounted sets or the exemption.
  - A service test: requests plus back-to-back waits → `waitingFor` holds no `mcp_quiet` coming from them.
  - A SIGTERM test on the abort signal.
- **Inventories.** The read-only scan (AC-WT-12). The existing gateway, upload and weekly-build inventories pass **unchanged**
  (no justified test change is needed, as weekly-build stays out).
- **CLI.** A fake endpoint gives:
  - JSON-only stdout;
  - each exit code;
  - a restart-shaped sequence (`restarting` → refused connections → `done`) → exit 0;
  - an 11-minute drop on a job wait → exit 2;
  - a token never in argv, stdout or stderr.
- Then `npm test`, `npm run lint`, `npm run build`, `git diff --check`, and an independent review before the merge.

## 7. Risks

- **R1. A client kills a block.** If stage 0 finds lower limits, the default and cap go down; the CLI path is unaffected.
- **R2. Polling load.** A dozen concurrent waits at 5 s on SQLite rows is negligible. Automerge targets are polled at 15 s; a
  shared per-process cache per (target, id) for one poll interval is allowed if profiling asks for it. BL-270's idle-load goals
  stay intact: no wait, no polling.
- **R3. A token in the environment.** Agents already keep it there (Codex `bearer_token_env_var`). The CLI reads only the named
  variable. No new gap; noted in AGENT_ISOLATION_SETUP.
- **R4. An agent mistakes `final: false` for done.** The result shape always carries `final` and `outcome`, and the description
  says to act only on `final: true`.
- **R5. A restart wait from an old checkout.** The CLI process keeps running old code across a restart. It only speaks HTTP, so
  that is harmless.

## 8. Out of scope

- The weekly build (Q4).
- Recode and rename as targets: they are synchronous (Q5).
- Other computers' jobs and uploads.
- Generation-plan stages.
- Waiting on several ids in one call.
- SSE progress streaming.
- Any Web UI change.
- Push notifications or webhooks to agents (ADR 0066's wake files stay as they are).
- Any write, YouTube call or paid call.

## 9. Questions (owner / Operator), with recommended answers

- **Q1. The CLI's name.** `ytm wait …` needs a `bin` entry and a link on PATH; the repo has none today.
  **Recommended:** ship `npm run --silent wait -- …` from the app folder now, and add a `ytm` bin later if the Operator wants it.
- **Q2. An upload paused for `auth` / `live_writes_off`** can stay paused forever.
  **Recommended:** return at once with `outcome: blocked` (exit 2), so the agent tells the owner instead of waiting blind.
  Quota and upload-limit pauses keep waiting.
- **Q3. `partly_done` translation request.**
  **Recommended:** exit 1 (`outcome: partly_failed`, the result lists which videos have sets), because some of the work failed.
- **Q4. Weekly build.** There is no state in YT Manager, every read runs Python, and AC 11 keeps it out of MCP.
  **Recommended:** defer. The Operator waits on the factory's own `factory_launch.py … status --json` in the workspace. A later
  item can make YT Manager keep the job state (then the wait is cheap and AC 11 is amended by the owner).
- **Q5. "Recode/rename jobs".** `factory_release_recode` and `factory_release_folder_rename` answer in one call.
  **Recommended:** ask the Operator whether it meant something else (for example a factory-side ffmpeg render). If not, waiting
  for their busy reasons is the `upload` / job targets.
- **Q6. Producer and `restart`.** The Producer has no restart tool today.
  **Recommended:** yes. It is a harmless global read, and the Producer is affected by restarts too.
