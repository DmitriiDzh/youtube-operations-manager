# 0075. Waiting for long operations without spending agent tokens: a read-only wait core, `*_wait` MCP tools and a CLI

Status: Accepted (2026-11-17; built on `feature/bl-271-wait`, stage 0 measured -- see "Stage 0 measurements").

**Date:** 2026-11-17.
- **Plan:** `docs/roadmap/plans/WAIT_TOOLS_PLAN.md`, acceptance AC-WT-01..18. Backlog BL-271.
- **Source:** owner Telegram msgs 3617/3618, relayed by the Operator.
- **Builds on:** ADR 0049 (restart when idle), 0048 / BL-217 (worker tools over pinned factory deps), 0059 (the Producer's upload
  queue view).

## Context

Agents follow long operations by polling get/status tools or running watcher loops. Each "still running" wakes the LLM session
and re-reads its whole context (~590k tokens). The owner wants a wait that costs nothing while it waits and returns once, on the
final result.

Constraints found in the code and the clients:
- **Responses arrive all at once.** The MCP endpoints are stateless Streamable HTTP with JSON responses, so a blocked call sends
  nothing until it returns.
- **Client limits.**
  - Claude Code kills an HTTP MCP call after about 60 s by default (measured in stage 0; the plan first inferred a 300 s idle limit).
  - Codex's `tool_timeout_sec` defaults to 60 s (OpenAI docs; stage 0 measures it).
  - The TS SDK's default request timeout is 60 s.
- **Restart when idle.** It counts the start of every MCP call except the status polls, and stops the process with SIGTERM, then
  a forced exit 90 s later.
- **Existing CLIs.** They import `@/lib/db`, which migrates the DB, and have no channel identity.

## Decision

1. **One wait core, ports per target.** `src/lib/operation-wait/` (pure) polls a target's read port until it is final, times
   out, or is aborted. The ports are composed at the app layer (`src/composition/wait-targets.ts`) over each module's existing
   reads. No feature module imports another (§M), and a missing module disables only its target.
2. **Targets.**
   - `upload`;
   - `media_session` (`until` ready | ended);
   - `media_job`, `gemini_job`, `speech_job`, `sound_job`;
   - `translation_request` (`until` claimed | finished);
   - `storyboard_review`, `storyboard_render`;
   - `restart`.

   All are on this computer only, with the status mapping in the plan's §2. Two are left out on purpose:
   - **The weekly build has no state in YT Manager.** It lives in the factory launcher, every read runs Python, and BL-231 AC 11
     keeps it out of MCP. Deferred.
   - **Recode and rename are synchronous.** They answer in one call, so there is nothing to wait on.
3. **MCP tools.** `factory_wait`; `agent_wait`, which is the same tool collected through `WORKER_FACTORY_TOOLS` over
   channel-pinned deps; and `producer_wait`, `producer-only`, uploads (and `restart` if the owner agrees).
   - They are read-only: no YouTube call, no write, no mutation gate.
   - A resource of another channel answers exactly like a missing one.
   - One call blocks for **at most 240 s, default 50 s**. Then it returns `final: false, outcome: still_running` with the last
     status.
   - The calls are **not counted** as MCP activity. This covers the Producer wrapper too, which gets its first exemption.
   - A call **returns at once** on SIGTERM (`server_stopping`) and when a restart request turns `restarting`.
4. **CLI.** `npm run --silent wait -- <target> <id> [--timeout <sec>]` (`src/cli/wait.ts`).
   - **Transport.** It is a thin HTTP client of the **caller's own endpoint**, chosen by the token prefix. The token is read from
     a named environment variable, never from an argument. It does not read SQLite, so channel scoping stays in one place and no
     migration can race the server.
   - **Loop.** It repeats 240 s tool calls without printing.
   - **Connection loss.** It retries: until the deadline for `restart`, up to 10 minutes for any other target -- once the app has
     answered; an app that never answered ends the wait after 60 s. 401 / 403 / 404 end it at once.
   - **Output.** It prints **one JSON line** and exits 0 (succeeded), 1 (failed / cancelled / rejected / changes requested /
     expired) or 2 (timeout, blocked, unknown, unreachable, usage).
   - **Preferred path.** The CLI, run as a background shell command, is the way for any wait longer than a few minutes.
   - **Restart.** `restart current` allows 30 s for the developer's request file to be taken up, pins the request id, and also
     treats a later `serverStartedAt` as done (a request file satisfied at boot, with no row).
   - **Clients.** Every role runs Claude Code (Q7); a background shell command's exit notifies the session once.
