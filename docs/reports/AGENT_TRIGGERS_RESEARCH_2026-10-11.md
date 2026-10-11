# Research: starting agent work from the app's UI (2026-10-11)

Owner's request (Telegram 2569): today agents command the app through MCP; how can a press or an action in YT Manager start an
agent's work? This note records what the code has and what the outside world offers. It is research only: nothing is assigned or
built.

## 1. What the app has today (code read at `dev` 5100c00)

- **Every path from the owner to an agent is pull.**
  - The three MCP endpoints (`/api/mcp`, `/api/mcp/factory`, `/api/mcp/producer`) are stateless Streamable HTTP: POST only,
    loopback only, a fresh server per request. They have no session, no SSE stream, no `notifications/*` and no subscriptions.
  - Nothing in `src/` starts `codex` or `claude`, and nothing calls an agent provider. The only child processes open a browser or
    run git and the launchd runner.
- **How the owner's actions reach an agent:**
  - **Generation plans:** owner actions are plan events (`record()` into `generation_plan_events`). The agent reads them through
    `factory_plan_get { since }` (or `agent_get_generation_plan`).
    - The cursor has one-second resolution, and its 60 s look-back repeats events, so the agent drops duplicates.
    - The owner's "ask to generate again" (`requestRerun` → `rerun_requested`) shows only in that events feed. **It is not in
      `factory_plan_todo`**, whose `rerun` lists failed or interrupted attempts. It also has no route on another computer's plan.
  - **Agent proposals (BL-163):** the Producer proposes, the owner approves or rejects in the Web UI, and the Producer polls the
    outcome. The approval verbs are fenced out of MCP by inventory tests.
  - **Other requests the owner approves:** collection, research and media-session requests all follow the same pattern: the agent
    asks, the owner approves, the agent polls.
- **Rules a design must keep:**
  - **ADR 0029 §4:** "the factory drives runs; the app never starts anything by itself". An app that starts an agent changes this
    rule and needs a new ADR.
  - **AGENTS.md §B:** no operator instructions in the repo. A task's payload is structured data; how the agent does the work lives
    in its own instructions, outside the repo.
  - **§G:** one gateway per external API category.
  - **§M:** an independent module.
  - **Security gates:** loopback, the MCP master switch, the operation lock, Live Writes.
  - **Spec §26:** "AI may propose. Human approves. System applies."
- **Building blocks to reuse:**
  - the plan events feed with a cursor;
  - `factory_plan_todo`, which already has the shape of a work queue;
  - the `agent_proposals` lifecycle (pending → decided, mark done, retention, web-only decisions with inventory fences);
  - the approve-request flows (atomic status changes, orphan sweep at boot).

## 2. What the outside world offers (as of 2026-10)

### 2.1 MCP cannot wake an agent today

- **MCP 2026-07-28** (final): the protocol is stateless and server-initiated requests are removed. Elicitation and sampling now
  ride inside the client's own request ("MRTR"). The GET stream and `resources/subscribe` are replaced by `subscriptions/listen`,
  which carries change notifications only. Sampling is deprecated. Tasks moved to an extension, still driven by the requester's
  polling.
  - https://modelcontextprotocol.io/specification/2026-07-28/changelog
- **A standard "triggers/events" mechanism:** the Triggers & Events working group was chartered in 2026-03; its RFC is still at
  "ideating".
  - https://modelcontextprotocol.io/community/working-groups/triggers-events
- **Codex** documents no handling of server pushes, and `codex mcp-server` was removed.
  - https://learn.chatgpt.com/docs/extend/mcp.md?surface=cli
  - https://learn.chatgpt.com/docs/mcp-server
- **Claude Code** reacts to pushes only through "channels". They are a research preview, work only in an interactive session, and
  are ignored by `-p` and the Agent SDK.
  - https://code.claude.com/docs/en/channels-reference
- **ChatGPT "MCP Events"** (2026-09-29) posts to a public HTTPS callback, so it cannot reach an app on 127.0.0.1.
  - https://developers.openai.com/plugins/build/mcp-events

### 2.2 Starting an agent programmatically works today

- **Codex `codex exec`:**
  - Non-interactive, with JSONL events (`--json`) and an output schema.
  - Read-only sandbox by default. Billing is the saved ChatGPT login, or `CODEX_API_KEY`.
  - Sessions can be resumed with `resume`.
  - **Codex SDK** (TypeScript): threads and streamed turns.
  - **Codex app-server:** a long-lived JSON-RPC session where the app can answer approval requests. It is "experimental, not for
    production".
  - https://learn.chatgpt.com/docs/non-interactive-mode
  - https://learn.chatgpt.com/docs/codex-sdk
  - https://learn.chatgpt.com/docs/app-server
