> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 47. Publishing from YT Manager: uploads, calendar, reminder (BL-182, ADR 0037, FO-REQ-0023)

Plan: `docs/roadmap/plans/PUBLISHING_PLAN.md`. Owner: msgs 2698, 2702 and 2707.

### 47.1 Stage 0 — the write gateway's resumable upload and the G1 probe

- **`youtube-write-gateway/upload.ts`** implements Google's resumable protocol over `node:https`:
  - `beginResumableVideoUpload`: a POST with `uploadType=resumable` and `X-Upload-Content-*`; the session URI comes back in
    `Location`.
  - `putVideoUploadChunk`: chunks in multiples of 256 KB, sent with `Content-Range`. A 308 with `Range` gives the bytes stored;
    200/201 is done; 404 means the session expired.
  - `queryVideoUploadOffset`: a status query, `bytes */total`.
  - `deleteVideoById`, for the probe only.
  - The token is sent only to `https://www.googleapis.com`, and the session URI is checked before every request.
  - A 5xx is reported as "outcome unknown", never as a refusal.
  - googleapis is not used for the media: it cannot resume a session after a restart.
- **Quota.** `videos.insert` has its own daily bucket (100 calls), so `countsAgainstPool` excludes it. `thumbnails.set` costs 50.
  An upload is recorded in the ledger once, when it finishes (`noteYoutubeQuotaCall`).
