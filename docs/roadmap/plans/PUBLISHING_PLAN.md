# Publishing from YT Manager: upload and schedule, calendar, 7-day reminder, History (FO-REQ-0023, BL-182)

- **Status:** APPROVED 2026-10-13 (owner, Telegram msg 2707, "да для всего": the order in §7.1, rescheduling while private, the
  AI-use fix). **Stage 0 (G1) DONE 2026-10-13: uploads are NOT locked** (§2 stage 0, result). **Stage 1 BUILT** on
  `feature/bl-182-publishing` (ARCHITECTURE §47.2), reviewed (findings fixed); stages 0 and 1 merged into `dev` 2026-10-13 (owner msg
  2722). **Stage 2 merged into `dev`** 2026-10-13 (`3ad95cc`, owner msg 2737; ARCHITECTURE §47.3); its acceptance is the first real
  upload, from the merged build, on the owner's "да" (waits for the Operator's first `Vn_release.json`).
- **Stage 1 deviations:**
  - The tool is named `agent_get_publishing_calendar` (agent prefix and capability check), not `channel_publishing_calendar`.
  - The refresh of other channels is a full channel sync (about 7 units), not a targeted read.
  - The threshold is a constant (7), not yet a setting.
  - There is no "both channels" view and no separate 14-day list.
  - Rescheduling needs both times more than 15 minutes ahead.
  - Any status write from Details sends "AI use" explicitly (it cannot be read).
- **Stage 2 deviations and decisions:**
  - The publish time is a UTC time, 12:00 by default, with the owner's time in parentheses (msgs 2725/2727; the shared field and
    module came with BL-183), not "15:00 local".
  - The AI-use fix for published videos is dropped: AI use is already set on every video (msg 2725).
  - Sync does not read `containsSyntheticMedia` (the API returns null, G1).
  - The per-device "uploading on <device>" record is the sync family `publishing-uploads` (a per-device report: channel, video,
    state); the approval on the other computer refuses such a video.
  - The approval checks the 100-a-day `videos.insert` bucket and the pool units through `quota-guard.checkUnits` (new).
  - Agents also get the packages and this computer's uploads in `agent_get_publishing_calendar` (Agent API 3.17.0, Producer 1.8.0).
  - Ready packages show on the calendar's planned days (dashed, they fill no gap). Not yet: Details' AI use from the channel default.
- **The owner's go:** for this work, msg 2698 ("check the Operator's new messages"); for the G1 test, msg 2702 (one private test
  upload, then its deletion). The Operator's quotes of 1110 / 1114 are the Operator's record, not the authorisation here.
- **Request:** FO-REQ-0023 (Operator, 2026-10-12; owner instruction 1110, answers 1114), relayed by the owner on 2026-10-13
  (msg 2698).
- **Sources:**
  - `dev` ba9429f (schema v88);
  - the Operator's research `05 Factory Health/analysis/2026-10-12_publishing_module/`;
  - PROJECT_SPEC §34 and §58, FUTURE_PHASES §6a, ADR 0005, ADR 0036, AGENTS.md §F, §G and §M.
- **Spec change.** This lifts the PROJECT_SPEC §58 non-goals "video upload" and "automatic video publishing" for one case:
  - the owner's own finished release packages;
  - uploaded and scheduled by the owner's approval in the Web UI;
  - never by an agent.

  §34's draft → preview → approval → apply → verify → audit model applies to every new write.

## 1. What the code has today (facts that shape the design)

- **No upload code.**
  - There is no `videos.insert`, `thumbnails.set`, `videos.delete` or resumable upload anywhere.
  - `costs.ts` lacks `videos.insert` / `thumbnails.set`: they would be logged as "unknown" units.
  - The OAuth scope `youtube` already covers uploads, so no re-consent is needed.
- **Write gateway.**
  - Primitives are raw. Each domain adapter calls `assertLiveWritesAuthorized()` right before them.
  - `gateway-inventory.test.ts` already catches `videos.insert` / `videos.delete` / `thumbnails.set` outside the gateway.
  - `live.ts` is the precedent for a child file.
- **Live writes.**
  - The toggle is off at every boot and works as a 3-minute lease renewed by the web server.
  - Idle shutdown and idle reset turn it off.
  - So a long upload queue must count as busy (`isBusy`) and must re-check the toggle before every gateway call.
- **Long jobs.**
  - `operation-progress` is memory-only.
  - Persistent precedents: `gemini_media_jobs` (queue + boot sweep), media jobs (resume in flight), live streams (persisted intent).
- **Files.**
  - `resolveWorkspaceFile` (safe, workspace-relative, realpath-checked) is used by live streams.
  - `ffmpeg-host.probeMedia` gives duration and size.
