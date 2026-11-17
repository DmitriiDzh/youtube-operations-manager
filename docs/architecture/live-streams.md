> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 45. A channel's 24/7 live stream of its own public videos (BL-176, ADR 0036)

Plan: `docs/roadmap/plans/LIVE_STREAMS_PLAN.md` (FO-REQ-0019). Schema v86, Factory API 1.14.0. A separate feature module,
`src/lib/live-streams/`, off by default; it runs only on the Mac running as the system service (`YTOM_SERVICE_MODE=1`).

- **Boundaries (§M).** It uses the shared gateways, `ffmpeg-host`, `workspace-exchange`, `write-context`, `sync-gateway` and the
  channel store; no other feature module, and nothing imports it (`boundaries.test.ts`).
- **YouTube writes** (`broadcasts.ts`, §3.9) only on the owner's button press: Live writes checked before the first write, then
  `assertWriteChannel`, then the write gateway's live primitives (`youtube-write-gateway/live.ts`, each preceded by
  `assertLiveWritesAuthorized` in `adapters/youtube-writes.ts`), an event per write. Start: `liveStreams.insert` (once),
  `liveBroadcasts.insert` (auto-start on, auto-stop off, monitor off), `bind`, then the encoder; 5 units the first time, 4 after.
- **Rotation** (`services.ts`, `rotation.ts`): a video enters only if it is the channel's (local store), public now (a fresh
  `videos.list`) and its original (resolved by `workspace-exchange.resolveWorkspaceFile`) matches within 1 s with AAC sound.
- **Buffer** (`buffer.ts`): copies of the originals of the video playing and the next ones in `<appData>/live-streams/<channelId>/`
  (`.part`, checks, rename; delete only after the replacement is in place).
