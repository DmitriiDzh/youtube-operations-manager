# 0072. The owner's review gates the media only; packaging is fixed after upload through the existing snippet writer

Status: Proposed. The requirement is the owner's (PRD-REQ-0195 part B, owner TG 2340 via the Producer, 2026-11-16; owner msgs
4566–4569 to the developer, «да на оба»). The design choices and the open questions in the plan's §6 await the owner.

**Date:** 2026-11-16.
- **Plan:** `docs/roadmap/plans/MEDIA_GATE_PLAN.md`, acceptance AC-MG-01..34. Backlog BL-265.
- **Amends:** ADR 0070 §3 (what an approval covers) and §4 (decisions). Builds on ADR 0005 (write gateway), 0046/0059 (upload
  rows), 0051 §7–§8 (upload order, upload translations), 0062 (packaged slot approval, unchanged here), 0069 (thumbnail writer,
  reused), 0071 (BL-263 video code `S<n>`, recode alias).
- **Factory contract:** Operator bundle 2.5.45 (frozen). Every package states the mp4's `sha256` + `sizeBytes`, and only hard
  rejections make NOT READY.

## Context

BL-257 binds the owner's approval to the whole manifest SHA-256 plus the thumbnail file's hash. Every packaging fix re-packages the
manifest, so it drops the approval, and a queued upload then fails `package_changed` (`upload-runner.ts`, the manifest-hash check
before the first byte). The owner (TG 2340): «В медиа я одобряю сами медиа файлы … Но если у меня будут сомнения на счет упаковки
то я должен иметь возможность поправить и задним числом даже опубликованные. Так что это тоже не должно блокировать публикации.»

The default-language `snippet.title/description/tags` of any video can already be written by `src/lib/video-details/` (the
owner's Details card, owner-authorized 2026-09-20), with identity check, backup, etag conflict check, full snippet
read-merge-write, read-back and audit. What is missing is a package-driven path for it, and a few safety gaps.

## Decision

1. **The approval covers the media.** Its key is the manifest's mp4 identity `(channel, video, sha256, sizeBytes)`. Decisions in the
   `package_reviews` family gain `videoSha256` and `videoSizeBytes` and keep `manifestSha256`, so an older build reads them as
   manifest-only, which is stricter. The thumbnail is no longer part of the approval or of the gate. A package without `sha256` is
   never approvable. A different `sha256` or size is a media change, and the package is pending again. The video code must match
   exactly, or be BL-263's recode alias. Legacy decisions count for the media key of their manifest while that manifest is still on disk.
2. **«Вернуть» returns media; packaging gets comments.** A new decision kind `packaging_comment` (comment required) never changes the
   gate. It wakes the Producer like any decision. Older builds drop the unknown kind. Only the owner's Web UI decides (unchanged).
3. **Only hard limits block.** `packageProblems` splits into blocking problems (unreadable package, media integrity, channel,
   language baseline, duplicate title, factory verdict, YouTube's text/thumbnail/localization limits) and `warnings` (chapters,
   test thumbnails). Warnings are shown and block nothing (plan §3.1 table).
4. **A queued upload takes a metadata-only re-package.** While a row is `queued`, before the identity read and `begin`, the
   runner reads the manifest bytes once. If the SHA-256 changed, the same channel, video, slot, `sha256` and `sizeBytes` are
   required, along with no blocking problem and the media gate. The row's `manifestSha256` and `packageJson` are then replaced in one
   conditional update and audited (`publishing.upload_package_refreshed`). A media change → `cancelled media_changed`. A slot change →
   `cancelled package_slot_changed`. An unparseable manifest waits up to 10 minutes, then `package_changed`. A row with a session never
   changes its package. Every new row freezes `videoSha256` (owner rows too); a row without it keeps today's `package_changed`.
5. **Packaging after upload uses the existing writer.** A publishing service (`src/lib/publishing/package-metadata.ts`) builds a
   patch of `title`/`description`/`tags` from the package's **current manifest** for the video its upload record names. It calls
   `video-details.applyFieldsUpdate` (the gateway's `applyVideoDetailsUpdate`, `part: snippet`). There is no new module and no
   new gateway function (AGENTS.md §D). The write is a full snippet read-merge-write: other writable snippet fields are sent back
   as read, except `defaultAudioLanguage` `zxx` (RISK-102). It never touches `localizations` or `status`. A three-way conflict check
   (YouTube now / uploaded / manifest, PROJECT_SPEC §30) and the etag guard apply. The write is refused while this computer's upload
   of the video has not finished its read-back. The pipeline is device gate, ownership (`snippet.channelId`), identity check,
   backup, Live writes immediately before the call, read-back of the written fields and of the untouched fields, privacy,
   `publishAt` and the localization languages, then audit (`source: package_metadata`). A dry run does every read and no write.
   In `video-details` itself, Live writes move to directly before the gateway call, the snapshot gains `channelId`, and a
   `verifyUnchanged` read-back option is added.
6. **Who.** The owner, by a click on the diff in Media → «Видео на проверку» (remote allowed). The Producer gets
   `producer_video_metadata_update` (current package values only, refuses conflicts, its endpoint only) **only if the owner says
   so**. A new manifest is never applied to YouTube automatically. Worker agents and the factory get no tool. The thumbnail is
   replaced through `src/lib/video-thumbnails/` (ADR 0069). Translations of an uploaded video stay out until the owner authorizes
   them (plan §6 Q4).

## Alternatives

- **Keep the manifest key and add an "approve again quickly" button:** every packaging fix still stops the upload. Rejected
  (requirement).
- **Key by `sha256` alone, ignoring the video code:** the same mp4 under another code would be approved silently. Rejected; the
  recode alias is the one allowed exception.
- **A new writer module for title/description/tags:** a parallel path to `video-details` (§D). Rejected.
- **Apply a re-package to YouTube automatically:** a public title could change with no person seeing the diff. Rejected as the
  default.
- **Refresh the package of a row that already has a session:** the insert's title is fixed, `onExpired` adopts by it and the
  read-back checks it. Rejected.

## Consequences

- AGENTS.md §F gains the «Package metadata after upload» entry (draft in the plan §4) and the «Owner package review» bullet is
  amended. PROJECT_SPEC §21 follows. RISK-154 is amended.
- The `packaged` slot approval (ADR 0062) still names the manifest. Until part A of PRD-REQ-0195 (week template) lands, a
  metadata-only re-package after a slot approval uploads but waits for one slot re-approval for its date (plan §6 Q1).
- APIs (additive): Factory 1.50.0, Agent 4.22.0, Producer 1.24.0 (after BL-263's 1.49.0 / 4.21.0 / 1.23.0).

## Compatibility / migration impact

There is no SQLite schema change: the upload row's existing `manifest_sha256` / `package_json` / `steps_json` are rewritten. The
sync family gains additive fields and one kind. An older build is stricter: it reads approvals as manifest-keyed and still fails a
queued row on re-package. Both computers update together, and the upload computer is the Mac. Existing approvals carry over while
their manifest is on disk.
