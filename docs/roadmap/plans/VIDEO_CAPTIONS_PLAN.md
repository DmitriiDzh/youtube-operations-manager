# English captions for WWE long videos (BL-269, ADR 0074, FO-REQ-0055)

Owner: 2026-11-16, Telegram 4590 («да» to `captions.insert`, English only, burned-in subtitles off) and 4592 (captions only for
WWE long, horizontal videos; none for other channels or Shorts). Factory contract: Operator bundle 2.5.46 (`12 --captions`) writes
the package field `captions` (§3.1). Request: FO-REQ-0055.

Status: **plan only** (no code). ADR 0074 is Proposed. Branch `feature/bl-269-video-captions` (from dev `510161e2`), one branch for
all stages, one merge (AGENTS.md §K.1).

## 1. Requirements

- R1. A new YouTube writer: `captions.insert` of **one English track**, and nothing else. No `captions.update`, no `captions.delete`,
  ever, in this work. The app never replaces or deletes a track it did not create (a "foreign" track).
- R2. Captions only where the channel's captions switch is on (WWE) **and** the video is horizontal (a long video, V code). A
  `captions` field anywhere else is a package problem, and nothing is written.
- R3. Upload step for new packages: after processing, next to the translations and the thumbnail, before `publishAt`. The date is
  given only after the captions step **and** the read-back passed. Quota exhausted → the step pauses, it does not fail.
- R4. Add a track to an already uploaded video: the owner (Web UI button) and the Producer (its own endpoint only). Channel worker
  agents and the factory get no tool. V19, V27 and later videos ship without captions now; this path covers them later.
- R5. The full AGENTS.md §G pipeline through the write gateway: validation, device gate, ownership, identity check
  (`write-context.assertWriteChannel`), backup (the track list before), Live writes immediately before the call, dry run, read-back
  (`captions.list`), audit. The quota guard is checked before the write.
- R6. Package field (agreed with the Operator): `captions: [{ language, file, name, sha256 }]`; problem codes `captions_missing` /
  `captions_invalid`; file existence, SHA-256, size and format (SRT or WebVTT) checked.
- R7. The upload record `yt-release-upload/1` gains the mp4's `sha256` + `sizeBytes` (Operator's request).
- R8. Budget about 450–550 pool units per long video (Google's table, re-checked 2026-11-16: `captions.insert` 400, `list` 50,
  `update` 450, `delete` 50; already in `src/lib/youtube-quota/costs.ts`).

## 2. API facts (YouTube Data API v3 reference, read 2026-11-16)

- `captions.insert`: 400 units; scope `youtube.force-ssl` (or `youtubepartner`) -- the plain `youtube` scope is not listed; media
  ≤ 100 MB, MIME `text/xml`, `application/octet-stream` or `*/*`; settable `snippet.videoId`, `language`, `name` (all required),
  `isDraft`. `sync` is deprecated (2024-03-13) and is never sent. Errors: `captionExists` (409: a track with the same language **and**
  name), `nameTooLong` (> 150 characters), `invalidMetadata`, `forbidden`, `videoNotFound`, `contentRequired`.
- `captions.list` (50 units, same scopes): `snippet.trackKind` `standard` | `ASR` | `forced`, `status` `serving` | `syncing` |
  `failed` (+ `failureReason`), `isDraft`, `language`, `name`, `lastUpdated`. **No content hash** -- which track is ours must be
  recorded by us (§3.4).
- Formats YouTube accepts include SubRip `.srt` and WebVTT `.vtt` (support.google.com/youtube/answer/2734698); we allow only these
  two (Operator).
- `videos.list part=fileDetails` (owner only, 1 unit) carries `videoStreams[].widthPixels/heightPixels/rotation` -- the orientation
  of an uploaded video when the mp4 is no longer on this computer (BL-238 deletes it).

## 3. Design

### 3.1 Package field and checks (`src/lib/publishing/packages.ts`)

`yt-release-package/2` gains the optional `captions` array; v1 with `captions` → `field_invalid`. Absent or `[]`: no captions (never a
problem, also on WWE). Parsed per entry: `language` (string), `file` (`isSafeRelativePath`, inside the package folder, extension
`.srt` or `.vtt`), `name` (string), `sha256` (64 hex). A malformed entry → `field_invalid` `captions`.

Blocking checks in `allPackageChecks` (never in `PACKAGE_WARNING_CODES`), one code with a `reason` parameter so the two agreed codes
suffice:

