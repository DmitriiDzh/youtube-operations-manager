# TubeMaster Interfaces: Web UI, CLI, MCP, API

<- [Back to README](../README.md)

Use this as the operational reference after setup: TubeMaster covers channel workflows across metadata, transcripts, playlists, rules, and automation surfaces.

## Web UI (`http://localhost:3000`)

### Login flow

1. Open home page.
2. Click **Sign in with Google**.
3. On success, app redirects to `/dashboard`.

### Dashboard tabs

- **Manual**
  - Browse your videos (`/api/youtube/videos`) or paste IDs/URLs in batch mode.
  - Add/remove videos from playlists (`/api/youtube/add-to-playlist`, `/api/youtube/remove-from-playlist`).
  - Create playlist from UI (`/api/youtube/create-playlist`).
- **Rules**
  - Create rule (field + match type + target playlist).
  - List/delete rules.
  - Run matching engine (`/api/run`) over recent videos.
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
recovery-mode check, never a channel-identity check) as `apply`/`playlist create`. Corrected by
independent review: an earlier version of this line said "identity/operation-lock gate", which
overstated what this specific gate actually verifies -- `AGENTS.md` §G's identity-check
requirement is satisfied elsewhere (`write-context.assertWriteChannel`, used by the write-capable
tools that actually touch YouTube), not by this gate. `channel list`/`channel video-list` are
read-only.

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

Most tools accept optional `credentialRef`; if omitted, server falls back to active local auth context.

### Restricted mode (`MCP_RESTRICTED_MODE=true`)

Set the `MCP_RESTRICTED_MODE` environment variable to `true` (or `1`), or pass
`{ restrictedMode: true }` as `createMcpServer`'s second argument, to start the server with only
read/propose/create-class tools registered. `apply`, `playlist_create`, `playlist_update`,
`playlist_delete`, `playlist_add_videos`, `playlist_remove_videos`, `write_channel_select`, and
`auth_user_select` are **never registered at all** in this mode — not merely rejected at call
time, so a connected client cannot even discover them. Every other tool (including
`channel_sync` and `changeset_create_from_import`, both of which mutate the local database)
remains registered, since neither ever writes to YouTube. This is the concrete implementation of
Phase 7's "operation-specific permissions and read-only access to application data"
(`docs/roadmap/FUTURE_PHASES.md` §3) — the intended default for a Codex operations connection,
once one exists.

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
- `GET|POST|DELETE /api/rules`
- `POST /api/run`

-> Next: [docs/troubleshooting.md](./troubleshooting.md)

<- [Back to README](../README.md)