- **Claude `claude --bare -p`:**
  - Options: `--mcp-config`, `--allowedTools`, `--max-budget-usd`, a JSON result with cost, and `--resume`. `--bare` needs an API
    key.
  - **Agent SDK:** `maxBudgetUsd`, `maxTurns`, `canUseTool`, `strictMcpConfig`, and abort.
  - https://code.claude.com/docs/en/headless
  - https://code.claude.com/docs/en/agent-sdk/overview
- **Cloud triggers:** Claude Code Routines `/fire`, Codex through Linear or Slack, ChatGPT events. They need the app reachable
  from outside, and they wake cloud agents, not the local operator.
- **Pitfall to test first:** a Codex issue reported that MCP tool calls are cancelled in `exec` mode because stdin is closed.
  Current docs add per-tool `approval_mode`. Unattended loopback MCP calls from `codex exec` must be checked before building on it.
  - https://github.com/openai/codex/issues/24135

### 2.3 Patterns and security

- **Patterns:**
  - a work-item table with the MCP Tasks states (`queued → working → input_required → completed | failed | cancelled`, plus a
    dead letter);
  - a claim with a lease;
  - a transactional outbox, so the app survives a restart between the press and the start;
  - one run per work item;
  - idempotency keyed on the work-item id;
  - status in the UI with Cancel.
  - Vibe Kanban is the closest public reference: a local UI that starts Claude Code or Codex per card on 127.0.0.1 with an origin
    check (https://github.com/BloopAI/vibe-kanban).
- **Security:**
  - **Prompt injection** ("Agents Rule of Two", OWASP Agentic Top 10): YouTube data and earlier AI output are untrusted data.
    Wrap them as data, as Routines do with `<routine-fire-payload>`.
  - **Permissions:** the task *type* decides the allowed tools, never the content.
  - **Spending and publishing** only create pending approvals, checked on the server.
  - **Secrets:** none in prompts or payloads.
  - **Local endpoint:** loopback plus an `Origin` check plus a token. Localhost HTTP alone is not a boundary (MCP Inspector
    CVE-2025-49596). A "start agent" endpoint spends money, so it also needs CSRF protection.
  - **Agent settings:** load none from the environment (`claude --bare`, `codex exec --ignore-user-config`, a dedicated working
    folder).

## 3. Options for this app

1. **A task queue and a local dispatcher (recommended).**
   - A press stores an `agent task` (type, subject, the owner's note, structured parameters) and an outbox row.
   - A dispatcher in the app starts one headless run per task: `codex exec` or the Codex SDK for the Factory Operator, or
     `claude --bare -p` / the Agent SDK for another role.
   - The run's working folder is the agent's own operations folder, so its instructions stay outside the repo.
   - The fixed prompt only names the task id and type.
   - The agent claims and reports the task through new MCP tools, and does the work through the existing ones.
   - The app enforces the limits: 1–2 runs at a time, a timeout, a daily cap, and a tool set per task type.
   - Spending and publishing stay approvals. The owner sees queued / working / done / failed and can cancel.
   - Needs:
     - a new ADR, because it changes ADR 0029 §4;
     - its own module (§M);
     - a gateway for starting agents (§G);
     - the checks in §2.2.
2. **A long-lived agent session driven by the app.** This uses the Codex app-server, an Agent SDK streaming session, or Claude
   channels. It has the lowest latency and the richest control, but these are experimental or a research preview, the context
   keeps growing, and a crash loses work that is in flight.
3. **Pull only.** Owner tasks appear in the feeds the agents already read (`factory_plan_todo`, a task list), and the agent drains
   them on its own schedule. Almost no new code and no rule change. But the latency is the polling interval, an empty poll still
   costs a model turn, and it is not "a press starts the work".

**Suggested order**, each step only with the owner's go:
1. **Step 0:** owner requests in `factory_plan_todo` (`rerun_requested` and similar). This fixes today's gap with no new rule.
2. **Step 1:** an `agent-tasks` module: owner-created tasks, MCP list / claim / report, and status in the UI. Agents still pull,
   so it works with today's setup.
3. **Step 2:** the dispatcher starts `codex exec` for the operator on a new task, behind an owner switch and limits, after the
   §2.2 checks and a new ADR.
