# Connecting an agent to one channel: technical setup

Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md`). This document is the **technical** configuration
of an MCP/CLI client against this product's released interface: tokens, environment variables and
launch settings. It deliberately contains no operating, editorial or channel-strategy instructions
for any agent (`AGENTS.md` §B). Those live in each channel's own workspace folder, outside this
repository.

## 1. Model

- **One agent = one channel.** An agent is bound to exactly one channel by that channel's agent
  token, and it can read and change only that channel's data through this product.
- **No token means no access.** The app's MCP endpoint answers a request without a valid token with
  an explicit `401` (`AGENT_TOKEN_REQUIRED` / `AGENT_TOKEN_INVALID`) and shows no tools.
- **The "MCP connection" toggle** (Settings → AI Agent) stays the master switch. While it is off the
  endpoint answers `403` (`MCP_CONNECTION_DISABLED`) to everyone, token or not. It applies to the very
  next request, with no client restart.
- **The agent never needs the project path.** The app serves MCP itself
  (`docs/decisions/0013-in-app-http-mcp-transport.md`); the agent's configuration holds only a URL and
  its token. The CLI has no agent mode any more: it is the operator's tool.

## 2. Issuing a token

1. Settings → Channels → the channel's row → **Agent token → Issue token**.
2. Copy the token (`ytom_ch_…`) immediately. It is shown only once and stored only as a hash.
3. **Rotate** issues a new token and invalidates the old one at once. **Revoke** invalidates it
   without issuing a new one. A running agent's next call then fails with `AGENT_TOKEN_INVALID`.

The token is tied to the channel's Google identity as it is at issue time. **Disconnecting the
channel, or reconnecting it with a different Google account, invalidates the token immediately**
(disconnecting also revokes it). Issue a new one afterwards.

## 3. MCP client configuration

The app must be running. It serves MCP at `POST http://127.0.0.1:<port>/api/mcp` (port 3000 with the
launchers), on this computer only (the web server binds `127.0.0.1`; requests whose `Host`/`Origin` is
not loopback are refused). The token is sent as `Authorization: Bearer ytom_ch_…`. Settings → AI Agent
shows the exact URL and ready-to-copy commands.

Codex (`~/.codex/config.toml`, or `codex mcp add ytom --url … --bearer-token-env-var YTOM_AGENT_TOKEN`):

```toml
[mcp_servers.ytom_channel_a]
url = "http://127.0.0.1:3000/api/mcp"
bearer_token_env_var = "YTOM_AGENT_TOKEN"
```

Claude Code: `claude mcp add --transport http ytom-channel-a http://127.0.0.1:3000/api/mcp --header "Authorization: Bearer ytom_ch_…"`.

Each agent (and therefore each channel) gets its own server entry and its own token.
`AGENT_CONNECTION_ID` is no longer used (`docs/decisions/0011-retire-agent-capability-zones.md`).

**Migrating from the stdio setup (`AGENT_API_VERSION` 2.0.0).** Remove the old `npm run
mcp:video-metadata` entry and its `cwd`, and add the URL entry above. `YTOM_AGENT_TOKEN` is only the
name of an environment variable of the agent's own client. The CLI rejects `--agentToken` and does not
read that variable.

## 4. The channel's working folder

The operator sets each channel's production-workspace folder in Settings → Channels (Phase 11).
The agent reads its path with `agent_get_channel_workspace`, keeps its own working copies and
instructions there, and works from there. This product never reads or writes that folder.

## 5. Limits, and recommended hardening

The owner chose the in-app wall (decision D0(b), so that switching channels stays fast, without
separate OS accounts). Within this product's interface the wall is complete. However, an agent
running as the **same OS user** as the operator can still, with its own file tools:
- open the application's database (`~/Library/Application Support/YouTubeOperationsManager/`
  on macOS, `%APPDATA%\YouTubeOperationsManager\` on Windows);
- open another channel's working folder;
- read another agent's MCP client configuration, including its token.

Recommended, per agent, where the agent client supports it:
- run the agent with its **working directory set to its own channel folder**;
- enable the client's own sandbox / filesystem restriction (for example, a workspace-write or
  read-restricted mode) so its file tools cannot reach the application data directory or other
  channels' folders;
- keep each agent's launch configuration (which holds its token) outside the other channels'
  folders.
