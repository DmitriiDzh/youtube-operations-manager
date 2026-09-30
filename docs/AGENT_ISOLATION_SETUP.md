# Connecting an agent to one channel: technical setup

Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md`). This document is the **technical** configuration
of an MCP/CLI client against this product's released interface: tokens, environment variables and
launch settings. It deliberately contains no operating, editorial or channel-strategy instructions
for any agent (`AGENTS.md` §B). Those live in each channel's own workspace folder, outside this
repository.

## 1. Model

- **One agent = one channel.** An agent is bound to exactly one channel by that channel's agent
  token, and it can read and change only that channel's data through this product.
- **No token means no access.** An MCP server started without a valid token exposes no tools. A
  CLI call without a token is refused unless the operator has turned on "Operator CLI access".
- **The "MCP connection" toggle** (Settings → AI Agent) stays the master switch, for the MCP
  server and for a token-bound CLI alike. While it is off, no agent gets anything, token or not.

## 2. Issuing a token

1. Settings → Channels → the channel's row → **Agent token → Issue token**.
2. Copy the token (`ytom_ch_…`) immediately. It is shown only once and stored only as a hash.
3. **Rotate** issues a new token and invalidates the old one at once. **Revoke** invalidates it
   without issuing a new one. A running agent's next call then fails with `AGENT_TOKEN_INVALID`.

The token is tied to the channel's Google identity as it is at issue time. **Disconnecting the
channel, or reconnecting it with a different Google account, invalidates the token immediately**
(disconnecting also revokes it). Issue a new one afterwards.

## 3. MCP client configuration

Launch the server exactly as before (`npm run mcp:video-metadata` from the application directory).
Add the token to the client's environment for that server entry, for example:

```json
{
  "mcpServers": {
    "youtube-manager-channel-a": {
      "command": "npm",
      "args": ["run", "mcp:video-metadata"],
      "cwd": "/path/to/application",
      "env": { "YTOM_AGENT_TOKEN": "ytom_ch_…" }
    }
  }
}
```

Each agent (and therefore each channel) gets its own server entry and its own token.
`AGENT_CONNECTION_ID` is no longer used (`docs/decisions/0011-retire-agent-capability-zones.md`).

CLI: `YTOM_AGENT_TOKEN=ytom_ch_… npm run cli:video-metadata -- agent channel-context --channelId <UC…>`,
or pass `--agentToken ytom_ch_…`.

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
- read another agent's MCP launch configuration, including its token.

Recommended, per agent, where the agent client supports it:
- run the agent with its **working directory set to its own channel folder**;
- enable the client's own sandbox / filesystem restriction (for example, a workspace-write or
  read-restricted mode) so its file tools cannot reach the application data directory or other
  channels' folders;
- keep each agent's launch configuration (which holds its token) outside the other channels'
  folders.