| Condition | Code (`params.reason`) |
|---|---|
| file not found | `captions_missing` (`file`) |
| channel's captions switch off | `captions_invalid` (`channel_disabled`) |
| S code, or frame vertical, or frame unknown | `captions_invalid` (`not_horizontal` / `orientation_unknown`) |
| more than one entry, or `language` not `en` | `captions_invalid` (`count` / `language`) |
| `name` empty, > 150 characters, or with `<` `>` | `captions_invalid` (`name`) |
| 0 bytes or > 10 MiB (`CAPTIONS_MAX_BYTES`, our cap; API: 100 MB) | `captions_invalid` (`size`) |
| SHA-256 of the bytes ≠ `sha256` | `captions_invalid` (`sha256`) |
| not UTF-8, extension and content disagree, no cue, a bad timestamp, end ≤ start, or a cue ending after duration + 1 s | `captions_invalid` (`format`) |

The format check is a pure parser in `src/lib/video-captions/caption-file.ts` (SRT: index line optional, `HH:MM:SS,mmm --> HH:MM:SS,mmm`;
VTT: `WEBVTT` header after an optional BOM, `.` milliseconds, optional hours). `PackageFacts` gains `captions` (exists, sizeBytes,
sha256, parse result), read by `package-scan.ts` with the same workspace rule as the thumbnail.

The switch: a new channel publishing default `captionsEnabled` (boolean, default false) in the synced `channel-publishing-settings`
family -- the owner sets it in the Content panel's publishing defaults (Web UI only; no MCP tool writes publishing settings).

Captions are **packaging**, not media (ADR 0072 §1): adding or fixing them keeps the owner's media approval, and a queued upload takes
the metadata-only re-package (ADR 0072 §4) -- `changedPackageFields` gains `captions`.

### 3.2 One writer: `src/lib/video-captions/` (new module, §M)

- `caption-file.ts` -- pure: the format check, the SHA-256, the MIME type sent (`application/octet-stream`).
- `services.ts` -- `addTrack(input, actor, { dryRun })`, the only code that inserts a caption. Callers: the upload runner (injected
  dep `writeCaptions`, like `writeLocalizations`) and the package-captions service (§3.5). It imports nothing from `publishing`.
- Gateway: one new primitive `insertVideoCaption(youtube, { videoId, language, name, isDraft: false, media })` in
  `src/lib/youtube-write-gateway/` (added to `WRITE_PRIMITIVE_NAMES`); **no update/delete primitive** -- a new inventory test fails if
  any file calls `captions.update` or `captions.delete`. Read: `listVideoCaptions` in `youtube-read-gateway/data-api.ts`
  (`part=snippet`), and `fileDetails` in the existing video read.
- Credentials require `youtube.force-ssl` (`requiredScopes`, as `live-streams` does); a missing scope → refused
  `captions_scope_missing` (the owner reconnects the channel), never a silent skip.

Pipeline of `addTrack` (both callers):

1. Validation: the file read once into memory, re-hashed and re-parsed (must equal the package's `sha256`; the bytes hashed are the
   bytes sent). Channel switch read **now** (not the frozen copy), language `en`, name rules.
2. Device mutation gate (operation lock, recovery mode) -- owner and Producer paths.
3. Video read (`videos.list` 1 unit): exists, `snippet.channelId` is the channel; orientation (§3.5) horizontal.
4. Track list before (`captions.list`, 50). Decision by **language** (primary subtag `en`), not by name:
   - `ASR` tracks are ignored: never touched, never block.
   - a `standard`/`forced` English track whose id is in our record with the same `sha256` → `already_present`, no write;
   - our own English track with another `sha256` → refused `captions_own_track_differs` (no update in v1; Q1);
   - any other `standard`/`forced` English track → refused `captions_foreign_track`, nothing written.
   Why refuse rather than add alongside: a person put that track there on purpose; two "English" entries confuse viewers and the app
   cannot know which is right. The owner removes or keeps it in Studio; the app never does.
5. Quota guard `checkUnits(550)` (list + insert + list + one re-read); short → `youtube_quota_exceeded` (a pause in the runner, a
   refusal on the add path).
6. Dry run stops here: every read and check, no backup, no write, no audit RESULT; reports units 51 (+ 500 for the real run).
7. Backup: the list from step 4 as a `video_captions` snapshot, plus the bytes about to be sent, under
   `<appData>/backups/<channelId>/<operationId>/`; a failed backup stops the write.
