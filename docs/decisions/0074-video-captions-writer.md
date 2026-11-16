# 0074. English captions for WWE long videos -- one writer, insert only

Status: Proposed (until the merge). The requirement is the owner's (Telegram 2026-11-16: msg 4590 «да» to `captions.insert`, English
only, burned-in subtitles off; msg 4592 captions only for WWE long horizontal videos). Request FO-REQ-0055 (Operator; bundle 2.5.46
`12 --captions`).

**Date:** 2026-11-16.
- **Plan:** `docs/roadmap/plans/VIDEO_CAPTIONS_PLAN.md`, acceptance AC-CAP-01..37. Backlog BL-269.
- **Builds on:** ADR 0005 (write gateway), 0007 (read gateway), 0051 §7–§8 (upload order; amended: a captions step after the
  translations), 0069 (thumbnail writer, the pattern), 0072 (media-only gate; captions are packaging).

## Context

AGENTS.md §F keeps captions out of the Change Set mechanism, and PROJECT_SPEC §21 says the app does not integrate captions at all.
WWE wants an English subtitle track on its long videos, uploaded as a track (searchable, switchable), not burned in. YouTube's
`captions.insert` (400 units, scope `youtube.force-ssl`) adds a track; `captions.list` (50) shows the tracks (`trackKind` standard /
ASR / forced, `status` serving / syncing / failed) but no content hash, so which track the app made must be recorded by the app.
A 409 `captionExists` guards only the same language **and** name.

## Decision

1. **One writer, `src/lib/video-captions/`, insert only.** It may insert one English caption track (`captions.insert`, `isDraft:
   false`, no `sync`) on a video of the channel, and nothing else. One gateway primitive `insertVideoCaption`; no update or delete
   primitive, and an inventory test fails on any `captions.update`/`captions.delete` call. `captions.list` goes through the read
   gateway. Callers: the upload runner (injected dep) and the package-captions service; the module imports nothing from `publishing`.
2. **Where (owner TG 4592).** Only on a channel whose synced publishing default `captionsEnabled` is on (owner, Web UI; default off)
   and only on a horizontal long video (V code; frame from ffprobe at queue time, from YouTube `fileDetails` on an uploaded video;
   unknown → refused). Anything else is a package problem (`captions_invalid` with a `reason`), and nothing is written.
3. **The package field (Operator).** `yt-release-package/2` `captions: [{ language, file, name, sha256 }]`: at most one entry,
   `language` `en`, a `.srt` or `.vtt` file inside the package folder, UTF-8, parsed (cues, timestamps, within the duration), ≤ 10 MiB,
   SHA-256 matching, name 1–150 characters. Problems `captions_missing` / `captions_invalid` block. Captions are packaging: they keep
   the owner's media approval and a queued upload takes a metadata-only re-package (ADR 0072 §1, §4). Optional on every package.
4. **Existing tracks -- by language, never by name.** ASR tracks are never touched and never block. A standard/forced English track
   the app recorded with the same SHA-256 → already present, no write. The app's own track with another file → refused (no update
   in v1). Any other standard/forced English track is **foreign** → refused, nothing written. A second "English" track next to a
   person's own would confuse viewers, and the app cannot know which is right; the owner decides in Studio.
5. **"Created by the app"** = the track id recorded in this computer's upload row or in the release's `Vn_youtube.json`
   (`captions: [{ trackId, language, name, sha256, at, by }]`), which the other computer reads from the shared workspace. Losing the
   record makes the track foreign: a refusal, never a wrong write.
6. **The pipeline (AGENTS.md §G).** Validation (bytes re-hashed and re-parsed; the switch read now) → device mutation gate → video
   read (exists, `snippet.channelId`, orientation) → track list (`captions.list`) and the rule of §4 → quota guard (550 units) → dry
   run stops here (units 51) → backup (the list + the bytes to send, `video_captions` snapshot; failure stops) → identity check
   (`assertWriteChannel`) → attempt mark → Live writes immediately before the one insert → read-back (`captions.list`: the new id,
   `en`, the name, standard, not draft, `serving`; `syncing` one bounded re-read; every earlier track unchanged) → record → audit
   (`BACKUP`, `RESULT`, `VERIFICATION`, `source: video_captions`, actor upload/owner/producer). A missing `youtube.force-ssl` refuses.
   A failure after a successful insert is reported as written.
