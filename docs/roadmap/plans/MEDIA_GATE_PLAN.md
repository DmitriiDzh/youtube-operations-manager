# Media-only gate and packaging fixes after upload (BL-265, ADR 0072)

Owner: 2026-11-16, Producer PRD-REQ-0195 part B (owner TG 2340 via the Producer), owner msgs 4566–4569 to the developer («да на
оба»). Factory contract: Operator bundle 2.5.45 (frozen, pins with this work): `12 Release_Package` always writes the mp4's top-level
`sha256` + `sizeBytes`; only YouTube/YTM hard rejections make a package NOT READY, everything else is a warning.

Status: **plan, Proposed** (ADR 0072). Nothing here is built yet. Parts A (week template) and D (factory routines) of PRD-REQ-0195 are
not in this plan; part C shipped as BL-264 (`496aeb12`, Producer API 1.22.0).

## 1. Goal

- **B1.** The only blocking owner approval is his approval of the **media** (Медиа → «Видео на проверку», BL-257). It is bound to the
  video file's identity (the manifest's `sha256` + `sizeBytes` of the mp4, per channel and video code), not to the whole manifest.
  A re-package that changes only packaging (title, description, thumbnail, tags, translations, crossPost) keeps the approval, and a
  queued upload goes on with the new manifest. A different mp4 is a media change and needs the owner again. Packaging never blocks in
  YTM except YouTube's own hard limits; packaging review becomes comments.
- **B2.** The owner can fix packaging after upload/publication: the video's default-language `snippet.title`, `snippet.description`
  and `snippet.tags`, from the package's current manifest, through the existing safety pipeline; thumbnail through the existing
  BL-255 writer.

## 2. Current behaviour (dev `f3e637b2`)

| Where | What it does today | Why it blocks B |
|---|---|---|
| `src/lib/package-reviews/model.ts` `wellFormedDecision`, `latestOwnerDecision`, `ownerReviewStateOf`, `ownerReviewProblemOf` | Approvals and returns are keyed by `manifestSha256`; an approval also names `thumbnailSha256` and counts only while the thumbnail file still hashes to it (ADR 0070 §3). | Any re-package (new manifest bytes) or a new thumbnail file → `owner_review_pending` again. |
| `src/lib/package-reviews/services.ts` `decide` | Approval needs the manifest's video `sha256`, this computer's mp4 hashing to it, and a thumbnail file (`package_review_thumbnail_missing`). | Thumbnail (packaging) is a precondition of the media approval. |
| `src/lib/sync-gateway/package-reviews/contracts.ts` `PackageReviewDecision` | `{ id, manifestSha256, video, thumbnailSha256, kind: approved|returned, comment, by, device, at, seq? }`. | No video identity field. |
| `src/lib/publishing/owner-review-gate.ts` `OwnerReviewGate` | `needsThumbnailHash(manifestSha256)`, `problemOf(manifestSha256, thumbnailSha256)`. | Gate port speaks manifest + thumbnail. |
| `src/lib/publishing/package-scan.ts` `scanOne` (≈ l. 244–251) | Gate applied to a package with no record and no other problem. | Same key. |
| `src/lib/publishing/upload-runner.ts` `upload` (l. 443–472) | A queued row: owner gate by `job.manifestSha256` + thumbnail hash → cancelled `OWNER_REVIEW_WITHDRAWN`; then **`manifest sha256 !== job.manifestSha256` → `fail(package_changed)`**; size check; `videoHashDiffers` only for rows that froze `videoSha256`. | Any metadata-only re-package kills a queued upload. |
| `src/lib/publishing/upload-approval.ts` l. 158 | Freezes `videoSha256` on automatic and Producer rows only, never on the owner's approval rows. | Owner rows have no frozen media identity to compare against. |
| `src/lib/publishing/upload-runner.ts` `readBackMismatches` (l. 300) | The finishing read-back compares YouTube's title/description/tags with the row's frozen package. | A packaging write during an unfinished upload would make the read-back fail and withhold the date. |
| `src/lib/publishing/packages.ts` `packageProblems` | Every problem is blocking (`not_ready`), including `chapter_too_short`, `chapters_first_not_zero`, `chapters_too_few`, `test_thumbnail_*`. | Non-YouTube-rejection checks block. |
| `src/lib/publishing-plans/` + `approvalNamesUpload` (`auto-upload.ts` l. 144, runner l. 703, `plan-schedule.ts` l. 78) | The `packaged` slot approval's fingerprint is `[video, manifestSha256, videoId|null]` (ADR 0062 §2–§3). | A metadata-only re-package still drops the slot approval → the date waits. **Not changed by B** (see §6 Q1: part A replaces slot approval). |
| `src/composition/cross-posting-plan.ts` l. 71–120, `src/lib/cross-posting/runner.ts` l. 181 | Cross-posts bind to the slot approval's manifest SHA-256. | Same as above; not changed by B. |
| `src/lib/video-details/` (`services.ts` `previewFieldsUpdate`/`applyFieldsUpdate`, `adapters/youtube-api.ts` `applyPatch`, routes `src/app/api/channels/[channelId]/videos/[videoId]/details/{preview,apply}`, `src/components/video-details-panel.tsx`) | **Already writes `title`, `description`, `tags`** of any video for the owner (Studio-parity Details card, owner-authorized 2026-09-20): identity check (`assertWriteChannel`), backup (`video_fields`), etag conflict check, full snippet read-merge-write (`pickWritableSnippetFields({ ...context.snippet, ...patch }, { includeDefaultAudioLanguage: "keep" })`), read-back of the patched fields, audit (`DRY_RUN`/`BACKUP`/`RESULT`/`VERIFICATION`), local cache refresh. Other callers: `worker-privacy` (privacy only), `language-fix-all`, `publishing` (veto removes a date), live-stream fields. | See §3.2: B2's physical write exists; the gaps are listed there. |
| `src/lib/video-thumbnails/` (BL-255, ADR 0069) | Thumbnail of any uploaded video, owner + `producer_video_thumbnail_replace`. | Reused as is. |
| `src/lib/shared-video-localizations/` | Callers: `live-localizations` and the upload's own translations step only (AGENTS §F). | Translations of an already-uploaded video are **not** authorized today (§6 Q4). |