- **Content tab.**
  - Its sub-tabs are declared in `section-tabs.ts`.
  - The intro says «Только чтение», but Details writes to YouTube.
  - Sync runs on Content open when the data is older than 20 min, on "Sync now" and via MCP. There is no background sync.
  - `videos` stores `privacy_status` and `publish_at`, but not `containsSyntheticMedia` or processing.
- **Rescheduling is refused today.** `publish_at_already_published` refuses any write of `publishAt` when the fresh read already has
  one, whatever the privacy (`video-details/services.ts:115`, `adapters/youtube-api.ts:95`). So a scheduled video cannot be moved.
- **Write trails.**

  | Write path | Where it is recorded |
  |---|---|
  | Batches | `audit_events` (deleted with clean batches after 30 days) |
  | Details / «Исправить все» | `video_edit_audit_events` (no UI) |
  | Live streams | `live_stream_events` (device-local) |
  | Playlists, MCP `apply` | nothing |
  | Every call | `quota_ledger` (no payload, 45 days) |

  None of these can be the History as it is.
- **Change-set sources** are `xlsx_import`, `ai_localization` and `deletion`.
  - Languages «Отправить одобренные» sends all three.
  - An experiment executes its attached change set from Decisions.
  - So the Batches steps "pick a change set / select changes" are no longer the only path for anything.
- **Alerts.** The BL-178 language family (`/api/localization-alerts` + `language-alerts.ts` → badge + bell) is the template.
- **Sync families.**
  - Per-channel Automerge (as `channel-language-settings`) suits settings.
  - The per-device report (as live streams) suits "which computer is doing what".

## 2. Stages (one branch per stage, each merged on the owner's yes)

### Stage 0 — G1: are uploads from our project locked private? (small; owner's yes, msg 2702)

0. **ADR 0037.** Uploads and scheduling of the owner's own release packages from the Web UI, by owner approval only. It lifts the
   §58 non-goals for this case, as ADR 0036 did for live streams. PROJECT_SPEC §58 gets a pointer to it.
1. **Gateway child `upload.ts`.**
   - `beginResumableVideoUpload`: a POST to the upload endpoint, `uploadType=resumable`, with the metadata. It returns the
     session URI.
   - `putUploadChunk`: chunks in multiples of 256 KB.
   - `queryUploadOffset`: `Content-Range: bytes */TOTAL` → 308 `Range`.
   - `deleteVideo`.
   - Uses `node:https` with the OAuth access token; googleapis is not used for media.
   - The primitive names go into the inventory.
   - Quota (`youtube-quota`):
     - `costs.ts` gains `videos.delete` 50 and `thumbnails.set` 50;
     - `videos.insert` counts against its own daily bucket, not the 10 000-unit pool: a second exclusion in
       `countsAgainstPool`, next to `search.list`, and `VIDEOS_INSERT_DAILY_CALL_LIMIT = 100` (Google, since 2026-06-01).
   - `isWriteMethod` learns the `set` verb.
2. **A developer-only CLI command** (`publishing g1-probe`, behind the `--i-understand-this-uploads` flag).
   - Identity check: `assertWriteChannel`.
   - Live writes must be on.
   - Uploads the 25 s clip as private, without a date, with `notifySubscribers=false`, `containsSyntheticMedia=true`, en / en,
     and records an audit row.
   - Then reads `videos.list part=status,processingDetails,snippet` until processing ends.
   - Reports:
     - `privacyStatus`, `uploadStatus`, `rejectionReason`;
     - whether `defaultAudioLanguage` was accepted;
     - the video id.
3. **"Locked" is shown only in Studio.** The owner (or I, in Chrome) looks at Studio for "Private (locked)".
4. **Then `deleteVideo`.** This is the second write the owner approved. A targeted sync follows, so the test video leaves the
   `videos` table and no calendar or list shows a ghost.
4a. **Before the run:**
   - **Unmerged code.** The command runs from the unmerged stage-0 branch in the development worktree, against the Mac's real
     database and tokens. The schema is the same (v88), so nothing is migrated. The owner is told this before the run.
   - **Identity.** Each channel has its own connected Google user. The command uses Rural Japan Music's user, and
     `assertWriteChannel` checks that this token's channel is the expected one (it fails closed otherwise). No switch in the UI is
     needed.
   - **Unknown outcome (review S1).**
     - A `started` record is saved before the first request.
     - A lost answer is resolved by asking the session where it stands.
     - While the outcome is unknown, no new upload starts; the owner looks in Studio first.
     - The video id is printed the moment YouTube returns it.
   - **Live writes.** «Запись в YouTube» must be on. The toggle is a lease renewed by the web server, so it stays on only while the
     owner's session keeps it on.
   - **The clip.** The Operator's clip is the first 25 s of V39, which is public on the same channel. YouTube may reject it as a
     duplicate (`rejectionReason: duplicate`), and a rejected video cannot show whether uploads are locked. Then a synthetic
     25 s clip is used instead: an ffmpeg test pattern plus a tone, with the same metadata. This is the probe's one allowed retry
     (`--retry-after-duplicate`), only once the rejected video is deleted, and only after telling the owner.
