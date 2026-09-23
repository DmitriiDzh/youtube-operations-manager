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
npm run cli:video-metadata -- ai-localization create-change-set --channelId <UC...> --proposalsJson <json> [--provenanceJson <json>]
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
CLI-flag equivalent for that shape. Neither command has an apply-class equivalent, same as Change
Sets above; there is also no CLI/MCP command for the channel editorial profile or generation
provenance reads (see `docs/ARCHITECTURE.md` §11's BL-075/BL-078 entry for what this slice
deliberately left out).

### Agent Operations commands (CLI parity for the MCP `agent_*` tools, Phase 7 slice A)

```bash
npm run cli:video-metadata -- agent capabilities
```

Read-only, no channel/credential resolution at all (instance-level information, not channel-
scoped). Returns product version, this interface's own version, the capabilities actually
reachable right now, the full permission-class vocabulary and what's actually granted (always
`READ`+`DRAFT`), named future extension points, and the local schema version. See
`docs/AGENT_OPERATIONS_INTERFACE.md` for the full design.

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
    provenance? }` → the created `ChangeSet` (`source: "ai_localization"`). **Persists** a new
    Change Set — mutates local state only, never YouTube, gated by the same device-availability
    check as `changeset_create_from_import`. Every resulting Change starts `approvalStatus:
    "pending"` — there is no code path, here or anywhere, that can mark an AI-authored proposal
    already-approved (`AGENTS.md` §G).

  Deliberately **not** included in this slice: `getEditorialProfile`/`saveEditorialProfile`/
  `getGenerationProvenance` (no MCP/CLI tool for any of the three), and any approve/reject/apply
  path for a Change Set regardless of its source — same Gate-B-blocked gap RISK-04 already tracks.
- Agent Operations Interface tools (Phase 7 slice A, `docs/AGENT_OPERATIONS_INTERFACE.md`):
  - `agent_get_capabilities` — `{}` (no parameters) → `SystemCapabilities` (product/agent-API
    version, implemented capabilities, data domains, the full permission vocabulary, what's
    actually granted today — always `["READ","DRAFT"]` — named future extension points, and the
    local schema version). Read-only, no channel scoping (instance-level information). Call this
    first, before assuming any other Agent Operations tool exists.
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
