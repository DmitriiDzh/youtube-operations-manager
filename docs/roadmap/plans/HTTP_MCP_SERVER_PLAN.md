# In-app Streamable HTTP MCP server (replaces stdio) — plan

**Status: IN PROGRESS.** Backlog: BL-113. Branch: `feature/http-mcp-server`. ADR:
`docs/decisions/0013-in-app-http-mcp-transport.md` (reverses Phase 12 decision D0(b)).

**Owner direction (chat, 2026-10-01):**
- The MCP server must run on *our* side, "as in Blender". Codex/Claude only connect to it through
  their own interface and receive only what the product allows. The agent must not need the
  project path.
- "Делаем … старый подход убираем / заменяем его на подход собственного mcp сервера" — stdio is
  **replaced**, not kept alongside.
- No token / invalid token → an explicit, clear error (not an empty tool list).
- The whole web server binds to `127.0.0.1`.
- CLI agent mode (`--agentToken` / `YTOM_AGENT_TOKEN`) is **removed** (variant 1). The operator CLI
  is unchanged.

Safety-critical (`AGENTS.md` §L: channel identity, §F/§G). Governed by §M: the endpoint is its own
module (`src/lib/agent-mcp-endpoint/`), the route is a thin adapter.

## 1. Design

- **Endpoint:** `POST /api/mcp` in the Next.js process, Streamable HTTP, **stateless** (a fresh
  `McpServer` + `WebStandardStreamableHTTPServerTransport` per request, JSON responses). No sessions,
  so nothing survives a revoked token or a toggled switch. `GET`/`DELETE` → 405.
- **Order of checks (each fails closed, each is an explicit error):**
  1. Loopback only: `Host` must be `127.0.0.1`/`localhost`/`[::1]`; a present `Origin` must be a
     loopback origin → else 403.
  2. "MCP connection" toggle read **on every request** → off: 403 with an explanatory message.
  3. `Authorization: Bearer <channel token>` → `verifyToken` on every request → missing/invalid/
     revoked: 401 with an explanatory message. No `WWW-Authenticate` challenge (avoids sending the
     client into OAuth discovery).
  4. Run the request inside a **per-request** agent scope (`AsyncLocalStorage`).
- **Per-request scope.** `src/lib/agent-session` becomes ALS-only. The ALS instance lives on
  `globalThis` under `Symbol.for(...)` so Next's bundling/HMR cannot create two instances. The
  process-wide `enterAgentSession` is **removed** (its only users were stdio MCP and the CLI agent
  mode, both removed), so there is no second, weaker way to be "in scope".
- **Fail-open guard.** Inside the web process, "no scope" means operator mode. Therefore the
  per-call wrapper asserts, immediately before every tool handler, that
  `getAgentSession()?.tokenId` equals this request's binding, and refuses otherwise.
- **`proxy.ts`:** `/api/mcp` is exempt from the device-mutation gate (every MCP call is a POST,
  including reads; the stdio server never went through it). Mutating tools keep their own gate
  (`server.ts`, `assertDeviceAvailableForMutation`).
- **Binding:** `-H 127.0.0.1` in the `dev`/`start` npm scripts (the launchers run `npm run start`).
- **Removed:** `startMcpServer`, `StdioServerTransport`, the `mcp:video-metadata` script, the CLI
  `--agentToken`/`YTOM_AGENT_TOKEN` handling and its `enterAgentSession` call.
- **Settings → AI Agent:** tooltip/dialog text corrected (applies immediately); shows the endpoint
  URL and Codex / Claude Code connection snippets.
- **`AGENT_API_VERSION` → 2.0.0:** every released agent configuration breaks (stdio launch removed,
  CLI agent mode removed). Same precedent as Phase 12's MAJOR bump for config breakage. Tool
  contracts themselves are unchanged.

## 2. Out of scope (deliberately)

