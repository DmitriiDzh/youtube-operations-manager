# Live streams: every API field in the stream's settings, and adding videos by checkboxes (BL-186, BL-187)

**Status: PLAN** on `feature/live-streams-fields-and-picker` (one branch for both, AGENTS.md §K.1). Nothing is built yet.

- Owner's requests: Telegram 2026-10-14, msgs 2780 (both items), 2782 (the field list), 2785 (the go):
  - "пробуем просто запустить 24/7 без перезапусков" — **one 24/7 broadcast, no daily restart**;
  - "добавь все параметры в раздел трансляции и тогда нам не нужен будет шаблон из YT Studio" — **no Studio template**;
  - msg 2780 §2 — pick rotation videos with checkboxes from a scan of `04 Videos`, "максимально удобно в плане UI".
- Builds on BL-176 (`LIVE_STREAMS_PLAN.md`, ADR 0036). Reuses BL-182's package scan (ADR 0037) and the video-details module.

## 1. Facts (code read 2026-10-14 at `dev` 9b9f992; the Mac read-only; YouTube docs read 2026-10-14)

### 1.1 The app today
- **What a broadcast gets.** `liveBroadcasts.insert` (`youtube-write-gateway/live.ts`) sends only title, description, start
  time, privacy, `selfDeclaredMadeForKids`, and contentDetails auto-start on, auto-stop off, monitor stream off,
  `recordFromStart: false`. The stream row (`live_streams`, schema v86) stores only title, description, privacy, made-for-kids.
- **The live edit.** `liveBroadcasts.update` of snippet (title, description, start/end, category echoed back) and status
  (privacy), on a fresh read, with an expected-state check, a before/after event and a read-back
  (`live-streams/broadcasts.ts` :250-305). `contentDetails` is never sent.
- **The video-details module** (`src/lib/video-details/`, owner-authorized 2026-09-20) already edits any channel video's
  tags, category, default language, audio language (experimental, read-back verified), privacy, license, embeddable, public
  stats, made-for-kids, `containsSyntheticMedia`, recording date — with the full chain: dry run, identity, backup, etag
  conflict, audit, read-back. It deliberately excludes `localizations` and paid product placement.
- **Elsewhere in the gateway:** `setVideoThumbnail` (`thumbnails.set`, JPEG/PNG ≤ 2 MB, BL-182) and
  `addVideoToPlaylistForAuthenticated` / `deletePlaylistItemById` (used by `playlist-management`, which validates the playlist
  belongs to the channel). `paidProductPlacementDetails` is sent only at upload (`upload.ts:48`).
- **Adding to the rotation** (`live-streams/services.ts addVideo`): one video id + one workspace-relative path at a time. Every
  add re-reads the video from YouTube (public, no future `publishAt`), checks the file is inside the workspace, and that its
  ffprobe duration is within 1 s of the video's. A refusal writes nothing. The Operator's `live_stream_sources` map pre-fills
  the path.
- **The package scan** (`publishing/package-scan.ts`) walks `04 Videos/` three levels deep by `lstat` (a symlink is never
  followed), reads `Vn_release.json` and `Vn_youtube.json` (the latter holds the uploaded `videoId`).
- **Schema** is at v91 (BL-185). The next is v92.

### 1.2 The Mac's workspaces (read-only, 2026-10-14)
- Tropico: `/Volumes/Samsung T9/YouTube/01 Tropico Jazz/04 Videos/<MM Month>/<MMDD Vn>/`. 45 `.mp4` files, but only one per
  release folder is the release: `Vn Tropico Jazz.mp4` (or `Vn Tropico.mp4`). The rest are source clips (`Seedance …`,
  `Runway …`, `.mov`) and folders without a V-number (`0906 8H`).
- Only **2** folders have `Vn_youtube.json` (V56, V57 — uploaded by YT Manager). Older videos were uploaded in Studio.
- **`04 Videos/video_registry.csv`** exists in both channels (54 rows in Tropico): `VNumber, FolderDate, PublishedAtUtc,
  ScheduledPublishAtUtc, Status, YouTubeVideoId, Title, Folder, …, MatchMethod, Note`. It maps `Vn` → video id → folder for
  the older videos. It is written outside this repository (no code here writes it); its format is not a contract.
- The workspaces are on the T9 (it can be unmounted: `LIVE_STREAMS_PLAN.md` §1.2).
- `live_stream_sources` and `live_stream_videos` are empty on the Mac.

