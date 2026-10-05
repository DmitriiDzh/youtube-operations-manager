# YouTube Operations Manager -- Interfaces: Web UI, CLI, MCP, API

<- [Back to README](../README.md)

Use this as the operational reference after setup: covers channel workflows across metadata, transcripts, playlists, and automation surfaces. (The auto-playlisting "Rules" engine and the "Manual" playlist-management UI tab were removed 2026-09-20, per the project owner's decision -- see `docs/ROADMAP_STATUS.md`. The underlying playlist API routes/MCP/CLI tools listed below remain, used by MCP/CLI independent of any Web UI tab.)

## Web UI (`http://localhost:3000`)

### Login flow

1. Open home page.
2. Click **Sign in with Google**.
3. On success, app redirects to `/dashboard`.

### Dashboard tabs

- **Sync** (read-only, Phase 2)
  - Trigger full-channel synchronization (`/api/channels/sync`), enumerating the uploads playlist and
    batch-fetching video metadata (up to 50 IDs per request).
  - Browse locally synchronized channels (`/api/channels`) and their videos with existing localization
    languages (`/api/channels/[channelId]/videos`).
  - No YouTube writes occur in this tab.
- **Localizations** (Phase 3 read-only view + Phase 4 import/change-set/approval)
  - Overview table of existing localizations per synchronized video (`/api/channels/[channelId]/localizations`),
    with search and status (All/Missing/Complete) filtering.
  - Click a video to see its original metadata plus every existing remote locale's title/description
    (`/api/channels/[channelId]/localizations/[videoId]`).
  - Export selected/filtered/all videos to XLSX (`/api/channels/[channelId]/localizations/export`).
  - **Import (Phase 4):** upload an edited XLSX export to preview proposed changes
    (`/api/channels/[channelId]/localizations/import/preview`, no persistence), then create a persistent
    Change Set from the same file (`/api/channels/[channelId]/localizations/import`).
  - **Change Set review (Phase 4):** browse change sets for the channel, filter by status/language/video,
    approve or reject individual changes or bulk-approve all valid/non-conflicting ones
    (`/api/channels/[channelId]/change-sets/**`, see below).
  - No YouTube writes exist anywhere in this tab, including after approval: an "approved" change is a local
    database state only. Conflict detection compares each row's export-time baseline against the last
    *synchronized* remote value, not a live YouTube check (re-sync the channel to refresh it).

---

## CLI (`npm run cli:video-metadata -- ...`)

**The CLI is the operator's tool only** (`docs/decisions/0013-in-app-http-mcp-transport.md`): it runs
only while Settings → AI Agent → "Operator CLI access" is on and refuses otherwise. The former agent
mode is removed: `--agentToken` is rejected with `AGENT_TOKEN_INVALID` and `YTOM_AGENT_TOKEN` is not
read. AI agents use the app's MCP endpoint (see the MCP section).

CLI prints JSON envelopes on stdout (`{ ok: true|false, ... }`) and uses non-zero exit on failure.

### Auth commands

```bash
npm run cli:video-metadata -- auth login
npm run cli:video-metadata -- auth login --device
npm run cli:video-metadata -- auth whoami
npm run cli:video-metadata -- auth list-users
npm run cli:video-metadata -- auth select-user --userId <USER_ID>
npm run cli:video-metadata -- auth list-channels
npm run cli:video-metadata -- auth select-channel --channelId <UC...>
npm run cli:video-metadata -- auth logout
npm run cli:video-metadata -- auth revoke [--userId <USER_ID>]
```

### Metadata commands

```bash
npm run cli:video-metadata -- list [--channelId <CHANNEL_ID>] [--maxResults 25] [--userId <USER_ID>]
npm run cli:video-metadata -- transcript --videoId <VIDEO_ID> [--userId <USER_ID>]
npm run cli:video-metadata -- preview --videoId <VIDEO_ID> --editorialPrompt "..." [--userId <USER_ID>]
npm run cli:video-metadata -- apply --videoId <VIDEO_ID> --finalTitle "..." --description "..." --expectedChannelId <UC...> [--dryRun] [--userId <USER_ID>]
```

### Playlist commands

```bash
npm run cli:video-metadata -- playlist list [--userId <USER_ID>]
npm run cli:video-metadata -- playlist create --title "..." [--expectedChannelId <UC...>] [--description "..."] [--privacyStatus private|public|unlisted] [--userId <USER_ID>]
npm run cli:video-metadata -- playlist update --playlistId <PLAYLIST_ID> --expectedChannelId <UC...> [--title "..."] [--description "..."] [--privacyStatus private|public|unlisted] [--userId <USER_ID>]
npm run cli:video-metadata -- playlist delete --playlistId <PLAYLIST_ID> --expectedChannelId <UC...> [--userId <USER_ID>]
npm run cli:video-metadata -- playlist add --playlistId <PLAYLIST_ID> --expectedChannelId <UC...> --videoIds <VIDEO1,VIDEO2,...> [--userId <USER_ID>]
npm run cli:video-metadata -- playlist remove --playlistId <PLAYLIST_ID> --expectedChannelId <UC...> --videoIds <VIDEO1,VIDEO2,...> [--userId <USER_ID>]
```

### Channel-sync commands (CLI parity for the MCP `channel_*` tools, Phase 7)

```bash
npm run cli:video-metadata -- channel sync [--channelId <UC...>] [--userId <USER_ID>]
npm run cli:video-metadata -- channel list [--userId <USER_ID>]
npm run cli:video-metadata -- channel video-list --channelId <UC...> [--userId <USER_ID>]
```

`channel sync` reads from YouTube and writes only to the local `channels`/`videos` tables --
never a YouTube write, but still a local mutation, so it goes through the same
device-availability gate (`assertDeviceAvailableForMutation` -- the operation lock and
recovery-mode check only, not a channel-identity check; that requirement is satisfied
elsewhere, by `write-context.assertWriteChannel`, for the tools that actually touch YouTube) as
`apply`/`playlist create`. `channel list`/`channel video-list` are read-only.

### Change Set / Batch commands (CLI parity for the MCP `changeset_*`/`batch_*` tools, Phase 7)

```bash
npm run cli:video-metadata -- changeset list --channelId <UC...>
npm run cli:video-metadata -- changeset get --channelId <UC...> --changeSetId <ID> [--status pending|approved|rejected|conflict|invalid|all] [--language <LANG>] [--videoId <VIDEO_ID>]
npm run cli:video-metadata -- changeset preview --channelId <UC...> --file <path/to/workbook.xlsx>
npm run cli:video-metadata -- changeset import --channelId <UC...> --file <path/to/workbook.xlsx>
npm run cli:video-metadata -- batch list --channelId <UC...>
npm run cli:video-metadata -- batch get --channelId <UC...> --batchId <ID>
```

`--file` is read from the local filesystem (unlike the MCP tools' `fileBase64`, which exists
only because MCP's JSON transport has no binary field -- the CLI has direct filesystem access,
so no base64 round-trip). `changeset preview` never persists anything; `changeset import`
persists a new Change Set and is gated like `channel sync` above -- neither ever writes to
YouTube. `changeset list`/`changeset get`/`batch list`/`batch get` are read-only. `batch get`
verifies the batch belongs to `--channelId` before returning anything (`AGENTS.md` §F).

None of these commands have an apply-class equivalent (approve/execute a Change Set or Batch) --
that remains Web-UI-only, same as the equivalent MCP tools.

### AI Localization commands (CLI parity for the MCP `ai_localization_*` tools, BL-075/BL-078)

```bash
npm run cli:video-metadata -- ai-localization generate --channelId <UC...> --videoIds <id1,id2,...> --targetLanguages <lang1,lang2,...> [--providerName mock] [--connectionId <CONNECTION_ID>]
npm run cli:video-metadata -- ai-localization create-change-set --channelId <UC...> --proposalsJson <json> [--provenanceJson <json>] [--evidenceJson <json>] [--rationale <text>]
```

`generate` calls the same `generateProposals` function the Web UI's own "Generate with AI" step
calls -- persists nothing. Omitting both `--providerName` and `--connectionId` uses the
deterministic mock provider (no network call, no cost); `--connectionId` routes through a real,
user-configured AI Connection and makes a genuine outbound call to that provider (capped at 50
(video, language) targets per call). `create-change-set` persists the reviewed (optionally edited)
proposals as a new Change Set, `source: "ai_localization"` -- the exact same persistence path
`changeset import` (XLSX) already uses, so approval/conflict-revalidation/Batch/dry-run are
unaffected; it is gated like `changeset import` above. `--proposalsJson`/`--provenanceJson` take a
JSON-encoded value (an array of `{videoId, language, title?, description?}` objects, and the
`generationContext` a prior `generate` call returned, respectively) -- there is no reasonable flat
CLI-flag equivalent for that shape. `--evidenceJson`/`--rationale` (Phase 7 slice F, owner spec
§12/§13) are optional, caller-supplied research citations/reasoning for the Change Set's proposals
as a whole (not per-proposal, `docs/TECHNICAL_DEBT.md` RISK-55) -- `--evidenceJson` is a
JSON-encoded `EvidenceReference[]` (`url`, `retrievedAt`, `description`, `claimSupported`,
`sourceType`, optional `excerpt`), `--rationale` is plain text. Every `create-change-set` call
(this CLI command, the MCP tool, and the Web route) records which transport created the Change
Set (`createdVia`/`agentApiVersion`, SERVER-STAMPED, never caller-supplied) -- see
`docs/AGENT_OPERATIONS_INTERFACE.md` §4e. Neither command has an apply-class equivalent, same as
Change Sets above; there is also no CLI/MCP command for the channel editorial profile (see
`docs/ARCHITECTURE.md` §11's BL-075/BL-078 entry for what this slice deliberately left out).

### Agent Operations commands (CLI parity for the MCP `agent_*` tools, Phase 7 -- see `docs/AGENT_OPERATIONS_INTERFACE.md` §7 for which slice is currently implemented)

```bash
npm run cli:video-metadata -- agent capabilities
npm run cli:video-metadata -- agent channel-context --channelId <UC...>
npm run cli:video-metadata -- agent video-context --channelId <UC...> --videoId <VIDEO_ID> [--include metadata,localizations]
npm run cli:video-metadata -- agent channel-analytics --channelId <UC...> --startDate <YYYY-MM-DD> --endDate <YYYY-MM-DD>
npm run cli:video-metadata -- agent video-analytics --channelId <UC...> [--videoId <VIDEO_ID>] [--startDate <YYYY-MM-DD>] [--endDate <YYYY-MM-DD>] [--metricNames views,likes,...]
npm run cli:video-metadata -- agent list-assets --channelId <UC...> [--videoId <VIDEO_ID>] [--assetType thumbnail|source_image|...]
npm run cli:video-metadata -- agent get-asset-context --channelId <UC...> --assetId <ASSET_ID>
npm run cli:video-metadata -- asset register --channelId <UC...> --assetType <type> --referenceKind url|local_path|external_artifact_id --referenceValue <value> [--title <t>] [--description <d>] [--linkedVideoId <id>] [--provenanceJson <json>]
npm run cli:video-metadata -- agent get-generation-provenance --channelId <UC...> --changeSetId <CHANGE_SET_ID>
npm run cli:video-metadata -- agent create-content-proposal --channelId <UC...> [--objective <text>] [--topicConcept <text>] [--rationale <text>] [--evidenceJson <json>] [--briefJson <json>] [--referenceVideoIds <id1,id2,...>] [--referenceAssetIds <id1,id2,...>]
npm run cli:video-metadata -- agent get-content-proposal --channelId <UC...> --proposalId <PROPOSAL_ID>
npm run cli:video-metadata -- agent list-content-proposals --channelId <UC...>
npm run cli:video-metadata -- agent register-external-artifact --channelId <UC...> --proposalId <PROPOSAL_ID> --assetType <type> --referenceKind url|external_artifact_id --referenceValue <value> [--title <t>] [--description <d>] [--linkedVideoId <id>] [--provenanceJson <json>]
npm run cli:video-metadata -- agent list-proposal-artifacts --channelId <UC...> --proposalId <PROPOSAL_ID>
npm run cli:video-metadata -- agent list-operations-files
npm run cli:video-metadata -- agent get-operations-file --path <RELATIVE_PATH>
npm run cli:video-metadata -- agent channel-workspace --channelId <UC...>
npm run cli:video-metadata -- agent find-comparable-videos --channelId <UC...> --anchorVideoId <VIDEO_ID> --sort publicationProximity|durationProximity|performanceMetric|titleTokenOverlap [--publicationWindowDays <N>] [--durationToleranceSeconds <N>] [--performanceMetric <name>] [--performanceThresholdOperator '>='|'<='] [--performanceThresholdValue <N>] [--limit <N>]
npm run cli:video-metadata -- agent list-asset-performance --channelId <UC...> [--assetType thumbnail|source_image|...] [--performanceMetric <name> --performanceDayOffset <N>] [--sort linkedVideoPublicationDate|lifetimeViewCount|performanceMetric] [--limit <N>]
```

`agent capabilities` is read-only with no channel/credential resolution at all (instance-level
information, not channel-scoped). Returns product version, this interface's own version, the
capabilities actually reachable right now, the full permission-class vocabulary and what's
actually granted (always `READ`+`DRAFT`), named future extension points, and the local schema
version.

`agent channel-context`/`agent video-context` are channel-scoped reads: like
`ai-localization`/`changeset`/`batch` above, this CLI namespace resolves the local active-user
identity and explicitly checks it against the requested `--channelId` before calling the
underlying service (the service functions themselves do no such checking). Both are read-only —
they read only already-synced local data, never a live YouTube call. `--include` on
`video-context` takes a comma-separated subset of `metadata,localizations`; omitted, both
sections are returned.

`agent channel-analytics`/`agent video-analytics` are agent-oriented wrappers over the existing
`analytics overview`/`analytics list` commands below -- same underlying data, same YouTube-call
classification (`channel-analytics` is a **live** Analytics API read that counts against quota;
`video-analytics` is a local read only), but the response additionally carries explicit metric
definitions, the request's own period/filters echoed back, and a data-freshness note. Unlike
`channel-context`/`video-context` above, these two do NOT get an explicit `assertActiveChannel`
check from this CLI namespace itself -- they forward a resolved `credentialRef` straight into the
existing `analyticsCore`, which already performs that check internally (mirrors this CLI's own
pre-existing `analytics overview`/`analytics list` commands, not the `ai-localization` pattern).
`--metricNames` on `video-analytics` is comma-separated; omitted, every metric this instance
actually collects is described.

`agent list-assets`/`agent get-asset-context` are channel-scoped reads over the new asset
catalog, same `assertActiveChannel` pattern as `channel-context`/`video-context` above. `asset
register` is a separate namespace (not under `agent`) -- the operator-facing way the catalog gets
populated, never a live YouTube call, gated like any other local mutation.
`--provenanceJson` takes a JSON-encoded object.

`agent get-generation-provenance` is a channel-scoped read over the pre-existing
`ai-localization` provenance record for a Change Set (editorial-profile version, effective
context, `changeSetId`/`channelId`/creation time) -- same `assertActiveChannel` pattern. Reports
`{ provenance: null }`, never an error, for a Change Set with none recorded (e.g. XLSX import).
The returned `profileVersion`/`effectiveContext` were supplied by whoever created the Change Set,
not independently verified by this server. See `docs/AGENT_OPERATIONS_INTERFACE.md` for the full
design.

`agent create-content-proposal` (Phase 7 slice G, owner spec §18) persists a new, write-once
Content Proposal -- no update, no approval workflow (the owner spec describes none for this
domain). `--evidenceJson` takes a JSON-encoded `EvidenceReference[]` (same shape as
`ai-localization create-change-set`'s own `--evidenceJson`), `--briefJson` a JSON-encoded
`ContentProposalBrief` (proposedTitleDirection, thumbnailDirection, visualBrief, audioBrief,
durationHint, publicationHypothesis, localizationStrategy, experimentDesign, expectedMetrics,
requiredProductionOutputs), `--referenceVideoIds`/`--referenceAssetIds` a comma-separated list of
ids -- each validated to actually belong to `--channelId`. Mutates local state, gated like
`ai-localization create-change-set`. `createdVia`/`agentApiVersion` are SERVER-STAMPED
(`"cli"`/`null`), never taken from flags. `agent get-content-proposal`/`agent
list-content-proposals` are the same `assertActiveChannel`-checked, read-only pattern as
`agent get-asset-context`/`agent list-assets` above. See `docs/AGENT_OPERATIONS_INTERFACE.md`
§4f for the full design.

`agent register-external-artifact` (Phase 7 slice G2, owner spec §19) is "a lightweight way for
external agent workflows to return created artifacts to the system" -- it registers a new asset
(delegating to `asset-catalog`'s own `registerAsset`, never a second, parallel asset-insert path)
and links it to an existing, channel-owned Content Proposal. `--referenceKind` accepts only
`url`/`external_artifact_id` here -- **not** `local_path` (owner spec §17: the agent must receive
only explicitly cataloged/authorized assets; `local_path` registration remains available only via
the pre-existing, operator-only `asset register` command above). When `--referenceKind url` is
given, `--referenceValue` must actually be an http(s) URL -- the schema validates the shape, not
just the label (RISK-58, `docs/TECHNICAL_DEBT.md`); a filesystem path or `file://` URI is
rejected. `external_artifact_id` remains an intentionally opaque, unvalidated identifier this
application never resolves. `--provenanceJson` takes a
JSON-encoded object, same convention as `asset register`'s own flag. Mutates local state (a new
asset row plus a new link row), gated like `create-content-proposal`. `createdVia`/
`agentApiVersion` are SERVER-STAMPED (`"cli"`/`null`), never taken from flags. `agent
list-proposal-artifacts` is the same `assertActiveChannel`-checked, read-only pattern as `agent
get-asset-context`/`agent list-assets` -- it hydrates each link with its full `CreativeAsset` and
silently drops a link whose asset is somehow missing rather than fabricating one. See
`docs/AGENT_OPERATIONS_INTERFACE.md` §4f for the full design.

`agent channel-workspace --channelId <UC...>` (Phase 11, `docs/AGENT_OPERATIONS_INTERFACE.md`
§4m) prints the local production-workspace folder path the operator set for that channel on this
device: `{ configured: true, path }` exactly as stored, or `{ configured: false }`. It performs the
same `assertActiveChannel` check as `agent channel-context`, and it never touches anything at or under
the workspace path.
**No command in this CLI can set or clear the path.** Only the Web UI's Settings → Channels card
can.

`agent list-operations-files`/`agent get-operations-file` (Phase 7 slice I, owner spec §3/§30)
surface the contents of an operator-configured, out-of-repository folder holding Codex's own
operating instructions. Unlike every other `agent` command, neither takes `--channelId` and
neither calls `assertActiveChannel` -- this is instance-level, not channel-scoped (one global
path). Both return `{ configured: false }`, never an error or a silently empty list, if the
operator hasn't set a path yet (Settings tab only -- **no command in this CLI can set or change
it**, matching the `local_path` self-authorization concern already established for
`register-external-artifact`). `list-operations-files` returns each file/folder's path (relative
to the workspace root, POSIX-normalized -- the absolute base path is never exposed), whether it's
a directory, and its size in bytes (`null` for directories); only `.md`/`.txt`/`.json`/`.yaml`/
`.yml` files are listed, dotfiles/dot-directories are always excluded, and the result is bounded
by a depth/file-count cap (`truncated: true` if hit). `get-operations-file --path <RELATIVE_PATH>`
reads one file's content (capped at 200,000 bytes, `truncated: true` if the real file is larger)
-- a path that tries to escape the workspace (`..` segments, an absolute path, or a symlink
resolving outside it, including into this app's own app-data directory) is rejected with the same
`OPERATIONS_FILE_NOT_AVAILABLE` error as a genuinely nonexistent file, never distinguishable. Both
are pure filesystem reads, never gated by the device-availability check. See
`docs/AGENT_OPERATIONS_INTERFACE.md` §4j for the full design.

`agent find-comparable-videos` (Phase 7 slice K, owner spec §10) is a channel-scoped read
(`assertActiveChannel`, same pattern as `agent list-assets` above) that finds already-synced
videos on `--channelId` comparable to `--anchorVideoId`, by publication proximity, duration
proximity, and/or an age-aligned (days-since-publish, capped at 365) already-collected performance
metric threshold -- local reads only, never a live YouTube call. It does **not** support "same
content family," "similar target audience," or "similar metadata pattern" matching -- no data
source for any of those exists in this application. `--performanceMetric`/
`--performanceThresholdOperator`+`--performanceThresholdValue`/`--sort performanceMetric` each
require a resolvable credential (only ever used when a performance metric is actually requested).
`--performanceThresholdOperator`/`--performanceThresholdValue` must be given together — one without
the other is rejected as `validation_failed`, never silently treated as "no threshold." Videos
missing the data a requested `--durationToleranceSeconds`/performance filter needs are counted in
the response's `excludedForMissingData`, never silently coerced to a fabricated `0` or dropped
without being counted. `sharedTitleTokens` on each candidate is a literal lowercase word-overlap
set, never topic/semantic similarity, never produced by an embedding model. The response's `anchor`
block and `performanceAlignment` report the anchor's own facts and the exact comparison day, so
each candidate's distance fields are interpretable without a second call. See
`docs/AGENT_OPERATIONS_INTERFACE.md` §4g for the full design.

`agent list-asset-performance` (Phase 7 slice L, owner spec §16) is a channel-scoped read
(`assertActiveChannel`, same pattern as `agent list-assets` above) that joins the existing asset
catalog (`linkedVideoId` -- an operator/agent-asserted "this asset was used on this video"
association, never verified against YouTube, no time range) against each linked video's own
already-collected performance data -- local reads only, never a live YouTube call. Always reports
each video's LIFETIME totals (`viewCount`/`likeCount`/`commentCount`/`durationSeconds`, plus
`lifetimeCountersAsOf` -- when the channel sync last refreshed them, NOT when analytics were
collected); `--performanceMetric`/`--performanceDayOffset` must be given together (the domain
schema itself enforces this) and additionally compute an age-aligned value at the exact,
caller-supplied day -- NEVER derived from wall-clock "now" (the same lesson independent review
found the hard way in slice K, round 1). A video with real data at later days but no day-0
coverage (published before regular collection began) correctly reports `null` here while its row
and lifetime counters stay intact -- this is a JOIN, not a filter, so a null performance value is
never grounds for exclusion. `--sort lifetimeViewCount` ranks by a NON-age-fair total that
structurally favors older videos -- never itself a "performed better" signal. Only an asset's own
broken link (unlinked, or `linkedVideoId` not resolving to a video on the SAME channel -- one
combined count, since a channel-scoped read cannot further distinguish "never synced" from "on
another channel") is excluded, counted in `excludedForMissingLink`. Does **not** support
thumbnail-CTR/impressions-based questions (this application's own analytics collection never
fetches YouTube's impressions/CTR metrics at all), `metadata/version` linkage, `experiment/outcome`
linkage (Phase 10), or Content Proposal reference associations (a structurally different,
draft/unactioned relationship). `--limit` above the maximum is silently clamped, never rejected
(the same lesson independent review found in slice K, round 3). See
`docs/AGENT_OPERATIONS_INTERFACE.md` §4h for the full design.

`agent competitors` (Phase 9 slice 4, `docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`) takes no
flags and returns the whole research watchlist (no evidence attached) -- global data, no
`--channelId`/active-channel check, no auth resolution. `agent market-intelligence --channelId
<UC...>` returns that one watchlisted channel's own record plus its evidence history (Phase 13: another channel's API-sourced rows -- `youtube.channels.list`/`youtube.videos.list`/`youtube.videos.batchGetStats` snapshots and "Fetch public snapshot" evidence -- only within the last 30 days, YouTube API Developer Policies III.E.4.d; operator-entered rows of any age), failing with
`RESEARCH_CHANNEL_NOT_AVAILABLE` if it isn't on the watchlist. Neither makes a live YouTube call.
Both are wired via `createMarketIntelligenceCore()` directly, not through `agentOperationsCore` --
see `docs/AGENT_OPERATIONS_INTERFACE.md` §4k for the full design.

### Analytics commands (CLI parity for the MCP `analytics_*` tools, Phase 8 follow-up)

```bash
npm run cli:video-metadata -- analytics list --channelId <UC...> [--startDate <YYYY-MM-DD>] [--endDate <YYYY-MM-DD>] [--videoId <VIDEO_ID>] [--metricNames views,likes,...]
npm run cli:video-metadata -- analytics overview --channelId <UC...> --startDate <YYYY-MM-DD> --endDate <YYYY-MM-DD>
npm run cli:video-metadata -- analytics data-quality --channelId <UC...> --startDate <YYYY-MM-DD> --endDate <YYYY-MM-DD>
npm run cli:video-metadata -- analytics comparable-age --channelId <UC...> --videoIds <id1,id2,...> [--metricName views] [--maxDays 30]
npm run cli:video-metadata -- analytics weekly-reports --channelId <UC...>
npm run cli:video-metadata -- analytics weekly-report-get --channelId <UC...> --weekStartDate <YYYY-MM-DD>
```

All six are read-only. `analytics list` reads already-collected `video_metrics_daily` rows
locally; `analytics overview` is a live Analytics API read (channel-level totals + deltas, counts
against quota); `analytics data-quality` is a local read over `analytics_collection_runs` (see
`docs/ARCHITECTURE.md` §14.9); `analytics comparable-age` is a local read that aligns 2-10 videos'
already-collected rows by days-since-publish (see `docs/ARCHITECTURE.md` §14.10); `analytics
weekly-reports`/`analytics weekly-report-get` read already-generated weekly snapshot rows (see
`docs/ARCHITECTURE.md` §14.11) -- there is no CLI/MCP command to generate one on demand, only the
Web UI's own dashboard-mount trigger does that. Mirrors the equivalent MCP tools exactly -- see
below.

---

## MCP server (`POST /api/mcp`, served by the running app)

The app itself serves MCP (stateless Streamable HTTP, `src/lib/agent-mcp-endpoint`, route
`src/app/api/mcp/route.ts`); the stdio server and `npm run mcp:video-metadata` no longer exist
(`docs/decisions/0013-in-app-http-mcp-transport.md`). **It exposes tools only to a channel-bound
agent.** Each request is checked in order: loopback `Host`/`Origin` (else `403
AGENT_ENDPOINT_NOT_LOOPBACK`), method `POST` (else `405`), "MCP connection" toggle on (else `403
MCP_CONNECTION_DISABLED`), `Authorization: Bearer <channel token>` present (else `401
AGENT_TOKEN_REQUIRED`) and valid (else `401 AGENT_TOKEN_INVALID`). Errors are explicit; there is no
empty tool list and no `WWW-Authenticate` challenge. The server never exposes a login flow:
channel identities are connected by the operator in the Web UI (Settings → Channels).

The list below is the full tool inventory. Tools marked *(operator-only)* are classified
`operator-only` in `src/mcp/tool-classification.ts`, so they are **never registered for an agent**.
They remain listed only for completeness.

Key MCP tools:

- Context/auth tools:
  - `write_context`
  - `write_channel_list` *(operator-only)*
  - `write_channel_select` *(operator-only)*
  - `whoami`
  - `auth_user_select` *(operator-only)*
- Metadata tools:
  - `list`, `transcript`, `preview`, `apply`
- Playlist tools:
  - `playlist_list`, `playlist_create`, `playlist_update`, `playlist_delete`
  - `playlist_add_videos`, `playlist_remove_videos`
- Change Set / Batch tools (Phase 7 slice 1, `docs/roadmap/plans/PHASE_7_PLAN.md`; closes part of
  `docs/TECHNICAL_DEBT.md` RISK-04) — all five are **read/propose-only**: none can reach a real
  YouTube write, and none accepts or is gated by `credentialRef` (they read the local database
  only, not the YouTube API):
  - `changeset_list` — `{ channelId }` → `{ changeSets: ChangeSet[] }`
  - `changeset_get` — `{ channelId, changeSetId, status?, language?, videoId? }` →
    `{ changeSet, changes, pagination }`
  - `localization_import_preview` — `{ channelId, filename, fileBase64 }` (workbook bytes,
    base64-encoded — MCP's JSON transport has no native binary field) → the same
    `{ summary, errors, totalErrors }` shape the Web UI's
    `POST .../localizations/import/preview` route returns; **persists nothing**
  - `changeset_create_from_import` — same `{ channelId, filename, fileBase64 }` input, but
    **persists** a new Change Set (mirrors `POST .../localizations/import`) → `{ changeSet,
    summary, errors, totalErrors }`. Never writes to YouTube, but does mutate the local
    database, so — unlike the preview tool above — it IS gated by the same
    device-availability check as `channel_sync`/`apply`.
  - `batch_list` — `{ channelId }` → `{ batches: Batch[] }`
  - `batch_get` — `{ channelId, batchId }` → `{ batch, ledgerRows }`; verifies the batch belongs
    to `channelId` via `requireBatchForChannel` before returning anything (`AGENTS.md` §F).
    A ledger row `status` is one of `PENDING`, `AWAITING_EXECUTION`, `APPLYING`, `SUCCESS`, `FAILED`,
    `CONFLICT`, `UNKNOWN`, `ABORTED_SYSTEMIC`, `DRY_RUN_COMPLETE` or (since 2026-10-03, ADR 0016)
    `CANCELLED` — the operator stopped the batch before that video started; nothing was written for it.
    A cancelled batch ends `ABORTED`.

  Deliberately **not** included in this slice: any apply-class Change Set/Batch tool (creating,
  approving, or executing) — blocked on Gate B's live-write validation track
  (`docs/TECHNICAL_DEBT.md`), tracked separately and unaffected by this slice.
- Channel-sync tools (`BL-008`, `docs/roadmap/BACKLOG.md`) — closes the rest of RISK-04's MCP
  portion:
  - `channel_sync` — `{ channelId?, credentialRef? }` → `{ channel, videoCount, syncedAt }`.
    Reads from YouTube, writes to the local `channels`/`videos` tables only — never a YouTube
    write. **Mutating**: gated by the same device-availability check as `apply`/`playlist_create`
    (it mutates local state even though it never touches YouTube).
  - `channel_list` — `{ credentialRef? }` → `{ channels: SyncedChannel[] }`. Read-only.
  - `channel_video_list` — `{ channelId, credentialRef? }` → `{ channelId, videos: SyncedVideo[] }`.
    Read-only.
- AI Localization tools (BL-075/BL-078, `docs/roadmap/BACKLOG.md`) — wrap the exact same two
  service functions the Web UI's own `POST .../ai-localization/{generate,change-sets}` routes
  already call; no new validation/persistence logic. Neither accepts `credentialRef` (mirrors
  `changeset_list`/`changeset_get`'s own convention — always the active local auth context):
  - `ai_localization_generate` — `{ channelId, videoIds, targetLanguages, providerName?,
    connectionId?, editorialBrief? }` → `GenerationResult` (per-target proposals, errors,
    summary, `generationContext` provenance). **Persists nothing.** Omitting both
    `providerName`/`connectionId` uses the deterministic mock provider (no network call);
    `connectionId` makes a real outbound call to a configured AI Connection, capped at 50
    (video, language) targets per call, gated by its own internal device-availability check
    (RISK-30) rather than this tool's own mutation gate.
  - `ai_localization_create_change_set` — `{ channelId, proposals: ReviewedProposal[],
    provenance?, evidence?, rationale? }` → the created `ChangeSet` (`source: "ai_localization"`).
    **Persists** a new Change Set — mutates local state only, never YouTube, gated by the same
    device-availability check as `changeset_create_from_import`. Every resulting Change starts
    `approvalStatus: "pending"` — there is no code path, here or anywhere, that can mark an
    AI-authored proposal already-approved (`AGENTS.md` §G). `evidence`/`rationale` (Phase 7 slice
    F, owner spec §12/§13) are optional, caller-supplied, per-Change-Set (not per-proposal,
    `docs/TECHNICAL_DEBT.md` RISK-55) research citations/reasoning, never independently verified.
    This handler also SERVER-STAMPS `createdVia: "mcp"` and `agentApiVersion` on the resulting
    provenance record — see `agent_get_generation_provenance` below.

  Deliberately **not** included in this slice: `getEditorialProfile`/`saveEditorialProfile` (no
  MCP/CLI tool for either), and any approve/reject/apply path for a Change Set regardless of its
  source — same Gate-B-blocked gap RISK-04 already tracks. `getGenerationProvenance` WAS in this
  list until Phase 7 slice E added `agent_get_generation_provenance` (see the Agent Operations
  Interface tools below) — not an `ai_localization_*`-namespaced tool, but the same underlying
  function.
- Agent Operations Interface tools (Phase 7, `docs/AGENT_OPERATIONS_INTERFACE.md` §7 for current slice status):
  - `agent_get_capabilities` — `{}` (no parameters) → `SystemCapabilities` (product/agent-API
    version, implemented capabilities, data domains, the full permission vocabulary, what's
    actually granted today — always `["READ","DRAFT"]` — named future extension points, and the
    local schema version). Read-only, no channel scoping (instance-level information). Call this
    first, before assuming any other Agent Operations tool exists.
  - `agent_get_channel_context` — `{ channelId }` → `ChannelContext` (title, `lastSyncedAt`
    — `null` if never synced, never fabricated — synced video count, the channel's editorial
    profile or `null` if none was ever saved, and its explicitly tracked languages). Requires
    `channelId` to be the caller's currently-active channel (checked explicitly by the MCP/CLI
    layer, same convention as `ai_localization_*` above — the service function itself does no
    such check). Local read only.
  - `agent_get_video_context` — `{ channelId, videoId, include? }` → `VideoContext`, section-
    selectable: `"metadata"` (title, description, publish date, privacy status, default
    language, last sync time) and/or `"localizations"` (every existing per-language
    title/description already synced locally). Omitting `include` returns both sections; an
    omitted section is left entirely absent from the response (`undefined`), not an empty
    placeholder, for token efficiency. Requires `channelId` to be the caller's active channel and
    `videoId` to actually belong to it (`DATA_NOT_SYNCED` otherwise — protects against a
    cross-channel `videoId` or a typo). Local read only.

  - `agent_query_channel_analytics` — `{ channelId, startDate, endDate, credentialRef? }` →
    `ChannelAnalyticsContext` (daily rows, current-/previous-period totals, `metricDefinitions`,
    `period`, `freshness`, and, additively from Phase 13, `viewCountingChangeInComparison: boolean` -- true when the two periods straddle YouTube's 2026-08-27 view-counting change, so the totals are not like-for-like). Wraps `analytics_overview` unchanged — a **live** Analytics API read
    that counts against that API's quota. Requires `channelId` to be the caller's active channel
    (checked internally by the wrapped `analyticsCore` call, not a second check in this module).
  - `agent_query_channel_reach` — `{ channelId, startDate, endDate, credentialRef? }` →
    `{ channelId, state, jobCreatedAt, coverage, startDate, endDate, daily, videos, totals }`
    (BL-114, ADR 0014). Thumbnail impressions and click-through rate from the YouTube Reporting API
    Reach report that the app downloads and stores locally -- a **local read**, no live YouTube
    call (these two metrics are not available from the Analytics API, so they are not in
    `agent_query_channel_analytics`). `state` is `no_job`, `waiting_for_first_report` (a job exists
    but YouTube has delivered no file yet, up to ~48 h -- **not** zero impressions) or `ready`.
    Days without data are absent, never zero-filled. `daily` and `videos` (top 50 by impressions,
    keyed by canonical `videoId`) are raw FACT values; `totals` are DERIVED, with the CTR
    **impressions-weighted** (never an average of per-row CTRs); a `ctr` of `null` means the report
    left it empty. `coverage` (`firstDate`/`lastDate`/`importedFiles`) shows which days exist. The
    app refreshes the data when its dashboard is opened, at most every 6 hours; an agent cannot
    trigger the sync. Requires `channelId` to be the caller's active channel (checked inside the
    service, before any data is read). Maximum range 400 days.
  - `agent_query_video_analytics` — `{ channelId, videoId?, startDate?, endDate?, metricNames?,
    credentialRef? }` → `VideoAnalyticsContext` (raw already-collected rows, `metricDefinitions`,
    `period`/`filters` echoed back, `freshness`). Wraps `analytics_list` unchanged — a local read
    only. Omitting `metricNames` describes every metric this instance actually collects, never an
    invented one.
  - `agent_list_assets` — `{ channelId, videoId?, assetType? }` → `{ assets: CreativeAsset[] }`.
    Local read only over the new asset catalog — never reads/fetches the actual file behind
    `referenceValue`. Requires `channelId` to be the caller's active channel.
  - `agent_get_asset_context` — `{ channelId, assetId }` → `CreativeAsset`. Same channel-scoping
    as `agent_list_assets`; `ASSET_NOT_AVAILABLE` for a nonexistent id or one belonging to another
    channel (never distinguishable). In this slice (D) there is still no agent-callable way to add
    an asset directly — the catalog is populated only via the `asset register` CLI command. Slice
    G2 (below) later adds an agent-callable way to register an asset, but only indirectly, tied to
    a Content Proposal, and only for `referenceKind: url|external_artifact_id` — never
    `local_path`, which remains reachable only via `asset register`.
  - `agent_get_generation_provenance` — `{ channelId, changeSetId }` → `{ provenance:
    StoredGenerationProvenance | null }`. Wraps the pre-existing `ai-localization` provenance
    record (previously only reachable via its own HTTP route, no MCP/CLI tool) — same
    channel-scoping as `agent_get_asset_context`; `{ provenance: null }`, never an error, for a
    Change Set with none recorded. `profileVersion`/`effectiveContext`/`evidence`/`rationale` were
    supplied by whoever created the Change Set, not independently attested by this server.
    `createdVia`/`agentApiVersion` (Phase 7 slice F, owner spec §22) ARE server-stamped, never
    caller-supplied — `createdVia: "mcp"` with the real `agentApiVersion` for a Change Set created
    through this MCP surface, `"cli"`/`null` for the CLI, `"web_ui"`/`null` for the Web UI's own
    "Generate with AI", and `null`/`null` for a row created before this field existed
    (`docs/TECHNICAL_DEBT.md` RISK-54, RESOLVED).
  - `agent_create_content_proposal` (Phase 7 slice G, owner spec §18) — `{ channelId, objective?,
    topicConcept?, rationale?, evidence?, brief?, referenceVideoIds?, referenceAssetIds? }` →
    `ContentProposal`. **Persists** a new, write-once proposal row — no update, no approval
    workflow (the owner spec describes none for this domain; a proposal is a DRAFT object, full
    stop). `referenceVideoIds`/`referenceAssetIds` are each validated to actually belong to
    `channelId`. `createdVia`/`agentApiVersion` are SERVER-STAMPED (`"mcp"` + the real
    `AGENT_API_VERSION`), never taken from the request body. Mutates local state only, gated by
    the same device-availability check as `ai_localization_create_change_set`.
  - `agent_get_content_proposal` — `{ channelId, proposalId }` → `ContentProposal`. Same
    channel-scoping as `agent_get_asset_context`; `CONTENT_PROPOSAL_NOT_AVAILABLE` for a
    nonexistent id or one belonging to another channel (never distinguishable).
  - `agent_list_content_proposals` — `{ channelId }` → `{ proposals: ContentProposal[] }`. Local
    read only, newest first.
  - `agent_register_external_artifact` (Phase 7 slice G2, owner spec §19) — `{ channelId,
    proposalId, assetType, referenceKind, referenceValue, title?, description?, linkedVideoId?,
    provenance? }` → `ProposalArtifactLink`. **Persists** a new asset row (via `asset-catalog`'s
    own `registerAsset`, never a second, parallel asset-insert path) plus a new link row against
    an existing, channel-owned proposal. `referenceKind` accepts only `url`/`external_artifact_id`
    here — never `local_path` (owner spec §17: the agent must receive only explicitly
    cataloged/authorized assets; an agent that could register its own `local_path` would be
    self-authorizing filesystem access). `url` is structurally validated as an actual http(s) URL,
    not merely labeled (RISK-58, `docs/TECHNICAL_DEBT.md`); `external_artifact_id` remains an
    intentionally opaque, unvalidated identifier never resolved by this application.
    `createdVia`/`agentApiVersion` are SERVER-STAMPED (`"mcp"`
    + the real `AGENT_API_VERSION`), never taken from the request body. Mutates local state, gated
    by the same device-availability check as `agent_create_content_proposal`.
  - `agent_list_proposal_artifacts` — `{ channelId, proposalId }` → `{ artifacts:
    ProposalArtifactLink[] }`. Same channel-scoping as `agent_get_content_proposal`; local read
    only, hydrates each link with its full `CreativeAsset` and silently drops a link whose asset is
    somehow missing rather than fabricating one.
  - `agent_list_operations_files` *(operator-only since Phase 12, D2)* (Phase 7 slice I, owner spec §3/§30) — `{}` →
    `{ configured: false } | { configured: true, files: OperationsWorkspaceFileEntry[], truncated:
    boolean }`. NOT channel-scoped (one global, operator-configured path) — no `channelId`, no
    `assertActiveChannel` check, like `agent_get_capabilities`. Lists files/folders under the
    operator-configured operations-workspace directory; `.md`/`.txt`/`.json`/`.yaml`/`.yml` files
    only, dotfiles/dot-directories always excluded, depth/file-count capped. The path itself can
    only be set through the Web UI's Settings tab — no MCP tool or CLI command can set it.
  - `agent_get_operations_file` *(operator-only since Phase 12, D2)* — `{ path }` → `{ configured: false } | { configured: true, path,
    content: string, truncated: boolean }`. Same non-channel-scoped note as
    `agent_list_operations_files`. A `path` that escapes the configured directory (`..` segments,
    an absolute path, or a symlink resolving outside it, including into this app's own app-data
    directory) gets the same `OPERATIONS_FILE_NOT_AVAILABLE` error as a genuinely nonexistent
    file, never distinguishable. Content capped at 200,000 bytes.
  - `agent_find_comparable_videos` (Phase 7 slice K, owner spec §10) — `{ channelId,
    anchorVideoId, credentialRef?, publicationWindowDays?, durationToleranceSeconds?,
    performanceMetric?, performanceThreshold?, sort, limit? }` → `{ anchorVideoId, anchor,
    performanceAlignment, candidates: ComparableVideoCandidate[], excludedForMissingData: {
    duration, performance }, truncated, metricDefinitions, freshness }`. `anchor` carries the
    anchor video's own title/publishedAt/durationSeconds/performanceMetricValue and
    `performanceAlignment` (`{ metricName, dayOffset } | null`) names the exact day-since-publish
    every candidate's (and the anchor's own) `performanceMetricValue` was evaluated at.
    `metricDefinitions`/`freshness` mirror `agent_query_video_analytics`'s own enrichment (owner
    spec §9) — both `null` unless `performanceMetric` was requested. Same channel-scoping as
    `agent_list_assets`, except this tool deliberately lets an explicitly caller-supplied
    `credentialRef` govern which identity's active channel is checked (same convention
    `agent_query_channel_analytics`/`agent_query_video_analytics` already use), not just forwarding
    it downstream. Local
    reads only — never a live YouTube call; the performance-metric path reuses the same
    age-alignment logic as `agent_query_video_analytics`/`analytics_comparable_age`, never a second
    implementation. `anchorVideoId` not belonging to (or not found on) `channelId` fails with
    `DATA_NOT_SYNCED` (the same code `agent_get_video_context` already uses for this shape of
    not-found). Does **not** support "same content family," "similar target audience," or "similar
    metadata pattern" matching — no data source for any of those exists in this application, and
    this capability never approximates them. `sharedTitleTokens` on each candidate is a literal
    lowercase word-overlap set, never topic/semantic similarity, never an embedding model (owner
    spec §10 explicitly rules out embeddings for a first implementation).
    `credentialRef` is optional — if omitted, it is resolved automatically to the caller's own
    active identity (the same resolution every other channel-scoped tool already performs for its
    `assertActiveChannel` check) and is only actually used, internally, when `performanceMetric` is
    requested. Videos missing the data a requested duration/performance filter needs are counted in
    `excludedForMissingData`, never silently coerced to a fabricated `0` or dropped without being
    counted.
  - `agent_list_asset_performance` (Phase 7 slice L, owner spec §16) — `{ channelId, assetType?,
    credentialRef?, performanceMetric?, performanceDayOffset?, sort?, limit? }` → `{ assets:
    AssetPerformanceEntry[], performanceAlignment, excludedForMissingLink: { unlinked,
    linkedVideoNotOnChannel }, truncated, metricDefinitions, freshness }`. Joins the existing asset
    catalog (`linkedVideoId`) against each linked video's own already-collected performance data --
    local reads only, never a live YouTube call. Each `AssetPerformanceEntry.linkedVideo` always
    carries LIFETIME totals (`lifetimeViewCount`/`lifetimeLikeCount`/`lifetimeCommentCount`/
    `durationSeconds`, plus `lifetimeCountersAsOf` — when the channel sync last refreshed them, NOT
    when analytics were collected) and an OPTIONAL `ageAlignedPerformanceValue`, computed only when
    `performanceMetric`+`performanceDayOffset` are BOTH given (enforced by the schema itself) --
    `performanceDayOffset` is ALWAYS caller-supplied, NEVER derived from wall-clock "now" (the exact
    mistake independent review found and fixed in slice K, round 1). A video with real data at
    later days but no day-0 coverage (published before regular collection began for its channel)
    correctly reports `null` here while its row and lifetime counters stay intact — this is a JOIN,
    not a filter, so a null performance value never excludes a row. `sort: "lifetimeViewCount"`
    ranks by a NON-age-fair total that structurally favors older videos — never itself a "performed
    better" signal. `excludedForMissingLink` has only two reasons, not three: `unlinked` and
    `linkedVideoNotOnChannel` — a channel-scoped video read cannot structurally distinguish "never
    synced" from "belongs to a different channel," and asset registration itself already validates
    `linkedVideoId` against the same channel at write time, so a genuine cross-channel link should
    not normally occur. `limit` above the maximum is silently clamped, never rejected (the exact
    mistake independent review found and fixed in slice K, round 3). `credentialRef` is optional —
    if omitted, resolved automatically to the caller's own active identity, only actually used when
    `performanceMetric` is requested. Does **not** support thumbnail-CTR/impressions-based questions
    (this application's own analytics collection never fetches YouTube's impressions/CTR metrics at
    all, never approximated via card/annotation click-through metrics), `metadata/version` linkage
    (`linkedVideoId` has no time range and is never independently verified), `experiment/outcome`
    linkage (Phase 10, doesn't exist yet), or Content Proposal reference associations
    (`content_proposal_artifacts` — a structurally different, draft/unactioned relationship, never
    conflated with actual asset usage). Requires `channelId` to be the caller's currently-active
    channel.

  `get_capabilities` also now registers several already-existing, already-implemented tools it
  previously omitted (`channel_list`, `channel_video_list`, `ai_localization_generate`,
  `ai_localization_create_change_set`, and four more `analytics_*` tools, including
  `analytics_comparable_age`) so its own capability list is honest about everything actually
  reachable today, not just what this module itself implements — an agent CAN already compare
  videos or create a localization draft/proposal today, just through those pre-existing tools
  rather than a dedicated `agent-operations`-specific wrapper for either. Content Proposal
  creation/read (Phase 7 slice G1) is now reachable via `agent_create_content_proposal`/
  `agent_get_content_proposal`/`agent_list_content_proposals` above, and external-artifact
  registration (owner spec §19, slice G2) via `agent_register_external_artifact`/
  `agent_list_proposal_artifacts` above. Deliberately **not** reachable through ANY tool yet:
  experiment history (owner spec §20, deferred to Phase 10) — that remains genuinely
  unimplemented, later work outside this phase.
- Analytics read tools (`docs/roadmap/BACKLOG.md`, "machine-readable analytics for operational
  agents to consume" — `docs/roadmap/FUTURE_PHASES.md` §4 / `docs/PROJECT_SPEC.md` §33):
  - `analytics_list` — `{ channelId, startDate?, endDate?, videoId?, metricNames?, credentialRef? }`
    → `{ channelId, rows: StoredVideoMetricRow[] }`. Local read only (never a live YouTube call) —
    every filter is optional; omitting all of them returns every collected row for the channel.
  - `analytics_overview` — `{ channelId, startDate, endDate, credentialRef? }` → channel-level
    daily series plus current/previous-period totals, the same shape `GET .../analytics/overview`
    returns. **A live Analytics API read** (counts against that quota, unlike `analytics_list`) —
    its own totals lag YouTube Studio's displayed numbers by 1-2 days, see
    `docs/ARCHITECTURE.md` §14.8.
  - `analytics_data_quality` — `{ channelId, startDate, endDate, credentialRef? }` → which dates
    in the range were actually covered by a collection run vs. never collected vs. too recent for
    the API to have reported yet, plus which videos had a recorded collection failure. Local read
    only (reads `analytics_collection_runs`, never calls YouTube) — see
    `docs/ARCHITECTURE.md` §14.9.
  - `analytics_comparable_age` — `{ channelId, videoIds (2-10), metricName? (default "views",
    additive metrics only), maxDays? (default 30), credentialRef? }` → per-video raw daily points
    and a running cumulative total, aligned by each video's own days-since-publish (Pacific-Time
    day 0) rather than calendar date. Local read only (reads already-collected
    `video_metrics_daily`, never calls YouTube). A day with no collected row is never fabricated as
    zero — the cumulative series stops at the last contiguous known day. See
    `docs/ARCHITECTURE.md` §14.10 for the day-alignment math and the real data-coverage caveat
    (videos older than ~1-2 weeks before regular collection started typically have no early-life
    data).
  - `analytics_weekly_reports_list` — `{ channelId, credentialRef? }` → every stored weekly
    report snapshot for the channel, newest week first. Local read only.
  - `analytics_weekly_report_get` — `{ channelId, weekStartDate, credentialRef? }` → one stored
    snapshot, or `{ report: null }` if none exists yet for that week. Local read only. See
    `docs/ARCHITECTURE.md` §14.11 for the snapshot's own content shape (`status: "final"` vs.
    `"provisional"`, `syncedVideoTotals`, `percentChange`, `topContent`, embedded provenance) and
    why there is no MCP/CLI tool to generate one on demand -- only the Web UI's own dashboard-mount
    trigger (`runWeeklyReportIfDue`) ever creates or replaces a snapshot.
  - All six are read-only (no local mutation, no YouTube write) — deliberately excludes
    `collectMetrics`/`runAutoCollectionIfStale`/`runWeeklyReportIfDue` (real local-persistence
    mutations; only the Web UI's own "Collect now" button and dashboard-mount triggers can start a
    new collection run or generate/replace a weekly report).