8. Identity check `assertWriteChannel` → an "insert attempted" mark persisted (§3.3) → Live writes (`assertLiveWritesAuthorized`)
   immediately before the one `insertVideoCaption` call.
9. Read-back (`captions.list`): the new id present, `language` `en`, the name, `trackKind` `standard`, `isDraft` false, `status`
   `serving` (`syncing` → one re-read later, bounded; `failed` → not verified with `failureReason`); every track id of the backup list
   still there unchanged. A failure after a successful insert is reported as "written, not verified", never as "not written".
10. Record: the caption id, language, name, `sha256`, `at`, actor -- in the upload row's steps and in `Vn_youtube.json` (§3.4).
11. Audit `BACKUP`, `RESULT`, `VERIFICATION`, `source: video_captions`, actor `upload` / `owner` / `producer`, file SHA-256.

### 3.3 Upload step (`src/lib/publishing/upload-runner.ts`)

Order in `finishing`: `localizations` → **`captions`** → `thumbnail` → `playlist` → `verify` → `publishAt` → `record` → `sync`.

- `steps.captions`: `none` (no `captions` in the package, and every row from before this build) | `verified` | `already_present` |
  `mismatch` | `failed` | `refused` (switch off now, not horizontal, foreign track, own track differs, scope).
- `ApprovedPackage` gains `captions` (`{ language, file (folder-relative), name, sha256 }`) and `orientation` frozen at queue time;
  `approvedPackageOf` and `changedPackageFields` carry them.
- Quota: the guard's refusal and YouTube's `quotaExceeded` are `quota_exceeded` pauses (`classifyUploadError`); the step stays
  undefined and runs again after the reset. `estimateUploadUnits` gains `captions ? 550 : 0` at both call sites (approval and the
  pending-units sum in `index.ts`).
