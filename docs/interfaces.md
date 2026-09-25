# TubeMaster Interfaces: Web UI, CLI, MCP, API

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
npm run cli:video-metadata -- playlist create --title "..." --expectedChannelId <UC...> [--description "..."] [--privacyStatus private|public|unlisted] [--userId <USER_ID>]
npm run cli:video-metadata -- playlist update --playlistId <PLAYLIST_ID> --expectedChannelId <UC...> [--title "..."] [--description "..."] [--privacyStatus private|public|unlisted] [--userId <USER_ID>]
npm run cli:video-metadata -- playlist delete --playlistId <PLAYLIST_ID> --expectedChannelId <UC...> [--userId <USER_ID>]
npm run cli:video-metadata -- playlist add --playlistId <PLAYLIST_ID> --videoIds <VIDEO1,VIDEO2,...> [--userId <USER_ID>]
npm run cli:video-metadata -- playlist remove --playlistId <PLAYLIST_ID> --videoIds <VIDEO1,VIDEO2,...> [--userId <USER_ID>]
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

## MCP server (`npm run mcp:video-metadata`)

Starts stdio MCP server with tools for auth context + metadata + playlists.

Important: MCP server does **not** expose login flow. Authenticate first using CLI (`auth login`).

Key MCP tools:

- Context/auth tools:
  - `write_context`
  - `write_channel_list`
  - `write_channel_select`
  - `whoami`
  - `auth_user_select`
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
    to `channelId` via `requireBatchForChannel` before returning anything (`AGENTS.md` §F)

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
    `period`, `freshness`). Wraps `analytics_overview` unchanged — a **live** Analytics API read
    that counts against that API's quota. Requires `channelId` to be the caller's active channel
    (checked internally by the wrapped `analyticsCore` call, not a second check in this module).
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
  - `agent_list_operations_files` (Phase 7 slice I, owner spec §3/§30) — `{}` →
    `{ configured: false } | { configured: true, files: OperationsWorkspaceFileEntry[], truncated:
    boolean }`. NOT channel-scoped (one global, operator-configured path) — no `channelId`, no
    `assertActiveChannel` check, like `agent_get_capabilities`. Lists files/folders under the
    operator-configured operations-workspace directory; `.md`/`.txt`/`.json`/`.yaml`/`.yml` files
    only, dotfiles/dot-directories always excluded, depth/file-count capped. The path itself can
    only be set through the Web UI's Settings tab — no MCP tool or CLI command can set it.
  - `agent_get_operations_file` — `{ path }` → `{ configured: false } | { configured: true, path,
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

Most tools accept optional `credentialRef`; if omitted, server falls back to active local auth context.

### MCP connection (Settings tab toggle, off by default)

Renamed and inverted 2026-09-21 from the earlier "restricted mode" (owner instruction: *"По
началу MCP / агент от всего отключен и получит доступ только если я зайду в настройки и
переключу этот тумблер... Все взаимодействия MCP / агента должны идти через это переключение"*).

The real entrypoint, `startMcpServer()` (`npm run mcp:video-metadata`), reads a single persisted
setting (`getMcpConnectionEnabled`, `src/lib/db.ts`) once at process startup and passes it to
`createMcpServer(core, { connectionEnabled })`. **While disconnected (the default, and the state
of every newly-created local database), the server registers ZERO tools at all** — not just the
write/identity-switching ones, every read/propose/create tool too (`whoami`, `list`,
`changeset_list`, `channel_sync`, everything). A connected MCP client sees a server with no
capabilities whatsoever until the project owner explicitly turns "MCP connection" on in the
app's Settings tab. There is no environment-variable override — the Settings-tab toggle is the
one and only way to grant a connection any access.

Once enabled, every tool is registered — including `apply` and every `playlist_*` tool, which
remain separately gated by the unrelated "Live writes" toggle (`docs/decisions/
0005-youtube-write-gateway.md`) before any of them can reach a real YouTube write. Turning on
"MCP connection" alone never sends anything to YouTube by itself.

Persisted across process boots once turned on — unlike "Live writes" (which resets to off every
session by design), this is a one-time setup step, per explicit project-owner instruction.
**Known limitation:** an MCP server's tool set is fixed at `createMcpServer()` construction time
(standard SDK behavior) — flipping this setting takes effect the next time an MCP client spawns
or reconnects the server process, not instantly for a connection that is already open.

This is the concrete implementation of Phase 7's "operation-specific permissions and read-only
access to application data" (`docs/roadmap/FUTURE_PHASES.md` §3) taken to its safer, default-deny
conclusion — no MCP client, including a future Codex operations connection, gets any access
until the project owner deliberately opts in.

### Multi-agent responsibility zones (BL-091, `docs/roadmap/plans/AGENT_ZONES_PLAN.md`)

Independent of the connection-level toggle above, six specific mutating actions can additionally
be restricted to exactly one *named* agent connection once one or more connections are enabled
(e.g. Claude and Codex connected at once): `channel_sync`, `changeset_create_from_import`,
`ai_localization_generate`, `ai_localization_create_change_set`, `agent_create_content_proposal`
(capability id `content_proposal.create_content_proposal`), and `agent_register_external_artifact`
(`content_proposal.register_external_artifact`). Every other tool, including every READ-only one,
is never affected by this — the point is a shared information field with exclusive write zones,
not a second permission tier.

- **Identity**: each MCP server process resolves its own agent-connection id once at startup from
  the `AGENT_CONNECTION_ID` environment variable (set in that client's own MCP launch config); the
  CLI resolves the same identity per invocation from `--agentConnectionId` (priority) or the same
  env var. Either way, an empty value never becomes a real identity: the env var resolves an empty
  value to `null`, while an empty `--agentConnectionId` flag value is rejected outright as
  `validation_failed`.
- **Management UI**: Settings → AI Agent → "Agent connections & responsibility zones"
  (`src/components/agent-connections-manager.tsx`) — register a connection (id + label, no
  secret), enable/disable it, and assign each of the 6 actions above to exactly one connection (or
  leave it unassigned). Backed by `GET/POST /api/agent-connections`,
  `PUT /api/agent-connections/[connectionId]`, `GET/PUT /api/agent-connections/zones`.
- **Fail-closed policy, keyed on ENABLED connections** (a disabled one does not count):
  - **Zero enabled connections**: entirely a no-op — identical to today's single-agent behavior.
  - **One or more enabled connections**: every one of the 6 actions requires a resolvable,
    enabled, registered connection id; an unknown or missing one is rejected with
    `AGENT_ZONE_VIOLATION`, never silently allowed.
  - **A capability with an explicit zone assignment** always rejects every connection except the
    assigned one, regardless of how many are enabled.
  - **A capability with NO explicit zone assignment** is open only while exactly one connection is
    enabled (trivially unambiguous). **Once two or more connections are enabled, an unassigned
    capability is rejected for every connection**, not shared — the owner's own exclusivity
    requirement ("нельзя одну и ту же зону ответственности дать обоим") means an unassigned zone
    with multiple active agents is a configuration gap the operator must resolve with an explicit
    assignment, never a default multi-agent grant.
- **Not the same as the "MCP connection" toggle above** — that toggle is the all-or-nothing gate
  deciding whether an MCP client sees any tool at all; this mechanism only matters once the toggle
  is already on and coordinates *which* connected agent may perform *which* of these 6 actions.
- **Resolved, not a gap**: the operator-only `asset register` CLI command (creative-asset catalog,
  `docs/AGENT_OPERATIONS_INTERFACE.md` §4c) is intentionally never gated by this mechanism —
  raised as an open question and explicitly resolved by the project owner (Telegram, 2026-09-25):
  "Если она не доступна агентам, то не вижу проблемы. Это интерфейс пользователя и пользователь
  может дополнять работу агентов по своему усмотрению" (if it isn't available to agents, there's
  no problem — this is a human-operator interface, and the operator may supplement the agents'
  work at their own discretion, e.g. adding assets directly or proposing test hypotheses). Zoning
  governs *agent* actions; a human operator directly using this application was never meant to be
  constrained by it.

---

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

### Analytics API (Phase 8 + Studio-Parity S6b, BL-055..059/BL-072 — previously undocumented here)

- `GET /api/channels/[channelId]/analytics` — every locally-collected `video_metrics_daily` row for the channel (read-only, no YouTube call)
- `POST /api/channels/[channelId]/analytics/collect` — `{ startDate, endDate }`; manual per-video collection via the YouTube Analytics API, real local-persistence mutation, gated by the once-a-day freshness gate (`analytics_data_current`)
- `POST /api/channels/[channelId]/analytics/auto-collect` — same collection, triggered once per dashboard mount if stale; no request body
- `GET /api/channels/[channelId]/analytics/overview?startDate=&endDate=` — live channel-level (no video filter) Analytics API read: daily series + current/previous-period totals for the Analytics "Overview" tab and Home's "Channel analytics" card; **never persisted**, not subject to the collection routes' freshness gate (see `docs/ARCHITECTURE.md` §14.8)
- `GET /api/channels/[channelId]/analytics/data-quality?startDate=&endDate=` — local read over `analytics_collection_runs`: covered/uncovered/too-recent dates plus videos with a recorded collection failure (read-only, no YouTube call; see `docs/ARCHITECTURE.md` §14.9) -- previously missing from this list, added here per `AGENTS.md` §H
- `GET /api/channels/[channelId]/analytics/comparable-age?videoIds=a,b,c&metricName=&maxDays=` — local read aligning 2-10 videos' already-collected rows by days-since-publish (`metricName`/`maxDays` optional, default `views`/30; read-only, no YouTube call; see `docs/ARCHITECTURE.md` §14.10)
- `GET /api/channels/[channelId]/analytics/weekly-reports` — every stored weekly report snapshot for the channel, newest week first (read-only, no YouTube call; see `docs/ARCHITECTURE.md` §14.11)
- `GET /api/channels/[channelId]/analytics/weekly-reports/[weekStartDate]` — one stored snapshot by its Monday start date, or `{ report: null }` if none exists yet (read-only, no YouTube call)
- `POST /api/channels/[channelId]/analytics/weekly-reports/generate-if-due` — generates/replaces the current due week's snapshot if one isn't already `"final"`; real local-persistence mutation, gated by `src/proxy.ts` like `analytics/auto-collect`; triggered once per dashboard mount, chained after auto-collect

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