- **Encoder helper** (`helper/encoder-helper.mjs`, plain JS sharing `playback.mjs` and `ffmpeg-host/keyframes.mjs`): a detached node
  process (survives server and launchd job restarts, spike A) that runs ffmpeg over the pass, resumes at a source keyframe, backs off
  2/4/8/16/32/60 s, tells an early end (exit 0 on a missing file) from a pass end, and replays the playable buffered videos when the
  next one is missing. Contract: `plan.json` in, `status.json` (with an adoption token) and `events.jsonl` out; the key only on stdin.
  A stall watchdog stops ffmpeg when its output time has not grown for 60 s (ffmpeg 7+ prints progress on a timer even over a dead
  connection). The supervisor serializes start/stop/restart/tick per stream (buffer copies run under a separate buffer lock, never
  under the stream's) and kills an ffmpeg left by a helper killed outright (matched by `<stream dir>/run.ffconcat`) on Start and Stop.
- **Supervisor and loop** (`supervisor.ts`, `runner.ts`, `instrumentation.ts`): every 15 s a stream whose intent is on is adopted
  (pid + token + fresh status) or started (the key read from YouTube); its position, buffer and next pass are tended; every 5 min the
  broadcast, the stream's health and the viewers are read (`youtube.json`). YouTube ending the broadcast stops the encoder with no
  write. A running stream is not "busy" for the idle watcher.
- **Live analytics** (BL-211..214, `docs/roadmap/plans/LIVE_ANALYTICS_PLAN.md`): every completed broadcast poll is kept in
  `live_viewer_samples` (v105; viewers null when YouTube gives no count; a failed write never breaks the poll). The shared leaf
  module `src/lib/live-analytics/` (imports no feature module) summarises samples + encoder run exits (`summarise.ts`, rules in
  the plan §3), pulls YouTube Analytics of ended broadcasts hourly from `instrumentation.ts` (`collect.ts` → `live_broadcast_analytics`,
  v106: concurrent avg/peak, per-minute `livestreamPosition` curve, `liveOrOnDemand` views/minutes; first pull 1 h after the last
  sample, final 4 days later; 400 = unsupported part, 403/404 on all = unavailable, else retry 6 h × 5; reads-off/quota stop the
  tick) and serves the «Эфиры» card (`GET .../live-stream/analytics`) and `producer_live_analytics`. The samples and pulls are
  device-local. BL-222 (plan §6): every 5 min its own loop publishes `publishLiveAnalyticsReport` -- the four ranges (1/7/30/90
  days) of each channel sampled in the last 90 days, from local data only -- as the per-device report `ytm-live-analytics` v1
  (`sync-gateway/live-analytics`, family `live_analytics`, the 18th; strict: ids, ISO dates, codes and numbers, never the
  per-minute curve). `summary` answers from local samples when it has any for the channel in the range, else from the newest peer
  report whose range has samples (`source: {kind: "peer", deviceId, hostName, updatedAt}`), else local (empty); a range outside
  1/7/30/90 is local only. `producer_live_analytics` stays local. The card is also shown on a computer without the stream host
  when a peer reports the channel.
- **Other computers** see the `live-streams` per-device report (`sync-gateway/live-streams`, strict fixed codes); the Operator reads
  `factory_live_get_status` and maps files with `factory_live_map_sources`. Bell notices: down, ended by YouTube, next video missing.
- **A second source: the segment library** (BL-234, FO-REQ-0048 as changed by the owner, msgs 3792/3793/3795; ADR 0056).
  - `live_streams.source_mode` (v114; null = `videos`, unchanged) chooses what the stream plays. `segments` = the owner's
    selection (`live_stream_library_segments`, device-local, in order, with the facts of its last check) from the channel's
    library `<workspace>/04 Videos/Live Segments/seg-<6 digits>.mp4` + sidecar `.json` (+ poster `.jpg`), written by the Operator's
    generator as `.part` then renamed. `library.ts` lists only complete segments whose sidecar parses with the file's `seq`; it has
    no write, rename or delete of a library file (`adapters/library-files.ts` reads through `resolveWorkspaceFile`, ffprobe cached by
    path/size/mtime). No YouTube read: a segment is checked by ffprobe only (picture, AAC 44.1/48 kHz ≤ 2 ch, known duration).
  - One engine: a segment's id in a pass is `seg-<seq>`; the supervisor's items are both sources' (`index.liveSourceItems`), the
    buffer checks a segment copy with `checkSegmentMedia` instead of the YouTube duration, the helper is unchanged (resume by index
    + offset, replay of the playable copies). `recheckLiveSource` dispatches by mode for Start, Restart, encoder starts and the
    next-pass draw: a missing/unreadable selected segment is left out (`segment_refused`, once per change); the library unreadable →
    the last checks stand (`segment_library_unavailable`); none → `live_stream_video_refused` with `no_segments_selected` /
    `no_playable_segments` / the library's reason, never an empty pass. At the next-pass draw of a running stream any refusal draws
    nothing (the helper replays its pass), is an event once per change (`source_refused`) and is retried at most every 60 s
    (`SOURCE_RETRY_MS`; a mode switch or selection change ends the wait, `noteSourceChanged`); the library's state is an event per
    change (`segment_library_unavailable` / `_available`). An empty videos answer on a running stream is a refusal too
    (`no_playable_videos`); the switch back to videos needs a playable rotation video (`live_stream_no_ready_videos`, 409).
  - The owner's switch (`PUT .../live-stream/source`) drops the already drawn next pass, so it applies at the next pass (at the
    latest the one after) or at once with Restart / the next Start. Switching to segments is refused (`live_stream_no_ready_segments`,
    409) until a selected segment passed its check; the selection is prepared in videos mode («Сегменты (подготовка)»). In segments
    mode every selection change drops the drawn next pass too. The switch and the selection's writes take `withChannelLock`; an add
    is one `INSERT … SELECT MAX+1` (`appendLiveStreamLibrarySegment`). No MCP tool reaches it or the selection; the status carries
    `sources` (Factory 1.38.0, Agent 4.12.0). The shared report keeps `playing: null` for a segment (its id is not a video id).