- Lost answer: `steps.captionsAttemptAt` is saved before the insert. On a retry, a `standard` English track with exactly the
  package's name that is not in the backup list (or a 409 `captionExists`) is this upload's track (the video is the upload's own):
  adopted, recorded, then read back.
- `failedBefore` gains `captions` unless `none`, `verified` or `already_present`: otherwise the date is withheld (the video stays
  private) -- R3. The final `problem` counts `mismatch` as `verify_mismatch` and `failed`/`refused` as `step_failed`.
- `giveUp` and the `step` union gain `captions`.

### 3.4 Upload record `yt-release-upload/1` (additive, both `writeRecord` sites: `adopt` and the record step)

- `videoSha256` (the frozen manifest's mp4 SHA-256; `null` when the package stated none) and `videoSizeBytes` (the frozen `sizeBytes`).
- `captions: [{ trackId, language, name, sha256, at, by }]` -- written by the record step after an upload and re-written by the add
  path (read-modify-write, atomic, only these keys changed). This, plus this computer's upload rows, is what "created by the app"
  means; the other computer learns it from the record in the shared workspace. A track in neither is foreign.

### 3.5 Add a track to an uploaded video (`src/lib/publishing/package-captions.ts` → `video-captions`)

Like ADR 0072's packaging fix: input is a **package** (channel + video code) whose upload record names the video id, and the captions
come only from that package's **current manifest** -- no free file path. Not full package readiness: the mp4 may be gone (BL-238), so
only the captions checks of §3.1 apply, plus:

- orientation from YouTube's `fileDetails` (width/height after rotation); absent → this computer's orientation memo; neither →
  refused `captions_invalid` `orientation_unknown` (fail closed). An S code is always refused.
- refused `captions_step_pending` while this computer's upload row of that video has not finished its own captions step.
- Owner: «Добавить субтитры» on the uploaded package's row in «Ролики и релизы» (dry-run preview with units, then an in-app confirm;
  no native dialogs); owner session + active channel; remote allowed (like ADR 0069 §6). UI texts in every locale.
- Producer: `producer_video_captions_add { channelId, video, dryRun? }` (permission `CAPTIONS_WRITE`, listed in
  `producer_get_capabilities` as `captionsTools`), its endpoint only. `no-agent-upload-tool.test.ts` allows exactly this tool there.
- No adoption on a lost answer here: the next call's list shows an unrecorded track as foreign, and the result says
  `unknown_outcome` with the track list for the owner.

### 3.6 Out of scope

Burned-in subtitles (the factory's render; off by owner TG 4590), other languages, `captions.update`/`delete`, ASR handling, Shorts,
other channels, live streams.

## 4. Stages (one branch, one merge)

1. `video-captions` pure parts: caption file parser/validator, SHA-256; gateway `insertVideoCaption` + read `listVideoCaptions` +
   `fileDetails`; inventory tests (primitive listed, no `captions.update/delete` anywhere).
2. Package field + checks + `captionsEnabled` switch + `PackageFacts.captions` in the scan; UI texts for the codes and the switch.
3. `addTrack` service (pipeline §3.2) with dry run, backup kind `video_captions`, audit, record update.
4. Runner step (§3.3), `ApprovedPackage` fields, units estimate, record `videoSha256`/`videoSizeBytes`/`captions`.
5. Add path: owner route + button, Producer tool; calendar/plan views show `captions` and `steps.captions`.
6. Docs: AGENTS.md §F bullet (ADR 0074 draft), PROJECT_SPEC §21 (lines 791–792 today say captions are not integrated at all),
   SYSTEM_MAP (line 219 "no captions" note), ARCHITECTURE publishing section, TECHNICAL_DEBT if a gap remains. Independent review,
   then the owner's merge approval.

Pre-build check (stage 1, read-only): WWE's stored grant includes `youtube.force-ssl` (otherwise the owner reconnects WWE first).

## 5. API versions (next free numbers at merge; today Factory 1.52.0, Agent 4.23.0, Producer 1.25.0)

- Producer **1.26.0**: `producer_video_captions_add`, `captionsTools`, permission `CAPTIONS_WRITE`.
- Agent **4.24.0**: `agent_get_publishing_calendar` packages gain `captions`, uploads gain `steps.captions`; new problem codes.
- Factory **1.53.0**: `factory_publishing_plan_get` packages show the new codes and `captions`; the record fields documented.
  All additive.

## 6. Open questions (few)

- **Q1 (owner).** A track the app itself added with a now-different file (a typo fixed by the Operator): v1 refuses
  (`captions_own_track_differs`). Later allow `captions.update` of **our own** track only (450 units, backup = our sent copy)?
  Recommendation: not now.
- **Q2 (owner).** A foreign English track found during the upload step withholds the date (fail closed). Recommendation: keep; the
  owner decides in Studio, then the Producer or he adds the date.
- **Q3 (Operator).** Bundle 2.5.46 writes `language: "en"` exactly (not `en-US`), one entry, `.srt` or `.vtt`, UTF-8, `name` ≤ 150
  characters (suggest `"English"`)? Record field names `videoSha256` / `videoSizeBytes` OK?
- **Q4 (Producer).** One tool `producer_video_captions_add { channelId, video, dryRun }` enough (no free file path)?

## 7. Acceptance criteria (written before the code, from R1–R8 and the API reference)

Package checks
- AC-CAP-01 A v2 package without `captions` (or `[]`) on WWE is ready as before; no captions step write (`steps.captions: none`).
- AC-CAP-02 `captions` on a channel whose switch is off → `captions_invalid` `channel_disabled`; not ready; nothing written.
- AC-CAP-03 `captions` on an S code, a vertical frame, or an unknown frame → `captions_invalid` (`not_horizontal` /
  `orientation_unknown`); not ready.
- AC-CAP-04 File absent → `captions_missing` with the file; a path with `..`, absolute, or outside the folder → `field_invalid`.
- AC-CAP-05 SHA-256 differs by one byte → `captions_invalid` `sha256`.
- AC-CAP-06 0 bytes, or 10 MiB + 1 byte → `captions_invalid` `size`; exactly 10 MiB with valid content is accepted.
- AC-CAP-07 Two entries, or language `de` / `en-US` → `captions_invalid` (`count` / `language`).
- AC-CAP-08 Name empty, 151 characters, or with `<` → `captions_invalid` `name`; 150 characters accepted.
- AC-CAP-09 Hand-written fixtures: valid SRT and VTT (with BOM, without hours) pass; `.srt` holding VTT, non-UTF-8, a cue with end ≤
  start, `00:00:61,000`, or a cue ending 2 s after the video → `captions_invalid` `format`.
- AC-CAP-10 Both codes block (not in `PACKAGE_WARNING_CODES`); adding/changing `captions` keeps the media approval, and a queued
  row takes the re-package (ADR 0072 §4).

Writer (both paths)
- AC-CAP-11 Exactly one `captions.insert` with `part=snippet`, `videoId`, `language: "en"`, the name, `isDraft: false`, no `sync`,
  body = the hashed bytes.
- AC-CAP-12 Adapter order: client → identity check → attempt mark → Live writes → insert. Live writes off → no insert (a pause in the
  runner, a refusal on the add path).
- AC-CAP-13 Wrong channel (identity) or a video whose `snippet.channelId` differs → fails closed, no insert.
- AC-CAP-14 Backup (track list + bytes) before the insert; a failed backup → no insert.
- AC-CAP-15 An `ASR` English track only → insert proceeds; the ASR track is untouched and not counted as foreign.
- AC-CAP-16 A `standard` (or `forced`) English track not in the record → `captions_foreign_track`, no insert, no update, no delete.
- AC-CAP-17 Our recorded track with the same SHA-256 → `already_present`, no insert; with another SHA-256 →
  `captions_own_track_differs`, no write.
- AC-CAP-18 Tracks of other languages are kept: the read-back fails if any backed-up id disappeared or changed.
- AC-CAP-19 Read-back `serving` with the new id, `en`, the name, `standard`, not draft → `verified`; `failed` → not verified with
  `failureReason`; `syncing` → one bounded re-read.
- AC-CAP-20 A failure after a 200 insert (read-back, audit, record) is reported as written, never as "not written".
- AC-CAP-21 Audit BACKUP, RESULT, VERIFICATION with actor and file SHA-256; dry run → no backup, no write, no RESULT, units 51.
- AC-CAP-22 Missing `youtube.force-ssl` → `captions_scope_missing`, no insert.
- AC-CAP-23 Inventory: `insertVideoCaption` is the only caption write primitive; no file calls `captions.update` or `captions.delete`.

Upload step
- AC-CAP-24 Order localizations → captions → thumbnail; the date is written only when `steps.captions` is `none`, `verified` or
  `already_present` and the read-back passed; `failed` / `mismatch` / `refused` → `publishAt: withheld`, video private.
- AC-CAP-25 Quota guard short, or YouTube `quotaExceeded` on the insert → row `paused` `quota_exceeded` until the reset; the step
  runs again after it; never `failed`.
- AC-CAP-26 Switch turned off after queueing → `refused` at the step, nothing written, date withheld.
- AC-CAP-27 Lost answer: attempt mark set, retry finds an unlisted `standard` `en` track with the package's name (or a 409) →
  adopted, one insert in total, read back.
- AC-CAP-28 `estimateUploadUnits` adds 550 for a package with captions, at approval and in the pending sum.
- AC-CAP-29 The record (`adopt` and the record step) carries `videoSha256` (or `null`) and `videoSizeBytes`; after captions,
  `captions` with the track id and SHA-256.
- AC-CAP-30 A row from before this build (no `captions` in its package) finishes with `steps.captions: none` and its date as before.

Add path
- AC-CAP-31 Only a package whose upload record names the video id; captions only from its current manifest; the mp4 may be absent.
- AC-CAP-32 Orientation from `fileDetails`; vertical → refused; absent and no memo → `orientation_unknown`, no write.
- AC-CAP-33 This computer's upload of the video with the captions step not finished → `captions_step_pending`.
- AC-CAP-34 Device handoff or recovery mode → refused before any backup or write (owner and Producer).
- AC-CAP-35 `producer_video_captions_add` exists only on the Producer endpoint; agent and factory endpoints have no caption tool.
- AC-CAP-36 Owner route needs the owner session and the active channel; the button shows the dry run and units before the confirm.
- AC-CAP-37 Success updates `Vn_youtube.json` `captions` (other keys byte-for-byte unchanged); the other computer then sees the track
  as the app's own (AC-CAP-17 holds there).

## 8. Risks

- **Foreign track blocks a date** (Q2): fail closed by design; the owner must act in Studio.
- **Scope**: WWE's grant may lack `youtube.force-ssl`; the first upload with captions would refuse until reconnect (pre-build check).
- **Quota pause holds the whole queue** (the runner's existing rule): a long pause can push a date inside the margin →
  `skipped_too_soon`. 550 units per long video is the budget; several WWE uploads a day are visible in the guard.
- **"Ours" lives in a file**: if `Vn_youtube.json` is lost or edited, our track becomes foreign -- safe (refusal), never a wrong write.
- **Format drift**: our parser is stricter than YouTube's; a file YouTube would accept may be refused (`format`) -- the Operator fixes
  it. YouTube may still fail processing (`status: failed`) → not verified, date withheld.
- **Lost answer on the add path** leaves an unrecorded track that later looks foreign; reported as `unknown_outcome`.
