# 0072. The owner's review gates the media only; packaging is fixed after upload through the existing snippet writer

Status: Proposed (until the merge). The requirement is the owner's (PRD-REQ-0195 part B, owner TG 2340 via the Producer,
2026-11-16; owner msgs 4566–4569 to the developer, «да на оба»). The owner answered the plan's open questions on 2026-11-16 (TG
4578/4581; slot approval TG 4569 «Одобрение слота вообще не нужно»): every recommendation accepted, and the Producer gets the tool.

**Date:** 2026-11-16.
- **Plan:** `docs/roadmap/plans/MEDIA_GATE_PLAN.md`, acceptance AC-MG-01..38. Backlog BL-265.
- **Amends:** ADR 0070 §3 (what an approval covers), §4 (decisions) and §5 (the tried exception; also BL-264). Builds on ADR 0005 (write gateway), 0046/0059 (upload
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
   exactly, or be BL-263's recode alias. Legacy decisions keep BL-257's meaning: one counts while its manifest is unchanged on disk, and the first re-package needs one re-approval, because no owner-written record ties them to the mp4. A recode copies only such a legacy decision; a media decision needs no copy.
2. **«Вернуть» returns media; packaging gets comments.** A new decision kind `packaging_comment` (comment required, allowed on any
   package of the channel, uploaded ones and gate-off channels included) never changes the gate. It wakes the Producer like any decision. Older builds drop the unknown kind. Only the owner's Web UI decides (unchanged).
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
6. **"Tried" moves to the media key (amends ADR 0070 §5 and BL-264).** A row that froze `videoSha256` makes its media key tried, and
   an older row its manifest hash. A package is tried when either key is. BL-257's exception (every row cancelled before YouTube and
   before the approval) is evaluated per media key. Without this, a failed or `unknown_outcome` row followed by a texts-only
   re-package would be taken by the automatic upload with no owner action.
7. **One comparison rule** for the difference badge, the three-way check, the patch and the read-back: the runner's
   `readBackMismatches` rule (title exact; description CR-normalised and trailing line breaks dropped; tags unordered), shared. The
   patch sends the normalised description, and `video-details`' read-back gains the description rule. An unknown upload baseline
   (the upload ran on the other computer) makes every differing field a conflict.
8. **Who.** The owner, by a click on the diff on the uploaded package's row in «Ролики и релизы» or its week-plan slot, on any channel (remote allowed). The Producer gets
   `producer_video_metadata_update` (current package values only, refuses conflicts, dry run, the same pipeline and device gate,
   its endpoint only) -- owner TG 4578/4581: it needs it perhaps more than he does, for packaging tests. A new manifest is never applied to YouTube automatically. Worker agents and the factory get no tool. The thumbnail is
   replaced through `src/lib/video-thumbnails/` (ADR 0069). Translations of an uploaded video stay out for now (owner,
   plan §6 Q4).

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
- The `packaged` slot approval (ADR 0062) still names the manifest; the owner leaves it to part A of PRD-REQ-0195 (week template),
  where slot approvals go away entirely (TG 4569). Until then a metadata-only re-package after a slot approval uploads, and an
  automatic or Producer row's date waits for one slot re-approval (its date comes only from the slot's approval). An **owner's**
  upload-approval row keeps the `publishAt` he chose himself in that approval when it takes the refreshed manifest: the date is his
  own decision and the media is unchanged (only the packaging differs), so the runner does not withhold it (`upload-runner.ts`, the
  date step). The date stays withheld when the thumbnail or translations step fails (BL-224, kept).
- APIs (additive): Factory 1.51.0, Agent 4.22.0, Producer 1.24.0. BL-263 merged first (1.49.0 / 4.21.0 / 1.23.0) and its review-carry
  fix took Factory 1.50.0.
- The BL-263 review carry (`carryReviewDecisionForRecode`) stays only as the fallback for decisions made before BL-265 (manifest-keyed);
  a media decision follows the recode alias with no copy.

## Compatibility / migration impact

There is no SQLite schema change: the upload row's existing `manifest_sha256` / `package_json` / `steps_json` are rewritten. The
sync family gains additive fields and one kind. An older build is stricter: it reads approvals as manifest-keyed and still fails a
queued row on re-package. Both computers update together, and the upload computer is the Mac. Existing approvals carry over while
their manifest is on disk.

