> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 17. Agent Operations Interface (`src/lib/agent-operations/`) — Phase 7, in progress, not yet in `dev`

Owner instruction, Telegram 2026-09-23: a full 34-section spec ("Phase 7 — Agent Operations
Interface for Codex") authorizing design and incremental implementation of a versioned interface
external operational agents consume, without per-slice approval (only the final `dev` merge needs
explicit sign-off). **The full technical design, permission model, error vocabulary, and
per-slice implementation status live exclusively in `docs/AGENT_OPERATIONS_INTERFACE.md` §7's
status table -- this heading deliberately never names which slice is implemented**, so it never
needs updating as slices land; consult §7 of that document instead, every time.

In one sentence: this application remains the sole source of truth for owned-channel data,
analytics, and the write-safety pipeline; the agent is a reasoning/proposal layer that must
re-request context rather than cache a private copy, and can only ever hold `READ`+`DRAFT`
permissions (never `APPROVE`/`EXECUTE`) until a future, separate, explicit owner decision widens
that. This phase's planned scope spans contracts/capability-discovery, channel/video context, an
analytics wrapper, a new creative-asset catalog, draft provenance, bulk-localization integration,
content-proposal/artifact registration, a Codex operations-workspace template, and independent
review -- **which of these is actually implemented as of any given moment is tracked exclusively
in `docs/AGENT_OPERATIONS_INTERFACE.md` §7's status table, never restated here**.

## 21. Channel-bound agent isolation — Phase 12, in `dev` (`7a57a48`)

Plan, the inventory of holes it closes, the owner decisions (D0–D5) and the acceptance criteria:
`docs/roadmap/plans/PHASE_12_PLAN.md`. Interface contract: `docs/AGENT_OPERATIONS_INTERFACE.md`
§4n.

**Why choke points.** Before this phase, channel scoping rested on one mutable column,
`users.selected_channel_id`, shared by the Web UI and every agent. Agents could repoint it
(`write_channel_select`) or sidestep it with a caller-supplied `credentialRef`. Instead of adding a
check to each of 57 MCP tools and roughly 70 CLI commands, a per-request immutable scope
(`src/lib/agent-session`, an AsyncLocalStorage leaf; process-wide before ADR 0013) is consulted at the two functions every path already
funnels through:
- `db.ts`'s `getSelectedChannelId` / `setSelectedChannelId`: the bound channel, and a no-op
  write. The no-op is not an error, because `apply` and playlist writes persist the selection
  *after* a successful YouTube write.
- `cli-auth`'s `resolveEffectiveCredentialRef`: always the token's identity, and explicit refs
  rejected.

Every pre-existing `assertActiveChannel` and write-context identity check then enforces the
binding without modification. The few reads that never called `assertActiveChannel` (`list`,
`transcript`, `preview`, `channel_sync`'s explicit id) are wrapped once in their core wiring.

**Identity.** A channel token (`src/lib/agent-tokens`) is the only agent identity.
- It is a SHA-256 hash with the `ytom_ch_` prefix, stored device-locally. Since BL-130 (ADR 0024) the plaintext is
  `ytom_ch_<channelId>.<secret>`; verification also requires the embedded id to equal the row's channel (legacy tokens
  without it still verify). The operator can register an already-issued token on another device (`importToken`, same
  identity check as issuing, only into the embedded channel). Since BL-160 (ADR 0033, §34) tokens and revocations also reach every
  device through the `agent-tokens` sync family, so a revocation is no longer per device (RISK-108 resolved).
- It records the Google identity that owned the channel live at issue time; credentials come
  from there, never from `channels.connected_user_id`.
- The token is verified once at process entry, which enters the scope, and re-verified on every
  MCP call so revocation is immediate.
- BL-091 zones and `AGENT_CONNECTION_ID` are retired (ADR 0011). The tables stay, inert.

**Market data (D1).** Phase 9 data stays global and unaware of channels. `src/lib/market-assignments`
(table `channel_record_assignments`, v35, part of the snapshot) maps records to channels, and the
MCP/CLI market handlers narrow results for agents. Its `db.ts` exports avoid the words
"market"/"research" so PHASE9-INV-02 continues to guarantee that no other module reaches into
market-intelligence's own tables.

**Surface.** `src/mcp/tool-classification.ts` classifies every MCP tool as `bound` or
`operator-only`; an inventory test compares it with `server.ts`'s `registerTool` names. The CLI no
longer has an agent mode: it is the operator's tool and runs only under the "Operator CLI access"
setting (default off).

**Transport (`docs/decisions/0013-in-app-http-mcp-transport.md`, reverses D0(b)).** The running app
serves MCP at `POST /api/mcp` (`src/lib/agent-mcp-endpoint`, a thin route over it): stateless
Streamable HTTP, a fresh `McpServer` per request, the "MCP connection" toggle and the channel token
read on every request, a loopback `Host`/`Origin` guard, and the whole web server bound to
`127.0.0.1`. The request runs inside an `AsyncLocalStorage` agent scope (`src/lib/agent-session`);
because "no scope" means operator mode in the web process, every tool call first asserts the ambient
scope equals the request's token. `src/proxy.ts` exempts `/api/mcp` from the device-mutation gate
(every MCP call is a POST); mutating tools keep their own gate.

**Accepted limit (RISK-87).** The agent still runs as the operator's OS user, so the wall is in-app:
an agent that deliberately finds and opens `data.db` can bypass it. What changed is that the agent's
own configuration no longer contains the project path. Mitigations: `docs/AGENT_ISOLATION_SETUP.md`.

**OAuth tokens at rest (12.8, owner chose the "env" key variant).** `db.ts`'s OAuth-token
functions are the only readers and writers of `users.access_token` / `refresh_token`. They route
through `src/lib/oauth-token-crypto`:
- With `OAUTH_TOKENS_ENCRYPTION_KEY` configured, values are stored as
  `enc:v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, `src/lib/shared-crypto`). Legacy plaintext rows
  are re-encrypted on first read.
- Without the key, values are stored as plaintext exactly as before. Sign-in is never blocked.
- A value that cannot be decrypted reads as "no token", so the user signs in again.

This protects against reading the database file alone. It does not protect against an agent that
also reads the key from the environment file.

## 25. Factory Operator access: logical path registry and a second agent role (BL-129, ADR 0022)

The plan and acceptance criteria (AC-FO-01..14) are in `docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md`; the decision is
`docs/decisions/0022-factory-operator-access.md`. Status: in `dev` (`ada77c5`), not released.

**Two independent modules, no shared state.**
- `src/lib/logical-paths/` is a registry of named local paths. `logical_paths(name, audience, description)` is the definition;
  `logical_path_values(device_id, name, path)` is one value per device. Both tables are device-local: they are not in
  `SNAPSHOT_TRANSFERRED_TABLES` and not in sync-gateway, by owner decision (each machine configures only its own values). Reads filter on the bootstrap
  `deviceId`; a read never creates it, never touches the filesystem and returns the stored string exactly as stored. Only the operator routes
  (`/api/logical-paths`, session required) create, set (validated once with `src/lib/local-path-validation`, like Phase 11) or delete.
- `src/lib/factory-agent-tokens/` holds the Factory Operator's token: `ytom_fo_` prefix, SHA-256 hash only, one active row, no channel, no Google identity. It can also be registered by operator import of an already-issued token (BL-130, ADR 0024); since BL-160 (§34) it and its revocation reach every device by themselves.
  It lives in its own table so that a channel token can never be looked up as a factory token or the reverse; the prefix check rejects a foreign
  token before any lookup.

**Two MCP surfaces, never mixed.**
- Channel agents: `POST /api/mcp`, token `ytom_ch_`, `createMcpServer`, `bound` tools inside the channel agent scope (`src/lib/agent-session`).
  Two additive reads were added (`agent_list_logical_paths`, `agent_get_logical_path`); the handler pins the registry to the `channel` scope, so only
  `all_agents` paths are visible and a `factory_only` name fails exactly like an unknown name.
- Factory Operator: `POST /api/mcp/factory`, token `ytom_fo_`, `createFactoryMcpServer` (`src/mcp/factory-server.ts`), a closed list of tools -- four read-only
  ones (ADR 0022) plus, since BL-132 (ADR 0025, Factory API 1.1.0), eight `factory_media_*` tools: storage status, models, pulls and templates (reads) and
  pull / cancel / delete a model and sync templates (writes, pinned by `FACTORY_WRITE_TOOL_NAMES`, audited as actor `factory`, each behind the device mutation
  gate injected as `assertMutationAllowed`; no session or job tool). The
  server file imports only the MCP SDK, zod and shared-domain: everything it can reach arrives through dependencies wired in
  `src/app/api/mcp/factory/route.ts`, which imports only the allowlisted modules (since BL-132 also `media-generation` and `device-mutation-gate`; no YouTube gateway, database access beyond the connection toggle and the traffic
  counter, analytics, change sets, batches). The endpoint never enters the channel agent scope, so it cannot read the operator's selected channel. Its
  channel listing returns channel id, title and this device's workspace path only.
- Shared, unchanged safeguards: loopback guard (extracted to `src/lib/loopback-guard`), the master MCP-connection switch (403 when off, for both
  endpoints), per-call token re-verification (a revocation lands on the next call), traffic counted in `mcp_tool_calls`.
- Revoking the factory token (`DELETE /api/factory-agent-token`) is an operator stop switch: it is exempt from the recovery-mode gate in `src/proxy.ts` like the channel-token revoke, so the role can be cut off exactly when something has gone wrong. The database also allows at most one active factory token (partial unique index, `factory_agent_tokens_one_active_idx`; migration v60 (v51 before the Phase 14 merge) first revokes all but the newest active row if several exist).
- `src/mcp/factory-server.test.ts` is the mechanical boundary: exact tool list, no `factory_*` name in `MCP_TOOL_CLASSIFICATION`, import allowlists, no channel-scope
  identifiers in the factory files.

**Known limit** (`docs/TECHNICAL_DEBT.md` RISK-105): a process running as the same OS user can read the factory token from its client configuration or the
database. The exposure is read-only (path strings, channel titles and workspace paths). The in-app wall does not defend against a hostile same-user process (see
`docs/AGENT_ISOLATION_SETUP.md` §5).

## 34. Agent tokens shared between devices, and the Producer role (BL-160, BL-161, ADR 0033, ADR 0034)

Plan: `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md`. Status: on `feature/producer-role-synced-tokens`, not merged.

**Tokens across devices (BL-160).**
- `src/lib/sync-gateway/agent-tokens` is a per-device report family (the `media-sessions` shape): each device writes only its own report of
  the agent tokens it knows -- `{hash, role, channelId, userId, label, createdAt, revokedAt}`, never the token -- and keeps the peers' latest
  reports. It merges nothing and imports nothing from the token modules; `run-all-families.ts` runs it with the others.
- `src/lib/agent-token-sync` owns the rules (`reconcileAgentTokens`, a pure function) and applies them through `db.ts`
  (`listAgentTokenRowsForSync`, `applyAgentTokenSyncPlan`: one transaction, revocations before inserts so the role tables' one-active
  indexes hold). Rules: joined by hash; revoked anywhere = revoked (earliest time), never undone; a peer record conflicting with a local row's
  role/channel/account is ignored; one active token per slot, newest `createdAt` wins (tie: larger hash), losers revoked at the winner's
  `createdAt`; a token's `createdAt` is the earliest any device reports (local rows re-dated); a peer record dated more than 5 min ahead
  is ignored. Every device computes the same result from the same records. The family's peer reports are never forgotten
  (`forgetAfterMs: null` on the per-device report core) and an unchanged report is republished daily.
- Timing: `src/instrumentation.ts` runs a step after each 60 s family cycle and once 5 s after start (agent-tokens family only); while
  the database is paused (recovery mode, an operation lock) it still exchanges the agent-tokens files, without applying. The three
  token stores call `shareAgentTokenChangeSoon()` after an issue/import/rotate/revoke: a publish-only step (no peer apply, so it also works in
  recovery mode) that pushes the family at once.
- Verification is untouched: each token module reads its own table; a learned channel token still needs the channel connected here under the
  recorded Google account (`users.id` = Google `sub`). The token tables stay out of the snapshot. `POST /api/channel-connections/disconnect`
  no longer revokes the channel's token.
- Trust: the shared folder's reports are unsigned (RISK-117).

**The Producer role (BL-161).**
- Token: `src/lib/role-agent-tokens` is the role-token logic extracted from `factory-agent-tokens` (now a thin wrapper);
  `src/lib/producer-agent-tokens` adds `ytom_pr_` on `producer_agent_tokens` (v72, partial unique index, one active).
- Endpoint: `src/lib/producer-mcp-endpoint` (the factory endpoint's checks; no request-level scope) and `src/app/api/mcp/producer/route.ts`,
  which wires a `ProducerSession` (re-verify, `resolveChannelUser` = the channel's `connected_user_id` if Settings → Channels lists it,
  `recordCall`, `listChannels`, `portfolioOverview`) into `createMcpServer`'s producer mode. The endpoint also logs every `tools/call`
  the MCP layer refused before a tool ran (it peeks at the request body and subtracts the calls the server's log recorded).
- `createMcpServer` producer mode: `registerTool` routes every tool through `producerRegistration`. A `bound` tool in the closed list
  (`src/mcp/producer-tools.ts`, each entry naming its capability: READ, the one pinned DRAFT tool, or since 1.28.0 the pinned playlist tools) gets `.extend({ channelId })` (required; `query_market_intelligence`'s
  own `channelId` moves to `watchlistChannelId`); its wrapper re-verifies, resolves the channel's account (none: `CHANNEL_NOT_ACTIVE`), runs the
  unchanged handler inside `runInAgentSession({tokenId, channelId, userId})` for that one call, logs it, and adds `forChannelId`. The
  `producer-only` tools (classification class) run without a scope; one that names a `channelId` (the proposal tools, BL-163) is logged under
  it and answers with `forChannelId`, so the endpoint matches the call to the server's own log entry. A channel session never registers a producer tool; the SDK registration
  is still one call.
- Playlists (owner TG 4782, 2026-11-23, ADR 0048 Amendment 1; Producer API 1.28.0): `PRODUCER_PLAYLIST_CHANNEL_TOOLS` is a third closed
  map beside the READ and DRAFT ones, naming the channel agent's `youtube_writes` capabilities (`playlist_list` READ; `playlist_create`,
  `_update`, `_add_videos`, `_remove_videos` EXECUTE; pinned by the test, never `playlist_delete`). They go through the same
  `producerRegistration` branch and the same handlers and playlist core, so the write-channel guardrail, the playlist owner check, the
  write gateway and `assertLiveWritesAuthorized` apply unchanged inside the channel's scope. Producer-only extra: for
  `PRODUCER_OWN_VIDEO_TOOLS` (`playlist_add_videos`) the wrapper checks every `videoIds` entry against the channel's synced mirror
  (`channel-access.assertAgentScopeVideo`) before the handler runs. In any agent scope the playlist core first refuses an
  `expectedChannelId` other than the scope's (`channel-access.assertAgentScopeWriteChannel`, `WRITE_CHANNEL_MISMATCH`), and no longer
  refuses `public` for a playlist (the video rule stays in `worker-privacy`).
- `src/lib/portfolio-overview` adds up stored data per channel (`channel_metrics_daily`, Reach totals read in the channel's scope, synced
  videos' `publishedAt`, freshness); a source with nothing stored is `null`, not zero.
- `producer_call_log` (v72) records every call with tool, channel, outcome and error code; pruned to 90 days on insert; shown on the Producer
  card (`GET /api/producer-agent-token/calls`).

## BL-228 — one-time paid approvals through the HUB "System" topic (ADR 0053 + Amendment 1)

Plan: `docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md`. Built on `feature/bl-228-system-topic` (not merged).

- **Split (owner msgs 3602/3607, FO-RESP-0043 H4).** The factory's hub (`hub_bot.py`) polls the existing HUB bot and keeps
  `status` / `stop` / `go`. The Manager makes no Telegram call and runs no factory script. It only approves one-time paid calls.
- **Relay.** The hub calls `POST /api/system-topic/inbound` for each System topic message and polls `GET /api/system-topic/outbox`
  every 5 s. Both require a loopback request (`isLoopbackRequest`, 403) and `Authorization: Bearer <relay secret>` (401); they do
  not use a Web session. The secret is generated in Settings and shown once; only its SHA-256 is stored, and the check compares the
  hashes with `timingSafeEqual`. An inbound message is kept only if the chat, thread and sender ids match the settings; anything
  else only raises a counter. The audit row (primary key: update id) is claimed before the command runs. The outbox hands each row
  out once (one `UPDATE … RETURNING`); that GET checks the device mutation gate itself, because `src/proxy.ts` gates only mutating
  methods.
- **Requests.** Every 10 s while the feature is on, the scan in `src/instrumentation.ts` reads `<requests>/<id>.json`. The id is
  the file stem and must match `^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$`. Each new request is posted once with the Manager's estimate
  and the `{action, args}` hash, or refused / expired once. `approve` only moves `posted` → `approved_in_topic`. The Web Confirm
  re-reads the file and requires its `{action, args}` to equal the stored ones as canonical JSON (the 8-hex hash is display only),
  re-computes the full SHA-256 fingerprint (it also covers a Gemini job's input files), and re-checks the schema, the cap and the
  limits; the call runs with the stored args. Then a compare-and-set
  (`approved_in_topic` → `confirmed`) marks it used before the call; only one confirm can win it. The call runs in process through
  `src/composition/system-topic-approvals.ts`, which calls `createFactoryMediaDeps().startSession` / `createGeminiMediaCore().createJob`
  with the MCP tools' schemas. That keeps the factory and Gemini limits as the ceiling, and the module itself imports neither.
  `<id>.result.json` is written through a temporary file and a rename.
  At boot, a request still `confirmed` from before this process started, and not in flight here, becomes `failed` with its result
  file; it never reruns. The free `factory_media_get_gpu_availability` (FO-RESP-0045) is the acceptance-test action.
- **Limits.** The media module records an approved session as the factory's (`requestedBy: factory`); only Gemini takes the actor
  `owner (System)`. A media start held by a device limit is recorded `failed` (it waits for the owner in Servers). The relay cannot
  prove who wrote a topic message (RISK-136); the Web Confirm is the mitigation.
## BL-248 — the owner's review decisions wake the Producer (ADR 0066)

- **Module:** `src/lib/review-notify/` -- `contracts.ts` (kinds, notices, plan entries, ports, timings), `render.ts` (pure: file-name
  parts `[A-Za-z0-9_-]` kept, else replaced, cut to 48 and suffixed `~<8 hex>` of the original; a plan pass id = the first 16 hex of
  the SHA-256 of its sorted entry ids; the Markdown with YAML front matter, JSON-quoted, the comment in a fence it cannot close; no
  writer name or write time), `services.ts` (`createReviewNotify`: `tick` / `view` / `updateSettings`; one run at a time),
  `schemas.ts`, `adapters/fs.ts` (`createInboxWriter`: exists → skip, `.tmp-<random>` with `wx`, re-check, rename with retry,
  temporary file removed on failure; `workspaceRootOf`), `index.ts` (barrel + the nudge registry on `globalThis`). No feature module,
  no db.ts, no sync family (`boundaries.test.ts`).
- **Composition:** `src/composition/review-notify.ts` -- pure mappers per source (`clipNoticesOf`: owner `approved`/`returned` with
  attachments, a non-deciding later owner decision marked; `storyboardNoticesOf`: owner decisions, comments, replies and render
  verdicts; `slotNoticesOf`: every slot decision; `planFeedOfActivity` / `planFeedOfPeerPlan`) and the production wiring (connected
  channels, settings / state in `app_settings` keys `review_notify_settings` / `review_notify_state`, the ledger in
  `review_notify_ledger`, the Inbox under the one common parent of the channel workspaces). `generation-plans` gained
  `listPlanReviewActivity(since)` (history, active picks, `group_reviewed` times of this computer's plans).
- **Tick:** off (the owner's setting, else the default: macOS with the `00 YT Producer` folder, sticky once seen on) → nothing read
  or recorded and the old error cleared; `.tmp-*` older than 1 h swept; a pass's entry ids stored before its file (finished as itself
  after a crash); a tick asked for during a run gives one more run; sources report per-channel errors without stopping; first on → state
  `activeSince` and `singlesFloor` (2026-11-08 the first time, else now); no Inbox folder → one logged error, nothing recorded; else
  each source (a failure is reported, the others go on) → notices not in the ledger → file → ledger row. Plans: the feeds of one plan
  merged across sources, the unseen entries written as one pass when a `group_reviewed` is at or after the earliest (2 s slack) or the
  newest is 5 minutes old. The ledger is pruned hourly (90 days).
- **Limits:** see RISK-152 (a second writer through Syncthing; the other computer's plan verdicts only as its report carries them; a
  crash between a pass file and its ledger rows).

## BL-271 — waiting for a long operation without agent tokens (ADR 0075; on its branch, not in dev yet)

- **Core** `src/lib/operation-wait/` (pure, no DB): `createOperationWait({ ports, now, sleep, shutdownSignal, restarting })` →
  `waitFor(input, scope)`. Reads at once, then every 5 s (uploads 10 s, Automerge targets 15 s) until final, the clamped timeout
  (default 50 s, 1-240), the process's stop signal (`server_stopping`; `instrumentation.ts` calls `signalShutdown` on SIGTERM/SIGINT, so
  a blocked call never holds Next's drain or the restart's forced exit) or a restart under way (`restarting`, from
  `restart-when-idle.isRestarting`, cheap). A never-seen id is `not_found` (only target and id in the details); three failed reads in a
  row are `target_unavailable`; a resource seen once and gone counts as a failed read.
- **Ports** `src/composition/wait-targets.ts` (§M): one per target over existing reads (`publishing.getUploadRow` /
  `latestUploadOfVideo`, the media core's `getSession` / `getJob`, the Gemini / speech / ElevenLabs job reads, `listTranslationRequests`,
  the storyboards `get`, restart `requestById` / `activeRequest` / `lastRestart`), each loaded on use. Every port checks the
  resource's channel against the scope; a worker's scope is its token's channel, so another channel's id answers exactly like a missing
  one. Nothing writes, calls YouTube or a paid provider, or passes the device mutation gate (`wait-targets.inventory.test.ts`).
- **MCP.** `factory_wait` (the factory server gets `deps.wait`, wired through `FactoryChannelDeps`); `agent_wait` is that tool over
  `pinFactoryDepsToChannel` (channelId put in / `CHANNEL_NOT_ACTIVE`); `producer_wait` (`producer-only`, upload / restart). All three are
  outside `mcp_tool_calls` (`UNCOUNTED_TOOLS`, `UNCOUNTED_CHANNEL_TOOLS`, `UNCOUNTED_PRODUCER_TOOLS` -- the Producer's call log still
  records each call), so waits never keep restart-when-idle's quiet window open.
- **CLI** `src/cli/wait.ts`: a thin HTTP client of the caller's own endpoint (token prefix → endpoint; token only from an environment
  variable), so scoping stays in the endpoint and no migration can race the server. 240 s rounds, one JSON line, retries a lost
  connection (restart: until the deadline; others: 10 minutes), pins `restart current`'s id and treats a later `serverStartedAt` as done.
- **Client limits (stage 0):** Claude Code 2.1.322 kills an HTTP MCP call after ~60 s by default; the server entry's `timeout`
  (ms) raises it. Hence the 50 s default; the CLI is the path for long waits.
