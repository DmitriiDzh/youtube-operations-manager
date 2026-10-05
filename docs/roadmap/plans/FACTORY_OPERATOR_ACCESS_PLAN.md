# Factory Operator access: logical path registry + separate agent role — plan

**Status: IMPLEMENTED (slices F1-F5) on `feature/factory-operator-access`; plan approved by the owner 2026-10-05; merged into `dev` in `ada77c5` (owner approval 2026-10-05); not released.** Backlog item: BL-129. Branch: `feature/factory-operator-access`
(all slices on one branch, one merge-approval request, `AGENTS.md` §K.1/§K.2). Safety-critical per §L
(agent isolation, token handling), so the full §A reading list applies.

**Sources.**
- Requests from the Factory Operator role: `FO-MSG-0001`, `FO-REQ-0001` (status APPROVED by the owner, 2026-10-05) in the
  Developer Exchange folder; my reply `DEV-RESP-0001`.
- Owner decisions (Telegram, 2026-10-05):
  - **a.** Each machine configures only its own values (no editing or syncing of other machines' values).
  - **c.** The Factory Operator needs MCP access, but **must not** have the read access or commands of the per-channel agents.
    Per-channel agents in turn must not get any function reserved for the Factory Operator.
  - Proposal accepted: two token types, three tool classes; the Factory Operator reads only the registry of logical paths,
    capabilities, and the list of connected channels with their workspace paths; `factory_shared` is visible to every agent,
    `developer_exchange` only to the Factory Operator.

## 1. What exists today (inventory, `dev` at `82c3139`)

- **Machine identity:** the bootstrap-config `deviceId` (`src/lib/channel-workspaces/`).
- **The same shape already shipped (Phase 11):** `channel_workspaces(device_id, channel_id, path)`; operator-write through
  `/api/channel-workspaces`, agent read-only, explicit `configured:false`, path validated once at set time, device-local
  (not in `SNAPSHOT_TRANSFERRED_TABLES`). The logical path registry is the same pattern keyed by a global name instead of `channelId`.
- **Agent access today:** one endpoint, `/api/mcp` (loopback only, stateless Streamable HTTP, ADR 0013). Bearer token
  `ytom_ch_…` (`agent_channel_tokens`, hash only) = identity + channel binding. `MCP_TOOL_CLASSIFICATION` has two classes
  (`bound`, `operator-only`); an unclassified tool fails construction and the inventory test. The master "MCP connection"
  toggle applies to every request.
- **Not available:** any agent identity that is not channel-bound; any name-keyed path; any cross-channel agent view
  (deliberately, Phase 12).

## 2. Design

### 2.1 Separate role, separate endpoint, separate server (not a flag on the existing one)

A Factory Operator session is **not** a special case of a channel session. It uses its own endpoint, token table, and MCP
server factory, so there is no code path in which a missing check turns a channel agent into a Factory Operator or the reverse.

| | Channel agent (existing) | Factory Operator (new) |
|---|---|---|
| Endpoint | `/api/mcp` | `/api/mcp/factory` |
| Token | `ytom_ch_…`, table `agent_channel_tokens` | `ytom_fo_…`, new table `factory_agent_tokens` |
| Binding | one channel + its Google identity | none (no channel, no Google identity, no credentials) |
| Server | `createMcpServer` (`bound` tools) | new `createFactoryMcpServer`, only the tools in §2.4 |
| Agent scope | `runInAgentSession` (channel scope) | **never entered**; no channel-scope state is read |

- A `ytom_ch_` token sent to the factory endpoint is rejected, and a `ytom_fo_` token sent to `/api/mcp` is rejected
  (prefix check first, then the hash lookup in that endpoint's own table only). Both get `AGENT_TOKEN_INVALID`.
- Common safety unchanged: loopback only; the master MCP-connection toggle (owner rule, 2026-09-21); token stored only as
  SHA-256; shown once; re-verified on every tool call (revocation lands mid-session); device-local, never synced or in the snapshot.
- One active factory token at a time. Issuing a new one revokes the previous one. The operator issues and revokes it in
  Settings (card next to the existing MCP connection toggle). Revoking it does not touch channel tokens.

### 2.2 Logical path registry (module `src/lib/logical-paths/`, contracts/schemas/services/adapters)

- **Tables (additive migrations; the next free `SCHEMA_MIGRATIONS` version at implementation time, currently v50+):**
  - `logical_paths(name PRIMARY KEY, audience, description, created_at)`; `name` matches `^[a-z][a-z0-9_]{1,63}$`;
    `audience` is `all_agents` or `factory_only`.
  - `logical_path_values(device_id, name, path, updated_at)`, `PRIMARY KEY (device_id, name)`.
  - The migration seeds only the two initial **names** (no values): `factory_shared` = `all_agents`, `developer_exchange` = `factory_only`.
  - New paths later are rows, so no schema change (FO-REQ-0001 AC-4). Both tables are device-local: not in
    `SNAPSHOT_TRANSFERRED_TABLES`, not in sync-gateway (comment + test, like `channel_workspaces`). Every read filters on this device's `deviceId`.
- **Operator surface:** `GET/PUT/POST/DELETE /api/logical-paths` (session required, 401 otherwise) and a Settings section,
  in its own error boundary (§M independence): create a path (name, audience, description), set or clear **this device's**
  value, see on this device whether the path exists. Validation at set time reuses `src/lib/local-path-validation/` (absolute,
  exists, directory, no overlap with app-data). The "exists / missing" indicator is computed by the operator route only,
  never by an agent read.
- **Agent read never touches the filesystem and never creates a `deviceId`** (same rule as AC-P11-09). It returns the stored string.

### 2.3 Channel-agent tools (bound class, additive)

`agent_list_logical_paths`, `agent_get_logical_path {name}`: expose **only `all_agents` paths**. A `factory_only` or unknown name
returns the same `LOGICAL_PATH_NOT_FOUND` as a missing one (not distinguishable). Read-only; no tool can create or set a path.

### 2.4 Factory Operator tools (the complete, explicit allowlist)

| Tool | Returns |
|---|---|
| `factory_get_capabilities` | factory API version, tools actually callable, this token's permissions (READ only) |
| `factory_list_logical_paths` | all paths, with `configured: true/false` for this device and the stored string when configured |
| `factory_get_logical_path {name}` | the string for this device, or an **explicit error** `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE` (never an empty path); unknown name → `LOGICAL_PATH_NOT_FOUND` |
| `factory_list_channels` | for each connected channel: `channelId`, title, this device's workspace path or `configured:false`. No tokens, user ids, video data, analytics, or credentials. |

Everything else is absent from the factory server: YouTube reads/writes, analytics, change sets, batches, playlists, market data,
proposals, hypotheses, operations files, `write_*`/`auth_*`. Read-only throughout: the Factory Operator cannot set a path or a
workspace, change any channel's data, or reach a channel's Google credentials. Manifests of production pipelines stay files in the
channel folders, read by the role with its own filesystem tools (YT Manager never reads inside a path).

### 2.5 Mechanical enforcement (inventory tests, same style as the write-gateway inventory)

1. The factory server's registered tool names equal the §2.4 list exactly (a new name fails the suite).
2. No factory tool name appears in `MCP_TOOL_CLASSIFICATION` as `bound` (channel sessions can never be offered one), and no
   channel `bound` tool is registered by the factory server.
3. `factory-server.ts` and the factory handlers may import only an allowlisted set of modules (`logical-paths`,
   `channel-workspaces`, `factory-agent-tokens`, channel-connection read, shared-domain); importing `youtube-*-gateway`, `auth`,
   `analytics`, `batches`, `changesets` etc. fails the suite.
4. The factory server never enters or reads channel agent scope (`agent-session`); a test runs every factory tool with the
   operator's selected channel set to channel A and asserts the output is independent of it.

## 3. Slices (one branch, separate commits; the owner's rule of one merge per phase applies)

| Slice | Content |
|---|---|
| F1 | `logical-paths` module, tables + seed migration, snapshot-exclusion comment and test, operator route + Settings section. |
| F2 | `factory-agent-tokens` module (table, hash-only store, issue/revoke/verify), operator route + Settings card. |
| F3 | `/api/mcp/factory` endpoint (loopback, toggle, prefix + hash check, per-call re-verify), `createFactoryMcpServer` with the §2.4 tools, inventory tests §2.5. |
| F4 | Channel-agent tools §2.3, classification entries, capability entries, `AGENT_API_VERSION` 3.2.0 → 3.3.0 (additive, MINOR). |
| F5 | ADR 0022 (second agent role and its isolation), docs per `DEVELOPMENT_PLAYBOOK.md` §6.12 (`SYSTEM_MAP`, `ARCHITECTURE`, `AGENT_OPERATIONS_INTERFACE`, a technical contract section for the factory endpoint: tools, schemas, error codes, versioning), independent review cycle, then the merge-approval request. |

The factory-endpoint documentation is a technical contract only. It contains no channel editorial guidance and no operating
instructions for the Factory Operator (`AGENTS.md` §B).

## 4. Acceptance criteria (written before implementation from the requirement, `AGENTS.md` §L)

| ID | Criterion |
|---|---|
| AC-FO-01 | A path defined by the operator with a value stored under `deviceId` X is returned to a factory agent on device X and is **not** returned on device Y (a row under another `deviceId` is invisible). Windows and macOS values for the same name are each seen only on their own machine. |
| AC-FO-02 | `factory_get_logical_path` for a defined name with no value on this device returns the explicit error `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE`; no result contains an empty-string path. |
| AC-FO-03 | Adding a third logical path through the operator UI/route works with no migration (the table schema version is unchanged). |
| AC-FO-04 | Set-time rejection, nothing saved: relative path, nonexistent path, a regular file, a path equal to, inside, or an ancestor of app-data; a name not matching the pattern; a duplicate name. |
| AC-FO-05 | A channel agent's `agent_get_logical_path("developer_exchange")` and `("no_such_name")` fail with the identical error; `agent_get_logical_path("factory_shared")` returns the stored string; `agent_list_logical_paths` lists only `all_agents` paths. |
| AC-FO-06 | A `ytom_ch_` token on `/api/mcp/factory` → 401 `AGENT_TOKEN_INVALID`; a `ytom_fo_` token on `/api/mcp` → 401. Missing token → 401; MCP toggle off → 403; non-loopback → 403; revoked token fails the very next call of a running session. |
| AC-FO-07 | The factory server's tool list equals exactly {`factory_get_capabilities`, `factory_list_logical_paths`, `factory_get_logical_path`, `factory_list_channels`}. No channel `bound` tool is reachable, and no factory tool is registered in a channel session (§2.5 tests 1–3). |
| AC-FO-08 | `factory_list_channels` output contains no user id, token, hash, credential, email, or video/analytics data (the fields are asserted against the exact allowed key set). Output is independent of the operator's selected channel (§2.5 test 4). |
| AC-FO-09 | No agent surface (either endpoint) can create/modify/delete a logical path or value, issue/revoke any token, or set a workspace path. The input schemas are `.strict()` and a mechanical test checks no such tool exists. |
| AC-FO-10 | Factory tokens: stored only as SHA-256, shown once, never logged, not in the snapshot/sync/handoff; issuing a new token revokes the previous; revoking a factory token leaves channel tokens working, and the reverse. **Amended 2026-10-05 (BL-130, ADR 0024, owner msg 1577):** the token may also be registered on a device by operator import; an import also revokes the previous one. |
| AC-FO-11 | The agent read path performs no filesystem access under a stored path (deleting the directory afterwards leaves the stored string returned) and never creates the bootstrap `deviceId`. |
| AC-FO-12 | Unauthenticated `GET/PUT/POST/DELETE /api/logical-paths` and the factory-token routes return 401. A failing logical-paths Settings section does not break the rest of the Settings tab (manual check in the running app). |
| AC-FO-13 | `AGENT_API_VERSION` is `3.3.0`; the factory API has its own version constant `1.0.0` and its tools appear in no channel agent's `agent_get_capabilities`. |
| AC-FO-14 | Existing behavior unchanged: the full existing suite (including the Phase 12 inventory and isolation tests) passes without modification. |

## 5. What this does and does not guarantee

- **In-app:** a channel agent cannot see or call anything of the Factory Operator, and the Factory Operator cannot read channel
  data or credentials, by construction and by test.
- **Same limit as Phase 12:** an agent that has raw filesystem access as the same OS user can read `data.db` or another role's
  token from its launch configuration. Tokens are hash-only in the database, but a plaintext token in a client's config
  file is outside this app's control; see `docs/AGENT_ISOLATION_SETUP.md`.
- **Paths are strings only.** The registry grants no file access, and the app never opens, lists, or reads inside a path.

## 6. Open points (do not block the plan; decided inside the slice unless the owner objects)

1. Where the Factory Operator card lives in Settings (proposal: next to the MCP connection toggle).
2. `factory_list_channels` title source: the already-synced local channel row; a channel never synced shows no title.
3. Whether `factory_*` calls count in the existing `mcp_tool_calls` traffic stat (proposal: yes, same counter).

## 7. Out of scope

Editing or syncing other machines' values (owner decision a); any write tool for the Factory Operator; a server-side
per-channel manifest/document store (needs its own requirement and approval); channel-side fallback logic
(`FACTORY_SHARED` environment variable is the Factory Operator's own concern); any operating instruction for either role.
