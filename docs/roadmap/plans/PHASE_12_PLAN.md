# Phase 12: Channel-bound agent isolation ("Chinese wall") — plan

**Status: IN PROGRESS. Decisions D0–D5 answered by the owner (msgs 1051/1053); only the 12.8
key-storage variant is pending (msg 1054). See §7.**

**Owner direction (Telegram, 2026-09-30):**
- msg 1044: the problem is "a Chinese wall between agents", so that the agent for channel A
  neither reads nor changes anything of channel B. This includes trend research.
- msg 1046: agents get their own per-project folders. An agent never reads the database directly.
  It uses a **channel token** to receive only that channel's data, stores it in its own folder for
  that channel, and works from there.
- msg 1048:
  1. *One agent = one channel.*
  2. (market-data model: pending, see §5.)
  3. *An agent without a token has no channel assigned, so there is nothing for it to receive.*
  4. *Make it Phase 12, covering the whole architecture at once.*

Built on Phase 11 (per-channel workspace path). Governed by `AGENTS.md` §F/§G/§M; safety-critical
per §L (channel identity).

## 1. Current state (inventory, 2026-09-30, HEAD `2fe9955`)

Nothing today binds an agent to a channel. The holes, most severe first:

1. **`write_channel_select` (MCP) / `auth select-channel` (CLI) can repoint `users.selected_channel_id` at any
   channel id.**
   - That column is the only thing `assertActiveChannel` checks.
   - One call therefore opens every channel-scoped tool for another channel.
   - It also changes what the operator's Web UI is scoped to.
2. **`auth_user_select` / `auth select-user|login|logout|revoke` switch the device-global active user.**
   - The active user lives in `auth-context.json`, shared by every MCP/CLI process.
   - `revoke --userId` can revoke another identity's tokens.
3. **Caller-supplied `credentialRef` (`{userId}` or `{accessToken}`) is honoured by roughly 25 MCP tools and
   every CLI command.**
   - This lets an agent act as any stored user.
   - For several tools (analytics, channel-sync, find_comparable_videos, list_asset_performance)
     the same ref also drives the scoping check. The check is therefore spoofable.
4. **Some actions change the active channel as a side effect:**
   - implicit `channel_sync`;
   - successful `apply`;
   - every playlist write;
   - `/api/youtube/channel-info`.
5. **`channel_sync` with an explicit id syncs any channel and overwrites that row's
   `channels.connected_user_id`.**
6. **The CLI ignores the MCP connection toggle.** It exposes the full surface, including OAuth
   login and `asset register --referenceKind local_path`, to anything that can run it.
7. **Agent identity (`AGENT_CONNECTION_ID`) is self-declared, with no secret.**
   - Zoning is per capability, not per channel.
   - It covers 8 mutations and no reads.
8. **Global surfaces reachable by every agent:**
   - market-intelligence: 4 tools, all tables global;
   - operations workspace: 2 tools;
   - hypotheses with `channel_id IS NULL`, plus their experiments;
   - `ai_connections` (spend);
   - live `list` / `transcript` / `preview` / `playlist_list` with no channel check.
9. **Structural:** an agent running as the same OS user can read `data.db` / `auth-context.json`
   directly (plaintext tokens, RISK-07). An in-app boundary is real only if the agent is
   OS-isolated from those files (§4, slice 12.7).

## 2. Target model

**Central decision D0: the transport, which decides whether the wall is real.**

- Today's MCP server is a *stdio child spawned by the agent*. It runs as the agent's own OS user
  and opens `data.db` itself.
- So if an agent is OS-isolated from app-data (its own macOS user, or a sandbox), its MCP server
  and the CLI cannot open the database either, and the agent surface stops working.