- OS-level isolation of the agent from `data.db` (RISK-87 stays: same OS user can still open the
  file; what changes is that the agent's own configuration no longer contains the project path).
- Moving `src/mcp/server.ts` (tool definitions stay where they are).
- Any change to tool contracts, classification, or per-channel data ownership.

## 3. Acceptance criteria (written before implementation)

| ID | Criterion |
|---|---|
| AC-HM-01 | Loopback guard: a request whose `Host` is not loopback, or whose `Origin` is present and not loopback, is rejected (403) before the token is looked at. `localhost`, `127.0.0.1`, `[::1]` with or without a port are accepted. |
| AC-HM-02 | Toggle off → 403 with a message naming the setting, for any token. The toggle is read per request: switching it takes effect on the very next call. |
| AC-HM-03 | No `Authorization` header, a non-Bearer scheme, an unknown token, or a revoked token → 401 with a message saying what is wrong. No tool list, no data. No `WWW-Authenticate` header. |
| AC-HM-04 | Valid token + toggle on → `initialize` and `tools/list` succeed and list exactly the `bound`-classified tools; no `operator-only` tool appears. |
| AC-HM-05 | Revocation is immediate: after the operator revokes/rotates, the very next request with the old token gets 401. |
| AC-HM-06 | Scope: requests for token A (channel A) never return channel B's data, via the real endpoint, including a channel id / resource id of B passed as input. |
| AC-HM-07 | **Interleaving:** concurrent requests for token A, token B and an operator (non-agent) code path, with a deliberate `await` inside A's handler, each observe only their own scope (`getAgentSession()`), and the operator path observes none. |
| AC-HM-08 | Fail-open guard: a tool handler running with no scope, or with a scope whose `tokenId` differs from the request's binding, is refused (never executed). |
| AC-HM-09 | The web process never has an ambient agent scope: outside a request's ALS run, `getAgentSession()` is `null`; `getSelectedChannelId`/`setSelectedChannelId` behave as operator. |
| AC-HM-10 | Only `POST` is served; `GET`/`DELETE` → 405. |
| AC-HM-11 | `proxy.ts`: `/api/mcp` is not blocked by recovery mode/operation lock. Other mutating `/api/*` routes still are. |
| AC-HM-12 | Stdio is gone: no `StdioServerTransport`, `startMcpServer`, or `mcp:video-metadata` script remains; the CLI rejects `--agentToken` and does not read `YTOM_AGENT_TOKEN`; `enterAgentSession` no longer exists. An inventory test pins this. |
| AC-HM-13 | `npm run start`/`dev` bind `127.0.0.1`. |
| AC-HM-14 | Parity: every MCP tool classified `bound` is reachable through the HTTP endpoint (the same registration path), and `AGENT_API_VERSION` is `2.0.0`. |
| AC-HM-15 | Existing Phase 12 acceptance (AC-P12-01..13) still hold through the new transport, except AC-P12-01's "zero tools" for toggle-off/invalid-token, which becomes the explicit errors of AC-HM-02/03 (owner instruction, 2026-10-01). |

### 3a. Phase 12 acceptance tests changed or removed (AGENTS.md §L justification)

The requirement each one verified was removed by ADR 0013 (owner instruction), not worked around:
- `src/cli/video-metadata.test.ts`: "an agent session refuses every operator-only command" (AC-P12-04, CLI),
  "an agent session rejects a caller-supplied --userId" (AC-P12-05, CLI), "the CLI classification covers
  exactly the real command table" (AC-P12-08, CLI half), the `--agentToken` empty/missing-value test and
  "with the MCP connection switched off, a token-bound CLI session is refused" (AC-P12-01, CLI half).
  The CLI has no agent mode, so there is no agent session to refuse. Replaced by AC-HM-12 tests
  (`--agentToken` rejected in every form, `YTOM_AGENT_TOKEN` not read). The MCP halves of all of these
  remain and now run through the real endpoint (AC-HM-04/06).
- `src/lib/agent-session/agent-session.test.ts`: "enterAgentSession can be entered once and never
  replaced" (the process-wide scope no longer exists). Replaced by AC-HM-07/08/09.
- `src/mcp/server.test.ts`: the revoked-token test now runs inside a request scope (same assertion), and
  one test was added (AC-HM-08). `AGENT_API_VERSION` assertions changed 1.0.0 → 2.0.0 (AC-HM-14).
- AC-P12-01's "zero tools" for a disabled toggle / invalid token became explicit 403/401 (owner
  instruction, AC-HM-02/03). AC-P12-10 is unchanged and still tested.

## 4. Slices (one branch, one merge)

1. **S1** — `agent-session` → ALS-only; fail-open guard; interleaving test.
2. **S2** — `src/lib/agent-mcp-endpoint/` + `src/app/api/mcp/route.ts` + `proxy.ts` exemption.
3. **S3** — remove stdio, CLI agent mode, npm script; `-H 127.0.0.1`.
4. **S4** — Settings UI; docs (`interfaces.md`, `SYSTEM_MAP.md`, `ARCHITECTURE.md`,
   `AGENT_ISOLATION_SETUP.md`, README, RISK-87, PHASE_12_PLAN D0 note); version bump.
5. **S5** — real end-to-end check against a running server, independent review.
