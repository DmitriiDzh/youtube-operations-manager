> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 20. Channel Workspaces (`src/lib/channel-workspaces/`) — Phase 11, in `dev` (`f15a8c3`)

Scope comes from `docs/roadmap/FUTURE_PHASES.md` §11. The plan and acceptance criteria
(AC-P11-01..14) are in `docs/roadmap/plans/PHASE_11_PLAN.md`. The agent-facing contract is in
`docs/AGENT_OPERATIONS_INTERFACE.md` §4m.

**What it is.** One operator-set absolute local path per (device, linked channel): that
channel's production-workspace folder on this machine. This product's responsibility ends at
the path string. It never enumerates, reads, writes, or validates anything inside the folder.
The operational agent uses its own native filesystem tools. There is therefore no file-access
surface on this side to secure. Validation of the path itself happens once, at set time.

**Exception (BL-119, ADR 0019):** `src/lib/research-export/` (a separate module; this one keeps its contract) writes generated files into the fixed `99 Data Exchange/From YTM` subfolder of this path (owner-approved exception, 2026-10-04) when the agent asks for a research export — it re-validates the path, refuses a symlinked `exports`, names every file itself, and deletes its own expired files by ledger (`workspace_export_files`). Nothing else under the path is opened.

**Data flow.**
- *Operator writes.* Settings → Channels row → `ChannelWorkspaceField` → `PUT /api/channel-workspaces`
  → `setWorkspace`. That call checks, in order:
  1. The channel is one of `channel-connections`' connected channels.
  2. `local-path-validation` passes: the path is absolute, exists, is a directory, and does not
     overlap app-data in either direction (the RISK-07 reasoning from slice I).
  3. Only then does it upsert `channel_workspaces`.
- *Agent reads.* MCP `agent_get_channel_workspace` or CLI `agent channel-workspace` → identity
  resolution + `assertActiveChannel` → `getWorkspace`. The read is a store lookup that never
  touches anything at or under the workspace path (no path-validation or directory dependency is
  injected into it). The only other file it touches is this app's own `bootstrap-config.json`,
  read for the `deviceId`, and only ever read: with no config yet the answer is
  `{ configured: false }`. Only the operator write may create it (review round 1).
  Creating the file is now exclusive: `bootstrap-config`'s `ensureExists` writes a temp file and
  hard-links it into place, and if another caller wins the race it reads the winner's file
  instead (review round 2). Before this, two concurrent first calls could produce two different
  `deviceId`s, which would orphan a just-saved workspace row. On a filesystem without hard-link support it
  falls back to the previous rename-based creation. Temp-file cleanup is best-effort (review
  round 3). No agent surface receives
  `setWorkspace`: the MCP and CLI factories take a `Pick<…, "getWorkspace">`.

**Storage and device-locality.** `channel_workspaces(device_id, channel_id, path, updated_at)`,
primary key `(device_id, channel_id)`, SCHEMA_MIGRATIONS v33 (additive).
- §11 requires the value to be "device-local, never synced, keyed on this app's existing
  `deviceId`". So every read and write filters on the bootstrap `deviceId`. A row that arrives
  by some path other than this device's own writes (for example, a `data.db` copied between
  machines) is invisible rather than silently reused.
- The table is deliberately absent from `SNAPSHOT_TRANSFERRED_TABLES` (the reasoning is in the
  "never listed" block of `snapshot/contracts.ts`) and from `sync-gateway`.
- A snapshot-import test proves the receiving device's own rows survive untouched.
- Note: `cloud_connection` has no device column. It is device-local only through snapshot
  exclusion, so it is not the precedent for the `deviceId` key. §11's own wording is.

**Security posture: a deliberate reversal from slice I.** `operations-instructions` (§4j) never
exposes its configured absolute base path to the agent, because that would leak host layout and
the username. Phase 11's deliverable is exactly that absolute string. The owner requested it
explicitly in §11. The exposure is bounded:
- Only to an agent whose `channelId` is the caller's active channel.
- Only the one string the operator chose.
- Never any directory contents.

It is recorded here rather than carried silently (`AGENTS.md` §F).

**Module independence (`AGENTS.md` §M).**
- The set-time check lives in the shared `src/lib/local-path-validation/`, moved verbatim from
  `operations-instructions`, which re-exports it unchanged.
- MCP and CLI take `channelWorkspacesCore` directly rather than through `agent-operations`,
  the same pattern as market-intelligence and decision-engine.
- The UI field sits in its own error boundary inside each channel row.

**Deliberately not implemented.**
- The Workflow Registry (dropped by the owner).
- Any read-time re-validation. It would be meaningless, because nothing here ever opens the path.
- Cleanup of a row when its channel is disconnected. The row stays, is hidden from the Settings
  list, and reappears if the channel is reconnected.