## Amendment 1 — the package's translations after upload (2026-11-24)

**Requirement:** owner TG 4839/4842, 2026-11-24 («согласовываю»), relayed by the Producer (TG 2578) for a Japan packaging A/B test
(B variants on scheduled videos). It reverses §8's "Translations of an uploaded video stay out for now" for the package's own
translations only; `docs/WRITE_AUTHORIZATIONS.md` «Package metadata after upload» carries the amendment.

1. **What.** A video a release package already put on YouTube may get that package's **current manifest** `localizations` (title and
   description per language, `packageLocalizationSet` -- the set the upload's translations step sends), descriptions in YouTube's
   form (§7). Never free text, never YouTube's own `snippet.defaultLanguage` (listed as `ownLanguageSkipped`; that text is §5's
   snippet path), never a removal: a language the video has and the package lacks is kept (`kept`). A video with no default language
   on YouTube is refused.
2. **Writer.** No new writer and no new gateway function: `src/lib/publishing/package-localizations.ts` decides, the shared video
   translations writer `src/lib/shared-video-localizations/` writes (ADR 0051 §8, ADR 0045: identity check, backup of the current
   translations, safe merge, Live writes immediately before `videos.update part=snippet,localizations`, read-back, audit), with
   source `package_localizations`. Two additive writer inputs: `expectedCurrent` (each language written must still read as this
   check saw it, on the fresh read and on the recheck after the backup; otherwise `video_details_conflict`, nothing sent) and
   `auditContext` (actor, package). The service reads privacy and `publishAt` before and after (the writer reads only snippet and
   localizations); a change, or the writer's `verified: false`, is `update_failed`.
3. **Three-way check per language and field** (YouTube now Y / what the upload sent U / the package P; absent is a value): Y = P
   same; U known and Y = U write; otherwise conflict. U comes from this computer's audit of the video, newest first
   (`localizationBaselineOf`): the newest `package_localizations.applied` whose translations read back verified (`writerVerified`, also
   when a status field changed afterwards) gives `afterLocalizations` -- malformed: unknown; a newer attempt that did not read back
   verified (an applied row with the writer unverified, or the writer's RESULT row with no applied row after it) makes the languages it
   tried unknown. Otherwise this computer's finished upload row of the video when its translations step is `verified` (its frozen set, a
   language not in it was not sent) or `none` (nothing sent); otherwise unknown. The upload record file (`V<n>_youtube.json`) does not
   hold the translations, so an upload from the other computer is unknown: every difference is a conflict. **Any conflict refuses the
   whole call, for the owner as well** (`package_localizations_conflict`, `details.conflicts`; no per-language override; the screen
   shows which language and field).
4. **One YouTube write per call, and no stale snippet echo.** `producer_video_metadata_update { localizations: true }` and the owner's
   route `{ localizations: true }` fix the translations instead of title/description/tags (the flag, not a sibling tool, keeps one tool,
   one permission `METADATA_WRITE` and one session surface). One write per call alone does not stop a stale echo (review of 1c515813):
   the translations writer sends the snippet back from its own read, so a lagging replica could echo an older title over a texts fix
   just made, and its read-back -- against that same read -- would pass. So the call passes `expected` title / description / tags
   (`ExpectedSnippet` gains `title` / `description`): YouTube's texts as this check read them, overridden by what the latest
   `package_metadata` fix here sent when it is at most 15 minutes old. The writer waits for them (its bounded re-read loop) or refuses
   with nothing sent, and its read-back checks them. Both package fixes of one video also run one at a time on this computer
   (`withPackageVideoLock`, in-process). A texts fix made on the other computer within seconds is not covered by the lock; the
   expected texts then come only from this check's read.
5. **Gates as §5:** the device gate, `snippet.channelId`, refused while this computer's upload of the video has not finished its
   read-back, never automatic; public videos as §5 (allowed on a person's click or the Producer's deliberate call). Dry run: every
   read, no backup, no write. Quota about 56 units. A scheduled video that publishes during the call (private with a due `publishAt` ->
   public) is not a status change made by the write.
6. **API:** Producer 1.30.0 (additive; 1.28.0 went to BL-272, 1.29.0 is reserved for playlist-rights). Factory and Agent unchanged.