**Discrepancy to report.** The requirement calls B2 a "NEW YouTube writer". The physical write of `snippet.title/description/tags`
already exists in `src/lib/video-details/` (owner Details card). Per AGENTS.md §D no parallel writer is built: B2 is a new **surface**
over that writer (package-driven, plus possibly the Producer), with the safety gaps below closed in `video-details` itself. It still
needs an AGENTS.md §F entry, because it adds a new path and possibly a new caller (§4).

## 3. Design

### 3.1 B1 — the gate binds to the media

**Media identity.** `mediaKey = (channelId, video, sha256, sizeBytes)` as the manifest states them (`sha256` lower-case hex,
`sizeBytes` integer). A package without `sha256` can never be approved (unchanged, AC-PR-05).

**Decision record (sync family `package_reviews`, additive fields, no schema migration):**
`{ id, manifestSha256, video, videoSha256, videoSizeBytes, thumbnailSha256, kind, comment, by, device, at, seq? }`, with
`kind ∈ approved | returned | packaging_comment`.
- New decisions keep writing `manifestSha256` (the manifest seen) and `thumbnailSha256` (informational). An **older build** on the
  other computer ignores the new fields and keys by `manifestSha256` → it treats a new approval as covering only that manifest
  (stricter, fails closed). It drops an unknown `kind` (`wellFormedDecision` → null), so a `packaging_comment` is never an
  approval anywhere.
- **Which decision stands** for a media key: the latest `approved`/`returned` decision whose `(video, videoSha256, videoSizeBytes)`
  matches, ordered as today (`seq`, `at`, `id`). `packaging_comment` never counts for the gate.
- **Video code match.** The decision's `video` must equal the package's `video` exactly (string as-is; BL-263 adds `S<n>`), **or**
  the package's code is the BL-263 recode alias of the decision's code (a V cancelled with `replacedBy` that S). The recode only
  renames files, so the mp4 bytes and `sha256` stay. (Depends on BL-263 being merged first; until then exact match only. §6 Q8.)