- A wall that also holds against a hostile agent therefore needs the data served *by the
  operator's own running app process*, with the agent only a client:
  - **(a) Server-hosted agent transport — recommended.**
    - The operator-run app serves MCP over Streamable HTTP (confirmed available in the repo's
      `@modelcontextprotocol/sdk` 1.29.0: `server/streamableHttp`, `webStandardStreamableHttp`).
    - It is bound to 127.0.0.1, with a Host/Origin header check against DNS rebinding.
    - The channel token is the bearer credential. The agent's CLI agent mode becomes a thin client
      of the same endpoint.
    - Combined with OS isolation (slice 12.7), the agent physically cannot read the database,
      other channels' folders or other agents' tokens. This is exactly the owner's "the agent
      receives data only by token" model.
  - **(b) Keep stdio, in-app wall only.** It stops agent *mistakes*, not a hostile agent (same
    OS user: the agent can read `data.db` or another agent's token directly). This limit would
    be documented.

- **Channel token = agent identity + channel binding.**
  - Issued by the operator in Settings → Channels, one per channel (one agent = one channel).
  - Shown once and stored only as a hash.
  - Device-local (never synced, never in the snapshot), like `agent_connections`.
  - Revocable and rotatable.
- **Agent session.**
  - An MCP server started with `YTOM_AGENT_TOKEN`, or a CLI call with `--agentToken` / the same env
    var, is bound to the token's channel for its whole lifetime. There is no switching.
  - An invalid or revoked token gets **zero tools** (MCP), or a refusal (CLI).
- **No token means no data.** The agent transport exposes no tools unless a valid token is
  present. The existing "MCP connection" Settings toggle (owner rule, 2026-09-21: every MCP/agent
  interaction goes through it) is **kept as the master kill switch**. Tokens are an additional,
  per-channel check, not a replacement.
- **Everything an agent does is derived from the binding, never from input:**
  - `channelId` is optional and, if given, must equal the bound channel.
  - Credentials come from the Google identity **recorded on the token row at issue time**. The
    operator can issue a token only after the app confirms that identity's live OAuth channel
    equals the bound channel. The credential is never derived from `channels.connected_user_id`,
    which an explicit-id `channel_sync` can overwrite (hole #5). A caller `credentialRef` is
    rejected.
    - Real data, 2026-09-30: 2 `users` rows, each connected to exactly 1 channel. Each channel
      already has its own Google identity, so no Brand-Account ambiguity exists today.
  - Resource ids (video, change set, batch, proposal, asset, hypothesis, experiment, research
    record) must belong to the bound channel. A mismatch returns the same "not found" error as a
    missing id.
- **Agent sessions never read or write `users.selected_channel_id` or `auth-context.json`.**
  The operator's active channel and the agents are fully decoupled.
- **Operator-only in agent sessions:**
  - `write_channel_select`, `auth_user_select`, `write_channel_list`;
  - all `auth *` CLI commands;
  - `asset register local_path`;
  - creating or approving anything the Web UI already reserves for the operator (unchanged).
- **Per-channel data ownership for everything** (§5 for market data). Global rows are never visible
  to agents unless the owner decides a specific kind is shared (open decisions D2/D3).
- **Mechanical enforcement.** An inventory test classifies every registered MCP tool and CLI command
  as `bound`, `operator-only`, or `explicitly-shared`. The suite fails on any unclassified tool, the
  same pattern as the write-gateway inventory.

## 3. Slices (one branch, `feature/phase-12-agent-channel-isolation`, one merge)

| Slice | Content |
|---|---|
| 12.1 | `agent_channel_tokens` table (hash, channel_id, label, created/revoked/last_used), additive migration. Operator API and Settings → Channels UI: issue (shown once), revoke, rotate. Device-local, not in the snapshot. |
| 12.2 | Agent-session resolution in MCP and CLI: token → bound channel + channel credential. Without a valid token the MCP server exposes zero tools and the CLI refuses. Remove identity-switching tools. Reject explicit `credentialRef`. No `selected_channel_id` / `auth-context` reads or side effects in agent sessions. |
| 12.3 | Bound-channel enforcement for every channel-scoped tool (new `assertBoundChannel` in `channel-access`, reusing its fail-closed shape). Live YouTube reads/writes (`list`/`transcript`/`preview`/`playlist_*`/`apply`, `channel_sync`) restricted to the bound channel. Resource-ownership checks. Inventory test. |
| 12.4 | Data ownership: channel-own hypotheses only (NULL-channel rows become operator-only). Market intelligence per decision D1. Research requests owned by a channel. One-time assignment of existing global rows (operator UI, never guessed). |
| 12.5 | CLI operator mode: without a token the CLI runs as operator only when the new Settings toggle "Operator CLI access" is on (default **off**). Otherwise a shell-capable agent could bypass the wall simply by omitting its token. **Impact:** while the toggle is off, the owner's own operator-only CLI commands (e.g. `asset register --referenceKind local_path`, `auth login`) stop working until the toggle is switched on. Under D0(a), the CLI's operator mode is also out of an isolated agent's reach at the OS level anyway. |
| 12.6 | Retire self-declared `AGENT_CONNECTION_ID` identity and capability zones in favour of tokens (decision D4). A subtractive change, so it needs an ADR. |
| 12.7 | Technical guide `docs/AGENT_ISOLATION_SETUP.md`: run each agent as its own macOS/Windows user, or inside its own sandbox (e.g. Codex writable/readable roots = its channel folder), so it cannot read `data.db`/`auth-context.json`/other channels' folders. It covers the technical configuration only, never operating instructions (`AGENTS.md` §B). Docs, then the independent-review cycle, then the merge request. |

Order: 12.1 → 12.2 → 12.3 are the core wall. 12.4 depends on D1. 12.5–12.7 close the bypasses.

## 4. What this can and cannot guarantee

**Breaking contract change.** Removing identity-switching tools, rejecting `credentialRef`, and
requiring a token change the released agent contract. `AGENT_API_VERSION` gets a **MAJOR** bump
(0.15.0 → 1.0.0) under that constant's own rule. The released Codex setup stops working until the
operator issues it a channel token and updates its launch configuration (and, under D0(a), points
it at the HTTP endpoint). The release notes carry a migration note.

- **In-app (12.1–12.6):** an agent that uses only our MCP/CLI cannot read or change another
  channel's data, by construction.
- **Against an agent with raw filesystem/shell access as the same OS user:** no in-app mechanism
  helps.
  - It can open the database or other channels' folders directly.
  - It can also **steal another agent's token** from that agent's launch configuration (plaintext),
    the same risk class as reading `data.db`. Only 12.7's OS-level isolation closes
  this. The app can *check and warn* (e.g. refuse to start the MCP server in agent mode if the
  app-data directory is readable by the current OS user while not being the operator user) —
  decision D5.

## 5. Open decisions for the owner

- **D0. Transport (§2):** (a) server-hosted HTTP transport plus OS isolation, a real wall
  (recommended); or (b) stdio kept, in-app wall only (stops mistakes, not a hostile agent).
- **D1. Market data.**
  - (A) Fully per-channel: separate watchlists, duplicate collection and quota.
  - (B) **Recommended:** shared collection plus per-channel subscriptions. A competitor/trend is
    collected once; a channel's agent sees only what its channel subscribes to. Channel-own
    conclusions (hypotheses, research requests, notes) are always private.
- **D2. Global operations workspace (§4j):** keep it one shared folder readable by all agents
  (shared, non-channel instructions), or move to per-channel instruction folders only?
- **D3. AI provider connections:** may every channel's agent use every configured AI connection, or
  should each connection be assignable to specific channels?
- **D4. Zones:** with one agent per channel, retire BL-091 capability zones (recommended), or keep them
  inside a channel?
- **D5.** Should the app actively refuse agent mode when it detects the agent can read app-data
  (same OS user), or only document the requirement?

## 6. Acceptance criteria (final for D0(b), written before implementation, `AGENTS.md` §L)

**Enforcement design.** Enforcement happens at choke points, not per handler.
- **One immutable agent scope per process.** An MCP stdio server started with `YTOM_AGENT_TOKEN`,
  or a CLI call with `--agentToken`/`YTOM_AGENT_TOKEN`, validates the token once at the entrypoint
  and freezes a process-wide scope `{ channelId, userId, tokenId }` (new leaf module
  `src/lib/agent-session/`). The Next.js web process never enters agent scope.
- **In agent scope:**
  - reading the "selected channel" (`db.ts` `getSelectedChannelId`) returns the bound channel for
    any user;
  - writing it (`setSelectedChannelId`) is a silent no-op. It must not error, because `apply` and
    playlist writes save the selection *after* a real YouTube write succeeded;
  - `resolveEffectiveCredentialRef` returns the token's `userId` and rejects an explicit ref;
  - `auth-context.json` is never read or written.

  The existing `assertActiveChannel` checks (in handlers and in cores) and `write-context` then
  enforce the bound channel unchanged.
- **Tool registration.** The `registerTool` wrapper applies a classification table
  (`bound` / `operator-only`). In agent scope, operator-only tools are not registered. Every call
  re-verifies the token hash, so revocation takes effect mid-session.

| ID | Criterion |
|---|---|
| AC-P12-01 | The MCP connection toggle off → zero tools, with or without a token (unchanged owner rule). Toggle on without a valid token → zero tools. With a valid token → only `bound`-classified tools. |
| AC-P12-02 | Revoking a token makes the very next call of an already-running session fail (`AGENT_TOKEN_INVALID`), with no data returned. |
| AC-P12-03 | Session bound to channel A: any tool given channel B's id, or a resource id (video, change set, batch, proposal, asset, hypothesis, experiment, market record) belonging to B, fails. It never returns B's data. |
| AC-P12-04 | In agent scope, `write_channel_select`, `auth_user_select`, `write_channel_list`, the operations-workspace tools and all `auth *` CLI commands are unavailable. `setSelectedChannelId` via `apply`/playlist/`channel_sync` side effects changes nothing in the database. |
| AC-P12-05 | In agent scope, an explicit `credentialRef` / `--userId` / `--accessToken` is rejected. The credential used is always the token's recorded identity. |
| AC-P12-06 | The operator switching the active channel in the Web UI does not change what an agent session is bound to, and the reverse. |
| AC-P12-07 | `channel_sync` in agent scope syncs only the bound channel, and never overwrites another channel's `connected_user_id`. |
| AC-P12-08 | Inventory test: every registered MCP tool and every CLI command is classified. An unclassified one fails the suite. |
| AC-P12-09 | Market records: an agent sees only records assigned to its channel. NULL-channel hypotheses are invisible to agents. Research requests are owned by the channel that created them. |
| AC-P12-10 | CLI without a token: refuses unless the "Operator CLI access" toggle is on (default off). |
| AC-P12-11 | Tokens: stored only as a SHA-256 hash, shown once at issue, never logged, device-local (not in the snapshot or sync). Issuing requires that the channel's recorded identity has a live OAuth channel equal to the bound channel. Issuing again revokes the previous token (one agent = one channel). |
| AC-P12-12 | Capability zones are retired (owner D4, msg 1053): no tool consults them. An ADR records the subtractive change. |
| AC-P12-13 | `AGENT_API_VERSION` = `1.0.0`, and the release notes carry a migration note. |
| AC-P12-14 | OAuth tokens at rest are encrypted (12.8, key variant per the owner's D5 answer). Existing plaintext rows are migrated. Sign-in, refresh and revoke keep working. |

## 7. Owner decisions (Telegram, msg 1051, 2026-09-30)

- **D0 → (b): keep the stdio transport, in-app wall.** Verbatim: *"мне нужно иметь возможность быстро
  сменять каналы. Если будет 10 каналов я не могу заводить 10 учеток на компьютере."* Separate OS
  users per agent are rejected, so the wall protects against agent mistakes and accidental access.
  It does not protect against an agent that deliberately reads `data.db` or another agent's launch
  config. This limit is documented (§4), and D5 adds built-in hardening against accidental reads.
- **D1 → (B): shared collection plus per-channel assignment.** Verbatim: *"общий сбор и потом выдаем
  каждому каналу что нужно ему."* Market records are collected once. The operator assigns them to
  channels, and an agent sees only what is assigned to its channel. Channel-own conclusions stay
  private to the channel.
- **D2 → per-channel folders only.** Verbatim: *"попробуем только папки каналов."* The global
  operations-workspace tools (`agent_list_operations_files`/`agent_get_operations_file`) are removed
  from agent sessions. Each agent's instructions live in its own channel folder (Phase 11), which it
  reads with its own tools. The Settings field itself stays for now, as operator-only data, pending
  a later cleanup.
- **D3 → one agent does everything on its channel, translation included.** Verbatim: *"за перевод
  должен отвечать тот же агент что и за все остальное на канале."* `ai_localization_*` stay available
  to the bound agent for its own channel only. There is no per-channel assignment of AI provider
  connections.
- **D4 → retire zones.** Clarified by the owner (msg 1053): *"один агент отвечает за все на одном
  канале"*. Capability zones are redundant and are retired in 12.6 via an ADR.
- **D5 → yes: build in protection against accidental reads; instructions alone are not enough.**
  Concrete measures, in slice 12.7:
  1. ~~Workspace anchoring~~. **Withdrawn** (msg 1054). The MCP server is launched via `npm run`
     from the app directory, so a working-directory check would test the server's directory, not
     the agent's. It would break legitimate setups without constraining the agent.
  2. **Nothing sensitive leaks through the interface.** Agent-mode responses never contain
     app-data paths, other channels' workspace paths, or `local_path` asset references of other
     channels (already channel-scoped after 12.3).
  3. **Other agents' tokens are never stored in plaintext by the app** (hash only, 12.1). A startup
     warning is logged if the agent's launch configuration file sits inside another channel's
     workspace.
  4. **Accidentally opening the database yields no usable secrets.** Encrypt stored OAuth
     tokens at rest, reusing the existing `ai_connection_credentials` encryption pattern
     (closes RISK-07's plaintext part). This is scoped as its own slice, 12.8, because it touches
     OAuth storage (§F) and needs its own acceptance tests.