### 1.3 YouTube (official reference pages unless marked)
- **The broadcast's id is its video's id.** Video-level fields are set with `videos.update` / `thumbnails.set` /
  `playlistItems.insert` on that id; broadcast-level ones with `liveBroadcasts.insert/update`.
- **`liveBroadcasts` contentDetails** the app can set: `latencyPreference` (`normal|low|ultraLow`), `enableDvr`,
  `enableEmbed`, `closedCaptionsType` (`closedCaptionsDisabled|closedCaptionsHttpPost|closedCaptionsEmbedded`;
  `enableClosedCaptions` is deprecated since 2015), `projection`, plus the ones already sent.
  - `enableDvr` and `closedCaptionsType` cannot change once the broadcast is `testing` or `live` (403
    `enableDvrModificationNotAllowed` / closed-captions error). Whether `latencyPreference` and `enableEmbed` are locked the same
    way is **UNVERIFIED**; the plan treats all contentDetails as "set at Start".
  - Some settings are not supported together with a latency (400 `invalidLatencyPreferenceOptions`); the reference names
    ultra-low latency as not supporting closed captions (and resolutions above 1080p).
  - Since 2022, contentDetails fields left out of an update keep their values.
- **`videos.update` settable fields:** snippet `title, description, tags, categoryId, defaultLanguage` (the whole snippet is
  replaced, `title` and `categoryId` required); status `privacyStatus, publishAt, license, embeddable, publicStatsViewable,
  selfDeclaredMadeForKids, containsSyntheticMedia`; `recordingDetails.recordingDate`; `localizations`. `madeForKids`, age
  restriction and every `contentDetails.*` are read-only.
  - `paidProductPlacementDetails` is listed as a `part` of `videos.update`; the settable-properties list read did not name
    it. Setting it by update is **UNVERIFIED** (it works at upload, BL-182).
  - `recordingDetails.location` is deprecated and rejected (gateway comment, 2017/2018).
- **Quota:** live calls 1 unit; `videos.update` 50; `thumbnails.set` 50; `playlistItems.insert` 50; `videos.list` 1.

## 2. Decisions

### 2.1 What is set where (BL-186)