- **Legacy decisions** (no `videoSha256`): at read time, a legacy decision whose `manifestSha256` equals a manifest currently on
  disk is treated as a decision for that manifest's `(video, sha256, sizeBytes)`. BL-257 already proved the mp4 hashed to that
  `sha256` when the owner approved. A legacy decision whose manifest is gone counts for nothing, so the package is pending again
  (one re-click). (§6 Q7.)

**Gate port** (`owner-review-gate.ts`): `problemOf({ video, videoSha256, videoSizeBytes, manifestSha256 })`. `needsThumbnailHash`
is removed: the scan and the runner no longer hash the thumbnail for the gate. `CLOSED_OWNER_REVIEW_GATE` is unchanged (fail
closed). The rule stays in `package-reviews/model.ts` (§M).

**Decisions (owner Web UI only, unchanged boundary):**
- «Одобрить» = approve the media. Preconditions: the manifest states `sha256`, and this computer's mp4 is `sizeBytes` long and
  hashes to it. **A thumbnail is no longer required.**
- «Вернуть» stays, for the media only, with a required comment. It returns this mp4 (media key), and a new mp4 is pending again.
  A return of packaging is not possible any more (§6 Q5).
- **New «Комментарий к упаковке»** (kind `packaging_comment`, comment required, ≤ 2000 chars) on any item, including approved and
  uploaded ones. It never changes the gate, and it wakes the Producer like any decision (`REVIEW-DECISION-package-<video>-<id>.md`,
  `kind: packaging_comment`, via `review-notify`).
- The review screen keeps showing approved and uploaded items (today: 10 decided uploads) so the owner can comment on packaging
  later. An uploaded item whose current manifest differs from YouTube shows «Упаковка отличается от YouTube» and the B2 apply
  action (§3.2).

**Hard limits only (`packageProblems`)** — each code classified. Blocking means `not_ready`. A warning goes in a new `warnings: PackageProblem[]`
field on `ScannedPackage`, is shown, and blocks nothing.