7. **Upload step.** Order `localizations → captions → thumbnail → playlist → verify → publishAt`. `steps.captions` `none` |
   `verified` | `already_present` | `mismatch` | `failed` | `refused`; the date is written only after `none`/`verified`/
   `already_present` and the read-back, otherwise withheld (private). Quota short (guard or YouTube) → a `quota_exceeded` pause, never
   a failure. A lost insert answer: a track with the package's name absent from the backup list, or a 409, is the upload's own and is
   adopted. `estimateUploadUnits` adds 550.
8. **Already uploaded videos.** The owner («Добавить субтитры» on the uploaded package's row) and the Producer
   (`producer_video_captions_add { channelId, video, dryRun? }`, its endpoint only) add the track from the package's **current
   manifest** for the video its upload record names -- no free file path, the mp4 need not be on disk. Refused while this computer's
   upload of the video has not finished its captions step. No adoption on a lost answer here (`unknown_outcome`). Channel worker
   agents and the factory get no caption tool.
9. **Upload record.** `yt-release-upload/1` gains `videoSha256` (or `null`) and `videoSizeBytes` at both writes (Operator), plus
   `captions` (§5). Additive; the schema name stays.

## Alternatives

- **Add alongside a foreign English track** (YouTube allows another name): two English entries for viewers. Rejected.
- **Replace our own track with `captions.update`** (450 units): left for later (plan Q1); v1 refuses.
- **Identify our track by name**: anyone can type the same name. Rejected; the id is recorded.
- **Captions through the Change Set mechanism**: §F forbids it, and the mechanism is title/description only. Rejected.
- **Burned-in subtitles**: off (owner TG 4590); not searchable or switchable.

## Consequences

- AGENTS.md §F gains the bullet below; PROJECT_SPEC §21 (lines 791–792) and SYSTEM_MAP (line 219) stop saying captions are not
  integrated. `no-agent-upload-tool.test.ts` allows exactly `producer_video_captions_add` on the Producer endpoint.
- APIs (additive, next free at merge): Producer 1.26.0, Agent 4.24.0, Factory 1.53.0.
- WWE's grant must include `youtube.force-ssl` (checked before the build; otherwise the owner reconnects WWE).

## Compatibility / migration impact

No SQLite schema change (steps live in `steps_json`; the switch is a synced publishing default). New backup kind `video_captions`.
An older build ignores `captions` in a package and in the record; it would upload such a package without captions (both computers
update together; the upload computer is the Mac). Rows queued before this build finish with `steps.captions: none`.

## Proposed AGENTS.md §F bullet (added at merge)

  **Captions writer (2026-11-16, owner, Telegram msgs 4590/4592, FO-REQ-0055, BL-269, ADR 0074):** `src/lib/video-captions/` may
  insert one English caption track (`captions.insert`, never `captions.update` or `captions.delete`) -- only on a channel whose
  captions switch the owner turned on (WWE) and only on a horizontal long video, only the file a release package of that channel
  states (`captions`, checked by `packageProblems`: SRT/WebVTT, SHA-256, size, `en`). Two paths: the upload step of
  `src/lib/publishing/` (after the translations, before the thumbnail; the video gets its `publishAt` only after the captions step
  and the read-back passed) and, for a video already uploaded by a package, the owner's Web UI and the Producer
  (`producer_video_captions_add`, its own endpoint only), from that package's current manifest. Never replaces or deletes a track
  the app did not record as its own; a foreign English track refuses the write (ASR tracks are ignored). Identity check, backup of
  the track list, Live writes immediately before the call, read-back (`captions.list`), audit, dry run and the quota guard. Channel
  worker agents and the factory get no caption tool (`docs/PROJECT_SPEC.md` §21).