- **The G1 probe** is `publishing/g1-probe.ts` with the developer-only CLI `npm run cli:publishing-g1`. Before any byte goes out it
  runs the recovery gate, the identity check (`assertWriteChannel`, the channel's own connected user) and the metadata limits.
  - A `started` record is saved before the first request, and while it is there no new upload starts.
  - A lost answer is resolved with a status query.
  - The video id is printed as soon as YouTube returns it.
  - The read-back is polled until processing ends.
  - Only the probe's own video can be deleted, once.
  - Live writes are checked before every gateway call (`adapters/youtube-writes.ts`).
- **The 2026-10-13 run:**
  - **Not locked.** Studio shows «Ограниченный» (Private), and its change button works.
  - `defaultAudioLanguage` is accepted at insert.
  - `containsSyntheticMedia` is set at insert, but the API does not return it on read, so it cannot be verified or detected.

### 47.2 Stage 1 — calendar, 7-day reminder, rescheduling, agent read

- **Calendar logic.** `publishing/calendar.ts` reads only the local copy.
  - YouTube has no "scheduled" status: a scheduled video is a non-public video with a future `publishAt`.
  - Each video is one of: published (public or unlisted), scheduled, overdue (the date has passed but the copy is not public yet)
    or unscheduled (private without a date). Live broadcasts are left out.
  - The coverage is the latest future `publishAt`. The reminder is due when that is less than 7 days away, or when there is none. Since BL-235 the routes wire the daily coverage and the reminder is "fewer than 7 covered days in a row" (§47.6); this rule
    remains only as the fallback when that read fails.
  - The shared rule `isScheduledVideo` (`shared-formatting`) also drives «Видео».
  - Rows the latest channel sync did not return are left out (`currentRows`: row sync time older than the channel's). The sync
    never deletes rows, so a video deleted in Studio would otherwise keep the channel "covered".
- **Routes.** `GET /api/channels/[id]/publishing/calendar` (the active channel) and `GET /api/publishing-alerts` (every connected
  channel; a channel never synced gives no alert) are local reads.
  - `POST /api/publishing/refresh-stale` runs once per dashboard load. It syncs each other channel whose copy is older than 6 h,
    with the shared fan-out rules (`channel-fanout`):
    - the channel's own user (`credentialUserIdFor`), after `assertActiveChannel` for that user;
    - the shared 6 h backoff after a failure;
    - as the tracked `channel-sync` operation, so it never runs beside the owner's own sync of that channel (409 is skipped).

    It is a full channel sync (about 7 units for ~110 videos), not a targeted read. The active channel is already synced on every
    load.
  - The 60 s poll never calls YouTube.
- **UI.**
  - **Content → «Календарь»** (`publishing-calendar.tsx`, `publishing-calendar-grid.ts`):
    - a summary: covered through, the days left, the data age and Sync;
    - a Monday-first month grid with the gaps of the next 2 weeks marked;
    - the undated and overdue lists;
    - an entry opens the video's Details.
  - **«Видео»** shows «Запланировано», and has a filter for it.
  - **Badge and bell.** The «Контент» badge shows the days missing to a week of coverage. The other channels' reminders are in
    the bell's «Публикации» section. These form one family with the BL-178 translation alerts.
- **Rescheduling** (owner msg 2707). `video-details/publish-at-rule.ts` is one rule for the preview, the write and the card's field.
  `publishAt` may be written only on a private video. A date it already has must be more than 15 minutes ahead, and so must the
  new date: inside that margin YouTube may publish between the read and the write, and the write would take the video back to
  private. A public or unlisted video is refused even without a date.
  - The read-back and the verification compare instants as instants (`sameFieldValue`). YouTube echoes `...:00Z` for a written
    `...:00.000Z`; before the review this real write was reported as a failure.
  - "AI use" (`containsSyntheticMedia`) cannot be read (G1), and `videos.update` replaces the status part. So any status write from
    the card sends it explicitly: an unreadable value starts checked, and the card says why.
    - The adapter fails closed on a status write that does not carry it.
    - Its read-back is "unverifiable" (recorded in the VERIFICATION audit), not a mismatch.
    - Known limit: an owner's explicit "no" is not remembered. The next load reads null again and shows it checked. Showing the last
      audited value is left for stage 2's publishing defaults.
  - A new time within the margin is refused as `publish_at_too_soon` (en/ru text).
- **`agent_get_publishing_calendar`** (READ; Agent API 3.16.0, Producer API 1.7.0): a ±14-day window in UTC days, plus the undated
  uploads, the coverage and the gap dates. Agents get no upload or schedule tool.

### 47.6 One publishing coverage (BL-235, owner msgs 3806/3807)

- **Why.** The calendar (gaps by any published/scheduled video), «План недели» (approvals) and the factory's own plan file disagreed
  about what is "done". The owner's rule: a publishing day is covered when a video is uploaded, scheduled for that day (or already
  published that day) AND has all its translations -- computed from the YouTube data YT Manager already syncs.
- **Shared module `src/lib/publishing-coverage/`** (§M: imports no feature module). `rules.ts` holds the per-video calendar rule
  (moved from `publishing/calendar.ts`, re-exported there): published / scheduled / overdue / unscheduled, live left out, stale rows
  (`currentRows`). `coverage.ts` (pure): per day of the range (YYYY-MM-DD in the channel's zone, `zoned-time`; days advanced on the
  date itself, so DST never shifts them) `covered` | `missing_translations` | `gap`. Required translations = the shared
  `missingTrackedLanguages` (moved from `localization/services.ts` to `shared-language-baseline`): tracked languages minus the
  video's own language, read against the channel's language, non-empty title and (where the original has one) description. Overdue
  never covers; a private video whose `publishAt` passed less than 24 h ago is `published_pending` and does (YouTube published it,
  the copy learns it at the next sync -- so a release day is no false gap). Only releases viewers see count: unlisted videos and the
  recordings of the app's own live broadcasts (`listAppBroadcastIds`, a port given by the composition) do not. A day with several
  videos is covered if one qualifies; its `missingLanguages` are the most complete video's.
  `index.ts`: input `{ channelId, days 1..30 (7), fromDate? }`, `asOf` = the channel's `lastSyncedAt`; `not_found` for a channel
  never synced here.
- **Zone.** `src/composition/publishing-coverage.ts`: the zone of the channel's newest weekly plan (the plans are kept in the
  channel's time); no plan, an invalid zone or a failed read: the owner's zone (`analytics_sync_timezone`), else UTC; the result
  names its source. Cached per channel for 5 min (the alerts poll every channel each minute), dropped when the Operator or a worker
  saves that channel's plan here. The calendar and the alerts hand the rows they read to the coverage (`CoveragePreRead`): one read.
- **Users.** The calendar route and the alerts route pass `dailyCoverage` to `createPublishingCalendarCore`: the reminder
  (`coverage.due`, the badge, the bell) is "fewer than 7 covered days in a row from today", `coverage.coveredDaysInARow` is added and
  `dayCoverage` (14 days) drives the grid -- cells are the channel's days, its times are the channel's, gaps and the yellow
  "missing translations" days (tooltip with the languages) come from it. A failing coverage read leaves the older rule (§M). The
  plan route returns `{ plan, coverage }` (the plan's week in its zone) for the line «Закрыто N из 7 · без видео · без переводов»;
  approvals are untouched. MCP: `factory_publishing_coverage` and the worker's `agent_publishing_coverage` (channel-pinned);
  `agent_get_publishing_calendar` gets the same `due`, and its `gapDates` / `missingTranslationDates` come from the coverage (channel
  dates). In the calendar the cells, hover texts, «covered through» and the overdue list use the channel's time; it opens on the
  channel's today; packages sit on their planned date as a day.

### 47.3 Stage 2 — publishing defaults, release packages, upload and schedule

Owner msgs 2715 (defaults chosen once), 2717 (scheduled at insert; superseded by msgs 3510/3511, see the upload runner), 2725/2727 (UTC publish time, BL-183), 2725 (no AI-use fix: it
is already set everywhere), 2734 (one merge for the whole stage).

- **Publishing defaults per channel** (`publishing/settings.ts`; sync family `channel-publishing-settings`, one Automerge document
  per channel, an opaque map of values like `media-settings`). Fields and defaults: `publishTimeUtc` 12:00, `playlistId` none,
  `categoryId` 10 (Music), `madeForKids` false, `containsSyntheticMedia` true, `license` youtube, `embeddable` true,
  `notifySubscribers` true; since owner msgs 2751/2753 also `paidProductPlacement` false (Studio's «Прямая реклама», sent as the
  `paidProductPlacementDetails` part at insert -- accepted on videos.insert but not in the docs' settable list, so the read-back
  checks it) and `channelTags` [] (owner msg 2817: used only for a package with `tags: []`; a package's own tags replace them; the approval refuses a
  list over YouTube's 500 characters; FO-MSG-0017 / BL-190: the approval dialog shows each row's tag count, characters and source -- the package's, or the channel's when the package has `tags: []` -- and a package tag with `<` or `>` is the problem `tags_angle_brackets`). Studio's automatic chapters, places and concept explanations have no Data API property: they stay
  as YouTube sets them (on), changeable only in Studio. A stored value this build cannot use falls back to the default. Saved fields only (the panel sends
  what the owner changed); a conflict is chosen in Merge (actor-based, like the language settings). Routes:
  `GET/PUT /api/channels/[id]/publishing-settings`, `GET/POST .../publishing-settings/conflicts`. Panel: Settings → Channels (Content → «Публикация» before BL-266),
  the time as `UtcTimeField`.
- **Release packages** (`publishing/packages.ts`, `package-scan.ts`). The scan walks `04 Videos/` of the channel workspace on this
  computer (the shared `src/lib/workspace-videos/` walk and reads since BL-187), at most three levels, never through a symlinked folder, for `V*_release.json` (`yt-release-package/1`, FO-REQ-0023 §4 A);
  every file is reached through the workspace rule (`resolveWorkspaceFile`). Checks: the manifest's shape, the channel, the
  factory's own verdict, title ≤ 100 characters without `<`/`>`, description ≤ 5000 bytes without `<`/`>`, tags ≤ 500 by YouTube's
  count (commas, quotes around a tag with a space), chapters (first 0:00, at least three, each ≥ 10 s), the channel's language
  baseline, the video's size and ffprobe duration (`ffprobe_missing` apart from an unreadable file), a JPEG/PNG thumbnail ≤ 2 MB,
  and the same title already on the channel. State: not ready / ready / uploaded private / scheduled / published (by
  `Vn_youtube.json` and the synced copy) / uploaded_unknown (the record's video is not in the copy yet) / deleted_on_youtube
  (BL-243, ADR 0063: the copy has it with the sync's `removed_on_youtube_at` mark -- `listRemovedVideosByChannel`; problem
  `video_deleted_on_youtube`, `youtube.removedAt`, privacy and date null). Every package carries `existsOnChannel` (true | false |
  null; true only as of a completed removed check) and `checkedAt` (`channels.removed_check_at`, schema v118: set only when a
  sync's removed check ran, unlike `lastSyncedAt`; true also needs YouTube's `publishedAt` not after it). Unreadable mark or check
  time: none known / null. `parseUploadRecord` (shared `workspace-videos`) returns the record's `uploadedAt`. The manifest's SHA-256 travels to the approval. Routes: `GET .../publishing/packages`,
  `GET .../publishing/packages/thumbnail?path=` (an image under `04 Videos/` only, its type by its first bytes).
- **Approval** (`publishing/upload-approval.ts`, `POST .../publishing/uploads`). It binds to what the owner saw: each manifest's hash
  and the settings shown; anything changed refuses the whole approval. Also refused: a package not ready, already uploaded, queued
  here or reported as uploading by another computer (sync family `publishing-uploads`, a per-device report: channel, video, state);
  settings that differ between the computers; a publish time 15 minutes away or less; more uploads than are left of the 100-a-day
  `videos.insert` bucket (this computer's ledger and the shared one); pool units the quota guard cannot carry (`checkUnits`; an
  unknown quota only with the owner's yes). A dated row approves UPLOAD_PRIVATE and PUBLISH, an undated one only UPLOAD_PRIVATE.
  The UI suggests dates: the planned date at the channel's UTC time, the next free day when taken or too soon (`publish-dates.ts`).
- **Upload runner** (`publishing/upload-runner.ts`, table `publishing_uploads`, schema v89, device-local, at most one live row per
  channel and video). A 5 s loop in `instrumentation.ts`, one byte stream at a time (8 MB chunks, a 50 s slice per pass) and one step
  per pass for the uploads already sent. The approver's Google user and `assertWriteChannel` before the first byte; the files must
  still match the approval. The session URI is stored before the first byte; a resumed upload asks the session how much it holds; a
  lost answer is resolved by a status query (done → the video is adopted); an expired session restarts only when no video with the
  title is among the channel's newest uploads (found → adopted). The insert is always private and never carries `publishAt`
  (owner msgs 3510/3511, 2026-10-25, FO-REQ-0040 item 4: a video is never scheduled before its thumbnail is set and the upload is
  verified -- this replaced msg 2717's "at insert when at least 6 h ahead"). After processing, in order: `thumbnails.set` (new
  gateway primitive), `playlistItems.insert` unless the video is already in the playlist, a read-back against the approval
  (`verify_mismatch` names the fields), then the publish time -- only when the thumbnail is set, the
  playlist step did not fail and the read-back verified; otherwise it is withheld (`steps.publishAt = "withheld"`, a note names
  the failed step, the video stays private without a date). The date goes through video-details' own write (private, AI use
  explicit, backup, read-back, audit); the runner reads the video before it (a date already there from a write whose answer was
  lost is not written again) and after it (private with exactly that time, or the step is `failed`). 15 minutes or less ahead at
  that point is not written (`publish_at_too_soon` on the job). Then `Vn_youtube.json` next to the package (atomic, inside the
  workspace's real folder; `publishAt` only when it was set), an audit row, a channel sync. Trade-off: every dated upload now pays
  the `videos.update` and its reads (55 units in the estimate) that a date at insert saved. A row whose session began before this
  change with the date in its insert (`publish_at_at_insert = 1`, kept in the schema, always 0 for new rows) is finished as before:
  `steps.publishAt = "at_insert"`, nothing written, the read-back checks the date. Known limitation: such a row's date is already
  on the video, so a thumbnail, playlist or read-back failure does not clear it (no write takes a date off); the owner sees the
  failure on the job. The gateway's insert type has no `publishAt` and refuses one (`beginResumableVideoUpload`); an old row
  resumes its existing session and never re-sends the insert body, and an expired one starts a new session without a date.
  The read-back (independent review): it is read again up to 3 times, 10 s apart (video-details' `READ_BACK_RETRIES` /
  `READ_BACK_RETRY_DELAY_MS`, as a waiting step, `steps.verifyRereads`) before a difference counts -- YouTube can lag right after
  processing, and «Прямая реклама» can come back empty at first; an unreadable video counts at once (after the usual retries). It
  checks AI use (`containsSyntheticMedia`: null is not returned by YouTube and unverifiable, a different value is a mismatch), and
  a date where none is expected yet (`publishAt`). The thumbnail: the upload-state read (same `videos.list`, part
  `contentDetails`) gives `contentDetails.hasCustomThumbnail` ("Indicates whether the video uploader has provided a custom
  thumbnail image for the video", YouTube Data API videos resource, uploader only); false is a `thumbnail` mismatch, not returned
  leaves `thumbnails.set`'s 200 as the evidence. `Vn_youtube.json`: the first copy (when the video id arrives) has no date; the
  record step runs after the date step and writes `publishAt` only when it is on the video (`set`/`at_insert`), else null. The
  uploads list shows the date as «Публикация» only then, otherwise as planned and not set.
  Live writes off pauses a job and it resumes by itself; `quotaExceeded` (in any client's error shape: the upload's own, the read
  gateway's `youtube_quota_exceeded`, a gaxios 7 `response.data.error.errors[]`) pauses every queued upload until the quota day
  resets, `uploadLimitExceeded` that channel's for 24 h; a 5xx, 429, timeout, network failure or an answer that does not say
  "refused" is asked again (at most 10 times in a row, then a finishing step is noted failed and the next one runs); a refusal
  fails the job. An upload being sent or finished is busy for the idle watcher.
- **Never twice, after the independent review.** The last chunk is marked as sent before it goes (`finalChunkSentAt`): from then on
  the job is never cancelled, never restarted on an expired session (it fails as `unknown_outcome` unless the title is found among
  the channel's newest uploads, then it is adopted) and never failed into "approvable again". A resumed upload asks its session
  before any file check. As soon as YouTube gives the video id, a first `Vn_youtube.json` names it. A row whose video exists keeps
  its package taken whatever became of the job: the unique index covers it, the approval and the per-device report count it
  (`holdsPackage`). A lease (`lease_owner`, `lease_until`, 2 minutes per pass) keeps a second process on the same database (a dev
  server) away from a row. A publish time set at insert (only such an old row) that comes within 15 minutes before the last chunk (a long pause) stops
  the upload before that chunk (`publish_at_passed`, nothing made). Processing waits at most 24 h, and a video YouTube no longer
  returns for 30 minutes ends it as `video_missing`. The writes after the upload check the channel first, like the upload.
  Descriptions are sent and compared with LF line endings. The approval counts the uploads already queued here against the day's
  inserts and units. Cancel only before YouTube (queued, or paused before its last chunk went).
- **Re-check fixes.** After the last chunk, answers that stay unknown never fail the job: the session is asked again every 30
  minutes for as long as a session lives (a week). An `unknown_outcome` row holds its package (index, approval, per-device report)
  until the owner, having looked in Studio, presses «Видео нет — разрешить загрузить снова» (`POST .../uploads/[id]/release`,
  `unknown_outcome_released`). Processing whose state stays unreadable is polled slowly until its 24-hour limit. Network errors with
  an underscore (`EAI_AGAIN`, `ERR_*`, `UND_ERR_*`) are transient. The lease is renewed before every chunk. Migration v89 was edited
  in place before it reached any database (the service and the other computer ran v88).
- **The owner's own package** (BL-192, `docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md`, `publishing/package-composer.ts`). «Новый пакет»
  lists the `04 Videos/<month>/<MMDD Vn>` folders that hold a video directly inside (the `workspace-videos` walk). A draft takes the
  folder's direct children only: the one video (or the one named after Vn), the one `Thumbnail_*` (else the one image), the one
  `*Title_Description*.txt` parsed by `parseTitleDescription` (BOM and CRLF removed; the title is the lines between a `TITLE` line and a
  `DESCRIPTION` line, the description everything after it, trailing blanks trimmed), the size, ffprobe's duration (the scan's cached
  probe) and the channel baseline; the owner's picks and edits override them, and the draft carries `packageProblems` for the result.
  Saving rebuilds it on the server and writes `Vn_release.json` through `writeVideoFolderFile` (temporary file + rename, the folder's
  real path strictly inside the real `04 Videos/`), with `ready: true`, `problems: []`, `mix: null`, `createdBy: "owner"`. Refused with
  nothing written: no video or thumbnail, an unreadable length, no baseline, an empty title, bad input; an existing package without
  `replace`; one with `Vn_youtube.json` or held by an upload (`localHeldVideos`, `peerUploadsOf` -- shared with the approval). Problems
  the scan reports do not refuse: the package shows as not ready with them.
- **UI** (Content → «План» → «⋯» → release packages since BL-266; Content → «Публикация» before): the package list with checkboxes, a date per chosen package (DD.MM.YYYY UTC day; empty = private
  without a date), «Загрузить выбранные» → the approval dialog (rows, times in UTC and the owner's time, the shared settings, the
  units estimate, the Live-writes note), then the uploads list (state, share sent, pause reason and when it continues, the
  read-back result) polled while one is active.
- **Calendar:** a ready package shows on its planned day at the channel's time (dashed violet, not clickable); it is not scheduled
  yet, so its day stays a gap. The folder is read at most every 5 minutes.
- **Agents** (Agent API 3.17.0, Producer API 1.8.0): `agent_get_publishing_calendar` also lists the packages (state, problem codes,
  video id) and this computer's uploads (since 3.20.0 / 1.10.0 with `automatic`, `progressPercent`, `finishedAt`, §47.5). No channel agent or factory tool uploads, schedules or cancels (`no-agent-upload-tool.test.ts`); the Producer's queue tools are §47.7.

### 47.5 Automatic private upload (BL-209, ADR 0046, `docs/roadmap/plans/AUTO_PRIVATE_UPLOAD_PLAN.md`)

- **The switch.** `app_settings.auto_private_upload_enabled` (`getAutoPrivateUploadEnabled` / `setAutoPrivateUploadEnabled` in
  `db.ts`): off by default, persistent, device-local, one for every channel. Shown on the Live writes card
  (`live-writes-settings.tsx`) with a visible caption; read and set through `/api/settings` (`autoPrivateUploadEnabled`) only.
- **The watcher** (`publishing/auto-upload.ts`, `createAutoPrivateUploadCore` in `index.ts`), its own loop in `instrumentation.ts`
  every 5 minutes (the next tick starts after the previous one ended; skipped during an import/migration or in recovery mode). Off, a
  tick reads the switch only. On, for every channel with a connected account: the package scan, then per package -- `ready` (the
  scan's checks) with a thumbnail and a manifest hash → the manifest's top-level `sha256` (`packages.ts`, optional, lower-case hex;
  none → owner's approval only) → not held here or by a peer → its manifest hash never in any upload row here (`listTriedManifestHashes`:
  automatic or manual, any status -- review M1) → the video's size equals `sizeBytes` (no hash otherwise) → its SHA-256, cached in memory per (manifest hash, size,
  mtime) → the switch read again → `queueAutomatic`. A SHA-256 mismatch is audited once per manifest hash
  (`publishing.auto_upload_hash_mismatch`).
- **Queueing** is `upload-approval.ts` `queueAutomatic`: the approval's own `queue` step (held here / by a peer at queue time, ready,
  the `videos.insert` bucket with the queued uploads counted, the quota pool, the tags), with `publishAt` null, `automatic` true and
  `approvedBy` = the channel's `connected_user_id` (the runner's credentials and identity check). `upload_daily_limit`,
  `quota_insufficient`, `quota_unknown` (never acknowledged) stop the tick and wait; `publishing_settings_changed` skips the channel;
  any other refusal skips the package until a later tick. Audit: `publishing.upload_auto_queued` (time, channel, video, manifest
  hash, switch state, upload id).
- **Waiting reasons (no spam).** A ready, matching package not queued now (a refusal code: `upload_daily_limit`,
  `quota_insufficient`, `quota_unknown`, `publishing_settings_changed`, `upload_tags_too_long`, ...; `hash_failed`) and a channel
  skipped (`no_connected_account`, `no_workspace`, `workspace_unavailable`) are recorded once per (manifest hash, reason) or
  (channel, reason) change: one audit event `publishing.upload_auto_waiting` and one console line. A reason that clears is dropped
  and logged again if it returns; a tick stopped early keeps the reasons it did not reach. The standing list is kept in memory and,
  when it changes, in `app_settings.auto_private_upload_waiting`; `/api/settings` returns it as `autoPrivateUploadWaiting` and the
  Live writes card shows the first one in one line (en/ru keys `settingsCards.autoPrivateUpload.*`).
- **Review fixes.** A peer report listing the package in any state skips it (M2b); a visible line under the toggle says to turn it on
  on ONE computer only (M2a, no cross-computer lock). The first save after a start always runs, so a list stored before a restart is
  cleared (L1); switched off mid-tick the reasons are cleared (L3); one channel's error is its reason `channel_failed` and the other
  channels go on (L4). An automatic row's `package_json` carries `videoSha256`; the runner re-hashes the video before a new session
  (before the identity read on the first start; not on a resumed session) and fails it with `video_hash_mismatch` (L5).
- **Schema v103:** `publishing_uploads.automatic INTEGER NOT NULL DEFAULT 0`. The runner is unchanged: an automatic row is inserted
  private without `publishAt`, gets no date afterwards, and goes to the release playlist.
- **Visibility.** The uploads list (Content → «План» → «Очередь», Content → «Публикация» before BL-266) marks the row «автоматически»; `agent_get_publishing_calendar`'s `uploads` carry
  `automatic`, `progressPercent` (floor of stored / total bytes, null when the total is 0) and `finishedAt` (Agent API 3.20.0, Producer
  API 1.10.0; `calendar-reads.ts` `agentUploadOf`). No agent tool reaches the watcher, `queueAutomatic` or the setter
  (`no-agent-upload-tool.test.ts`, AC-AU-11).

### 47.7 Upload queue control (BL-239, ADR 0059, `docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md`)

- **Order.** Schema v117 adds `publishing_uploads.queue_rank` (backfilled from `created_at`; a new row gets its creation time in ms,
  an approval's rows + their index) and `queued_by` (`owner` / `automatic` / `producer`). The runner's `tick()` picks the next start
  from the `queued` rows sorted by `compareQueueOrder` (rank, then `createdAt`, then id); `sending ?? next` is unchanged, so a row
  being sent always goes on first. Processing/finishing rows keep their `createdAt` order.
- **Control** (`publishing/upload-queue-control.ts`, wired by `createUploadQueueControlCore` in `index.ts`): `list` (rows in progress;
  queued rows with position, channel title, size, `bytesAhead` = the sending row's remaining bytes + the queued sizes before; no ETA),
  `move` (to a 1-based place; `reorderQueuedPublishingUploads` renumbers the queued rows 1..N in one transaction, all or none --
  `upload_queue_changed` when one stopped being queued), `moveStep` (the owner's ±1), `cancel` (compare-and-set from `queued`;
  the Producer's sets `error_code = cancelled_by_producer`), `add` (Producer only). Add, move and cancel pass the device mutation
  gate. Every action is audited with `by` (`producer` + token id, `owner` + user id): `publishing.upload_queue_moved`,
  `publishing.upload_producer_queued`, `publishing.upload_cancelled`.
- **Add.** Refused unless this computer's `autoPrivateUploadEnabled` is on (the one uploading computer, ADR 0046 §8). Then
  `checkPackageForQueue` (extracted from `auto-upload.ts`, used by both): ready, slot not vetoed, `sha256` in the manifest, not held
  here or by a peer, not tried (`blockedHashes`: any row of the manifest hash except a row the Producer both queued and cancelled), size, SHA-256; the switch is
  read again; `upload-approval.ts` `queueByProducer` (the approval's queue step; private; `publishAt` only from an approved slot more
  than 15 minutes ahead; `videoSha256` frozen). The runner's re-hash keys on the frozen `videoSha256` (automatic and Producer rows); at the date step a slot no longer approved
  withholds the date on automatic and Producer rows alike.
- **Surfaces.** Producer API 1.14.0: `producer_upload_queue_list/_add/_move/_cancel` (`producer-only`, `session-deps.ts` wires the
  core with `planSlotDecisions` passed by `src/app/api/mcp/producer/route.ts`). Owner: `POST /api/channels/[channelId]/publishing/
  uploads/[uploadId]/move { direction }`; the uploads list (`publishing-uploads.tsx`) shows queued rows first in queue order with
  «№ k из n в общей очереди» and ↑↓. `no-agent-upload-tool.test.ts` pins the exception to these four tools and the core's callers.
- **Stop a running upload (BL-244, ADR 0064).** `cancel` is the one cancel for the Producer and the owner (`cancelUpload(input,
  userId)` → the core as the owner): `isCancellable` (no video id, no `finalChunkSentAt`, bytes left once sending; queued,
  uploading or paused), then `stopPublishingUploadBeforeYoutube` -- one `UPDATE` with the same conditions and the status read,
  `RETURNING` the bytes. The runner's last-chunk mark is a compare-and-set on `uploading`, so one of the two wins; after a stop
  the runner's next write fails, `claimPublishingUpload` gives no lease to an inactive row (no further chunk) and `fail()` writes
  and audits nothing over a row it no longer holds. Audit `publishing.upload_stopped` (sending) / `publishing.upload_cancelled`
  with `by`, status and bytes. No YouTube call: the resumable session expires. Owner UI: «Остановить загрузку» + `ConfirmDialog`.

### 47.4 Not built yet

- Stage 3: Batches → History.
- Deferred from stage 1 (FO-REQ-0023 C1 and D1):
  - the reminder threshold is the constant 7 (`PUBLISHING_REMINDER_DAYS`), not yet a setting;
  - the calendar shows the active channel's month, with no "both channels" view and no separate "next 14 days" list. The gaps of
    the next 2 weeks are marked on the grid; at month end, part of them is on the next month's page.
- Deferred from stage 2: the AI-use
  fix for published videos was dropped (owner msg 2725); Details still starts an unreadable AI use checked rather than from the
  channel default. (ffprobe on Windows, deferred here at first, is fixed: `ffmpeg-host` looks for `ffmpeg.exe`/`ffprobe.exe`
  in PATH there, and publishing looks again after a miss instead of keeping it until a restart.)

## BL-225 — the weekly publishing plan (ADR 0051)

FO-REQ-0040; owner msgs 3511/3534; plan `docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md` (AC-WP-01..34). Stage 1 on branch
`feature/bl-225-weekly-plan`: the plan, the MCP tools and the screen. No YouTube call, no schema change.

- **Storage** (`sync-gateway/publishing-plans`, family `publishing_plans`, 19 in all): one Automerge document per channel
  (`ytm-publishing-plans` v1, genesis actor "publishing-plans") with three flat maps that exist from the genesis -- `plans` by
  `weekStart` (time zone, created/updated by), `slots` by `<weekStart>:<slotId>` (assigned whole), `decisions` by a fresh id -- so
  two computers that start the same week or save different slots merge; a slot edited on both: last writer wins.
- **The module** (`src/lib/publishing-plans/`): `model.ts` derives everything -- the content hash (SHA-256 of `[timeZone, date,
  publishAt, lengthHint, note]`), approved (the newest approved/revoked decision with the current hash), `changedAfterApproval` (the
  last approved snapshot still standing when the hash differs), vetoed (the newest vetoed/restored decision), the status (stage 1:
  `planned` / `vetoed`; a `progress` port brings the others in stages 2-3), the plan state and counts. `services.ts`: `save` (every
  rule first, then one change; `details.refused`), `get`, `list`, `ownerList` (with `waiting`), `ownerGet`, `decide` (approve the
  shown hashes or nothing; revoke; veto; restore; nothing after a slot's time). `agentSurface` (save/get/list) feeds
  `factory-channel-deps.ts` and the workers' pinned tools; `createPublishingPlansOwnerCore` only the Web routes
  (`boundaries.test.ts` scans every MCP path). Times: `zoned-time` (`instantOf` refuses a skipped hour).
- **Web UI.** Контент → «План недели» (`weekly-plan-panel.tsx`): week arrows and state chip, the caption (who, when, the channel's
  zone, the owner's time in brackets), four tiles, a row per slot (date/time, thumbnail placeholder, title, the pipeline План ›
  Видео › Пакет › YouTube › Дата, actions), amber rows for a change after approval, struck-through vetoed rows with «Вернуть»,
  the inline veto confirmation, and in «Всю неделю» the bar with the count, the quota estimate (`estimateUploadUnits`) and «Одобрить
  неделю»; «По одному» gives «Одобрить» / «Отозвать» per slot. The tab's badge reads `waiting`.
  Owner TG 4784 (2026-11-23): the tab opens on the current week every time it is shown (`currentWeekStart` in the channel's zone =
  the newest plan's `timeZone`, `channelZoneOf`; before the list arrives the owner's zone, else the browser's), unless the address
  carries a deliberate `?week=<Monday>` (`weekFromSearch`). Away from the Sunday/Monday boundary (`weekIsZoneIndependent`: the same
  Monday at UTC-12 and UTC+14) the week is set at once and its read runs beside the list's; near it the screen waits for the owner's
  zone (`useUserTimezoneStatus`) and the list, at most 1.5 s, so it does not jump. Week reads go through `createWeekLoader` (a read
  of another week aborts the one before, the minute's poll of the same week joins the read under way, `fresh` after a move or a
  refusal; only the newest read's answer applied). Every kept answer names its channel (`Scoped`, `LoadedWeek`; `weekScreenOf`
  derives what is shown): another channel's rows, zone or template never show, a skeleton until the selected channel's week is read;
  answers and decisions arriving after a channel change are dropped (`applyDecisionAnswer`: applied, and the read in flight
  cancelled, only for the current channel and shown week). The list read and the week read have separate error lines. From a list
  container (`@container`) of 44rem the rows share the list's columns through CSS subgrid -- day, thumbnail, title, chain, buttons
  (44-64rem: narrower day and thumbnail, chain without arrows). A row shows at most one primary action («Вернуть» for a pulled
  slot, «Дать дату» for a slot off the template) and «⋯» (`Popover` with `menu`: arrow keys, Home/End, Escape back to the trigger)
  with the thumbnail, the new time, «Отозвать» and «Снять слот». The chain's and the buttons' tracks are sized by an invisible first
  row (`ColumnSizer`) holding the full chain and every compact button set in every interface language, so nothing moves on a
  language switch; under 44rem the stacked card with the buttons at the end of the chain's line.
- **BL-240 (ADR 0060) -- pulled and replaced slots.** The screen lists vetoed slots under one closed row (`splitVetoed`, numbers
  kept). `save` lets an agent remove a vetoed slot without an upload (also one approved before the veto) and audits it; the veto
  outlives the slot (`standingVetoOf`: `slotDecisions` still answers `vetoed` for its id, and a new slot with that id is refused
  `slot_id_removed`). A slot's optional `replacesSlotId` (same channel, any week) joins the content hash only when set; the view
  carries `replaces` (the target as it stands). `decide` "approve" also writes a `vetoed` record with `replacedBy` for each replaced
  slot not vetoed, released or gone, in the same change, audited; the week bar and the slot row say so before approving.
- **BL-242 (ADR 0062) -- one approval per packaged video.** The plans document's root `approvalStage` (`packaged` when absent, or
  `slot`) is set only by the owner (`setApprovalStage`: one Automerge change, audited `publishing_plan.approval_stage`, route
  `POST .../publishing-plans/approval-stage`). `decisionsForStage` counts approvals made with a package fingerprint in `packaged` and
  those without one in `slot` (vetoes in both). In `packaged`, `slotViewOf` reads the fingerprint from the `progress` port
  (`package.manifestSha256` from the scan, `videoId`): approvable (`packageReady`) when uploaded, or packaged with no problems --
  else `awaiting_package` (not `needsOwner`; plan state `planned`). The hash is `contentHashOf(zone, content, fingerprint)` (appended
  last); the slot's standing approval is the newest fingerprinted approve/revoke whose hash still matches the content
  (`standingPackageApprovalOf`), and it covers the current package when video and manifest match and its video id is null or the
  same (an approval before the upload covers the video made of that manifest). `slotDecisions` reads the same `progress` port
  (`composition/publishing-plan-slots.ts` passes `publishingPlanProgress`; a failed read approves nothing) and returns the view's
  fingerprint with `approved`; a veto record stores the slot's package at decision time (else `lastApprovedPackageOf`) and
  `vetoed` carries it. Per video number the newest of those decisions wins (a losing approval is `pending`, a losing veto loses its
  package); two counting approvals of one number are both `pending`. The view's `youtubePublishAt` (only with a current package) shows a date no approval counts
  for («на YouTube: …»); `duplicateVideo` flags the defensive case. Round 3: `channelState` reads progress once for the channel's
  live slots (not released by their own times, or vetoed) and gives `counting` (counting approvals by video number), used by the
  views, `decide`'s fallback veto and `slotDecisions`; `progressWithUploads` ignores a slot's row of another video than its package. Publishing restates it (`slot-decision.ts`
  `approvalNamesUpload`): the automatic upload / Producer add and the runner's date step date only that manifest; the plan schedule
  (`decisionForRow`) first looks for approvals naming the row's video id (one wins, two: pending; a veto naming it unschedules),
  else the row's own slot, whose fingerprint must name the row (video id, else manifest). Mixed builds: RISK-150.
- **BL-243 (ADR 0063) -- a video deleted on YouTube.** `markSharedSlots` leaves `deleted_on_youtube` packages out of every slot
  group (they hold nothing, are never marked). `progressOfSlots` uses a deleted package only when no other package names its slot:
  `failed` with `VIDEO_DELETED_ON_YOUTUBE` (`src/lib/shared-video-presence/`), the video id, no date; of two deleted packages the
  newest upload speaks. A row with planSync `video_missing` is `failed` `video_deleted_on_youtube`. `progressWithUploads` (one rule,
  review round 5): a row counts for its slot only when
  created after the newest deleted upload of that slot and number (removed row's time, else the deleted record's `uploadedAt`;
  unknown time blocks; manifest not part of it); one time rule `uploadTimeOf`; the progress port returns `{ progress,
  packagesUnavailable }` (save() then keeps the older rule, and reads the progress once per save); `existsOnChannelOf` (shared) also feeds the video list's
  `existsOnChannel` / `removedAt`. The code is `src/lib/shared-video-presence/`. `save()` counts approvals as the view does in
  the packaged stage (a deleted package's slot can be removed or retimed freely). A deleted-only slot reports no `changedAfterApproval` (nothing to
  approve; its release is not held to an old approval's time). `fingerprintOf` is null for that progress, so `packageReady` is false
  (`awaiting_package`) and no standing approval covers it (`slotDecisions` -> `pending`); a vetoed such slot is removable. The plan
  schedule never dates a removed video (dep `removedVideoIds`; unreadable: it dates nothing of the channel) but always un-dates
  through its live read (YouTube's not-found ends it -- planSync `video_missing`, the row's date cleared -- only when the removed
  mark names the video; otherwise `refused`, retried after the hour); the approval's `heldSlots` uses
  `holdsSlot` (a finished row of a removed video holds no slot; its video number stays held). Agents: calendar `missingOnChannel`,
  items' `existsOnChannel` / `checkedAt` / `removedAt`; `channel_video_list` `videoIds` with `removed` / `notFound`.
- **Stage 2 -- package v2** (`publishing/packages.ts`): `RELEASE_PACKAGE_SCHEMAS` accepts `/1` and `/2`; v2 adds `slotId`,
  `localizations` (checked in `packageProblems` by `shared-localization-set` with a video's limits; `packageLocalizationSet` gives the
  form sent), `containsSyntheticMedia`, `thumbnails` (one default = `files.thumbnail`; the tests checked by the scan like the default,
  2 MB each). The composer refuses a thumbnail over 2 MB or not an image. Schema v110: `publishing_uploads.slot_id`, set when queued.
  The plan's `progress` port is filled by `src/lib/publishing-plan-progress/` (a composition module: the package scan, cached a
  minute, and this computer's upload rows -> `built` / `packaged` / `uploading` / `failed (code)` / `scheduled` / `published`,
  `videoId`, the package's facts), passed by `factory-channel-deps.ts` and the owner's routes. The agents' list takes `limit`.
  Owner TG 4784: concurrent callers of one channel share the scan under way (`createPackagesReader`'s in-flight map, kept on the
  cache object); `invalidatePackagesEntry` also forgets a read under way, and a read that began before it is not kept. The shared
  read is bounded (`PACKAGES_SCAN_TIMEOUT_MS`, 120 s): past it every caller waiting gets `PackagesScanTimeoutError`, the read is
  forgotten (the next caller scans afresh) and the hung scan's answer is not kept.
- **Stage 3 -- uploads of approved slots** (ADR 0051 §7/§8/§10, `docs/WRITE_AUTHORIZATIONS.md` «Upload localizations»):
  - `auto-upload.ts` gets `slotDecisions` (from `src/composition/publishing-plan-slots.ts` -> the plan's `createPublishingPlansUploadCore`):
    vetoed -> skipped (`slot_vetoed`, not hashed); approved and > 15 min ahead -> `queueAutomatic({ slotPublishAt })`; else dateless.
  - `upload-runner.ts`: the insert's AI flag is `syntheticMediaOf(pkg, settings)`; finishing starts with `localizations` (the shared
    writer via `writeLocalizations`, `expected` = the insert's snippet so a stale read is never echoed back), then thumbnail, playlist,
    read-back, and the date only when all passed (`steps.localizations` in `none` / `verified`).
  - `src/lib/shared-video-localizations/` holds the writer moved out of `live-localizations` (unchanged; `source` names the caller in
    the audit); `live-localizations` re-exports it. Since ADR 0072 amendment 1 a third source `package_localizations` and two optional
    inputs: `expectedCurrent` (fail closed with `video_details_conflict` when a language to write no longer reads as the caller checked)
    and `auditContext` (merged into every audit row).
  - `plan-schedule.ts` + `createPlanScheduleCore` (loop in `instrumentation.ts`, every minute): for each done row with a slot and a
    video, `desiredDate` (veto -> no date; approved -> the slot's time when the upload's checks passed and it is > 15 min ahead; pending
    -> nothing; a date within 15 min is never changed); a fresh read, refused if not private; video-details `applyFieldsUpdate`
    (`publishAt` null removes the date: `statusPartOf` leaves it out of the status part); read back; `steps.planSync`, the row's date,
    audit `publishing.plan_scheduled` / `plan_unscheduled`. Live writes / reads off or the quota: the pass stops, nothing recorded;
    another refusal is recorded and retried after an hour.

## BL-238 — local video cleanup after upload (FO-REQ-0051, ADR 0058)

- **Module:** `src/lib/local-video-cleanup/`.
  - `allowlist.ts`: `isAllowedReleaseVideo`, the one pattern; pure.
  - `decide.ts`: pure. `decideLocally` → `decideOnYoutube` → `decideOnContent`. Each returns delete / wait / refuse / done.
  - `adapters/fs.ts`:
    - `inspectReleaseFile` walks every component with lstat (a symlink, a non-folder or a non-file ends it), and checks
      realpath == the walked path;
    - `writeTombstone`: tmp `wx` + fsync + rename + folder fsync + read-back compare;
    - `unlinkReleaseVideo` re-checks the allowlist, dev/ino/size and the tombstone right before `unlink`.
  - `services.ts`: the sweep, one at a time. The waits are kept in memory for the card.
  - `index.ts`: wires `db.ts` (`listPublishingUploads`, `listAllLiveStreamVideoRefs`, log helpers), channel workspaces, the read
    gateway (`getVideosCleanupState`, the approver's credentials with the read scope), ffprobe, and the CSV through `resolveFromYtmDir`.
- **Order per upload:** local facts first, so a file that cannot go costs no read. Then one `videos.list` per 50 ids per approver.
  Then sha256 (only when the package froze one) and duration (only without `fileDetails.fileSize`), then tombstone, then unlink,
  then log + CSV. A refusal is logged once (unique `upload_id`) and never re-checked. A crash between tombstone and unlink is
  completed at the next sweep only if the tombstone names the same bytes and video.
- **Independence:** publishing, video-projects and live-streams do not know the module. The tombstone needs no reader:
  - `video-projects` takes "published" from `V<n>_youtube.json` / the registry / the upload row;
  - `package-scan` clears problems once the record exists;
  - the live picker lists only existing files.
- **Limitations:** RISK-146.

## BL-255 — replacing an uploaded video's thumbnail (ADR 0069)

`src/lib/video-thumbnails/` is the one writer of a custom thumbnail on a video already on YouTube (owner msgs 4380/4383): the owner's
route `GET/POST /api/channels/[channelId]/videos/[videoId]/thumbnail` (Content card, week-plan slot) and the Producer's
`producer_video_thumbnail_replace` (Producer endpoint only; `no-agent-upload-tool.test.ts` pins it as the one thumbnail tool).

Flow (`services.ts`, deps injected, tested AC-TH-01..14): path rule (`04 Videos/`, .jpg/.jpeg/.png, no `..`) → the file through the
package-preview rule (`createPackageScanCore().readThumbnail`: workspace rule, real path inside `04 Videos/`, type from the first
bytes), at most 2 MB → credentials (the owner's own; for the Producer the channel's connected user) → `getVideoThumbnailState`
(read gateway, 1 unit): exists and `snippet.channelId` matches → `isUploadThumbnailStepPending` (publishing: an active upload row of
that video without `steps.thumbnail` would overwrite the new image) → dry run returns here → backup (`video_thumbnail` snapshot:
URLs + the largest image as base64, fetched by `downloadVideoThumbnailImage`, `*.ytimg.com` only) → `assertWriteChannel` →
adapter: client, `assertLiveWritesAuthorized()`, gateway `setVideoThumbnail` → read-back (`hasCustomThumbnail` true, privacy and
`publishAt` unchanged) → audit BACKUP / RESULT / VERIFICATION → `updateStoredVideoThumbnails`. Quota context `video_thumbnail`.

Security: a new YouTube writer reachable by an agent (the Producer), as the owner decided; it can change only the thumbnail, only
from the channel's own workspace images, behind the same identity check and Live writes switch as every other write.

## BL-269 — English captions for WWE long videos (ADR 0074; on its branch, not in dev yet)

`src/lib/video-captions/` is the one writer of caption tracks (`VIDEO_CAPTIONS_PLAN.md`): `caption-file.ts` (pure, browser-safe:
SRT/WebVTT check, name rule, `isEnglishLanguage`), `hash.ts`, `services.ts` (`write(input, actor)`, deps injected, AC-CAP-11..22,
38..46), `adapters/youtube-writes.ts` (client → `assertLiveWritesAuthorized()` → gateway insert/update), `index.ts` (production
wiring; the caller passes the channel switch and the runner's attempt mark). It imports nothing from `publishing`.

Flow: the very bytes re-hashed and re-parsed, `en`, name, V code, the switch read now → device gate (owner/Producer) → credentials
with `youtube.force-ssl` → `getVideoCaptionContext` (channel, `fileDetails` frame; else the frame memo) → `listVideoCaptions` and the
decision by language (ASR ignored; ours = the record's / the upload rows' track ids with the sha256 sent; without `overwrite` an
English track refuses -- foreign or own-differs; with `overwrite` exactly one standard non-draft track is replaced, none = insert) →
`checkUnits` (550 / 800) → dry run returns (51 units) → backup `video_captions` (track list, bytes to send; an overwrite also the
replaced track's content from `captions.download` -- a failed download stops the write) → `assertWriteChannel` → attempt mark
(runner) → one `captions.insert` / `captions.update` (`part=id`, `{ id }`, no snippet) → read-back (`captions.list`: id, language and
name, standard, not draft, serving / one re-read on syncing, an overwrite's `lastUpdated` advanced, other tracks unchanged) → audit
`source: video_captions`. Quota context `video_captions`.

Callers (publishing): the upload runner's `captions` step through `caption-step.ts` (DB-free; after `localizations`, before
`thumbnail`; refusals → `steps.captions: refused`, pauses/unknown answers → the runner; only a `serving` track passes -- `syncing` is
`pending` and read again up to READ_BACK_RETRIES, anything else `mismatch`; lost answer adopted via `steps.captionsAttempt` -- a
same-name track not listed before and updated at or after the mark -- or a 409 `captionExists`; the mark is taken back when the adapter
flags the error as not sent; the mark keeps the retry count, so a failing insert gives up after MAX_RETRIES) and `package-captions.ts`
(owner route, Producer tool; package + upload record, current manifest, `captions_step_pending` while a row of the video is active,
`captions_upload_unfinished` while the record is still the runner's first, then the record's `captions` -- a pending track recorded
`verified: false, pending: true` -- and `markUploadCaptionsSetLater`). The runner's record step merges the record's existing `captions`
(the other computer's add). The date waits for `captionsPassed`; `plan-schedule.checksPassed` too.

## BL-257 — the owner's review of final release packages (ADR 0070)

- **Module:** `src/lib/package-reviews/` -- `contracts.ts` (views, problem codes), `schemas.ts` (strict decision / switch inputs),
  `model.ts` (pure: well-formed decisions, the LATEST owner decision per manifest, the gate state -- no document off, unreadable on with
  nothing approved -- the scan gate object `reviewGateOf`, and the narrow tried exception `triedExceptionsOf`), `services.ts` (view,
  switch, decide, media file; every port injected), `index.ts` (production wiring; `readOwnerReviewState` for the scan,
  `createPackageReviewsOwnerCore(ports)` for the routes). It never imports `publishing`: `src/composition/package-reviews.ts` maps the
  scan to `ReviewPackage`s, resolves files through `createPackageScanCore().resolvePackageFile` (workspace rule + real path inside the
  real `04 Videos/`), keeps a 30 s scan memo for the player's Range requests, and after a change drops the plan's package cache
  (`invalidatePlanPackages`) and nudges review-notify.
- **Store:** sync family `package_reviews` (`sync-gateway/package-reviews`, `-sync`): one Automerge document per channel, fixed genesis
  actor; `required` assigned whole, `decisions` under fresh ids. `read` tells "no document" (`exists: false`) from a document that cannot
  be loaded (throws).
- **Gate:** `publishing/package-scan.ts` reads `ownerReview(channelId)` once per scan (a failing port = closed gate). Only a package with
  no upload record and no other problem is judged; the thumbnail is hashed only when an approval stands for that manifest. Wired inside
  `createPackageScanReads`, so every scan consumer sees it.
- **Upload runner (review M1):** the port `ownerReview` is asked again before a `queued` row starts; with the gate on, a row whose
  manifest is not approved with the current thumbnail file (returned while queued, queued before the gate, thumbnail swapped) is
  cancelled `owner_review_withdrawn` (audited `publishing.upload_cancelled_owner_review`) before any byte. Rows already sending follow
  BL-244.
- **Order (review L1):** the store gives each decision `seq` = highest in the copy + 1; the standing decision is ordered by `seq`, then
  `at`, then id (RISK-154 for the residual clock risk). With the gate off the view reports `waiting: 0` (no badge).
- **Tried exception:** `listUploadRowsForTriedRule` + `triedExceptionsOf`: an approved manifest whose rows are all `cancelled`, without a
  video id, and created before the approval is removed from the automatic upload's tried set; a row after the approval keeps it tried
  (no re-queue loop).
- **Surfaces:** owner routes `/api/channels/[channelId]/package-reviews` (`GET`/`PUT`, `/decision`, `/video`, `/thumbnail` via
  `local-file-response`, `isOwnerBrowserRequest`); Media → «Видео на проверку» (`MEDIA_TABS` value `packages`); the week-plan slot line
  from `PlanSlotPackage.reviewComment` and the problem codes; review-notify kind `package` (`packageNoticesOf`). Notices (fix
  2026-11-24): `GET /api/package-review-alerts` (`createPackageReviewAlertsHandler` in the same `handlers.ts`, so AC-PR-08's single
  composer holds) -- per connected channel the owner surface's `waiting(channelId)` (= `view().waiting`; 0 without a scan when the gate
  is off), the Media menu badge for the active channel and a bell entry (group `packages`, `/media/packages`) for the others
  (`src/components/package-review-alerts.ts`, the storyboard-alerts pattern).

## BL-267 — the week template replaces slot approval (ADR 0073, WEEK_TEMPLATE_PLAN.md)

- **Template storage.** Two root maps of the channel's `publishing_plans` document, absent from the genesis: `templateVersions`
  (whole, immutable `week-template/1` versions with a canonical content hash) and `templateDecisions` (the owner's
  approved / rejected / withdrawn, Lamport `seq`). The reader merges every conflicting value of a root key
  (`Automerge.getConflicts`), so two computers' first versions both survive. `templateInForce` fails closed on a hash mismatch.
- **Matching** (`template.ts`, pure): UTC weekday + exact minute; kind from the package's duration (short ≤ 180 s; `hours` ±10 %);
  positions are claimed channel-wide by the first created live slot of the kind; a vetoed slot claims nothing.
- **Date rule.** `slotDecisions` dates a slot by the template when it matches, its package is ready (apart from the owner-review
  problems) or uploaded, and the media review allows it (`progress.media.review`: computed in `publishing-plan-progress` with
  `package-reviews.standingDecision` for every package). Decisions carry `source` and the media key, so a packaging-only re-package
  keeps the date (`approvalNamesUpload`, `fingerprintCovers`). The explicit owner date is one slot per decision and names the media
  too. `approvalStage` is ignored (setApprovalStage writes nothing); `replacesSlotId` holds nothing. Decisions are read by slot id
  across weeks.
- **Owned dates.** `plan-schedule.change()` in automatic mode leaves a YouTube date that is not the row's own (`foreign_date`,
  retried hourly; a mismatch read back from its own write counts as its own). Explicit mode (moves) may change any date.
- **Moves.** `move()` checks everything (slot, hash, margins, target week, 52 weeks, 28 slots), then asks the `moveYoutube` port
  (`createPlanMoveYoutubeCore`: this computer's newest finished upload row of the video, `explicitPrecheck`) before writing; one
  `moveSlot` change; revocations of standing explicit approvals; then `explicitMove` (video-details' write, read-back, the row's
  `publishAt`, audit `publishing.plan_moved` with `by`). An undated video only changes position (D1); a failed write leaves the plan
  moved and is retried by moving to the same place.
- **Social.** `socialSlotStates` returns `approved` when the plan dates the slot (template or explicit), evaluated for slots up to 36 h
  past, bound to the current manifest; a foreign date, a veto, a removed entry or a taken position post nothing. `alsoSlotIds`
  (owner TG 4780, ADR 0068 amendment 2) adds slots past that look-back with the same rules -- the composition passes only the slots
  of the owner's pending retry of a failed social job or of a social job still in flight (`slotsBeyondLookback`). Such an old slot
  never counts against a slot inside the look-back in the "one video in two approved slots" rule; it is itself disapproved when
  its video is in another approved slot.
- **Weekly build by template.** `weekly-build.startByTemplate` writes the template (the `templateViewOf` serializer) to
  `05 Docs/publishing/week-template.json` and starts `13 Weekly_Plan v1 auto --template [--week]`; `collectTemplateBuild` saves a done
  job's `job.result.payloads` through the plan's agent save as `factory` once per job and runs `13 push --sent --plan` for the accepted.

## BL-265 — the media-only gate and packaging fixes after upload (ADR 0072, MEDIA_GATE_PLAN.md)

- **Gate key.** `package-reviews/model.ts`: `OwnerReviewState` = `{ required, decisions (approved/returned only, in seq/at/id order),
  aliases }`; `decisionCovers(d, key, aliases)` -- the same manifest SHA-256 always (BL-257 decisions have nothing else), else a decision
  with `videoSha256` + `videoSizeBytes` equal to the package's under the same code or `aliases.get(d.video) === key.video` (V -> S, one
  way); `standingDecision` = the latest covering one across both kinds. `reviewGateOf(state).problemOf({ manifestSha256, video,
  videoSha256, videoSizeBytes })` is the scan's and runner's port (`publishing/owner-review-gate.ts`, no thumbnail). Aliases come from
  `video-projects.recodeAliasesOf` through `publishing.ownerReviewStateFor` and `composition/package-reviews.ts` (a port, §M).
- **Decisions.** `decide` writes `videoSha256` / `videoSizeBytes` (an approval only after the mp4 is `sizeBytes` long and hashes to
  `sha256`; a return when the manifest states them) and keeps `manifestSha256` and the thumbnail hash so a BL-257 build reads it as
  manifest-only. `packaging_comment` (comment required) on any package, uploaded included; dropped by older builds; never in the gate.
  The recode's `carryDecision` copies only a decision without the media key (the 11 live WWE decisions); a media decision returns its
  kind with `wrote: false`.
- **Checks.** `packages.ts` `packageChecks` splits `PACKAGE_WARNING_CODES` off; `packageProblems` = the blocking list.
- **Runner refresh.** `upload-runner.ts`: deps `readManifest` (hash + text of one read) and `packageProblemsNow` (the scan's checks);
  `takeRepackage` runs only for a `queued` row with a frozen `videoSha256`, before identity and `begin`; the row is rebuilt with
  `approved-package.ts` `approvedPackageOf` (the one manifest -> row builder, also used by the approval and the packaging fix) in one
  conditional update. Tried keys: `listUploadRowsForTriedRule` returns the frozen `videoSha256`; `package-reviews.triedKeysOf` returns
  manifest hashes (old rows) and media keys; `owner-review-gate.isTriedPackage` checks both; the exception per key also accepts a BL-257
  approval of one of the rows' manifests.
- **Packaging fix.** `publishing/package-metadata.ts` (`createPackageMetadataCore` in `publishing/index.ts`): `inspect` (package with a
  video id, YouTube's text limits, no active upload row here, device gate, fresh snapshot: `not_found` (reason `no_item`) -> `video_missing`,
  `snapshot.channelId` != channel -> `video_not_in_channel`), three-way per field with `package-text.ts` (`samePackagingValue`: title
  exact, description `youtubeDescriptionText`, tags unordered; also `readBackMismatches`); baseline = the latest `package_metadata`
  VERIFICATION audit's `afterTexts`, else the finished upload row's package. `apply` sends only differing fields through
  `video-details.applyFieldsUpdate` with `expectedEtag`, `verifyUnchanged` (category, languages -- not a `zxx` audio language -- privacy,
  publishAt) and `auditContext`, then compares the localization language set before/after (`getVideoMetadataContext`).
- **Package translations fix (ADR 0072 amendment 1, owner TG 4839/4842).** `publishing/package-localizations.ts`
  (`createPackageLocalizationsCore`): the same gates (`findUploadedPackage`, `readUploadedVideo` exported from `package-metadata.ts`),
  the set `packageLocalizationSet` (descriptions `youtubeDescriptionOf`), YouTube's own default language skipped, per language and
  field three-way (`LocalizationBaseline { entries, complete }`: the latest verified `package_localizations.applied` audit's
  `afterLocalizations`, else the done row's frozen `localizations` when `steps.localizations` is `verified`, or empty and complete when
  `none`; else unknown). Any conflict refuses. `apply` calls `createVideoLocalizationsWriterCore("package_localizations")` with only the
  languages to write, `expectedCurrent` (the entries this check read; the writer re-checks them on its fresh read and recheck) and
  `auditContext`, then reads the snapshot again for privacy / publishAt. One write per call; against the writer's stale snippet echo it
  passes `expected` texts (`expectedSnippetOf`: the checked texts, or a `package_metadata` fix of the last 15 minutes) and both fixes
  take `withPackageVideoLock` (package-metadata.ts). Baseline parsing is `localizationBaselineOf` (pure, over `auditEvents`).
- **video-details.** `adapters/youtube-api.ts` takes injectable I/O; order client -> read -> refusal checks -> Live writes -> write;
  `snippetPartOf` (full snippet read-merge-write); snapshot `channelId`; `applyFieldsUpdate` input `verifyUnchanged` / `auditContext`;
  `read-back.ts` `youtubeDescriptionText` in `sameFieldValue`.

## BL-263 — the second video code `S<n>` and the Short recode (ADR 0071, SHORT_VIDEO_CODE_PLAN.md)

- **One code rule.** `src/lib/shared-video-code/` (pure, no dependencies; `sync-gateway`, the Factory server and client components
  import it) owns every rule about a code: `VIDEO_CODE_PATTERN` `^(V|S)[1-9][0-9]{0,5}$` for every input and new contract;
  `isLegacyVCode` (`V\d+`) / `isReportVCode` (`V\d{1,6}`) plus the strict S for readers of existing files and reports, so no existing V
  package or report changes meaning; `parseVideoCode`, `compareVideoCodes(Desc)` (V block before S, numeric), `reportVersionFor`.
- **Files.** `workspace-videos.videoNumberOfFolder` reads `<MMDD> S<n>[ Short]`; `RELEASE_PACKAGE_FILE_PATTERN`, the upload record and
  cost file names, the cleanup allowlist and the release-folder rename take S. A package whose manifest names an S (or sits in an S
  folder) must name exactly its folder's and file's code, else `field_invalid` (the check runs only when an S is involved).
- **Numbering (`video-projects`).** `strictVideoCode` keeps every strict code in the list (`V07` stays ignored, as before); the next V
  reads only series V. `createVideo({ video })` reserves a given S (`reserveGiven`) unless any source knows it (`video_number_taken`,
  `details.source`); a given V is refused before the gate. `renumber` refuses an S; an S conflict has no `suggestedVideo`.
- **Recode alias.** `recodeAliases` (numbering.ts): a V that any computer reports cancelled with `replacedBy` an S (a conflict renumber
  is always V→V). Such a V is `recoded` (+ `recodedTo`), never in dispute, names no YouTube video, refuses links (`video_not_found`
  reason `recoded`, also on the fast path of `assertAttachable`), and counts toward the next V. `video-costs` maps runs of a recoded V
  to the S (port `recodeAliases`, wired to `video-projects.recodeAliasesOf` -- a light read of the reservations, no workspace walk);
  the weekly plan's progress port adds `recodedFrom` (same light read) so `fingerprintCovers` accepts an approval naming
  the old V when it names the same non-null video id.
- **Sync.** The three per-device reports carrying a code are written as version 2 only when they hold an S (else version 1 byte for
  byte); the schemas accept 1 and 2 and refuse a v1 report holding an S. An older build reading a v2 report says "newer than this app
  understands; update the app" and keeps the peer's last report (release order: both computers updated before the first S).
- **The recode (`src/lib/publishing/release-recode.ts`, `factory_release_recode`).** Checks first (invalid, not found / ambiguous in this
  channel's workspace, not a « Short» folder or horizontal, target known or a target name present, busy, a peer upload row, a standing
  owner approval), then journal + backups (`<app data>/release-recode/<channel>/<video>-<ms>.json`, holding the original manifest and
  record texts and the DB snapshot), then: rename files named after the code (`renamedForCode`: `<C>[ _.]…`, `Thumbnail_<C>(_X|_base)`
  images and `.logo.json`, `work/<C>_*`), write the manifest (`rewriteManifest`: `video` + every non-free-text field naming a renamed
  file), write the records' `video`, rename the folder, `db.ts recodeVideoRows` (one transaction, every update guarded by the snapshot's
  value), relink storyboards. A failure undoes the done steps (and the running one) in reverse -- each undo idempotent
  (`undoVideoRecodeRows` puts back only values that still are the new ones); a journal left by a crash is undone at the next call.
  Then caches invalidated, the three reports published, read-back (scan, file names, rows, the video list's alias and next V) and audit
  `release.recoded` (a `mismatch` lists `readBackProblems`). A finished recode writes `completed: true` into its journal before removing
  it; a completed journal (or one whose `done` covers every step) is only cleared, never undone. Unfinished journals are read by the
  shared `src/lib/release-recode-journals/` module, so `video-projects` blocks their codes and lists them (`pendingRecodes`) without
  importing publishing. Composition (`src/composition/release-recode.ts`) supplies the video list, package-review approvals, plan slot
  decisions, storyboards, peer rows and the other reports, so publishing imports none of those modules. No YouTube client anywhere.