- **Streams and an upload share the Mac's uplink** (BL-233, FO-REQ-0047; owner msgs 3786/3788). Two encoders at 6000k plus a
  4.7 GB upload over ~10 Mbit/s Wi-Fi starved a stream (0.676x, `videoIngestionStarved`).
  - A stream's own bitrate: `live_streams.bitrate_kbps` (v113, null = the computer's `bitrateKbps`), saved with the stream's settings;
    `supervisor.encoderBitrateFor` picks it at encoder start; a stored value outside 1000..12000 never reaches ffmpeg.
  - `src/lib/upload-bandwidth/` (shared, pure, imports no feature module) is the upload governor. Its `load()` is composed in
    `src/composition/upload-bandwidth.ts` from `live-streams.readLiveUploadLoad()` (the computer's settings `uploadCapMbps` 2 /
    `uploadGuardMinutes` 3, the streams whose intent is on, and each encoder's reading from `status.json` -- `encoder-load.ts`);
    the governor is handed to publishing's upload runner by `instrumentation.ts` and registered on `globalThis` for the readers.
  - Rules: any stream on → the upload is paced to the limit (0 = none); none → unlimited. A stream measured below 0.97x for the
    guard minutes → no new chunk (the row stays `uploading`, its session kept; nothing is read, hashed or asked while held) until
    every measured stream holds ≥ 0.99x for a minute, at most 30 minutes; after a ceiling release it is not held again until the
    streams recover. A gap (stale or not-running status) neither starves nor recovers; a hold for a stream turned off or no longer
    listed ends at once (`stream_off`); a failed read still ends a hold at the ceiling; no upload asking for 30 s forgets the hold and
    the timings (`no_upload`), and a gap of more than 90 s between evaluations or samples restarts the measuring. The speed is
    measured from `outTime` over the last 30-90 s, because ffmpeg's `speed=` is the average since its run began; ffmpeg's figure is
    used until the window fills. Each progress block carries its own time (`progress.at`), because the helper's 10-s heartbeat
    rewrites the status with the old output time; for helpers started before that, an unchanged output time is taken only after
    20 s (a stall). The limit is 0 or at least 0.5 Mbit/s.
  - Pacing: the write gateway's `putVideoUploadChunk` takes `pace`; `nodeUploadHttp` then writes the chunk body in 64 KB slices,
    each after a token-bucket wait (burst ≤ 0.25 s), honouring backpressure -- the request (Content-Length, Content-Range) is the
    same. A limited chunk is about a minute of sending in whole 256 KB units (≤ 8 MB). A hold never stalls a PUT in flight (socket
    timeout 10 min, lease 12 min): the chunk in flight finishes at the limit.
  - Holds and releases are `upload_held` / `upload_released` events in the starving stream's history and a server log line.
    `factory_live_get_status` (1.37.0) returns `encoders` (speed, recentSpeed, bitrate, target, outTime, lag -- from the helper's new
    `progress.runStartedAt`, else estimated from the speed) and `upload`; the Web UI shows a line from `GET /api/publishing/upload-bandwidth`.
- **Adding by checkboxes** (BL-187, `docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md` §2.4; `picker.ts`, `picker-service.ts`,
  `adapters/picker-files.ts`, `src/components/live-stream-add-videos-dialog.tsx`). `GET .../live-stream/rotation/candidates`
  lists the video files under `04 Videos/` (the shared `workspace-videos` walk; `?all=1` adds source clips and folders without a
  V-number). A release file is the one file in a `MMDD Vn` folder named after its Vn; two such files: neither is matched by the
  folder. Match sources, strongest first: the Operator's map (exact file), `Vn_youtube.json`, `video_registry.csv`'s row for the
  folder (read tolerantly; its format is not a contract); only the channel's own videos count, and sources naming different
  videos give a conflict and no match. Otherwise the owner picks from the channel's videos within 1 s of the file (ffprobe,
  cached by path, size and mtime). Nothing is ticked for the owner. `POST .../rotation/batch` runs `addVideo` for each item in
  order (all its checks, a fresh YouTube read each); a refusal is reported and does not stop the rest; a missing workspace stops
  the batch. Read-only on disk; no YouTube write.