| Code(s) | Class | Why |
|---|---|---|
| `not_a_package`, `unknown_schema`, `field_invalid`, `thumbnails_default_count`, `invalid_json`, `youtube_record_invalid` | blocking | The package cannot be read safely. |
| `other_channel`, `video_missing`, `video_size_differs`, `video_unreadable`, `ffprobe_missing`, `video_duration_differs` | blocking | Media integrity / identity. |
| `factory_not_ready` | blocking | The factory's own verdict; since 2.5.45 it only means a hard rejection. |
| `title_empty`, `title_too_long`, `title_angle_brackets`, `description_too_long`, `description_angle_brackets`, `tags_too_long`, `tags_angle_brackets` | blocking | YouTube rejects the insert. |
| `thumbnail_missing`, `thumbnail_not_image`, `thumbnail_too_large` | blocking | `thumbnails.set` rejects (JPEG/PNG, 2 MB). Without a thumbnail the runner's date rule (BL-224) holds the date anyway. |
| `localizations_invalid` | blocking | YouTube rejects the localizations update (the shared rules = YouTube's limits). |
| `no_channel_baseline`, `language_differs`, `audio_language_differs` | blocking | The channel language baseline (PROJECT_SPEC §14). This is a YTM write rule, not packaging taste. |
| `same_title_on_channel` | blocking | A duplicate guard: the runner adopts an expired session's video by title (`onExpired`). |
| owner review codes | blocking | The media gate itself. |
| `chapters_first_not_zero`, `chapters_too_few`, `chapter_too_short` | **warning** | YouTube accepts the description; it just shows no chapters. |
| `test_thumbnail_missing`, `test_thumbnail_not_image`, `test_thumbnail_too_large` | **warning** | Test thumbnails are not uploaded by the runner (Test & Compare is manual). |

### 3.2 Re-validation of a queued upload after a re-package (runner)

Only while the row is `queued`, before the identity read and before `gateway.begin`. A row that already has a session, or any later
status, **never** takes a new manifest. After `begin` the insert's title is on YouTube, `onExpired` adopts by that title, and
`readBackMismatches` checks it, so later packaging changes go through B2 after the upload finishes.

1. Read the manifest bytes at the row's `manifestPath` **once**; hash and parse those same bytes (no read-twice race).
2. Same SHA-256 as `job.manifestSha256` → today's path unchanged.
3. Different SHA-256 and the row froze `videoSha256` (§3.3):
   - Bytes not parseable, or not a package → **wait**: the row stays `queued`, `nextAttemptAt` is 60 s later, and the attempt is noted. After 10 minutes of this
     → `fail(package_changed)` (a half-written manifest gets time; a broken one does not loop forever).
   - Parsed: `channelId`, `video` and `slotId` must equal the row's frozen package. A different slot is a plan change, so the row is
     `cancelled` with `package_slot_changed` and the automatic upload / Producer re-queues it under the plan's rules. The manifest's `sha256`
     and `sizeBytes` must equal the frozen `videoSha256` and `sizeBytes`. If they differ, the row is **`cancelled` with
     `media_changed`** (audit `publishing.upload_cancelled_media_changed`). The new manifest is a new media key, pending in review, and not
     tried, so it is queued again after the owner approves it.
   - `packageProblems` of the new manifest with fresh facts (the scan's own checks) must have no **blocking** problem. Otherwise
     `fail(package_changed)` with the codes.
   - The owner gate is checked by the media key (the same check as today, before anything is sent).
   - Then **one conditional update** (`store.update(id, "queued", …)`) writes `manifestSha256` = new, `packageJson` = rebuilt from
     the new manifest (title, description, tags, `localizations`, `thumbnailFile`, `containsSyntheticMedia`, languages; the
     frozen `settingsJson`, `slotId`, `videoSha256`, `sizeBytes` and `publishAt` stay), and appends `{ from, to, at, fields }` to
     `steps.repackaged`. Audit `publishing.upload_package_refreshed { uploadId, video, from, to, changedFields }`.
   - Then today's checks continue: size, `videoHashDiffers` (the file hashes to the frozen `sha256`), identity, `begin`.
4. Different SHA-256 and **no** frozen `videoSha256` (a row made before this build) → today's `fail(package_changed)`.

**Consumers of the row's `manifestSha256` after a refresh:** `triedHashes` and `triedExceptionsOf` see the new hash (the old
manifest no longer exists). `plan-schedule.decisionForRow` / the date step `approvalNamesUpload` compare the slot approval with
the **new** manifest, so a slot approved for the old manifest gives no date until the owner approves the slot again (ADR 0062,
unchanged; §6 Q1). The automatic upload never makes a second row for the same video: `checkPackageForQueue` refuses `held` while a
row of that video is active here.

### 3.3 Every new row freezes the media identity

`upload-approval.ts` freezes `videoSha256` (and the row already has `totalBytes`) on **every** new row whose manifest states
`sha256`, the owner's approval rows included. So the runner hashes the file before the first byte on owner rows too (the same cost
as automatic rows today), and only a row with a frozen identity can take a refreshed manifest (§6 Q9).

### 3.4 B2 — packaging fixes on an uploaded video

**Where.** No new module and no new gateway function. The physical write stays `video-details.applyFieldsUpdate` →
`youtube-write-gateway.applyVideoDetailsUpdate` (`videos.update`, `part: snippet`). A new service in the publishing module,
`src/lib/publishing/package-metadata.ts` (publishing already composes `video-details` for the veto's date removal), builds the
patch from the package and calls it. (A separate feature module was considered. It would have to re-scan packages that only
publishing owns, so it was rejected.)

**What is written.** Only `title`, `description` and `tags`, only the fields whose manifest value differs from YouTube's current one,
always as the package's current manifest states them. The patch is never free text from a caller. The snippet is a full
read-merge-write: `categoryId` and `defaultLanguage` are sent back exactly as read just before the write, and so is
`defaultAudioLanguage`, except `zxx` ("Not applicable"), which YouTube rejected when echoed (RISK-102) and which stays out as
today. The write never touches `localizations`, `status` (privacy, `publishAt`), recording details or paid placement.

**Three-way check (PROJECT_SPEC §30).** For each of the three fields the service compares (a) YouTube now, read fresh, (b) what this
video's upload sent (the finished upload row's frozen package, or the previous apply's audit), and (c) the manifest now:
- a = c → nothing to write for this field.
- a = b ≠ c → write c.
- a ≠ b and a ≠ c (someone changed it in Studio since) → `CONFLICT` for this field. It is not written unless the owner ticks «перезаписать»
  for that field on the preview.
The preview's `etag` goes into the apply as `expectedEtag`, so a change between preview and apply fails closed (`video_details_conflict`).

**Pipeline (AGENTS §G):** validation (the package exists on this computer, has a record with a video id, no blocking problem in its
texts) → refused while this computer has an upload row of that video that has not finished its read-back (`upload_steps_pending`,
like `thumbnail_step_pending`) → device mutation gate (operation lock, recovery mode) → read the video: it must exist (`not_found`
→ `video_missing`) and `snippet.channelId` must equal the channel (`video_not_in_channel`) → three-way diff → identity check
(`assertWriteChannel`, fails closed) → backup of the current snippet (`video_fields`, existing) → **Live writes immediately before
the gateway call** → `videos.update` → read-back: the patched fields as sent; and `categoryId`, `defaultLanguage`,
`defaultAudioLanguage`, `privacyStatus`, `publishAt` and the localization language set unchanged. The localization set is read by
publishing's own read port, because `video-details` never reads locales → audit (`source: package_metadata`, actor, manifest SHA-256,
fields) → local cache refreshed.