5. **Versions.** Factory API 1.54.0, Agent API 4.25.0, Producer API 1.27.0. All texts are English. No Web UI change.

## Stage 0 measurements (2026-11-17)

A standalone sleep-only MCP server (same transport: stateless Streamable HTTP, `enableJsonResponse: true`; no app, no DB) was called
by a real **Claude Code 2.1.322** (`claude -p`, `--strict-mcp-config`, one `sleep` tool) -- the probe, not a real `factory_wait`:

| block | client config | result |
|---|---|---|
| 50 s | default | passes (answer after 50 s) |
| 75 s | default | killed at ~60 s ("The operation timed out.") |
| 240 s, 330 s | default | killed at ~60 s |
| 240 s | server entry `"timeout": 300000` | passes |
| 240 s | `MCP_TOOL_TIMEOUT=300000` | passes |

- So Claude Code's **default** limit for an HTTP MCP call is about **60 s**, not the 300 s idle limit the plan inferred. The binary sets
  the call limit to the server entry's `timeout` (or `MCP_TOOL_TIMEOUT`) and the idle limit to max(300 s, that timeout).
- A bare `tools/call` POST without `initialize` works on a stateless server.
- All probes ran in `-p` (non-interactive) mode. The binary shows that interactive sessions may move an MCP call running over 120 s
  into the background (feature flag `tengu_mcp_auto_background`); that path, and the `timeout` advice in an interactive session, were
  not measured.
- **Decision:** default **50 s** (works unconfigured) and cap **240 s** stay as planned. A block over ~55 s needs `"timeout": 300000`
  in the agent's server entry (`docs/AGENT_ISOLATION_SETUP.md` §3). The CLI is our own HTTP client and always uses 240 s rounds.
- **Codex** was not probed: every role runs Claude Code (Q7).
- **AC-WT-18:** a CLI wait (`npm run --silent wait -- media_job …`) run as a background shell command from a Claude Code session
  against a fake `factory_wait` endpoint that became final after 600 s: three calls (240 / 240 / the rest), exit 0 after 593 s, one
  JSON line, empty stderr; nothing was printed before the exit, and the session got one notification when the process exited.

## Questions resolved (coordinator, 2026-11-17)

Review (2026-11-17): an upload `done` with an `errorCode` (a step after the upload did not pass) is `partly_failed`, exit 1.
Q1 `npm run --silent wait -- …` (no `bin`); Q2 an upload paused for `auth` / `live_writes_off` answers `blocked`, exit 2; Q3
`partly_done` is `partly_failed`, exit 1; Q4 the weekly build is deferred; Q5 recode / rename have no target (synchronous); Q6 the
Producer may wait on `restart`; Q7 every role runs Claude Code; Q8 no tokenless shell mode beyond the CLI.

## Consequences

- An agent's long wait costs one tool call, or one background process, and one result.
- Restart when idle is unaffected: waits are invisible to its quiet window and never hold a shutdown. A restart wait through the
  CLI survives the server going down and reports the new version.
- The 240 s cap is tied to today's clients. If stage 0 or a client update shows other limits, this ADR is amended with the
  measured values before the tools ship.
- The plan's §9 questions are resolved (above).

## Alternatives rejected

- **A CLI reading SQLite directly** (like `operation-lock`). It has no channel identity, so it gives a worker every channel's
  state, it duplicates the status mapping, and an `@/lib/db` import migrates the DB.
- **Blocks of 9–10 minutes.** Claude Code kills them at about 60 s by default (300 s at most with a raised idle limit), and Codex at 60 s by default.
- **SSE progress for the wait tool.** It does not lift Claude Code's hard limit and it changes the transport for one tool. The
  CLI covers long waits.
- **Webhooks or push to agents.** There is no agent-side listener contract. ADR 0066's wake files remain for owner decisions.