- **The stream's YouTube settings** (BL-186 stage 2, `LIVE_STREAMS_FIELDS_PLAN.md` §2.1/§3.2; `fields.ts`, `video-settings.ts`,
  `adapters/thumbnail-fs.ts`, `src/components/live-stream-video-settings.tsx`). Schema v92 `live_streams.video_settings_json` holds
  every field the API can set: tags (500 characters as YouTube counts them), category, title/description and audio languages (the
  app's YouTube list; `zxx` for audio), recording date (midnight UTC), license, synthetic-media and paid-promotion marks, public like
  count, up to 10 playlists, the thumbnail's facts (kind, size, SHA-256; the JPEG/PNG of at most 2 MB, checked by its bytes, is
  kept in `<appData>/live-streams-thumbnails/<channelId>.jpg|png`), and the broadcast's latency, DVR, embedding and captions type
  (`closedCaptionsDisabled` only: no caption source). `PUT .../live-stream/video-settings` and `PUT|DELETE .../thumbnail` are local;
  the thumbnail route refuses a body over 2 MB before reading it all. A stored value that fails the schema is reported on the page
  and refuses Start before any call (never read as defaults). Start sends the four broadcast fields inside the same
  `liveBroadcasts.insert` (no new call or unit; never saved = not sent, YouTube's defaults). The video-level fields are shown in the
  Start dialog as "not sent yet": applying them (`videos.update`, `thumbnails.set`, `playlistItems.insert`) is stage 3, after spike
  C. The field limits and lists live in the shared `src/lib/youtube-video-fields/` (publishing re-exports them). Translations of
  the broadcast's title/description are not these settings: they are the stream's own set (BL-207, see "Live stream translations
  at publish" below; this reverses plan §2.3).
- **Risks:** RISK-125 (the key in ffmpeg's argv), RISK-126 (the T9 every ~2 h).

## BL-207 — live stream translations at publish (ADR 0045)

Owner msgs 3254/3257; plan `docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md`. A second, narrowly scoped writer of per-language
title/description (`docs/WRITE_AUTHORIZATIONS.md`, PROJECT_SPEC §21), reversing `LIVE_STREAMS_FIELDS_PLAN.md` §2.3.

- **Shared merge** (`src/lib/shared-localization-merge/`, pure): `buildSafeLocalizationsPayload`, `checkDefaultLanguage`,
  `localeKeyFor` and the fresh-video types, moved unchanged from `batches/merge.ts` (which re-exports them; Batches-only types
  such as `PendingChange` stay there). The change input is the narrow `LocalizationFieldChange`. `hasAngleBrackets` moved from
  `publishing/packages.ts` into `youtube-video-fields`.
- **The set** (`live-streams/localizations.ts`): schema v101 `live_streams.localizations_json`, device-local (the table is in the
  snapshot's device-local list; the `ytm-live-streams` report does not carry it). `validateLiveLocalizations` (pure, for the MCP
  tool, the route, the store and the page) refuses the whole set if any language fails: exact supported code
  (`suggestYoutubeLanguageCode` gives the letter-case hint), title 1–100 characters after trimming (stored trimmed), description
  1–5000 bytes (required: blank refused, owner msg 3287; CRLF stored and counted as LF), no `<`/`>`, not the channel's baseline (case-insensitive), ≤ 50 languages. `createStreamLocalizations`: `set`
  replaces, `{}` clears (null), a channel without a stream row here is `live_stream_not_found` (404), event `localizations_saved`
  (`{ languages, by: owner | factory }`). `view` adds the warnings (a set while the row's video settings are unsaved or unreadable:
  `video_settings_not_saved` / `video_settings_invalid` -- the step runs only inside `applyVideoSettings`, a warning, never a
  refusal, owner msg 3287; a set holding the channel's current base language: `baseline_language_in_set` with `language` -- the
  step fails closed on it; no base language: `no_baseline` -- the video gets no default language, so nothing is written) and the last `localizations` step from the last `video_settings_applied` summary; `save` = `set` + the
  warnings.
  `readStoredLocalizations` reports a stored value that no longer passes (never guessed).
- **The step** (`live-streams/video-apply.ts`): read once in `broadcasts.ts`'s `runVideoSettings` (the funnel of Start,
  «Применить снова» and segments). Right after the fields step: corrupt set → failed step; no set → no step; fields not verified
  → `skipped: "fields_failed"`; stream stopped/replaced → the usual skip; port absent → failed step; otherwise the port's result
  (`YouTube reads back something else: <detail>` when not verified; `sent: false` when the broadcast stopped being current right
  before the write → the usual skip). Events `video_settings_step` as for every step. The dry runs add 53 units and the
  languages when a set exists and both writers are plugged in.
- **The writer** (`src/lib/live-localizations/`, plugged in by `src/composition/live-stream-localizations.ts` in the routes and
  the server's runner): `assertWriteChannel` → fresh `getVideoMetadataContext` (read gateway), re-read until it shows the fields
  step's tags (any order), category and languages — else `update_failed` and nothing sent → `checkDefaultLanguage` → the set
  holding the video's own language fails closed → backup (`kind: "localization"` with snippet text) → `isCurrent` asked again
  (stopped/replaced: nothing sent) → a re-read that must equal the first read's title, description, tags, category, languages and
  localizations (else `update_failed`, "the video changed … apply again", nothing sent; no broadcast lock: Edit holds it) → the
  shared merge from the re-read, with the audio language just read sent back (`zxx` included) → `assertLiveWritesAuthorized` →
  `applyVideoMetadataUpdate` → read-back, up to 6 reads 10 s apart: each written language (key case-insensitive; "language
  missing" / "text differs"), every other language kept ("language lost" / "other language changed"), the snippet text, and the
  tags (any order), category and languages ("tags changed", "audio language changed", …) → audit BACKUP/RESULT/VERIFICATION
  (`video_edit_audit_events`, `source: "live_localizations"`).
- **MCP and route (stage 4, Factory API 1.27.0):** `factory_live_save_localizations` (strict `{ channelId, localizations }`, gate
  first, `save(..., "factory")`, refusals as `validation_failed` with `details.refused`) and `factory_live_get_status.localizations`
  (`localizationsStatusEntry`: codes only -- `problem: invalid_stored`, warning codes, `lastStep.failure: read_back_mismatch |
  failed`, never the error text). Web: `GET/PUT /api/channels/[channelId]/live-stream/localizations` (`liveStreamHandler`:
  session 401, active channel 403) and `localizations` in the overview.
- **The «Переводы» card (stage 5):** `src/components/live-stream-localizations.tsx` under the broadcast settings card, its pure
  logic in `live-stream-localizations-model.ts` (rows ↔ set, language choices = supported codes minus the channel baseline and
  minus the other rows' languages, the server's validator per row plus `language_missing`, `details.refused` placed on rows).
  A row per language (select, title, description with a byte counter), Add / Remove / Save (Save sends the whole set; removing
  every row and saving clears it); the warnings, a stored-value problem and the last step shown; the panel's step list, the
  Start summary, the «Применить снова» list and the history name the step and its languages. Rows are replaced from the poll
  only while unedited (compared as stored: title trimmed, description CRLF → LF, so a just-saved card is clean). No native dialogs; all text in `ui-text` (`live.translations.*`).
- **Not yet verified:** whether
  a live broadcast's video reads its localizations back is unverified until the first real go-live with a set.