- Market intelligence query tools (Phase 9 slice 4, `docs/roadmap/plans/PHASE_9_SLICE_4_PLAN.md`)
  — fulfil the two capability names `agent-operations` reserved since Phase 7
  (`PLANNED_FUTURE_CAPABILITIES`), using those exact literal names rather than an `agent_`-prefixed
  pair. Neither accepts `credentialRef` (neither makes a live YouTube call) and neither is
  channel-scoped — this data describes channels the operator does not necessarily own
  (`docs/ARCHITECTURE.md` §18).
  - `query_competitors` — `{}` → `{ channels: ResearchChannel[] }`, every channel currently on the
    research watchlist (`channelId`, `handleOrUrl`, `reason`, `addedAt`) — no evidence attached,
    just the roster. Local read only, a direct passthrough of the existing `listWatchlist` service
    call.
  - `query_market_intelligence` — `{ channelId }` → `{ channel: ResearchChannel, evidence:
    ResearchEvidence[], channelSnapshots: MarketChannelSnapshot[], videoSnapshots:
    MarketVideoSnapshot[], topicAssignments: MarketTopicAssignment[], dataQualityFlags:
    DataQualityFlag[] }` (the last four fields added in Phase 9 slice 9G, part A — additive, the
    original `{channel, evidence}` shape is unchanged; `MarketVideoSnapshot` itself additively
    gained a `title: string | null` field in Phase 9 slice 9H part C — `null` for any snapshot
    taken before that field existed, never backfilled or guessed — no `AGENT_API_VERSION` bump,
    per that constant's own doc comment: a new, ignorable field on an existing capability's
    contract is not a new capability), one watchlisted channel's own record plus
    its evidence history (Phase 13: another channel's API-sourced rows -- `youtube.channels.list`/`youtube.videos.list`/`youtube.videos.batchGetStats` snapshots and "Fetch public snapshot" evidence -- only within the last 30 days, YouTube API Developer Policies III.E.4.d; operator-entered rows of any age), via the single `getWatchlistEntryContext` service call (one
    existence check feeding both the channel and evidence lookups — an earlier version called
    `getWatchlistEntry`/`listEvidence` separately, found by independent review to double the
    existence check and risk a non-deterministic error shape). Fails with
    `RESEARCH_CHANNEL_NOT_AVAILABLE` (`details: { channelId }`) if `channelId` is not on the
    watchlist. Local read only. `confidence` on an evidence row is uncalibrated free text, not a
    statistical measure — a `fetchPublicSnapshot`-sourced row can read `"high"` even when every
    underlying count was hidden/absent (`docs/roadmap/plans/PHASE_9_PLAN.md` §8, still an open
    vocabulary decision).
  - `agent_list_market_records` (Phase 9 slice 9G, part A) — `{ kind: "topics" |
    "trend_candidates" | "discovery_candidates" }` → `{ kind, topics }` / `{ kind, trendCandidates }`
    / `{ kind, candidates }` respectively. One tool with a `kind` discriminator rather than three
    separate ones (owner spec §28), a thin fan-out over the module's own already-existing
    `listTopics`/`listTrendCandidates`/`listDiscoveryCandidates` — no new service logic.
  - `agent_create_market_research_request` (Phase 9 slice 9G, part B, owner spec §29) — `{ query,
    rationale, monitorDurationDays? }` → the created request, `status: "pending"`. This domain's
    first DRAFT-class capability (`market_intelligence.agent_create_market_research_request`) —
    gated by the same
    device-availability check as `agent_create_content_proposal`. `createdVia`/`agentApiVersion`
    (owner spec §22) are SERVER-STAMPED — `"mcp"` + the real `AGENT_API_VERSION` for this transport,
    `"cli"` + `null` for the CLI command (mirrors `agent_create_content_proposal`'s own convention:
    MCP is the one transport this interface's version actually mediates).
    `monitorDurationDays` is stored and returned as descriptive metadata only — no code path in this
    application ever reads it to decide whether/when to run anything (there is no scheduler here at
    all), which is the structural answer to "this must not automatically create unlimited collection
    jobs." **There is no MCP tool or CLI command to approve or reject a request, and none is ever
    planned without a fresh, explicit owner instruction overriding this slice's own core design** —
    approval is reachable ONLY through the Web UI (`POST
    /api/market-intelligence/research-requests/[requestId]/approve` — no body, uses the approving
    human's own session credentials for the one real `search.list` call this triggers via the
    existing `discoverChannels`/`agent_discover` pipeline; `POST .../reject` — `{ reason }`; `GET
    /api/market-intelligence/research-requests` lists all requests for the review queue), verified
    mechanically by `market-research-request-approval-inventory.test.ts` (scans `src/mcp/**`/
    `src/cli/**`/`src/lib/agent-operations/**`, `src/app/api/**` exempted).
  - All four registered directly against `createMarketIntelligenceCore()` in `src/mcp/server.ts`/
    `src/cli/video-metadata.ts`, not through `agent-operations`'s own service layer —
    `docs/ARCHITECTURE.md` §18 records why (module-independence, `PHASE_9_PLAN.md` §5).
    CLI parity: `agent competitors` / `agent market-intelligence --channelId <UC...>` / `agent
    market-records --kind <kind>` / `agent create-research-request --query <q> --rationale <r>
    [--monitorDurationDays <n>]`.

- **Decision & Experiment Engine (Phase 10 slice 2, `docs/roadmap/plans/PHASE_10_SLICE_2_PLAN.md`):**
  - `agent_list_hypotheses` — `{}` → `{ hypotheses: Hypothesis[] }`, already channel-filtered by the
    service layer (channel-scoped rows narrowed to the caller's active channel, channel-less rows
    always included).
  - `agent_get_hypothesis_trail` — `{ hypothesisId }` → `{ hypothesis, experiments: (Experiment &
    { outcomes: ExperimentOutcome[] })[], evidence: HypothesisEvidence[] }`. One combined "trail"
    read (owner spec §25's "few composable tools" rule) rather than five separate list/get tools;
    composed from `decision-engine`'s own `getHypothesisTrail` service function.
    `HYPOTHESIS_NOT_FOUND` for an unknown id. `evidence` added additively in Phase 10 slice 3
    (`docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md`) — no `AGENT_API_VERSION` bump, per that
    constant's own doc comment (a purely additive, backward-compatible widening of an existing
    tool's output is not a capability-discovery-relevant change).
  - `create_experiment_proposal` — `{ hypothesisId, treatment, controlBaseline, successCriteria,
    stoppingCriteria, responsible, startConditions?, plannedDuration?, sampleCoverageConstraints?,
    budgetEstimate? }` → the created experiment, always `status: "proposed"` (schema is `.strict()`,
    no `status` field accepted at all). The one reserved capability name
    (`PLANNED_FUTURE_CAPABILITIES` since Phase 7, `decision_engine.create_experiment_proposal`),
    gated the same way as
    `agent_create_market_research_request`. `createdVia`: `"mcp"`/`"cli"` (persisted, matches
    `Experiment.createdVia`). The MCP/CLI handler also passes `createdBy: "agent"` in the
    service-layer call's `ctx` (never a real user id, since MCP/CLI callers have no session), but
    `createExperiment`/`insertExperiment` never actually persist `createdBy` anywhere -- the
    `Experiment` type has no such field, only `responsible` (a caller-supplied input value, not an
    identity stamp).
  - `agent_export_research_data` (BL-119, ADR 0019) — `{ channelId, researchChannelIds?, includeOwnChannel?=true, formats?=["csv"] }` (`.strict()`; no path or file name) → `{ generatedAt, exportsDir, files: [{ dataset, format, path, rows, bytes, expiresAt }], watchlistChannels: { exported, withoutSnapshots }, retentionNote }`. `DRAFT`, channel-scoped, passes the mutation gate; writes into the fixed folder `<channel workspace>/99 Data Exchange/From YTM/` (created on the first export; owner-approved exception, ADR 0019 amendment). Errors `RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED` / `RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE` / `RESEARCH_EXPORT_WRITE_FAILED`. `query_market_overview` — `{ channelIds?, limit?=50 (max 200), offset?=0 }` → `{ total, offset, limit, channels: [{ channelId, handleOrUrl, latestChannelSnapshot, channelSnapshotCount, videoSnapshotCount, evidenceCount, dataQualityFlags }], nextOffset }`; `READ`, local. `agent_query_channel_reach` also takes `videoId` and `groupBy: "video_day"` (adds `videoDaily`, capped at 5000 rows); `agent_query_video_analytics` takes `format: "wide"` (`wideRows`, `rows` empty); `channel_video_list` takes `fields`, `limit` (max 500), `offset` (→ `{ channelId, videos, total, offset, nextOffset }`). Agent API 3.1.0.
  - `agent_create_collection_request` (ADR 0021) — `{ researchChannelIds?: string[], reason?: string (<= 500) }` (`.strict()`; no force) → `{ created, request, notNeeded: [{ channelId, reason: "collected_recently"|"recent_failure", hoursSince }], alreadyRequested: [{ channelId, requestId }] }`. `DRAFT`, channel-bound, passes the mutation gate; zero YouTube calls. `request` = `{ requestId, channelIds, reason, status, estimate: { channels: [{ channelId, mode, expectedUnits, worstCaseUnits }], totalExpectedUnits, totalWorstCaseUnits, dailyBudgetUnits, unitsSpentToday, remainingTodayUnits, fitsToday }, result, unitsSpentTotal, error, ... }`; units are YouTube quota units, estimates are upper bounds (incremental: about 2, at most 5); `alreadyRequested[].requestId` only for requests assigned to the caller; a `done` request can have every channel skipped_*, read `result`. Errors `MARKET_INTELLIGENCE_QUOTA_DISABLED` (no daily budget), `RESEARCH_CHANNEL_NOT_AVAILABLE`. `agent_get_collection_request` — `{ requestId? }` → `{ request }` or `{ requests }` (latest 20 assigned to the caller); per-channel `result` entries `{ channelId, outcome: completed|partial_budget|failed|skipped_not_stale|skipped_recent_failure|skipped_quota_limited, videosStored, newSnapshotsObservedAt, unitsSpent }`; `COLLECTION_REQUEST_NOT_FOUND` for an unknown or unassigned id. `agent_get_collection_limits` — `{}` → `{ dailyBudgetUnits|null, unitsSpentToday, remainingTodayUnits|null, quotaDayResetsAt, defaultMaxVideosPerChannel, defaultPublishedAfter, staleWindowHours, perChannelOverrides }`; both `READ`, local. CLI: `agent create-collection-request [--researchChannelIds a,b] [--reason ...]`, `agent collection-limits`. Approve/run/reject are Web-only (`POST /api/market-intelligence/collection-requests/[requestId]/approve|reject`, session required; approve blocks until the run finishes). Agent API 3.2.0.
  - `agent_list_logical_paths` / `agent_get_logical_path` (BL-129, ADR 0022; Agent API 3.3.0) — `{}` / `{ name }` (both `.strict()`; an extra field such as `scope` or `path` is rejected) →
    `{ paths: [{ name, description, configured: false } | { name, description, configured: true, path }] }` / `{ name, path }`. `READ`, local, not channel-scoped
    (an instance-wide registry). Only paths the operator made visible to all agents are returned, with THIS device's value. `agent_get_logical_path` fails with
    `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE` when no value is set on this device (never an empty path) and with `LOGICAL_PATH_NOT_FOUND` for an unknown
    name or a path not available to agents (the two are indistinguishable). The string is returned exactly as stored; nothing at or under it is touched.
    No MCP tool can create, set or delete a path: only the operator, through the Settings UI (`/api/logical-paths`).
  - `agent_get_channel_workspace` (Phase 11, `docs/AGENT_OPERATIONS_INTERFACE.md` §4m) —
    `{ channelId }` (`.strict()`) → `{ configured: false } | { configured: true, path: string }`.
    `READ`, channel-scoped (`assertActiveChannel`, like `agent_get_channel_context`).
    It returns the operator-set absolute path for this device exactly as stored and never touches
    anything at or under that path. It only reads the app's own bootstrap config, for the
    `deviceId`, and never creates it. No MCP tool can set or clear it: `PUT /api/channel-workspaces` (Web UI
    only) is the sole setter. Device-local, never synced or handed off. Error codes
    (setter only): `CHANNEL_WORKSPACE_PATH_INVALID` (400) and
    `CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED` (404).
  - **There is no MCP tool or CLI command to create a hypothesis from scratch, transition an
    experiment's status, or record an outcome** — all Web-UI-only, verified mechanically by
    `decision-engine-agent-approval-inventory.test.ts` (`PHASE10-INV-02`, same scan technique as
    `market-research-request-approval-inventory.test.ts` above).
  - All three registered directly against `createDecisionEngineCore()` in `src/mcp/server.ts`/
    `src/cli/video-metadata.ts`, not through `agent-operations`'s own service layer — same
    module-independence reasoning as market-intelligence above; `decision-engine`'s own service
    layer already does its own channel-access assertion internally, so no separate check is needed
    in the MCP/CLI handler layer.
    CLI parity: `agent list-hypotheses` / `agent get-hypothesis-trail --hypothesisId <id>` / `agent
    create-experiment-proposal --hypothesisId <id> --treatment <t> --controlBaseline <c>
    --successCriteria <s> --stoppingCriteria <st> --responsible <r> [--startConditions <...>]
    [--plannedDuration <...>] [--sampleCoverageConstraints <...>] [--budgetEstimate <...>]`.

Most tools accept optional `credentialRef`; if omitted, server falls back to active local auth context.

### MCP connection (Settings tab toggle, off by default)

Renamed and inverted 2026-09-21 from the earlier "restricted mode" (owner instruction: *"По
началу MCP / агент от всего отключен и получит доступ только если я зайду в настройки и
переключу этот тумблер... Все взаимодействия MCP / агента должны идти через это переключение"*).

The endpoint reads the persisted setting (`getMcpConnectionEnabled`, `src/lib/db.ts`) **on every
request** and passes it to `createMcpServer(core, { connectionEnabled, agentSession })`, built fresh per
request. **While disconnected (the default, and the state of every newly-created local database), the
endpoint answers `403` and registers nothing** -- no read/propose/create tool is reachable. There is no
environment-variable override: the Settings-tab toggle is the one and only way to grant a connection any
access.

**Since Phase 12 this toggle is the master switch only** (`docs/roadmap/plans/PHASE_12_PLAN.md`). With it
on, a request still gets nothing unless it carries a valid channel token (issued in Settings → Channels,
sent as a Bearer token). A valid token binds that one request to that one channel (see "Channel-bound
agent sessions" below). Write tools remain separately gated by the unrelated "Live writes" toggle
(`docs/decisions/0005-youtube-write-gateway.md`). Turning on "MCP connection" alone never sends anything
to YouTube.

Persisted across restarts once turned on -- unlike "Live writes" (which resets to off every session by
design), this is a one-time setup step, per explicit project-owner instruction. Because the server is
stateless, flipping the setting, or revoking/rotating a token, applies to the very next request; no
client restart is needed.

This is the concrete implementation of Phase 7's "operation-specific permissions and read-only
access to application data" (`docs/roadmap/FUTURE_PHASES.md` §3) taken to its safer, default-deny
conclusion — no MCP client, including a future Codex operations connection, gets any access
until the project owner deliberately opts in.

### Channel-bound agent sessions (Phase 12, `docs/roadmap/plans/PHASE_12_PLAN.md`)

Owner direction, 2026-09-30: *one agent = one channel*; an agent without a token receives
nothing. This replaces BL-091's per-capability zones, which are retired in
`docs/decisions/0011-retire-agent-capability-zones.md`.

- **Token.** In Settings → Channels, each channel row has "Agent token" (Issue / Rotate / Revoke).
  - Backed by `GET/POST/DELETE /api/agent-tokens`.
  - The token is shown once, and only its SHA-256 hash is stored, on this device only.
  - Issuing requires the channel's recorded Google identity to own the channel live. Issuing
    again revokes the previous token.
- **Session.** The token arrives per request as a Bearer credential. A valid token puts that request
  (and only it) into that channel's scope, carried by an `AsyncLocalStorage`
  (`src/lib/agent-session`; there is no process-wide scope, and before every tool handler the wrapper
  asserts that the ambient scope is exactly this request's token, failing closed otherwise):
  - every channel-scoped check uses the bound channel;
  - credentials are always the token's recorded identity, and a caller `credentialRef` /
    `--userId` / `--accessToken` is rejected (`AGENT_SESSION_CREDENTIAL_OVERRIDE`);
  - the operator's selected channel is neither read nor changed.

  The token is re-verified on every MCP call, so revocation takes effect immediately
  (`AGENT_TOKEN_INVALID`). A token is also invalid once its channel is disconnected or reconnected
  under another Google identity, and disconnecting revokes it. The "MCP connection" master switch
  gates every agent request.
- **What an agent session can reach.**
  - Only tools classified `bound` (`src/mcp/tool-classification.ts`, enforced by an inventory test).
  - Operator-only, and never available to an agent: `write_channel_select`, `write_channel_list`,
    `auth_user_select`, and the global
    operations-workspace tools (owner decision D2: channel folders only).
  - `list` / `transcript` / `preview` / `channel_sync` are confined to the bound channel.
  - Market tools return only records the operator assigned to that channel (below).
  - Channel-less hypotheses are invisible.
- **Market record assignment (owner decision D1).**
  - Market data is collected once. The operator assigns individual watchlist entries, topics,
    trend candidates, discovery candidates and research requests to channels, using the
    "Visible to agents of:" chips on the Research panels (`GET/PUT /api/market-assignments`).
  - A research request an agent creates is owned by its channel automatically.
- **CLI.** It is the operator's tool and runs only while Settings → AI Agent → "Operator CLI access"
  is on (default off). Otherwise it is refused, so a shell-capable agent cannot run it from the
  project folder.
- **Limit (RISK-87).** This is an in-app wall. It stops agent mistakes, not an agent that
  deliberately finds and reads `data.db` or another agent's client configuration as the same OS user.
  See `docs/AGENT_ISOLATION_SETUP.md`.

---

## Factory Operator MCP endpoint (`POST /api/mcp/factory`, BL-129, ADR 0022)

A second agent role, separate from the channel agents. Technical contract only (no operating instructions for the role).

- **Transport:** stateless Streamable HTTP, loopback only, `Authorization: Bearer ytom_fo_...`. Order of checks: loopback (403 `AGENT_ENDPOINT_NOT_LOOPBACK`),
  POST only (405), the MCP connection switch (403 `MCP_CONNECTION_DISABLED`), a token (401 `AGENT_TOKEN_REQUIRED`), the token (401 `AGENT_TOKEN_INVALID` for an
  unknown, revoked or wrong-type token, including a channel token; 503 `AGENT_ENDPOINT_UNAVAILABLE` if the database cannot answer). The token is re-verified on
  every tool call, so a revocation applies to the next call. A factory token on `/api/mcp` is rejected the same way.
- **Factory API version:** `1.0.0` (`factory_get_capabilities`), independent of `AGENT_API_VERSION`.
- **Tools (a closed list; all `READ`, local, no YouTube call, all inputs `.strict()`):**
  - `factory_get_capabilities` — `{}` → `{ role: "factory_operator", factoryApiVersion, tools: [...], permissions: ["READ"] }`.
  - `factory_list_logical_paths` — `{}` → `{ paths: [{ name, description, configured: false } | { name, description, configured: true, path }] }` for every path, with THIS device's value.
  - `factory_get_logical_path` — `{ name }` → `{ name, path }`; errors `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE` (defined, no value on this device; never an empty path) and `LOGICAL_PATH_NOT_FOUND`.
  - `factory_list_channels` — `{}` → `{ channels: [{ channelId, title, workspace: { configured: false } | { configured: true, path } }] }`. No account identity, token, video or analytics data.
- **Not available to this role:** every channel tool, every write, `write_*`/`auth_*`, YouTube reads. It cannot create, set or delete a path or issue a token.
- **Tool errors** use the same `{ ok: false, error: { code, message, details } }` shape as the channel server.

## API Route Handlers (selected)

All routes are App Router handlers and require authenticated session user.

### Metadata API

- `POST /api/video-metadata/transcript`
  - body: `{ "videoId": "..." }`
- `POST /api/video-metadata/preview`
  - body: `{ "videoId": "...", "editorialPrompt": "..." }`
- `POST /api/video-metadata/apply`
  - body: `{ "videoId": "...", "finalTitle": "...", "description": "...", "expectedChannelId": "UC...", "dryRun": true|false }`

### Channel sync API (read-only)

- `GET /api/channels` — list locally synchronized channels
- `POST /api/channels/sync` — synchronize a channel (`{ "channelId"?: "UC..." }`; omitted = the
  authenticated account's own channel)
- `GET /api/channels/[channelId]/videos` — list synchronized videos + existing localization languages

### Agent Operations API (Phase 7 slice A)

- `GET /api/agent-operations/capabilities` — same shape/underlying function as the MCP tool
  `agent_get_capabilities` above (see `docs/AGENT_OPERATIONS_INTERFACE.md`). Read-only, gated by
  the same NextAuth session check as every other route in this app; not channel-scoped.

### Agent tokens and market assignments API (Phase 12, `docs/roadmap/plans/PHASE_12_PLAN.md`)

Both are operator-only and require a NextAuth session. The mutating methods are gated by
`src/proxy.ts`.

- `GET /api/agent-tokens` → `{ tokens: [{ tokenId, channelId, label, createdAt }] }` (metadata only).
- Logical paths and the Factory Operator token (BL-129, ADR 0022), all operator-only (session required, 401 otherwise):
  - `GET /api/logical-paths` → `{ paths: [{ name, audience, description, path | null, status: "exists" | "missing" | null, updatedAt | null }] }` (this device's value; `status` is a one-time check of the stored path).
  - `POST /api/logical-paths` with `{ name, audience: "all_agents" | "factory_only", description? }` → `201 { path: { name } }`; `LOGICAL_PATH_ALREADY_EXISTS` (409), invalid name `validation_failed` (400).
  - `DELETE /api/logical-paths` with `{ name }` → `{ path: { name } }` (also removes its values); `LOGICAL_PATH_NOT_FOUND` (404).
  - `PUT /api/logical-paths/value` with `{ name, path | null }` → `{ value: { name, path | null } }`; `null` or blank clears this device's value; `LOGICAL_PATH_VALUE_INVALID` (400) for a path that is not an absolute existing directory outside app-data.
  - `GET /api/factory-agent-token` → `{ token: { tokenId, label, createdAt } | null }`; `POST` (body `{ label? }`, strict) → `201 { token: { ..., token } }` with `cache-control: no-store`, the plaintext exactly once; `DELETE` → `{ revoked: n }`. Issuing again revokes the previous token.
- `POST /api/agent-tokens` with `{ channelId, label? }` → `201 { token: { ..., token } }`, with
  `cache-control: no-store`. The plaintext is returned exactly once. It revokes the channel's
  previous token. Errors: `AGENT_TOKEN_CHANNEL_NOT_CONNECTED` (404),
  `AGENT_TOKEN_IDENTITY_MISMATCH` (409).
- `DELETE /api/agent-tokens` with `{ channelId }` → `{ revoked: n }`. Idempotent.
- `GET /api/market-assignments?recordKind=<research_channel|topic|trend_candidate|discovery_candidate|research_request>`
  → `{ assignments: [{ recordKind, recordId, channelIds }] }`.
- `PUT /api/market-assignments` with `{ recordKind, recordId, channelIds }` replaces that record's
  channel set. Every channel must be connected and the record must exist.

### Channel Workspaces API (Phase 11, `docs/roadmap/plans/PHASE_11_PLAN.md`)

- `GET /api/channel-workspaces` → `{ workspaces: [{ channelId, path | null, updatedAt | null }] }`.
  Returns one entry per connected channel, for this device only.
- `PUT /api/channel-workspaces` with `{ channelId, path | null }` → `{ workspace: { configured,
  path? } }`. This is the only setter anywhere. `null` or blank clears the value.
  - The channel must be connected (`CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED`, 404).
  - The path must be absolute, exist, be a directory, and not overlap app-data
    (`CHANNEL_WORKSPACE_PATH_INVALID`, 400).
  - Gated by the `proxy.ts` mutation gate.
- Both require a NextAuth session. They are not active-channel-scoped: the Settings → Channels
  card manages every connected channel.

### Market Intelligence API (Phase 9 slices 1-4/9A-9E/9G — previously undocumented here, per `AGENTS.md` §H)

All routes are global (not scoped to one owned channel) -- the research watchlist tracks channels
the operator does not necessarily own (`docs/ARCHITECTURE.md` §18).

- `GET /api/market-intelligence/channels` — list the watchlist; `POST` — add a channel (`{ channelId, handleOrUrl?, reason }`)
- `GET /api/market-intelligence/channels/[channelId]` — one watchlist entry + its evidence history (Phase 13: another channel's API-sourced rows -- `youtube.channels.list`/`youtube.videos.list`/`youtube.videos.batchGetStats` snapshots and "Fetch public snapshot" evidence -- only within the last 30 days, YouTube API Developer Policies III.E.4.d; operator-entered rows of any age); `DELETE` — remove it (cascade-deletes its evidence/snapshots)
- `GET /api/market-intelligence/channels/[channelId]/evidence` — the recorded observations for the channel (Phase 13: API-sourced rows only within the last 30 days, operator-entered rows at any age); `POST` — record one manually (`{ observation, source, confidence? }`; `source` is free text but must not be one of the strings the API collection stamps itself, `youtube.channels.list` / `youtube.videos.list` / `youtube.videos.batchGetStats` — `validation_failed`)
- `POST /api/market-intelligence/channels/[channelId]/fetch-public-snapshot` — the one slice-3 action making a real `channels.list` call; records a free-text evidence row
- `POST /api/market-intelligence/collect-if-stale` (Phase 9 slice 9B) — repeatable, budget-aware auto-refresh: every watchlisted channel stale by >24h gets a channel snapshot + up to 50 newest video snapshots, gated by the operator-set daily unit budget (`marketIntelligenceDailyQuotaBudgetUnits`, Settings tab); triggered once per dashboard mount (chained after the two Phase 8 analytics calls), real mutation, gated by `src/proxy.ts` like `analytics/auto-collect`; no request body
- `GET/POST /api/market-intelligence/collection-depth` and `GET/POST /api/market-intelligence/channels/[channelId]/collection-depth` (operator request 2026-10-04) — the global default and a watchlist entry's override of the competitor collection depth (`maxVideosPerChannel` integer 1..2000 or null, `publishedAfter` `YYYY-MM-DD` or null; null = default / unset = 50 videos, no date), plus (per channel) `collectionProgress` (videos stored, complete, estimated first-collection units). Session only, like the other watchlist routes; Web UI only, no MCP/CLI write contract. MCP read side: `query_market_overview` per-channel `collection`, `query_market_intelligence` `collectionProgress`, data-quality flag `feed_fallback_used`.
- `GET /api/market-intelligence/discover` (Phase 13 slice 13.4) — today's `search.list` usage against its own bucket (`{ searchesUsedToday, dailyLimit: 100, quotaDayStartedAt }`, the quota day starting at midnight Pacific)
- `POST /api/market-intelligence/discover` (Phase 9 slice 9C; quota revised in Phase 13 slice 13.4) — `{ query }`; one `search.list` call (1 unit from its own bucket of 100 calls a day, refused when that bucket is used up; it does not draw on the collection budget), only ever called from an explicit Research-tab UI click, never automatic; upserts discovery candidates (dedup against the watchlist and existing candidates)
- `GET /api/market-intelligence/discovery-candidates` — list all discovery candidates, newest `lastSeenAt` first (Phase 13: a candidate not seen for over 30 days is hidden while `"new"`, or returned with `title: ""`/`reasonDiscovered: null` once the operator has decided on it; rediscovery refreshes `lastSeenAt`, `title` and `reasonDiscovered`)
- `GET /api/market-intelligence/music-chart?region=XX` (Phase 13 slice 13.9) — the current YouTube Music chart for one region of the fixed `MUSIC_CHART_REGIONS` list (anything else is `validation_failed`); 1 unit per region per 30 minutes (in-memory cache), never persisted
- `GET /api/market-intelligence/topics/[topicId]/wikipedia` (Phase 13 slice 13.8) — the topic's linked Wikipedia articles and their 30-day pageview sums; `POST` — link one (`{ article, project? }`, an article title or a `*.wikipedia.org/wiki/...` link)
- `DELETE /api/market-intelligence/topics/[topicId]/wikipedia/[linkId]` — unlink one article from that topic (and only that topic)
- `PATCH /api/market-intelligence/discovery-candidates/[channelId]` — `{ status: "watching" | "ignored" | "archived" }` (never `"promoted"`, which has its own route below)
- `POST /api/market-intelligence/discovery-candidates/[channelId]/promote` — `{ reason }`; adds the candidate to the watchlist and marks it `"promoted"`
- `GET /api/market-intelligence/topics` (Phase 9 slice 9E, part A) — list topics; `POST` — create one (`{ name }`, rejects a normalized-comparison duplicate)
- `DELETE /api/market-intelligence/topics/[topicId]` — removes a topic, cascades its own assignments, detaches (never deletes) any trend candidate tagged with it
- `GET /api/market-intelligence/topics/[topicId]/assignments` — assignments for a topic; `POST` — assign a subject (`{ subjectType: "channel" | "video", subjectId }`; a channel subject must already be on the watchlist, a video subject id is only format-checked)
- `DELETE /api/market-intelligence/topic-assignments/[assignmentId]` — removes one assignment
- `GET /api/market-intelligence/trend-candidates` (Phase 9 slice 9E, part B; `GET` switched to `listTrendCandidatesWithFreshness` in slice 9H part A) — list trend candidates, each paired with a `freshness: "fresh" | "needs_attention"` label (`TREND_EVIDENCE_FRESH_WINDOW_DAYS` = 30, a UI-only addition — the underlying `marketTrendCandidateSchema`/`agent_list_market_records` MCP contract is unchanged); `POST` — create one (`{ title, description?, topicId?, initialEvidence: { evidenceType, referenceId?, description } }`; always starts at status `"emerging"`; creation is rejected without `initialEvidence`, spec §14; a discriminated union on `evidenceType` requires `referenceId` to be a real YouTube channel id for `supporting_channel` / a real video id for `supporting_video`, absent for `signal` — never a free-typed title, `AGENTS.md` §F)
- `PATCH /api/market-intelligence/trend-candidates/[trendCandidateId]` — `{ status, reason }`; changes lifecycle status, writing `reason` as a `"signal"` evidence row in the same action (a status can never move without a corresponding evidence trail)
- `GET /api/market-intelligence/trend-candidates/[trendCandidateId]/evidence` (`GET` switched to `getTrendEvidenceSummary` in slice 9H part A) — evidence for the trend candidate, newest-first, plus `independentChannelCount` (distinct `referenceId`s among `supporting_channel` rows) — the core's own `getTrendEvidence` action (renamed from `listTrendEvidence`, no MCP/CLI caller) keeps its own ascending order unchanged; `POST` — record one (`{ evidenceType, referenceId?, description }`, same per-type `referenceId` shape as above) without changing status
- `GET /api/market-intelligence/channels/[channelId]/intelligence-summary` (Phase 9 slice 9H, part A) — `getChannelIntelligenceSummary`: `getWatchlistEntryContext`'s own fields (minus `videoSnapshots`, see below) plus `subscriberVelocity`/`uploadCadence` (`FieldVelocity`, 7-day window -- **Phase 13 (III.E.4.h): values derived from another channel's API data are withheld.** Phase 13 returns `{ value: null, basis: "withheld_by_policy" }` for both), `recentBreakoutVideos` (always empty in Phase 13; the pre-13 leave-one-out baseline is described in `docs/ARCHITECTURE.md` §18), `emergingChannel` (an assessment whose reason cites the policy), `latestSnapshotPerVideo` (one row per video, not the full append-only series), and a `methodology` object with the named constants driving all of the above (so the UI never hardcodes a copy that could drift)
- `GET /api/market-intelligence/channels/[channelId]/videos/[videoId]/snapshot-history` (Phase 9 slice 9H, part A) — one video's own full snapshot series, filtered server-side before returning — the bounded drill-down `intelligence-summary` deliberately omits (RISK-78, `docs/TECHNICAL_DEBT.md`)
- `GET /api/market-intelligence/overview` (Phase 9 slice 9H, part B) — `getMarketOverview`: aggregates across the whole watchlist — `newDiscoveries` (`status: "new"` discovery candidates), `breakoutVideos`/`emergingChannels` (one `getChannelIntelligenceSummary` call per watchlisted channel, tagged `channelId` and filtered to `isBreakout`/`isEmerging` -- always empty in Phase 13, because those values are withheld, III.E.4.h), `trendCandidates` (direct passthrough of `listTrendCandidatesWithFreshness`), `collectionWarnings` (a channel appears only for `stale_observation`/`quota_limited`/`missing_snapshot` — never the full `DataQualityFlag` set, `hidden_subscriber_count` is deliberately excluded — or a `"failed"` latest collection run, or `neverObserved: true` for a channel with zero snapshots and no successful collection run ever -- Phase 13: expired API snapshots alone do not make a channel "never observed"). Web UI only, no MCP/CLI contract
- `GET /api/market-intelligence/videos-overview` (Phase 9 slice 9H, part C) — `getMarketVideosOverview`: per-video aggregation across the whole watchlist — `title`/`publishedAt`/`viewCount`/`observedAt` (the video's latest known snapshot; `title` is `null` for a pre-migration snapshot), `velocity` (`FieldVelocity`; Phase 13: always `{ value: null, basis: "withheld_by_policy" }`, III.E.4.h), `breakout` (Phase 13: always `null`), `topics` (`{topicId, name}[]`, resolved via one `listTopics()` call plus one new bulk `db.ts` read, `listMarketTopicAssignmentsBySubjectType("video")` — never one call per video). Web UI only, no MCP/CLI contract of its own
- `GET /api/market-intelligence/research-requests` (Phase 9 slice 9G, part B) — list all agent-created research requests, for the Web UI's own review queue
- `POST /api/market-intelligence/research-requests/[requestId]/approve` — no request body; the ONLY way a request moves `pending -> approved` (verified mechanically, see `docs/ARCHITECTURE.md` §18) — uses the approving human's own session credentials for the one real `search.list` call this triggers; records `status: "executed"` + `candidatesFound`/`candidatesNew` on success, `status: "execution_failed"` + `executionError` on failure (never reverts the approval itself)
- `POST /api/market-intelligence/research-requests/[requestId]/reject` — `{ reason }`; the ONLY way a request moves `pending -> rejected`

### Decision & Experiment Engine API (Phase 10 slices 1-4, `docs/roadmap/plans/PHASE_10_SLICE_{1,3,4}_PLAN.md`)

All routes are global (not nested under `/api/channels/[channelId]/...`) — a hypothesis is only
*sometimes* channel-scoped (`channelId` nullable; a "new channel concept" hypothesis has none),
mirroring Market Intelligence's own global routing shape (`docs/ARCHITECTURE.md` §19). Every
route checks the caller's active channel (`channelAccess.assertActiveChannel`) whenever the
resource it resolves to has a non-null `channelId` — including reads, not only creation.

- `GET /api/decision-engine/hypotheses` — list hypotheses, narrowed to the session's active channel for channel-scoped rows, always including channel-less ones; `POST` — create one (`{ channelId?, statement, evidenceNotes }`)
- `GET /api/decision-engine/hypotheses/[hypothesisId]` — one hypothesis
- `GET /api/decision-engine/hypotheses/[hypothesisId]/experiments` — experiments for a hypothesis; `POST` — create one (`{ treatment, controlBaseline, successCriteria, stoppingCriteria, startConditions?, plannedDuration?, sampleCoverageConstraints?, budgetEstimate?, responsible }`; always starts at status `"proposed"`)
- `GET /api/decision-engine/experiments/[experimentId]` — one experiment
- `POST /api/decision-engine/experiments/[experimentId]/transition` — `{ targetStatus }`; the ONLY way `status`/`approvedBy`/`approvedAt` change, via one atomic `UPDATE ... WHERE status IN (<valid predecessors>) ... RETURNING` (`EXPERIMENT_INVALID_TRANSITION` if the row's real current status no longer allows it — including a losing concurrent race); `approvedBy` is server-stamped from the session, never accepted in the request body
- `GET /api/decision-engine/experiments/[experimentId]/outcomes` — outcomes for an experiment, newest-first (append-only, no update/delete route exists); `POST` — record one (`{ outcomeData, dataQualityLimitations?, criteriaMet: "met" | "not_met" | "inconclusive", lessonsLearned? }`; rejected with `EXPERIMENT_NOT_OBSERVABLE` unless the experiment's status is `running`/`concluded`/`abandoned`)
- `GET /api/decision-engine/hypotheses/[hypothesisId]/evidence` — structured evidence references for a hypothesis, newest-first (append-only, no update/delete route exists); `POST` — add one (`{ reference: EvidenceReference, note? }`, Phase 10 slice 3, `docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md`) — `reference` is a discriminated union (`phase8_metric`/`phase9_channel_snapshot`/`phase9_video_snapshot`/`phase9_trend_candidate`), validated against the real Phase 8/9 row before insert (`validation_failed` if it doesn't exist); the route file (not `decision-engine`'s own module) is the only place that constructs the real resolver against `analyticsCore`/`marketIntelligenceCore` (`src/app/api/decision-engine/evidence-reference-resolver.ts`)
- `POST /api/decision-engine/hypotheses/generate` — AI-generated hypothesis draft, preview only, persists nothing (Phase 10 slice 4, `docs/roadmap/plans/PHASE_10_SLICE_4_PLAN.md`) — `{ channelId?, notes, evidenceReferences?: EvidenceReference[], connectionId? }` → `{ draft: { statement, rationale, providerName, connectionId, evidenceReferences } }`; `connectionId` omitted uses the mock provider; `proxy.ts`-exempt (read-only with respect to local persistence, same classification as `/ai-localization/generate`)
- `POST /api/decision-engine/hypotheses/generate/save` — persists a (possibly human-edited) generated draft: creates the hypothesis, attaches every evidence reference (re-validated, never trusted from the `generate` call), and records one `hypothesis_generation_provenance` row — `{ channelId?, finalStatement, evidenceNotes, evidenceReferences?, generatedStatement, rationale?, providerName, connectionId?, modelId? }` → `{ hypothesis: Hypothesis }`; NOT `proxy.ts`-exempt, a real mutation like the plain `POST /hypotheses` route
- `PUT /api/decision-engine/experiments/[experimentId]/change-set` — attach or detach the Change Set this (localization-type) experiment will execute (Phase 10 slice 5, `docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md`) — `{ changeSetId: string | null }` → `{ experiment: Experiment }`; only legal in status `proposed`/`approved`, and only while no fresh execution claim is held; attaching validates the Change Set actually exists for the hypothesis's own channel (`EXPERIMENT_CHANGE_SET_NOT_FOUND`/`EXPERIMENT_CHANGE_SET_CHANNEL_MISMATCH`)
- `POST /api/decision-engine/experiments/[experimentId]/execute` — creates a real Batch from the attached Change Set's own eligible approved changes, via the existing Change Set/Batch pipeline (Phase 10 slice 5) — `{ live?: boolean }` → `{ experiment: Experiment, batchId, videoCount, dryRun }`; requires status `"approved"` with a Change Set attached (`EXPERIMENT_NOT_EXECUTABLE` otherwise); `dryRun` mirrors `/api/channels/[channelId]/batches`' own fail-closed Live Writes gate exactly (`live: true` honored only when that toggle is already on server-side, via `getLiveWritesEnabled()` — never assumed from the request); claim-first internally (`execution_claimed_at`, 15-minute expiry, same precedent as Phase 9's collection claim) so two concurrent calls can never both create a Batch; moves `status` to `"running"` only on success — a manual `POST .../transition {targetStatus:"running"}` is refused (`EXPERIMENT_MUST_USE_EXECUTE`) once a Change Set is attached

MCP/CLI contract: `agent_list_hypotheses`/`agent_get_hypothesis_trail` (read) and `create_experiment_proposal` (draft) exist since slice 2 (`docs/ARCHITECTURE.md` §19) — creating a hypothesis from scratch, AI generation, transitioning status, and recording an outcome remain Web-UI-only, mechanically verified.

### Analytics API (Phase 8 + Studio-Parity S6b, BL-055..059/BL-072 — previously undocumented here)

- BL-120: `GET /api/channels/{id}/analytics/overview` now answers from the stored channel totals when they cover both periods (`?refresh=1` forces a live Analytics API read) and also returns `source`, `collectedAt`, `channelStartDate`, `previousPeriod { status: full|partial|predates_channel, note }`, `provisionalFromDate`, `granularity`, `buckets` (`?granularity=day|week|month`). New `GET /api/channels/{id}/analytics/history-status` → `{ remainingVideos, hasChannelGap }` (local read). `GET /api/channels/{id}/reach` also takes `videoId` and `groupBy=video_day`.

- `GET /api/channels/[channelId]/analytics` — every locally-collected `video_metrics_daily` row for the channel (read-only, no YouTube call)
- `POST /api/channels/[channelId]/analytics/collect` — `{ startDate, endDate }`; manual per-video collection via the YouTube Analytics API, real local-persistence mutation, gated by the once-a-day freshness gate (`analytics_data_current`)
- `POST /api/channels/[channelId]/analytics/auto-collect` — same collection, triggered once per dashboard mount if stale; no request body
- `GET /api/channels/[channelId]/analytics/overview?startDate=&endDate=` — live channel-level (no video filter) Analytics API read: daily series + current/previous-period totals for the Analytics "Overview" tab and Home's "Channel analytics" card; **never persisted**, not subject to the collection routes' freshness gate (see `docs/ARCHITECTURE.md` §14.8)
- `GET /api/channels/[channelId]/analytics/data-quality?startDate=&endDate=` — local read over `analytics_collection_runs`: covered/uncovered/too-recent dates plus videos with a recorded collection failure (read-only, no YouTube call; see `docs/ARCHITECTURE.md` §14.9) -- previously missing from this list, added here per `AGENTS.md` §H
- `GET /api/channels/[channelId]/analytics/comparable-age?videoIds=a,b,c&metricName=&maxDays=` — local read aligning 2-10 videos' already-collected rows by days-since-publish (`metricName`/`maxDays` optional, default `views`/30; read-only, no YouTube call; see `docs/ARCHITECTURE.md` §14.10)
- `GET /api/channels/[channelId]/analytics/weekly-reports` — every stored weekly report snapshot for the channel, newest week first (read-only, no YouTube call; see `docs/ARCHITECTURE.md` §14.11)
- `GET /api/channels/[channelId]/analytics/weekly-reports/[weekStartDate]` — one stored snapshot by its Monday start date, or `{ report: null }` if none exists yet (read-only, no YouTube call)
- `POST /api/channels/[channelId]/analytics/weekly-reports/generate-if-due` — generates/replaces the current due week's snapshot if one isn't already `"final"`; real local-persistence mutation, gated by `src/proxy.ts` like `analytics/auto-collect`; triggered once per dashboard mount, chained after auto-collect
- `GET /api/channels/[channelId]/analytics/breakdown?startDate=&endDate=&breakdown=` — live channel-level Analytics API read for one of six breakdown kinds (`trafficSources`/`deviceType`/`ageGender`/`geography`/`subscribedStatus`/`contentFormat`, see `CHANNEL_BREAKDOWN_PRESETS`); **never persisted**, not subject to the collection routes' freshness gate (see `docs/ARCHITECTURE.md` §14.12)
- `GET /api/channels/[channelId]/videos/[videoId]/analytics/retention?startDate=&endDate=` — live per-video Analytics API read: audience-retention curve (`elapsedVideoTimeRatio` dimension, "Intro" mode only — no "typical retention" comparison line); **never persisted** (see `docs/ARCHITECTURE.md` §14.12)

### Localization API (read-only)

- `GET /api/channels/[channelId]/localizations` — localization overview table (present/missing languages per video)
- `GET /api/channels/[channelId]/localizations/[videoId]` — per-video original metadata + existing remote locales
- `GET /api/channels/[channelId]/localizations/export` — XLSX download; optional `?videoIds=a,b,c` to scope the
  export, otherwise exports the entire synchronized channel

### XLSX import / Change Sets API (Phase 4, local-only — no YouTube writes)

- `POST /api/channels/[channelId]/localizations/import/preview` — multipart `file`; parses and validates the
  workbook, returns a summary + bounded row-error list, **persists nothing**
- `POST /api/channels/[channelId]/localizations/import` — multipart `file`; same parse/validate, then persists
  a new Change Set (only real proposed edits and invalid rows become `Change` rows; no-op rows are counted but
  not stored)
- `GET /api/channels/[channelId]/change-sets` — list change sets for a channel
- `GET /api/channels/[channelId]/change-sets/[changeSetId]` — change set detail; re-validates conflict status
  against the current synced state on every read; query params `?status=pending|approved|rejected|conflict|invalid|all`,
  `&language=`, `&videoId=`, `&page=`, `&pageSize=`
- `POST /api/channels/[channelId]/change-sets/[changeSetId]/changes/[changeId]/approve` — approve one change
  (rejected with `change_not_approvable` if it is currently invalid or conflicted)
- `POST /api/channels/[channelId]/change-sets/[changeSetId]/changes/[changeId]/reject` — reject one change
  (always allowed, including for invalid/conflicted changes)
- `POST /api/channels/[channelId]/change-sets/[changeSetId]/approve-all` — bulk-approve every pending,
  valid, non-conflicting change
- `POST /api/channels/[channelId]/change-sets/[changeSetId]/reject-all` — bulk-reject every pending change

An approved `Change` is never sent to YouTube by any of these routes — Phase 5 is expected to consume
`approvalStatus: "approved"` changes as its write-batch input.

### Playlist / video API used by UI

- `GET /api/youtube/videos`
- `GET /api/youtube/playlists`
- `POST /api/youtube/create-playlist`
- `POST /api/youtube/add-to-playlist`
- `POST /api/youtube/remove-from-playlist`
- `GET /api/youtube/channel-info`

### Cloud connection API (2026-09-22, `docs/decisions/0008-cloud-connection.md` — on `feature/gateway-traffic-counters`, not yet in `dev`)

A single, device-persistent Google Cloud OAuth grant, entirely independent of the channel-login
session above (though every route still requires one) and of which YouTube channel is active.
These four routes are connect/disconnect status only -- the real Cloud Monitoring API calls
(`src/lib/cloud-quotas/`, `docs/ARCHITECTURE.md` §16) ride along inside `GET /api/settings`
instead, not a route here.

- `GET /api/cloud-connection/start` — redirects the browser to Google's consent screen requesting
  `https://www.googleapis.com/auth/monitoring.read` (narrowed 2026-09-22 from the originally
  broader `cloud-platform` once the Cloud Quotas API that justified it turned out to be
  unnecessary); sets a short-lived httpOnly `state` cookie
- `GET /api/cloud-connection/callback` — exchanges the authorization code, persists the encrypted
  grant, redirects back to `/dashboard?cloudConnection=connected|error`
- `GET /api/cloud-connection/status` — `{ "connected": false }` or `{ "connected": true,
  "connectedEmail": "...", "scope": "...", "connectedAt": "..." }` — never includes a token
- `POST /api/cloud-connection/disconnect` — revokes the token with Google, clears the stored grant

-> Next: [docs/troubleshooting.md](./troubleshooting.md)

<- [Back to README](../README.md)
