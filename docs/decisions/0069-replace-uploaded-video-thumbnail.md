# 0069. Replace the thumbnail of an uploaded video -- the owner and the Producer, one writer

Status: Accepted (owner, Telegram 2026-11-15: msg 4380 «Да, ставь и это можно допустить не разово, а чтобы и в будущем такая
возможность была», msg 4383 -- option 3: the owner and the Producer, any video of the channel). Closes FO-REQ-0053 (2026-11-08,
Operator: a thumbnail route for uploaded videos).

**Date:** 2026-11-15.
- **Plan:** this ADR, acceptance AC-TH-01..14 below. Backlog BL-255.

## Context

A thumbnail reached YouTube only through the upload runner (`src/lib/publishing/`, the package's file, once, right after
processing) and through a live stream's settings (`src/lib/live-streams/`). Replacing the thumbnail of a video already uploaded
(Tropico V85/V86 on 2026-11-08, V91–V95 on 2026-11-15: the logo badge was missing) needed a one-off script run by the developer
on the owner's word. Re-packaging is not a way: a new manifest SHA-256 no longer matches the slot's approval fingerprint
(ADR 0062 §2), so the slot falls back to "needs approval".

`thumbnails.set` (YouTube Data API v3, 50 units) "uploads a custom video thumbnail to YouTube and sets it for a video"; maximum
file size 2 MB, `image/jpeg` or `image/png`. It changes nothing else of the video (privacy, `publishAt`, metadata).

## Decision

1. **One writer, `src/lib/video-thumbnails/`.** It may write a video's custom thumbnail (`thumbnails.set`) and nothing else, for
   the owner (Web UI) and the Producer (`producer_video_thumbnail_replace`, its own endpoint only), on any video of the channel
   (owner msg 4383). Channel worker agents and the factory get no thumbnail tool.
2. **The file.** Only an image under `04 Videos/` of the channel's workspace on this computer, reached through the same rule as
   the package preview (`createPackageScanCore().readThumbnail`: workspace rule, real path inside the real `04 Videos/`, type
   from the first bytes), JPEG or PNG, at most 2 MB (`THUMBNAIL_MAX_BYTES`). The SHA-256 is computed from the bytes sent and
   recorded.
3. **The pipeline (AGENTS.md §G).** Validation → the video read (`videos.list`, 1 unit): it must exist and belong to the channel
   (`snippet.channelId`) → refused while this computer's upload of that video has not yet run its own thumbnail step (an active
   `publishing_uploads` row with that video id and no `steps.thumbnail`: the runner would put the package's file over the new
   one) → backup (the current thumbnail URLs and the largest image's bytes, as a `video_thumbnail` backup snapshot under
   `<appData>/backups/<channelId>/<operationId>/`; a backup that fails stops the write) → identity check
   (`write-context.assertWriteChannel`) → Live writes immediately before the one gateway call → read-back (`videos.list`:
   `contentDetails.hasCustomThumbnail` true, privacy and `publishAt` as before) → audit (`BACKUP`, `RESULT`, `VERIFICATION`,
   `source: video_thumbnails`, actor owner/producer) → the stored thumbnails of the video refreshed from the read-back.
4. **Dry run.** Both surfaces have a preview that does every read and check (file, video, ownership, pending upload step) and
   no backup and no write, and reports the quota units (1 + 50 + 1).
5. **The plan is not touched.** No manifest, slot, approval or date changes; the package keeps naming its own file. A later
   upload step never runs again for a finished upload, so nothing puts the old file back.
6. **Remote.** The owner's routes follow the existing video write routes (owner session, active channel); not Mac-only.

## Consequences

- AGENTS.md §F and PROJECT_SPEC §21 name the writer. `no-agent-upload-tool.test.ts` allows exactly this one thumbnail tool, on
  the Producer endpoint only. Producer API 1.20.0.
- `live-streams` keeps its own thumbnail step (a broadcast's settings); bringing it onto this writer is a separate task (§M).

## Compatibility / migration impact

No schema change. A new backup snapshot kind (`video_thumbnail`) in the existing JSON backup files. Additive MCP tool.

## Acceptance criteria (written before the code, from the requirement and the API reference)

- AC-TH-01 A path outside `04 Videos/`, absolute, with `..`, or not an image → refused `thumbnail_file_invalid`, no YouTube call.
- AC-TH-02 A file over 2 MB (2 097 152 bytes) → refused `thumbnail_file_invalid`; exactly 2 097 152 bytes is accepted.
- AC-TH-03 A video YouTube does not return, or whose `snippet.channelId` differs → `video_not_in_channel`; no write.
- AC-TH-04 An active upload row for that video id without `steps.thumbnail` → `thumbnail_step_pending`, no write; with `steps.thumbnail` set/failed, or a finished row → allowed.
- AC-TH-05 Backup is captured before the write; if it fails, no write and the error is returned.
- AC-TH-06 Identity check runs before the write; a wrong channel → fails closed, no write.
- AC-TH-07 Live writes off → refused, no `thumbnails.set` call (checked immediately before the call).
- AC-TH-08 Dry run → every read and check, no backup, no write, no audit RESULT; reports units 52.
- AC-TH-09 Success → exactly one `thumbnails.set` with the file's bytes and type; read-back `hasCustomThumbnail` true and privacy/`publishAt` unchanged → `verified: true`.
- AC-TH-10 Read-back differs (no custom thumbnail, or privacy/`publishAt` changed) → `verified: false` with the detail; audited.
- AC-TH-11 Audit rows BACKUP, RESULT, VERIFICATION with actor and SHA-256.
- AC-TH-12 The Producer tool exists only on the Producer endpoint; agent/factory endpoints have no thumbnail tool.
- AC-TH-13 Owner routes need the owner's session and the active channel.
- AC-TH-14 Nothing in the publishing plan or the upload row changes.
