# HUB "System" topic: owner commands the Manager executes (BL-228)

Status: **assigned** (owner, Telegram msg 3598, 2026-10-27: «Делай обе задачи, System и по музыке. Каждую в своей ветке»).
Request: FO-REQ-0042 (Operator, with its answers of 2026-10-27). Reply: DEV-RESP-0043 Part 1 (questions Q1–Q6). ADR 0053.

## 1. Why

The Operator, the Producer and the channel agents run in Claude Code. Its auto mode accepts a permission only from the terminal,
so the owner's «да» on Telegram cannot stop a running factory job or approve a paid call. The owner wants to command these from
the HUB group's "System" topic, and the Manager (not an agent) executes them.

## 2. Scope

1. **Telegram Bot API gateway** `src/lib/telegram-bot-gateway/`: the only module that calls `api.telegram.org`
   (`getUpdates`, `sendMessage`). The token is read from `device-secrets` for every call; it never reaches a log, an error
   text, the browser or an AI provider. A mechanical inventory test fails if any other production file calls the Bot API.
2. **Module `src/lib/system-topic/`** (feature module, AGENTS.md §M: the app works with it off or removed):
   - settings: owner Telegram user id, group chat id, topic thread id, the per-computer listening switch (off by default,
     refused off the Mac service), and the path of the factory's `commands.json`;
   - a poller (long-poll `getUpdates`, offset kept in the DB) that keeps only messages from the configured chat + topic +
     owner user id; everything else is dropped and counted;
   - a fixed command parser: `help`, `status [<channel>]`, `stop <channel> <jobId|plan>`, `go <channel>`, `approve <id>`,
     `deny <id>`. Anything else gets a one-line "unknown command, see help";
   - the command runners (§3–§5) and an audit row per command (who, text, result, time).
3. **Settings → «System (Telegram)»** card: token (masked `type="text"`, device-secrets), the three ids, the switch with a
   visible caption, the last poll time, the last 20 commands with results. All texts in every UI language.
4. **No MCP tool** in stage 1 besides the result files agents already read; agents never command System.

## 3. `status` and `go` — factory commands from the factory's own config (AGENTS.md §B)

The Manager holds the command grammar only. Script paths, the workflow name and channel short names come from the
factory-owned `00 YT Operator/System/commands.json` (DEV-RESP-0043 Q1), read on each command, never written:

- `status [<channel>]` runs the configured `status.argv` (+ `channelArg <name>`) without a shell, 60 s timeout, and posts the
  output cut to 3500 characters;
- `go <channel>` removes the channel's `stopFile`, runs `go.argv` detached in the channel root, and posts the new job id
  (Q4) or "started".
- A channel `root` in the config must equal that channel's workspace path on this computer (`channel-workspaces`), otherwise the
  command is refused (`channel_root_mismatch`). Relative paths resolve inside the root and may not leave it.

## 4. `stop` — fails closed

`stop <channel> <jobId>` stops a job only when all hold: the record is `<root>/<jobsDir>/<jobId>.json`; `device` equals this
computer's host name; `status` is `running`; the record has `pidStartedAt` and `cmdline`; the live process `pid` has the same
start time and command line (`ps -o lstart=,command=`); its process group is not the Manager's own. Then: create `stopFile`;
SIGTERM to the group; after 30 s SIGKILL if still alive; write `status: "stopped"`, `stoppedBy: "owner"`, `stoppedAt` into the
record (atomic replace); post the last log line. A record without `pidStartedAt`/`cmdline` (before factory bundle 2.5.41):
only the STOP file is created and the reply says the process was not stopped. `stop <channel> plan` stops every running job of
the channel whose workflow is the configured `go` workflow (Q3).

## 5. `approve <id>` / `deny <id>` — one-time approvals

- An agent writes `00 YT Operator/System/requests/<id>.json` (`format`, `id`, `createdAt`, `requestedBy`, `action`, `args`,
  `costEstimateUsd`, `reason`). The poller scans the folder each tick and posts each new request once: id, action, short
  arguments, the **Manager's own** cost estimate, the request hash (first 8 hex of SHA-256 of the canonical JSON of
  `{action, args}`).
- Allowlist: `factory_media_start_session` (cap $2 = the template's GPU rate × the stated maximum hours, auto-stop required) and
  `factory_gemini_create_job` (cap $1 from Gemini's price table). The existing day/month limits stay the ceiling.
- `approve <id>`: refused when the request is unknown, already used, denied, older than 2 h from `createdAt` (or `createdAt` in
  the future), the file's hash differs from the posted one, the args fail the tool's own schema, or the estimate is over the
  cap. Otherwise the Manager calls the same service function the MCP tool calls, in process, with the actor
  `owner (System)`, marks the request used **before** the call, and writes `<id>.result.json` (`status: done | refused |
  failed | expired`, `at`, `result` or `error`).
- Request state (posted, hash, used, denied) lives in the DB, so a restart neither forgets a use nor re-posts.
- This is the owner's explicit, per-call authorization of a paid call (AGENTS.md §K.2, PROJECT_SPEC §21): nothing else in the
  app may start one through System.

## 6. Never

Show tokens or keys; publish, delete or reschedule videos; touch live streams, uploads or the Manager's own process; run a shell;
execute any text that is not one of the six commands.

## 7. Acceptance, worked out by hand

- AC-SYS-01 A message `status` from another user id in the topic gets no reply and no audit row with a result; a counter rises.
- AC-SYS-02 `status` from the owner in another topic of the group is ignored.
- AC-SYS-03 `status tropico` runs the configured argv once with `--channel tropico` and posts its output; 5000 characters of
  output are posted as 3500 + "…".
- AC-SYS-04 `stop tropico <jobId>` on a running record whose `pidStartedAt` matches but `cmdline` differs: no signal is sent,
  STOP is created, the reply says why.
- AC-SYS-05 `stop` on a record of device `Windows-PC`: refused, no STOP, no signal.
- AC-SYS-06 `stop` on a matching job: SIGTERM to the group, record `stopped`/`owner`, STOP exists; a process that ignores
  SIGTERM gets SIGKILL after 30 s.
- AC-SYS-07 `go tropico` with a config `root` different from the channel's workspace path: refused, STOP kept, nothing run.
- AC-SYS-08 A request created 2 h 1 min ago: `approve` → `expired`, the tool is not called.
- AC-SYS-09 `approve` twice: the first calls the tool once, the second → `used`, the tool still called once.
- AC-SYS-10 The request file's `args.maxHours` changed after posting: `approve` → refused (hash), the tool not called.
- AC-SYS-11 A media session estimate of $2.01 → refused (cap); $2.00 → allowed.
- AC-SYS-12 An action outside the allowlist is posted as refused and cannot be approved.
- AC-SYS-13 With the switch off, the poller makes no Bot API call.
- AC-SYS-14 No log line, API response or error text contains the token (test with a token-shaped secret).
- Live, with the Operator: FO-REQ-0042's own acceptance (status, stop of a scratch job, go, a $0 approval twice, an expired one).

## 8. Stages (one branch, one merge)

1. Gateway, settings card, poller, `help` + `status`.
2. `stop` + `go`.
3. Approvals.

## 9. Risks

- A stolen Telegram account can approve paid calls up to the caps (owner's choice asked in msg 3600; recorded in
  TECHNICAL_DEBT when answered).
- Two computers polling one bot: prevented by the Mac-only switch.
- The factory config is trusted input from the factory side: argv runs without a shell, inside the channel root only.