**Gaps closed in `video-details` (they benefit every caller):**
1. `applyPatch` calls `assertLiveWritesAuthorized()` before creating the client and before the fresh read. It moves to directly before
   `applyVideoDetailsUpdate` (order: client → read → refusal checks → Live writes → write), as in AC-TH-07.
2. The snapshot gains `channelId` (`snippet.channelId`, read only) so callers can check ownership.
3. A `verifyUnchanged` option: the read-back also compares the listed untouched fields with the pre-write read. B2 uses it, and other
   callers keep their current behaviour unless they opt in.

**Dry run.** `preview` does every read and check and returns the diff, conflicts and quota (1 read + 50 update + 1 read-back
+ 2 localization reads). It makes no backup and no YouTube write. Its only record is the local `DRY_RUN` audit row, as
`video-details` writes today.

**Thumbnail on the same screen.** When the manifest's default thumbnail file's SHA-256 differs from the one last set on the video
(the upload row's thumbnail step, or the latest `video_thumbnails` audit), the screen offers «Заменить обложку». This calls the
existing `video-thumbnails` owner surface with its own pipeline, as a separate call with its own result. Nothing about thumbnails is duplicated.

**Translations.** Not part of B2. Re-sending a re-package's translations to an already-uploaded video needs a new §F authorization
(§6 Q4). Until then the owner's existing Change Set / Batches path covers an uploaded video's translations.

**Who and when.**
- **Owner, Web UI** (stage 4): Media → «Видео на проверку» item of an uploaded package. The calendar/«Ролики и релизы» row links
  there. Owner session, active channel, remote allowed (like the Details card and ADR 0069 §6).
- **Producer** (proposed, stage 5, only on the owner's yes): `producer_video_metadata_update { channelId, video, dryRun? }` on the
  Producer endpoint only. It applies only the video's **current package** values (no free text) and refuses on any conflict (no
  override for the Producer). It has the same pipeline and the device gate (AC-TH-15 precedent). Channel worker agents and the factory get no such tool.
- **Not automatic.** A re-package of an uploaded video is never applied to YouTube by itself. Safer default: the video may be public,
  a title change is visible to the audience at once, and an agent's re-package must not change a public title without a person
  seeing the diff. The screen shows the difference, and the owner clicks (or, if he says so, tells the Producer).

### 3.5 Factory contract (bundle 2.5.45)

The factory always writes `sha256` + `sizeBytes`, and only YouTube/YTM hard rejections make NOT READY. YTM's blocking list (§3.1)
must not be stricter than that. Any YTM-only check that the factory treats as a warning becomes a YTM warning. The table in §3.1
is the agreed list for the Operator. `factory_*` scan reads expose `warnings`.

## 4. AGENTS.md §F draft (for the owner's approval; to be added in stage 5)

> **Package metadata after upload (2026-11-16, owner, Telegram msgs 4566–4569, BL-265, ADR 0072):** `src/lib/publishing/` may write
> a video's default-language `snippet.title`, `snippet.description` and `snippet.tags` -- only of a video that a release package of
> the channel already put on YouTube (its upload record names the video id), only the values that package's current manifest
> states (never free text), only through `src/lib/video-details/` as a full read-merge-write of `snippet` (`categoryId`,
> `defaultLanguage` and `defaultAudioLanguage` sent back exactly as read just before the write; `zxx` left out as today), with a
> three-way conflict check (YouTube now / what the upload sent / the manifest), identity check, backup of the current snippet,
> Live writes immediately before the call, read-back (the written fields, and the untouched snippet fields, privacy, `publishAt`
> and the localization languages unchanged), audit (`source: package_metadata`) and a dry run. Only on the owner's «Применить
> упаковку» in the Web UI [*if the owner agrees:* and the Producer's `producer_video_metadata_update`, its own endpoint only,
> refusing any conflict]; refused while this computer's upload of that video has not finished its read-back. Never
> `localizations`, `status`, `publishAt`, category or languages; never automatically from a new manifest. Channel worker agents and
> the factory get no such tool. The owner package review (BL-257) now gates the **media** only: an approval covers the mp4
> (`sha256` + `sizeBytes`, per channel and video code); packaging changes neither need nor reset it.

PROJECT_SPEC §21 gets the same paragraph (short). §F's existing «Owner package review» bullet is amended in the same change.

## 5. API versions

Read on dev `f3e637b2`: Factory **1.48.0**, Agent **4.20.0**, Producer **1.22.0**. BL-263 (parallel) takes Factory 1.49.0, Agent
4.21.0, Producer 1.23.0. BL-265 therefore takes **Factory 1.50.0, Agent 4.22.0, Producer 1.24.0** (all additive: `warnings` on scanned
packages and calendar items, review codes unchanged, wake-file kind `packaging_comment`, `media_changed` / `package_slot_changed`
upload error codes; Producer also `producer_video_metadata_update` if the owner says yes). If BL-263 merges later or drops a bump,
renumber at merge time.

## 6. Open questions for the owner

1. **Slot approval still names the manifest (ADR 0062).** With B alone, a metadata-only re-package after the slot was approved
   still uploads (private) but the **date** waits for one slot re-approval, and cross-posts likewise. Recommendation: leave this to
   part A (week template), which replaces per-slot approval. Alternative: B also matches the `packaged` fingerprint by the media key.
2. **Date withheld when the thumbnail or translations step failed** (BL-224, owner msgs 3510/3511). This is an owner rule, not a
   review. Recommendation: keep it.
3. **Producer tool** `producer_video_metadata_update` (current package values only, no conflict override): yes or no?
4. **Translations of an already-uploaded video** from a re-package, through `shared-video-localizations` (a third caller, new §F
   bullet): authorize now, later, or keep Batches for it?
5. **«Вернуть»** stays for the media only; packaging gets «Комментарий к упаковке» (non-blocking, wakes the Producer). Agreed?
6. **Warnings list** (§3.1): chapters and test thumbnails become warnings; `same_title_on_channel` and the language baseline stay
   blocking. Agreed?
7. **Existing approvals**: carried over when their manifest is still on disk (recommended), otherwise one re-click. Or re-approve all?
8. **BL-263 recode** (V→S, same mp4): the approval follows the recode alias (recommended)?
9. **Owner upload-approval rows** also freeze the mp4 SHA-256 (one hash before the first byte, as automatic rows), so they can take
   a refreshed manifest. Agreed?

## 7. Stages (one branch `feature/bl-265-media-gate`, one merge)

0. **Plan + ADR 0072** (this commit).
1. **Media gate.** `package-reviews` model/services/schemas (media key, legacy upgrade, recode alias hook, `packaging_comment`, no
   thumbnail precondition); sync contract fields; gate port in `owner-review-gate.ts`; scan and runner use it; `warnings` split in
   `packageProblems` / `ScannedPackage`; calendar/factory/agent reads expose `warnings`.
2. **Runner refresh.** §3.2 and §3.3 (re-read once, wait/fail rules, conditional update, audits, `media_changed`,
   `package_slot_changed`); `upload-approval` freezes `videoSha256` on all rows.
3. **Review screen.** Approve/return = media; «Комментарий к упаковке»; uploaded items with «Упаковка отличается от YouTube»; the
   Producer wake kind; texts in every UI language (AGENTS §H).
4. **B2 owner apply.** `video-details` gaps (Live-writes order, `channelId`, `verifyUnchanged`); `publishing/package-metadata.ts`
   (preview/apply, three-way diff, refusals); owner routes; UI with per-field conflict override; thumbnail button wired to
   `video-thumbnails`.
5. **Agents + docs.** Producer tool only if Q3 = yes; API bumps (§5); AGENTS §F, PROJECT_SPEC §21, SYSTEM_MAP, ARCHITECTURE,
   `docs/interfaces.md`, TECHNICAL_DEBT (RISK-154 amended: an approval no longer covers the thumbnail); ADR 0072 → Accepted;
   independent review before the merge request.

## 8. Acceptance criteria (written before the code, from the requirement)

Gate (B1):
- **AC-MG-01** Approving package P (video `V7`, `sha256` S, `sizeBytes` N) makes it ready. A re-package P′ with the same `video`, S and N
  but a different title, description, tags, translations, crossPost or thumbnail file is **still ready**, with no new decision.
- **AC-MG-02** A re-package with a different `sha256` (or a different `sizeBytes`) → `owner_review_pending`; the earlier approval does
  not count for it.
- **AC-MG-03** A manifest without `sha256` is never approvable (`package_review_no_sha256`), and with the gate on it is never ready.
- **AC-MG-04** Approval is refused when this computer's mp4 does not hash to `sha256` or is not `sizeBytes` long.
- **AC-MG-05** Approval no longer needs a thumbnail file. A missing thumbnail is still the scan's blocking `thumbnail_missing`, and it
  is not a review problem.
- **AC-MG-06** A return of media key K → `owner_review_returned` with its comment. A later package with a different `sha256` →
  pending (not returned). A later approval of K → ready.
- **AC-MG-07** `packaging_comment` requires a comment and never changes any package's gate state (before = after for every item),
  on approved, pending and uploaded items alike. It produces exactly one Producer wake file.
- **AC-MG-08** An approval for `V7` with sha S does not approve a package `V9` with the same sha S (exact code match), unless
  `V9` is the BL-263 recode alias of `V7` (after BL-263).
- **AC-MG-09** Legacy decision (no `videoSha256`) for manifest M still on disk → it counts for M's media key, so a re-package of M with the
  same mp4 stays approved. A legacy decision whose manifest is gone counts for nothing.
- **AC-MG-10** An unreadable review document → every package pending (fail closed, as AC-PR-07). A channel without the gate scans
  exactly as before.
- **AC-MG-11** A decision written by this build keeps `manifestSha256`. A reader with BL-257's rules (simulated) sees it as an
  approval of that manifest only, and ignores a `packaging_comment`.
- **AC-MG-12** Only the owner's Web UI decides (boundaries test: no MCP/agent/factory path reaches `decide`).

Hard limits (B1):
- **AC-MG-13** `chapters_first_not_zero`, `chapters_too_few`, `chapter_too_short` and `test_thumbnail_*` appear in `warnings`, and the
  package is `ready`. Every other code in §3.1 keeps it `not_ready`. Hand-built fixtures cover a title of 101 characters, a
  description of 5001 bytes, tags of 501 characters, and a thumbnail of 2 097 153 bytes (blocking), against 100 / 5000 / 500 / 2 097 152 (accepted).

Queued upload (B1):
- **AC-MG-14** Row queued (frozen sha S), then a metadata-only re-package → the runner starts the upload with the **new** title,
  description and tags in the insert. The row's `manifestSha256` is the new one, `steps.repackaged` has one entry, and the audit has
  `publishing.upload_package_refreshed`.
- **AC-MG-15** Row queued, then a re-package with a different `sha256` → row `cancelled`, `media_changed`, and nothing sent to YouTube
  (no identity read, no `begin`). The new package is pending in review.
- **AC-MG-16** Row queued, then a re-package to another `slotId` → `cancelled`, `package_slot_changed`, nothing sent.
- **AC-MG-17** Row queued, then the new manifest has a blocking problem (e.g. title of 101 characters) → `fail(package_changed)`,
  nothing sent.
- **AC-MG-18** Row queued, then the manifest is unparseable → the row stays queued and is retried. After 10 minutes still unparseable →
  `fail(package_changed)`.
- **AC-MG-19** A row with a session (`uploading`) or later never takes a new manifest. Its insert, steps and read-back use the
  frozen package.
- **AC-MG-20** A row without a frozen `videoSha256` and a changed manifest → `fail(package_changed)` (today's behaviour).
- **AC-MG-21** A new owner-approval row whose manifest states `sha256` freezes it, and the runner refuses
  (`VIDEO_HASH_MISMATCH`) when the file differs.

Writer (B2):
- **AC-MG-22** Preview → every read and check; no backup and no `videos.update` (the gateway fake records zero writes). Returns the
  diff, any conflicts and 54 units.
- **AC-MG-23** Wrong channel identity (`assertWriteChannel` throws) → no write, error returned.
- **AC-MG-24** Live writes off → refused, and no `videos.update`. Adapter order test: client → read → Live writes → write.
- **AC-MG-25** The video does not exist (`videos.list` returns no item) → `video_missing`, no write. A video whose `snippet.channelId`
  differs → `video_not_in_channel`, no write.
- **AC-MG-26** Success: the body sent has `snippet.categoryId`, `defaultLanguage` and `defaultAudioLanguage` equal to the values read just
  before (fixture: `categoryId "10"`, `defaultLanguage "ja"`, `defaultAudioLanguage "ja"`), the new title/description/tags, no
  `localizations` part and no `status` part. Read-back: the written fields equal the sent ones, and the untouched fields, privacy,
  `publishAt` and the localization languages are unchanged → `verified: true`. Backup and the BACKUP/RESULT/VERIFICATION audit rows
  are present with `source: package_metadata`.
- **AC-MG-27** `defaultAudioLanguage` read as `zxx` → it is left out of the body (RISK-102), stated in the result.
- **AC-MG-28** Read-back shows an untouched field changed (e.g. `defaultLanguage`) → `verified: false` with the field, audited, and
  never reported as success.
- **AC-MG-29** Three-way conflict: YouTube's title differs from both the uploaded and the manifest title → the field is `CONFLICT` and
  not written without the owner's per-field override. The Producer surface (if built) refuses any conflict.
- **AC-MG-30** The etag changed between preview and apply → `video_details_conflict`, no write.
- **AC-MG-31** An active upload row of that video here whose read-back has not run → `upload_steps_pending`, no write.
- **AC-MG-32** Device handoff (operation lock) or recovery mode → refused before backup or write.
- **AC-MG-33** A field equal on YouTube and in the manifest is not in the patch. When all three are equal → nothing written,
  `changed: false`.
- **AC-MG-34** Owner routes need the owner session and the active channel. Agents and the factory have no metadata tool. The
  Producer tool exists only on the Producer endpoint, and only if Q3 = yes.

## 9. Risks

- **Approval covers less.** The owner no longer approves a thumbnail or texts before upload. This is by design (owner TG 2340), and
  packaging is fixed later. RISK-154 is amended: a forged decision in the synced folder still needs a matching mp4 hash.
- **Public title changes.** B2 can change a public video's title, which viewers see at once. Mitigations: the owner's click on a diff,
  the conflict check, backup and audit.
- **Media identity rests on the manifest's `sha256`.** Mitigation: the mp4 is hashed at approval and again before the first byte.
  `sizeBytes` is compared too.
- **Mixed builds.** An older build reading new decisions is stricter (manifest-keyed). An older build's runner still fails a queued
  row on re-package. The upload computer is the Mac (ADR 0046 §8). Both computers update together.
- **BL-263 overlap.** Both branches touch `src/lib/publishing/packages.ts` (`parseReleasePackage`, the code regex),
  `package-scan.ts`, `publishing/index.ts`, `release-folder-rename.ts`, `sync-gateway/publishing-uploads/contracts.ts`, the three API
  version constants, `docs/decisions/README.md` and `docs/roadmap/BACKLOG.md`. BL-263's recode rewrites upload rows' manifest SHA-256 and the manifest's `video`.
  The media key must use the `video` string as-is and support its recode alias. Merge BL-263 first, then rebase this branch and
  renumber the API versions.
- **Quota.** One apply costs about 54 units (1 + 50 + 1 + 2 localization reads, plus read-back retries).
