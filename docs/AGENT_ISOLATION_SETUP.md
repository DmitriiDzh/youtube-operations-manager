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

**Same token on another device (BL-130, ADR 0024).** On the other device, connect the same channel
first, then Settings → Channels → the channel's row → **Use an existing token** and paste the token.
The agent configuration stays identical on both devices. A token carries its channel
(`ytom_ch_<channelId>.…`) and can only be imported into that channel; tokens issued before this
format must be reissued first. **Revoke and Rotate act only on the device where you press them** —
revoke a leaked token on every device where it was entered (`docs/TECHNICAL_DEBT.md` RISK-108). The
MCP connection switch is also per device.

The token is tied to the channel's Google identity as it is at issue time. **Disconnecting the
channel, or reconnecting it with a different Google account, invalidates the token immediately**
(disconnecting also revokes it). Issue a new one afterwards.

## 3. MCP client configuration

The app must be running. It serves MCP at `POST http://127.0.0.1:<port>/api/mcp` (port 3000 with the
launchers), on this computer only (the web server binds `127.0.0.1`; requests whose `Host`/`Origin` is
not loopback are refused). The token is sent as `Authorization: Bearer ytom_ch_…`. Settings → AI Agent
shows the exact URL and ready-to-copy commands.

Codex. Use **one server entry and one environment variable per channel**: Codex reads
`bearer_token_env_var` from its own process environment, so a single shared variable (for example one
set globally) would give every Codex instance the same token, hence the same channel. Put the entry in
a **project-level `.codex/config.toml` inside that channel's own folder** (Codex gives the closest project
file precedence) and set the variable only in that agent's launch environment:

```toml
[mcp_servers.ytom]
url = "http://127.0.0.1:3000/api/mcp"
bearer_token_env_var = "YTOM_TOKEN_CHANNEL_A"
```

Codex also supports static `http_headers` and `env_http_headers` for a server entry, which are
alternatives to `bearer_token_env_var` (the endpoint only needs `Authorization: Bearer <token>`).

Claude Code: `claude mcp add --transport http ytom-channel-a http://127.0.0.1:3000/api/mcp --header "Authorization: Bearer ytom_ch_…"`.

Each agent (and therefore each channel) gets its own server entry and its own token.
`AGENT_CONNECTION_ID` is no longer used (`docs/decisions/0011-retire-agent-capability-zones.md`).

**Migrating from the stdio setup (`AGENT_API_VERSION` 2.0.0).** Remove the old `npm run
mcp:video-metadata` entry and its `cwd`, and add the URL entry above. `YTOM_AGENT_TOKEN` is only the
name of an environment variable of the agent's own client, and the examples now use one per channel.
The CLI rejects `--agentToken` and does not read that variable.

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

## 6. The Factory Operator token (ADR 0022)

The Factory Operator is a second agent role with its own token (`ytom_fo_...`, Settings -> AI Agent) and its own endpoint (`/api/mcp/factory`). It reads the logical path
registry, the capabilities and the list of channels with their workspace paths, and since ADR 0025 it can also **pull and delete models on the RunPod volume and sync
the template registry** -- without an approval click (each action is audited with its actor; RISK-109). Since ADR 0026 it can also start GPU
sessions and run jobs in them, approved by itself ONLY within the owner's factory limits (switch off by default); above them its start waits for
the owner. It sees and stops only the sessions it started, and it has no channel binding. The same advice as in §5 applies to it: keep its launch
configuration (which holds its token) outside every channel agent's folder, and never put a channel token and the factory token in one configuration. The two tokens are not
interchangeable: each endpoint rejects the other's token. The same factory token can be entered on another device with **Use an existing token** in its
card; as with channel tokens, revoking applies only to the device where you revoke it.
