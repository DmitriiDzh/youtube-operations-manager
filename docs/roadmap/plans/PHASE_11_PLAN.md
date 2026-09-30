# Phase 11 — Channel Workspaces: execution plan and acceptance criteria

**Assigned 2026-09-30** by the project owner (Telegram, msg 1036, verbatim): *"Создай новую ветку
для фазы 11. Создай план выполнения и приступай к выполнению в автономном режиме. Я согласую
финальный мердж в дев."* One branch (`feature/phase-11-channel-workspaces`), all slices on it,
one independent-review cycle at the end, one merge-approval request (`AGENTS.md` §K.1/§K.2).

Scope source: `docs/roadmap/FUTURE_PHASES.md` §11 (the resolved, narrowed scope). The
original analysis (`CHANNEL_WORKSPACES_WORKFLOW_RUNTIME_ANALYSIS.md`) is a historical snapshot
only. **Out of scope:** the Workflow Registry (dropped by the owner), any file enumeration or
reading inside a workspace path, and any change to the Global Operations Workspace
(`docs/AGENT_OPERATIONS_INTERFACE.md` §4j), which stays exactly as implemented.

## 1. Design

- **Shared path validation (`src/lib/local-path-validation/`).** Slice I's set-time checks
  (`isPathInsideOrEqual`, `validateWorkspacePath`: the path is absolute, exists, is a directory,
  and does not overlap the app-data directory) are needed by two feature modules now. They move
  into their own shared module (`AGENTS.md` §M). This is a pure move:
  `operations-instructions/services.ts` re-exports the same names, so its existing tests stay
  untouched.
- **Storage.** A new table, `channel_workspaces(device_id, channel_id, path, updated_at)`, with
  `PRIMARY KEY (device_id, channel_id)`. It is added additively as `SCHEMA_MIGRATIONS` v33.
  - **Device-local:** it is not in `SNAPSHOT_TRANSFERRED_TABLES` and not in `sync-gateway`. It
    is explicitly listed in that allowlist's "never listed here" comment block. Rows are keyed
    on this installation's bootstrap `deviceId`, and every read and write filters on the
    current `deviceId`. A row that arrives any other way (for example, a `data.db` copied from
    another machine) is invisible, never silently reused.
- **Domain module `src/lib/channel-workspaces/`** (§6.2 layering):
  - `getWorkspace(channelId)`: returns `{configured:false}` or `{configured:true, path}`.
  - `setWorkspace(channelId, path|null)`: an operator-only write. It validates the
    path through the shared helper and requires `channelId` to be one of this installation's connected
    channels. `null` or `""` clears the value.
  - `listWorkspaces()`: lists workspaces for this installation's connected channels. (Aligned in review round 1. There is no per-user ownership boundary in this app: this is an already-accepted tradeoff, `docs/TECHNICAL_DEBT.md`. The route still requires a session.)
- **Read path never touches the workspace path.** The agent-facing read returns the stored string only.
  There is no `realpath`, `stat` or enumeration call, because "this product's own
  responsibility ends at the path string" (§11). There is deliberately no read-time
  re-validation: this product never opens anything under the path, so a later re-symlink
  changes nothing this product does.
- **Deliberate reversal of slice I's posture, recorded here and in `ARCHITECTURE.md`.**
  `operations-instructions` never exposes its absolute base path (host layout and username
  leak). Phase 11's deliverable *is* the absolute path string, handed to a channel-authorized
  agent. The owner asked for this explicitly. The exposure is limited to the active-channel
  scope and is recorded, not silent (`AGENTS.md` §F).
- **Operator surface.** A dedicated route, `GET`/`PUT /api/channel-workspaces`, rather than
  another field on the monolithic `/api/settings` (§M independence). In the UI, each row on the
  Settings → Channels card gets a self-contained `ChannelWorkspaceField` inside its own error
  boundary. It uses a plain text input and no native dialogs.
- **Agent surface (read-only, never settable by an agent):**
  - The MCP tool `agent_get_channel_workspace {channelId}` and the CLI command
    `agent channel-workspace --channelId <UC...>`. Both follow `agent_get_channel_context`
    exactly: resolve `credentialRef`, then `assertActiveChannel`. They are unzoned, like every
    other read-only `agent_*` tool (`AGENT_ZONES_PLAN.md` §3/§9).
  - A capability entry `channel_workspace.get_channel_workspace` (READ) is added.
  - `AGENT_API_VERSION` changes from 0.14.0 to 0.15.0.

## 2. Slices (one branch, separate commits)

1. Extract `local-path-validation` (pure move plus re-export).
2. Schema v33, the `channel-workspaces` module, and the snapshot-exclusion comment and test.
3. The operator API route and the Settings UI field.
4. The agent MCP tool, CLI command, capability entry and version bump.
5. Documentation (`AGENT_OPERATIONS_INTERFACE.md` §4m, `interfaces.md`, `SYSTEM_MAP.md`,
   `ARCHITECTURE.md`, `FUTURE_PHASES.md` §11/§12, `ROADMAP_STATUS.md`, `BACKLOG.md`), then the
   independent-review cycle, then the merge-approval request.

## 3. Acceptance criteria

These criteria were written before implementation and derived from §11's Deliverable and
Constraints (`AGENTS.md` §L). The expected values are stated here and not taken from the
implementation's output.

| ID | Criterion |
|---|---|
| AC-P11-01 | Setting an absolute, existing directory path for a connected channel persists it. A subsequent read returns exactly that string. |
| AC-P11-02 | Set-time rejection, with nothing saved: a relative path, a nonexistent path, a regular file, a path equal to the app-data directory, a path inside it, or an ancestor of it. |
| AC-P11-03 | Setting a path for a `channelId` that is not one of this installation's connected channels is rejected (not-found class). Nothing is saved. |
| AC-P11-04 | Clearing (`null` or `""`) removes the value. The read then returns `{configured:false}`. |
| AC-P11-05 | Per-channel isolation: setting or clearing channel A never changes channel B's value. |
| AC-P11-06 | Device-local: a row stored under another `deviceId` is invisible to reads and to listing. `channel_workspaces` is not in `SNAPSHOT_TRANSFERRED_TABLES`. |
| AC-P11-07 | Agent read for the active channel returns `{configured:true, path}` with the stored string unchanged. For an unconfigured channel it returns `{configured:false}`, never an empty-string path. |
| AC-P11-08 | Agent read for a channel that is not the caller's active channel fails with the same active-channel error as `agent_get_channel_context`. No path is returned. |
| AC-P11-09 | The agent read performs no access at or under the workspace path. After the directory is deleted, the read still returns the stored string, because the service has no path-validation or directory dependency. The read also never creates the bootstrap `deviceId` (added in review round 1). |
| AC-P11-10 | No agent surface can set or clear the path. The MCP tool list contains only the get tool for this feature, the get tool's input schema is `.strict()` (an extra `path` field is rejected), and no `agent` CLI command writes it. |
| AC-P11-11 | `agent_get_capabilities` lists `channel_workspace.get_channel_workspace` with READ permission. `AGENT_API_VERSION` is `0.15.0`. |
| AC-P11-12 | The Global Operations Workspace is unchanged: the existing `operations-instructions` tests pass without modification. |
| AC-P11-13 | An unauthenticated `GET` or `PUT /api/channel-workspaces` returns 401. |
| AC-P11-14 | Module independence: a failing workspace field (for example, its API erroring) does not break the rest of the Channels card, including channel listing, Activate and Disconnect. This is verified manually in the running app. |