5. **The result goes to the Operator.** It decides stage 2:
   - not locked → as planned;
   - `publishAt` refused → private uploads only;
   - locked → the audit form; uploads wait.

**G1 result (2026-10-13).**
- Upload: video `KuCwWYI2pmE`, Rural Japan Music, at 11:30 UTC (run from `90ed9fb`). It was deleted at 11:36 after the owner's Studio check
  (msg 2715).
- **Not locked.** Studio shows «Ограниченный» (Private), the change button works, and there is no lock notice.
- Processing: processed / succeeded in 31 s; not rejected as a duplicate of V39.
- **`defaultAudioLanguage` is accepted at insert:** `en` read back.
- **`containsSyntheticMedia` is set at insert** (the owner saw "AI use" in Studio), **but the API does not return it on read.**
  Consequences:
  - the upload cannot verify it by read-back, and the approval screen says so;
  - which published videos lack it cannot be detected, so the AI-use fix can only set it on every published video, at 50 units
    each. The owner decides at stage 2.
- Owner, msg 2715: per-channel publishing defaults in Content, set once. Only the title, description and thumbnail change per video
  (stage 2 item 2).

### Stage 1 — Calendar + 7-day reminder (does not depend on G1; mostly reads)

1. **Content → «Календарь»** (a new sub-tab).
   - A month view and the next 14 days, per channel or both channels.
   - Each day shows: published, scheduled (private + `publish_at`), private without a date, a ready package
     (`plannedPublishDate`, once stage 2's scan exists) and gaps.
   - Times are local, with UTC in the tooltip. A click opens Details.
   - The data age is shown, with "Sync now".
2. **Freshness without a daemon.**
   - The 60 s alert poll stays local-only, like every other poll route, and states the data age.
   - The live refresh runs in the dashboard-load chain, next to the daily collection: once per load, when a channel's stored
     scheduled videos are older than 6 h.
   - It uses `playlistItems.list` (first page of uploads) plus `videos.list` of the scheduled ids: 2–3 units per channel.
3. **Reminder.** *Covered through* = the latest future `publish_at`, or now if there is none. The alert fires when that is less
   than now + 7 days (a setting). Example text: «Tropico: запланировано только до 14.10 (осталось 2 дня)».
   - Badge on «Контент» for the active channel, bell for the others.
   - One family with the BL-178 translation alerts.
   - It clears by itself.
4. **Read tool `channel_publishing_calendar`** (READ, Agent API; Producer too): published / scheduled / gaps for the past 14 and
   the next 14 days. Packages are added in stage 2.
5. **Reschedule a scheduled private video** (§7 question 2).
   - Lift `publish_at_already_published` for a video that is still private with a future `publishAt`.
   - The write is a read-modify-write that resends `privacyStatus=private`, through Details: preview, approval, backup,
     read-back, audit.
   - A public video stays refused.
6. **Content intro text.** «Только чтение…» goes; the new text says that Details and publishing write to YouTube (en + ru).

### Stage 2 — Release packages, upload and schedule from Content (after G1)

1. **Package contract** `yt-release-package/1` (FO-REQ-0023 §4 A).
   - The scan covers `04 Videos/**/V*_release.json` inside the channel workspace, via `resolveWorkspaceFile` rules.
   - Packages are re-validated and never edited.
   - After an upload, `Vn_youtube.json` is written next to the package.
2. **Publishing settings per channel.** A new Automerge family `publishing_settings`, synced between computers and editable in
   Content:
   - time (default 15:00 local = 12:00Z);
   - playlist;
   - categoryId;
   - madeForKids false;
   - containsSyntheticMedia true;
   - license, embeddable, notifySubscribers.
3. **Content → «Публикация».**
   - Package states: not ready (why) / ready / uploading / uploaded private / scheduled / published.
   - Validation:
     - title ≤ 100 characters, no `<` `>`;
     - description ≤ 5000 bytes;
     - tags ≤ 500 characters;
     - chapters;
     - JPEG/PNG thumbnail;
     - en / en;
     - ffprobe of the file;
     - not already uploaded (`Vn_youtube.json`, or the same title in recent uploads).
   - Dates come from `plannedPublishDate` at the channel's time. The next free day is used when a date is taken. Dates are
     editable, or the video goes up "private without a date".
4. **One approval screen** for the selection, with every row's fields, local + UTC times and the quota totals:
   - `videos.insert` from its 100/day bucket;
   - thumbnails and playlist items at 50 units each.

   `UPLOAD_PRIVATE` and `PUBLISH` are separate approvals: rows without a date only upload.
5. **Execution: a persisted job queue** `publishing_uploads` (device-local), one video at a time.
   - Steps:
     1. identity check;
     2. the per-device report "uploading package X on <device>" (sync family);
     3. resumable insert with the saved session URI and offset (survives restarts; a 404 restarts the upload);
     4. `publishAt` at insert if it is ≥ 6 h ahead, else after processing;
     5. poll processing;
     6. `thumbnails.set`;
     7. `playlistItems.insert`;
     8. read-back of everything;
     9. `Vn_youtube.json`, the History row and a targeted sync.
   - Busy for idle shutdown. Live writes are checked before every gateway call; when they turn off, the job pauses and does not
     fail.
6. **Never twice.**
   - An unknown final response leads to a search of the channel's uploads (title, newest items) and adoption, never a re-upload.
   - The other computer's report blocks a second start.
7. **Errors.**
   - `quotaExceeded` and `uploadLimitExceeded` are shown apart; the queue pauses until the reset (midnight PT) or for 24 h.
   - `invalid_grant` asks the owner to sign in again.
8. **No upload or schedule tool for agents or the Producer.** They read the package and job states.
9. **AI disclosure (G2).**
   - Sync reads `status.containsSyntheticMedia`, and Content shows it.
   - An «Исправить все»-style action fixes published videos without it (§7 question 3).

### Stage 3 — Batches → History

1. **A new durable log `youtube_write_history`.**
   - One row per write sent to YouTube: time, device, channel, video, type, short before → after, result, link to details.
   - Kept with no 30/45-day purge.
   - Shared between computers as per-device append-only files, like the quota ledger share.
2. **Every write path records into it:**
   - batches;
   - Details / «Исправить все»;
   - live;
   - playlists;
   - MCP `video-metadata/apply`;
   - publishing.

   The two paths that log nothing today gain a record.
3. **«Пакеты» becomes «История»:** a read-only feed with filters (channel, type, period, result).
   - A batch row opens the existing batch view: ledger, errors, audit, resend cancelled, split for quota, cancel.
   - The "create a batch from a change set" steps leave the tab. Every change-set source is sent from Languages or Decisions.

## 3. Write safety (AGENTS.md §G) for the new writes

| Write | Identity | Validation | Backup | Diff/preview | Approval | Dry run | Audit | Verification |
|---|---|---|---|---|---|---|---|---|
| upload (insert) | `assertWriteChannel` | package checks | — (new object) | approval screen | owner, Web UI | validation only | History + upload audit | read-back of every field |
| publishAt / reschedule | same | ≥ now, private | fresh read | before → after | owner | preview | History | read-back |
| thumbnails.set | same | type/size | old thumbnail URL | preview | with the upload | — | History | thumbnail present |
| playlistItems.insert | same | playlist of the channel | — | listed | with the upload | — | History | membership read |
| AI-use fix | same | — | fresh read | list | owner | preview | History | read-back |
| delete (G1 only) | same | the G1 video id only | — | — | owner msg 2702 | — | audit | `videos.list` empty |

## 4. Not in this plan

- Premieres: the API cannot create them.
- End screens, cards and monetisation: not in the API.
- Uploads by agents.
- Localizations at insert time: translations stay with Languages, after the upload.

## 5. Risks

- **G1 "locked".** If uploads are locked, they need Google's audit, which has no documented duration. Stages 1 and 3 do not
  depend on it.
- **7-day tokens.** While the consent screen is in Testing, a long queue may hit `invalid_grant`. The job pauses and the owner
  signs in again. The Operator recommends switching to Production; that is the owner's decision.
- **Workspace paths are per computer.** A package is uploaded from the computer that has the files. `Vn_youtube.json` travels with
  the folder only if that folder is synced.

## 6. Answers to the Operator's questions (FO-REQ-0023 §6)

1. **Discovery:** the scan of `04 Videos/**/V*_release.json`.
2. **Long uploads:** a persisted server-side job queue, resumable from the saved session URI and offset, like the media jobs.
3. **Which computer:** any computer that has the files and the channel signed in. The per-device report stops a double start.
   No "publishing computer" setting.
4. **Order:** proposed G1 → stage 1 (calendar + reminder: the reminder is needed now, both channels end 14.10) → stage 2 (upload)
   → stage 3 (History). §7 question 1.

## 7. Questions for the owner

1. **Order.** G1 now, then the calendar + reminder first, then uploads, then History. Agreed?
2. **Rescheduling.** May a video that is scheduled but still private have its date changed (with approval, read-back and History)?
   Today the code refuses it.
3. **AI use on published videos.** Videos that lack "AI use" get a fix action, like «Исправить все». It is one `videos.update` per
   video, with approval. Agreed?