| Field (owner's list in **bold**) | API | When it is applied |
|---|---|---|
| Title, description | `liveBroadcasts` snippet | Start; editable live (as today) |
| Privacy | `liveBroadcasts` status | Start; editable live (as today) |
| **Audience** (made for kids) | `liveBroadcasts` status at insert; `videos.update` status later | Start; editable live (video-details) |
| **Image** (thumbnail) | `thumbnails.set` on the broadcast id | Start; replaceable live |
| **Playlists** | `playlistItems.insert/delete` | Start; editable live |
| **Paid promotion** ("Прямая реклама" read as the paid-promotion mark) | `videos.update` `paidProductPlacementDetails` | Start; editable live — **UNVERIFIED**, spike C |
| **AI** (altered or synthetic content) | `videos.update` status `containsSyntheticMedia` | Start; editable live |
| **Tags**, category | `videos.update` snippet | Start; editable live |
| **Languages**: title/description language, audio language | `videos.update` snippet (`defaultAudioLanguage` as video-details does: experimental, read-back verified) | Start; editable live |
| **Languages**: translations of title and description | the existing localization pipeline on the broadcast's video (§2.3) | after Start, like any video |
| License, public like count, recording date | `videos.update` status / recordingDetails | Start; editable live |
| Latency, DVR, embedding, captions | `liveBroadcasts` contentDetails at insert | **only at Start** (locked once live) |

**Only in YouTube Studio** (no API to set them) — shown in the settings as a labelled, read-only list with "set it in YouTube
Studio": age restriction (18+); ad breaks and monetization of the stream; **auto-chapters, featured places, concepts**
(owner's item 6); comments on/off; chat settings (slow mode, members/subscribers only, blocked words); live "Promote" and
"Allow remixing" type options. Moderators are settable by API (`liveChatModerators`) but are not in this plan (§6).

**Captions.** The stream has no caption source, so `closedCaptionsHttpPost`/`Embedded` would show nothing. The setting is
offered as "off" only, with a note; ultra-low latency greys it out anyway. **Open question Q2.**

**Embedding.** One control: `contentDetails.enableEmbed` at Start. The video's `status.embeddable` is not sent as well — two
controls for one thing could disagree. Whether they are the same flag is **UNVERIFIED** (spike C reads both).

### 2.2 How the settings are applied
- **The settings are saved locally** (the stream row) and nothing is written to YouTube by saving — same as the title today.
- **Start** (the owner's button, Live writes on, identity check) becomes:
  1. `liveStreams.insert` (first time only), `liveBroadcasts.insert` with the new contentDetails, `bind` — as today;
  2. the encoder starts (as today: the stream is not held back by what follows);
  3. **"the video's settings"**: one `videos.update` through **video-details' preview/apply** on the broadcast id (it reads the
     video fresh, merges, sends only the touched parts, keeps the audio language, reads back); then
     `paidProductPlacementDetails` (a new video-details field, §3.2); then `thumbnails.set`; then one `playlistItems.insert`
     per playlist through `playlist-management`.
  4. Each write is an event (sent, result, read-back). A step that fails does **not** end the broadcast: the stream page shows
     "Не все настройки применены" with what failed and a «Применить снова» button (the same owner action, Live writes on).
- **The Start dialog** (the dry run) lists every value that will be sent and the units: 4–5 live calls + 1 read + 50
  (`videos.update`) + 50 (thumbnail, if set) + 50 × playlists.
- **Editing while live:** the Edit dialog gets sections.
  - "Название, описание, доступ" — `liveBroadcasts.update`, unchanged.
  - "Свойства видео" (tags, category, languages, audience, AI, paid promotion, license, likes, recording date) — video-details'
    own preview (before/after) and apply (etag conflict check, backup, read-back).
  - "Обложка" — replace (`thumbnails.set`, 50 units), with a before/after preview.
  - "Плейлисты" — add/remove via `playlist-management`.
  - "Трансляция" (latency, DVR, embedding, captions) — read-only while live, "применится при следующем запуске".
- **No daily restart** (msg 2785). The 12-hour archive limit (`LIVE_STREAMS_PLAN.md` §1.3) is irrelevant: recording is off.

### 2.3 Translations and AGENTS.md §F
- **The Change Set / localization mechanism keeps sole authority over per-language title/description.** This plan adds no
  second `localizations` writer: the stream's settings hold the **base** title and description only.
- After Start, the broadcast is a channel video. The stream page links «Переводы» to that video in the existing
  translation screens, where AI generation, review and Batches work as for any video. Batches also align
  `defaultLanguage` to the channel baseline there, as for every video (PROJECT_SPEC §14).
- Whether channel sync lists an upcoming/live broadcast as a channel video is **UNVERIFIED** (spike C). If it does not, stage 1
  adds the stream's broadcast id to the synced list by id (`videos.list`, 1 unit) — a read, not a new writer.
- Every video-level field above is written through **video-details**, which already holds the owner's authorization for
  those fields on any channel video (2026-09-20, 2026-10-02 for the audio language). PROJECT_SPEC §21 (Change Set authority)
  needs **no amendment**. ADR 0036 gets an amendment: Start may also write the broadcast's video fields, thumbnail and
  playlist membership, still only on the owner's attended action. If PROJECT_SPEC lists the modules that write video fields
  outside Change Sets, the live-streams use of video-details is added to that list (a one-line check during stage 1).

### 2.4 Adding videos by checkboxes (BL-187), designed as a UX flow
- **Entry.** The rotation's add row is replaced by one button «Добавить видео…». (The manual "video id + path" stays as a
  collapsed «Вручную» link for odd cases.)
- **The dialog** (wide modal, keyboard-usable):
  - Header: «Видео из 04 Videos — <channel>», a search box (V-number or title), filters «Только публичные» (on by default)
    and «Показать все файлы» (off: only release files).
  - One row per **release file**: the matched video's YouTube thumbnail (from the synced copy), `Vn`, the YouTube title,
    privacy badge, the file name and duration, the match source (see below), a checkbox.
  - Rows already in the rotation: greyed, «уже в ротации», no checkbox. Non-public videos: disabled, with the reason
    («запланировано на …», «приватное»). Files with no match: a «Выбрать видео…» picker inside the row (candidates by
    duration ±1 s, newest public first); the checkbox stays off until the owner picks one.
  - Footer: «Выбрано N · общая длительность hh:mm», «Выбрать все доступные», and the primary «Добавить N видео».
  - Progress while scanning and probing (durations come from ffprobe; cached by path, size and mtime for the dialog's life).
- **Which file is the release file.** In a `MMDD Vn` folder, a video file (`.mp4/.mov/.m4v`) whose name starts with that `Vn`
  (case-insensitive, followed by a space, `_`, `.` or end). Exactly one → it; several → all listed, none pre-matched. Folders
  without a V-number and other files appear only with «Показать все файлы».
- **Matching, strongest first:**
  1. the Operator's `live_stream_sources` map (exact file);
  2. `Vn_youtube.json` in the folder (an upload by YT Manager);
  3. `04 Videos/video_registry.csv` — a row whose `Folder` equals the file's folder and whose `YouTubeVideoId` is one of the
     channel's videos (read tolerantly: a missing file, a missing column or a bad row only means "no match from it");
  4. **suggestions** by duration (±1 s) among the channel's videos — never pre-checked, the owner chooses.
  Sources 1–3 that disagree for one file → no pre-match, the row shows the conflict. **Nothing is checked automatically
  except a 1–3 match whose video is public**; and every add still goes through `addVideo`'s own checks (channel video,
  public read fresh, file in the workspace, duration within 1 s), so a wrong match is refused, never streamed.
- **Adding.** «Добавить N» calls the existing add for each selected row in order (one request with a list, the server adds
  one by one, so one refusal does not stop the others). The result: «Добавлено N, отказано M» with each refusal's reason.
  Order: by V-number ascending (oldest first); the owner reorders afterwards as today.
- **Workspace missing / T9 not mounted:** the dialog says so plainly and offers nothing to check.

## 3. Design

### 3.1 Module layout (AGENTS.md §G, §M)
- **`live-streams`** owns the stream's saved settings, the Start/Edit orchestration, the picker's scan and matching
  (`picker.ts` + an adapter for the folder walk). Switched off, nothing runs (as today).
- **`video-details`** gains `paidProductPlacement` (patch, snapshot, read-back), and its gateway call gains the
  `paidProductPlacementDetails` part. Its behaviour for other callers is unchanged.
- **Shared, not copied:** the folder walk and `Vn_youtube.json` reader move from `publishing/package-scan.ts` into a small
  shared module `src/lib/workspace-videos/` (walk `04 Videos/`, list release folders, read the upload record, read the
  registry) used by both publishing and live-streams — §M forbids one feature reaching into another. Publishing's tests must
  still pass unchanged.
- **Gateway:** no new primitive is needed for stages 1–2 except `updateLiveBroadcast` accepting nothing new (contentDetails
  stays insert-only) and `insertLiveBroadcast` gaining the four contentDetails fields. `applyVideoDetailsUpdate` gains the
  `paidProductPlacementDetails` part. `WRITE_PRIMITIVE_NAMES` is unchanged.
- **Thumbnail file:** uploaded in the browser (JPEG/PNG, ≤ 2 MB, type by its first bytes, 16:9 advised), kept device-local
  under the app's data folder `live-streams/<channelId>/thumbnail.<ext>` with its SHA-256 in the settings. Excluded from
  snapshots like the rest of `live_streams`.

### 3.2 Data (schema v92, additive)
- `live_streams.video_settings_json` (nullable): `{ v: 1, tags, categoryId, defaultLanguage, defaultAudioLanguage,
  license, publicStatsViewable, containsSyntheticMedia, paidProductPlacement, recordingDate, playlistIds,
  thumbnail: { file, sha256 } | null, broadcast: { latencyPreference, enableDvr, enableEmbed, closedCaptionsType } }`,
  validated by a zod schema on read and write; a field left empty is **not sent** (never "blank means delete", AGENTS.md §F).
- `live_streams.settings_applied_json` (nullable): per Start, which steps succeeded, so «Применить снова» knows what is left.
- No change to `live_stream_videos` / `live_stream_sources`. The `live-streams` sync report is unchanged (settings are
  host-local; Windows already shows the page read-only).

### 3.3 Agent API / MCP
- No change in stage 1–2. `factory_live_get_status` stays as it is. (Exposing the settings to the Operator is not asked.)

## 4. Acceptance criteria (fixed before the code; from the owner's messages and the YouTube reference)

### 4.1 Automated
- **Settings:** saving writes nothing to YouTube; an empty field is not sent; an invalid value (tag total > 500 chars, unknown
  category, a language not in the app's list, a thumbnail > 2 MB or not JPEG/PNG by its bytes) is refused before any write.
- **Start:** with every field set, the insert carries exactly the chosen `latencyPreference`, `enableDvr`, `enableEmbed`,
  `closedCaptionsType` (plus today's fixed values); then exactly one `videos.update` with only the touched parts and the
  current `title`/`description`/`categoryId` kept; then `thumbnails.set` with the stored bytes; then one `playlistItems.insert`
  per playlist (a playlist not of this channel is refused before any write). Each write is preceded by
  `assertLiveWritesAuthorized` and recorded as an event.
- **Partial failure:** a failing `thumbnails.set` after bind leaves the broadcast and the encoder on, records the failure,
  and «Применить снова» repeats only the failed steps.
- **Ultra-low latency** with captions on is refused before any write.
- **Live edit:** the video section goes through video-details (conflict when the video changed since the preview; read-back
  mismatch reported); contentDetails are never sent while the broadcast is `live`.
- **Picker matching:** fixtures built by hand from §1.2's layout — `0928 V39/V39 Tropico Jazz.mp4` + a registry row → matched;
  a folder with two `V39*` files → no pre-match; `0906 8H/…` hidden unless «Показать все файлы»; a registry row pointing at a
  video not in the channel → no match; registry and `Vn_youtube.json` disagreeing → conflict shown, no pre-check; a match to a
  private video → disabled; a symlinked folder → not followed; workspace missing → the plain message.
- **Adding:** a batch of 3 with one refused (duration off by 5 s) adds 2 and reports the refusal; nothing is added twice.
- **Locales:** every new text in every supported language (`ui-text` tests).
- **Publishing unchanged** after the shared walk is extracted (its existing tests, untouched).

### 4.2 Spike C (real YouTube, with the owner's separate "да"; Tropico, an **unlisted** test broadcast, then ended)
Verifies the **UNVERIFIED** items: `videos.update` on an upcoming and on a live broadcast's video (tags, category, languages,
synthetic, license); `paidProductPlacementDetails` by update; `thumbnails.set` on the broadcast id; `playlistItems.insert`
of the broadcast; whether `enableEmbed` and `status.embeddable` are one flag; whether `latencyPreference`/`enableEmbed` are
locked once live; whether today's `liveBroadcasts.update` (title edit) resets tags, category or languages set by
`videos.update` (read the video before and after); whether channel sync lists the broadcast as a channel video.
Cost ≈ 300 units.

### 4.3 With the owner on the Mac
Set every field → Start → the broadcast in Studio shows them all; replace the thumbnail and a tag live; add 5 videos with the
picker in one go.

## 5. Build order (one branch, merged once on the owner's yes)
1. **Stage 1 — the picker (BL-187).** Shared `workspace-videos` walk (publishing switched to it), matching, the dialog, the
   batch add. Works on its own, no YouTube write, no spike needed.
2. **Stage 2 — the settings (BL-186), offline part.** v92, the settings form with the Studio-only list, validation, the
   Start dialog's full preview, `insertLiveBroadcast` contentDetails. Fully testable with fakes.
3. **Spike C** (owner's "да"), then **Stage 3 — applying video settings** at Start and in the live Edit, «Применить снова»,
   the «Переводы» link; adjusted by what spike C found.
4. Docs: `docs/SYSTEM_MAP.md` / `docs/ARCHITECTURE.md` live-streams sections, ADR 0036 amendment, `LIVE_STREAMS_PLAN.md` §7
   (thumbnail moved out of phase 2), `BACKLOG.md` rows, `ROADMAP_STATUS.md` when merged; `DEVELOPMENT_PLAYBOOK.md` only if the
   shared `workspace-videos` module becomes a documented pattern.

## 6. Not in this plan
- A daily or 12-hourly restart (dropped, msg 2785). Moderators (`liveChatModerators`). Captions from a source. Cuepoints/ad
  insertion. The Operator setting the stream's fields through MCP. Picking files outside `04 Videos/`.

## 7. Risks
- **`videos.update` on a live broadcast** may be refused or may disturb it; spike C before stage 3. If refused while live,
  the video section becomes "applies at Start" like contentDetails.
- **The registry CSV is an external file** whose format can change; it is only one match source, read tolerantly, and every
  add is re-checked by duration and public status.
- **Quota:** a Start with a thumbnail and 3 playlists ≈ 255 units (from 5); still small next to 10,000.
- **The T9:** the picker and the stream both depend on it; unchanged from BL-176.

## 8. Questions for the owner
- **Q1.** «Прямая реклама» — is it the paid-promotion mark («Видео содержит платное продвижение»)? If you meant ad breaks in the
  stream: that is Studio-only.
- **Q2.** Captions: the stream has no caption source, so the plan offers "off" only. OK?
- **Q3.** Translations of the stream's title/description through the usual Translations screen (§2.3), not a separate set in
  the stream's settings. OK?
- **Q4.** Spike C on a test unlisted broadcast (≈ 300 units, ~15 min with you) before stage 3 — "да"?
