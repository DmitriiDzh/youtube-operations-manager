> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 42. Re-checks of rated tracks: a fixed version, or a question about one spot (BL-173, FO-REQ-0017)

Plan: `docs/roadmap/plans/PLAN_RECHECKS_PLAN.md` (AC-RC-01..13). Schema v82, Factory API 1.11.0, plans report version 4. Part of the
generation plans module (`src/lib/generation-plans/`); extends §29 and §33.

- **Record.** A re-check is a row of `generation_plan_rechecks` (PK plan, recheck id), never a result row: a result row is keyed by
  (plan, stage, item, attempt) and a repeat replaces every column, so a revised file reported there would overwrite the original's
  checks (or, under a new attempt ref, count as an unlinked new attempt). It keeps the verdict it was opened on (`previousVerdict`),
  its own file, markers, checks and metrics, a status (open | answered | withdrawn) and the answer that closed it.
- **Opening** (`requestRecheck`, under the plan lock): the attempt must have a verdict at the review stage -- the owner's, a relayed
  one, or one from another computer not yet applied (`pendingPeerVerdicts`); one open re-check per attempt; a revision names a file
  that `files.sentFileExists` finds in the channel's Sent to YTM and whose type the player serves (`auditionContentType`, the list the
  audition route uses). The same id and content again is a retry; other content is `plan_recheck_exists`.
- **Answers** (`takeRecheckAnswer`, shared by the owner's answer and the peer path). A verdict answer seeds the history (§33), replaces
  the review-stage row unless the stored owner verdict is newer or the re-check was withdrawn, and adds a history row with `recheckId`.
  A kept answer (question only) adds a history row with `kept` and the note; `result` repeats the stored verdict, it never touches the
  row. The derived events skip kept rows (`planEvents`); `historyEntryOfVerdict` never picks one. An open re-check closes with the first
  answer (`closeRecheck` is a compare-and-set on `open`) and records `recheck_answered`. A later verdict answer that wins the row on an
  answered re-check (from the other computer) replaces its answer (`replaceRecheckAnswer`, `recheck_answered { replaced: true }`);
  a late answer to a re-check that a later re-check of the same attempt replaced is history only (`peer_verdict { superseded: true }`).
  The revision row's stage id is `~recheck` (never a plan stage id); a failed `fail` check makes it `rejected`.
  `group_reviewed` fires only when the answer wrote the attempt's first review row (a re-check opened on a verdict still on its way
  from another computer); otherwise the attempt was already reviewed and no wave's waiting count moves.
- **Current file.** `currentFilesOf`: per attempt, the file of its newest revision answered "accepted" (not kept). `resolveAudition`
  plays it; `getPlan` reports it per re-check (else the latest reported file); the queue entry and the shared report carry it
  (`currentFile`), and the screen then measures the loudness instead of taking the original's. A plan move checks the files that can
  still play (open re-checks, accepted revisions).
- **Counts.** `planProgress(…, rechecks)` adds `rechecksOpen` and per-wave `counts.rechecks`; the waiting rule (`reviewCandidates`),
  the notices, the badge and the channel summary are untouched.
- **Two computers.** The owning device shares its open re-checks (with the row the entry shows: the revision's, or the accepted
  revision a question plays). Another computer answers through `recordPeerRecheckAnswer` (only a re-check open in that report, once
  from here); the answer travels as a peer verdict with `recheckId` / `kept`. `applyPeerVerdicts` takes it through `takeRecheckAnswer`
  exactly once (`peer_verdict` event with `verdictId`), also when the re-check was answered (newest verdict wins, both kept in the
  history) or withdrawn meanwhile (history only). Until then `pendingRecheckAnswers` shows the re-check answered there, and
  `pendingPeerVerdicts` ignores re-check answers (they are not verdicts on a waiting track).
- **Screen.** `plan-review-screen.tsx` walks either the queue or the open re-checks (`RECHECKS_WAVE`). A revision plays the fixed file
  (`…/recheck-audition`) with the attempt's own file as A/B "Before", loudness from the revision's metrics (else measured, never the
  original's); a question opens at its first marker and offers "Keep the verdict" (K). Peer entries are built in the browser
  (`peerRecheckEntries`) from the version 4 report.
- **Limits.** The report's review list holds 500 entries; the attempts of open re-checks are always among them. Both computers must
  run report version 4 (RISK-119).

## 44. Review of generated images and video: one of N, pins, reason chips (BL-175, FO-REQ-0018 §A-§D)

Plan: `docs/roadmap/plans/VISUAL_REVIEW_PLAN.md`; reply to the Operator: DEV-RESP-0021. Phase 1 only (wipe, difference, visual
re-checks and the seam view are phase 2; Gemini outputs without copying, owner time and the phone mode are phase 3).

- **A pick is not a verdict.** `generation_plan_picks` (schema v84, on the plan's computer) holds one record per plan, item, kind
  (`pick` / `none_fits`) and attempt; withdrawing clears `active` and keeps the time, so "newer wins" also holds against a
  withdrawal that came from the other computer. The rules are pure (`src/lib/generation-plans/picks.ts`, `applyPickAction`) and
  serve the owner's own actions, the other computer's actions on the tick, and both pending overlays. A pick writes no result row
  and no verdict history; events `owner_pick` / `owner_unpick` / `owner_none_fits` (and `peer_pick` for an action weighed from
  the other computer) are recorded. An attempt is never both picked and rejected: a rejection withdraws the pick (also one that
  arrives later from the other computer, or a `rejected` or `failed` row the factory relays at the review stage), a pick on an
  attempt with such a verdict is refused (`forbidsPick`: `rejected` or `failed`, on the server and the screen alike), and a pick
  whose attempt has one on its way from the other computer takes no place when pending picks are weighed (the tick applies
  verdicts first). A pick stands only on an attempt in the owner's queue that is counted (`pickableRefs`: an in-app attempt
  whose job did not fail, was not interrupted or cancelled, or one reported by an external stage); a report row or a plan change (the factory's `factory_plan_update` or the owner's Web
  `review-rejected` switch, both under the plan's lock) that takes a picked attempt out of the owner's queue withdraws its pick
  (`left_queue`: a failed row of the stage right before the review, a rejected one while the plan does not show rejected
  attempts -- or one that cannot be played --, `reviewRejected` switched off, a stage removed; a row of an earlier stage does
  not -- only the stage right before the review decides the queue, `reviewCandidates`). A pick that may no longer stand never
  takes a place when another is picked.
- **Counting.** `entryWaits` is the one "waits for the owner" rule (queue, counts, badge, screen). An item is decided at its pick
  target (`pickTargetOf`); its attempts without a verdict are `notChosen` (neither accepted, pending nor rejected). Attempts that
  only external stages report now count in `attempts`, `accepted` and `missing`; the Mac's two music plans had none, so their
  numbers did not change (`picks.test.ts` AC-VR-07 pins the old rules with fixed values). A picked attempt that only external
  stages report stays accepted and usable when a stage after the review fails it, like a picked attempt of the app's own (its
  job is done); a pick never revives an in-app attempt whose job failed.
- **Two computers.** Plans report v5: marker `region`s, `reviewReasons`, items' `pickTarget`, active `picks` / `noneFits`,
  entries' `picked` / `notChosen`, `handledPicks`, and the top-level `picks` this computer sent. A v4 build refuses v5. A pick on
  another computer's plan is refused (`peer_update_required`) while that computer's report is below v5. The owner's own pick
  action first weighs the pick actions still on their way from the other computer (`weighPeerPicks`, as the tick does), so what
  those move is stored before the owner's action is weighed. A "none fits" sent from the other computer carries `covered` (the
  attempts its owner saw there); here it covers those plus the item's attempts already settled that were in the owner's queue
  when it was given (`queuedAtOf`: its job finished, or the row of the stage right before the review, or its review row -- the
  earliest; a re-report replaces a row and its time, so such an attempt counts as entering again and waits), so an attempt that
  still waits and was not seen -- or entered the queue later -- stays out (the report keeps 500 entries and cuts settled ones
  first). Whole seconds are compared (the store keeps those): an attempt that entered the queue in the same second as the
  action waits. Known limits: the action's time is the other computer's clock (RISK-119); an attempt shown again because `reviewRejected` was switched on after the action has no time of its own and is
  covered when its row is older. The same "none fits" weighed twice
  (its `peer_pick` event fell out of the newest 5000 events) is `unchanged`.
- **Phase 2 (§E–§F, screen only).** Compare views «Рядом · Шторка · Разница» (`CompareView`): the image viewer and the video
  player take an `overlay` -- the second side drawn in the same frame and view (the clip follows the first one's moment, play and
  speed, corrected past half a frame), cut by a line the owner drags (`wipeClip`) or blended with `difference`; proportions that
  differ by more than 1 % are named. The second side may be another attempt, a picture/clip reference (`referencesFor(..,
  "visual")`), or «Было» of a revision re-check (`against`, first on the left; the layer then opens compare only). A question
  re-check about a clip opens paused at its earliest marker (`questionStart`). `FeedPreview` («Как в ленте», `FEED_SIZES`) and
  `SeamFrames` live in `visual-review-tools.tsx`; the seam window (`seamJump`) and «×5» (`isWrap`, `playTimes`) are in the video
  player. No server, schema, report or Factory API change.
- **Phase 3 (§G).** *Gemini outputs in place:* `resolveExchangeFile` (shared `workspace-exchange`) reads `From YTM/<subdir>/
  <jobId>/<file>` for the caller's allowed folders with `resolveFromYtmJobFile`'s proofs, else a Sent to YTM path; the plans pass
  `PLAN_JOB_OUTPUT_SUBDIRS = ["gemini"]` (a contract string -- the plans never import the Gemini module). Every plan file route,
  the revision check and the plan move use it. *Owner review time:* the screen counts seconds per attempt while the tab is
  visible and the owner is there (`countsReviewTime`: an input within 5 min, or sound playing -- the track or the A/B reference; a looping clip does not count) and sends `reviewSeconds` with a
  verdict, an answer, a pick or "none fits" (a pick sums the item's attempts); stored in `generation_plan_verdict_history`
  (→ `owner_verdict`), in event details, and from the other computer through `SharedVerdict` / `SharedPickAction` and the peer
  tables (`review_seconds`, schema v85 -- its own migration, so a database stamped v84 by an earlier build gets it too).
- **Previews** (`src/lib/media-preview/`, a shared module that knows nothing about plans): `sharp` (a direct dependency since
  BL-175; Next.js already installed it) resizes an image to at most 480 px a side, `limitInputPixels` guards against decompression
  bombs, a 300-entry memory cache is keyed by path, size and mtime; any failure streams the original. The `…/preview` routes
  resolve and prove the file exactly as the audition route does (loopback, session, active channel, workspace proof) and answer
  415 for anything that is not an image.
- **Screen.** The media kind (`mediaKindOf`, by the played file's extension) picks the viewer before `MediaReviewPlayer` would
  decode a picture as audio. New components: `media-image-viewer.tsx`, `media-video-player.tsx`, `visual-review-layer.tsx`
  (grid / loupe / compare), pure helpers in `visual-review-model.ts` (pin geometry, view state shared for linked zoom, frames,
  chips, keys). The keys of pictures live in `visualKeyAction`; the music key map, chips and player are untouched.
- **Known limits.** The frame rate comes from the row's `metrics.fps`, else it is measured while the clip plays
  (`requestVideoFrameCallback`); Chrome does not load media in a hidden tab, so a clip shows only once its tab is visible.

## 48. Storyboards reviewed before video, and Media's tabs by kind (BL-184, ADR 0038, FO-REQ-0024)

Plan: `docs/roadmap/plans/STORYBOARD_PLAN.md`. Owner instructions 1178 (four tabs, a storyboard approved before video), 1183 (the
gate's scope), Telegram msgs 2739 (go), 2741/2743 (the layout: Music | Images | Storyboard | Video, plans and jobs inside them).

### 48.1 The storyboard (stage 1)

- **A feature module of its own, `src/lib/storyboards/`** (AGENTS.md §M; `boundaries.test.ts`: no other feature module, no Google
  client, no network). Store: the sync family `storyboards` (`sync-gateway/storyboards`, one Automerge document per channel, the
  twelfth family; genesis actor "storyboards-doc1"). A record holds `versions` (by number, assigned whole, never edited), `submissions`
  (by version), `decisions`, `comments` (by id, with `replies` by id), `picks` (by version, then segment) and the channel's `gate`
  setting. Appends use fresh ids as map keys, so the two computers' writes merge without conflicts; a comment's state and a pick are
  whole values (the last writer wins). Version numbers are counted locally, so two computers can both write "version N" before a
  sync and one body survives: each version carries `contentHash` (sha256 of its content), and a submission or a decision counts only
  while it names the surviving content's hash -- an approval never lands on content the owner did not see. `picks` and its version
  entry exist from a version's creation, so first picks from both computers merge.
- **Content rules** (`services.ts checkContent`): unique ids; the segments are exactly the chain of neighbouring keyframes (and the
  last back to the first with `loop`), stored in chain order; a prop cell names a keyframe of the version; a parent is another
  keyframe. Keyframe files are paths relative to the channel's `99 Data Exchange/` (`Sent to YTM/...`, or a Gemini / GPU job's own
  `From YTM/<gemini|media>/<jobId>/...`), still images only, resolved by the workspace-exchange rules; the sha256 and size are frozen in
  the version. A content change (a file's bytes included) makes the next version; the same content is no new version.
- **State is derived** (`model.ts`): draft until the Operator submits the latest version; then the owner's newest decision on that
  version (approved / changes requested) or in review. A decision names the version on the owner's screen and is refused unless it is
  the latest and submitted (`storyboard_version_not_latest`, `storyboard_not_submitted`). A new version is a draft until submitted --
  this corrects DEV-RESP-0029 ("back in review by itself").
- **Factory API 1.16.0:** `factory_storyboard_create/update/submit/reply` (writes, device mutation gate first) and `_get/_list`. The
  owner's actions are Web only: `/api/channels/[id]/storyboards/...` (list, detail with this computer's copy of each keyframe and the
  diff to the version before, the keyframe image, comments, replies, open/resolved, decisions), all on the active channel.
- **Screen:** Media → «Раскадровка». The filmstrip K0 → [S1] → K1 … → ↺K0; a keyframe large (zoom, pins by Shift + drag) and against a
  neighbour or its parent (side by side / wipe / difference); a segment's card; the prop table with a cell lit where it differs from the
  keyframe before; comments on the storyboard, a keyframe, a segment or a prop cell, with threads; the version switcher with "changed
  since"; «Запросить изменения» / «Одобрить эту версию» through `ConfirmDialog`. Notices: `GET /api/storyboard-alerts` -- the active
  channel's storyboards in review on the Media badge, the other channels' in the bell.

### 48.2 The gate (stage 2)

- **Rule** (`storyboards/gate.ts`, FO-REQ-0024 B4, owner 1183): a video job whose first and last frames are two different images (by
  sha256) is refused with `storyboard_not_approved` unless it names `storyboardId` + `segmentId` of the approved latest version and the
  segment's from / to keyframes are exactly those frames. A job that names a segment is always checked. Without a link, the refusal
  applies only while the channel's setting is on (`gate.requireApproved` in the synced document; absent = on; Media → «Раскадровка»,
  turning it off asks first). One image (a first frame only, or the same file twice) is never gated. A gate that cannot read the
  document refuses nothing silently: the error propagates and no job is created.
- **Where it runs.** The port is injected into `gemini-media` and `media-generation` in their `index.ts` (they know only the port).
  Gemini: right after `readInputs` (the frames' sha256 as read), before the estimate, the limits and any charge; a dry-run reports
  the refusal; the link is part of the request hash only when given. GPU jobs: a template's image parameters may carry `role:
  first_frame | last_frame` (the Operator sets it in the registry; only on an image input, each role once; an untagged template is not
  seen as first/last-frame); the two files are hashed on this computer before any upload to the volume. Plan runs pass an item's
  `storyboard` to every job they create.
- **Record.** A job let through with a link stores `storyboard_id`, `storyboard_version`, `segment_id` (schema v90, nullable columns
  on `media_jobs` and `gemini_media_jobs`) and shows `storyboard`.

### 48.3 The video and the tabs (stage 3)

- **Local files** (the keyframe image, a take's video) are sent only to a loopback request (ADR 0029 decision 5), as plan auditions.
  A GPU job's uploaded frame must hash as the gate saw it; a frame overwritten in between fails the job before ComfyUI.
- **Takes** (`/storyboards/[id]/takes`, composed in the route layer from both video modules' `listJobsByStoryboard`): each linked job
  with its state and whether this computer has its video; `takes/[source]/[jobId]` streams it with Range, only from that job's own
  folder (`resolveFromYtmJobFile`); `picks` stores the owner's take per segment of a version (only a take of that segment and version).
  Screen «Видео»: each segment's takes between its keyframes, «Выбрать», the joints with `SeamFrames` (the last frame of segment n
  against the first of n + 1, and the loop's closure), and the whole video -- the picked takes played one after another in one player.
- **Shared Range streaming** moved to `src/lib/local-file-response/` (the plan audition route uses it too).
- **Media's tabs** (`section-tabs.ts MEDIA_TABS`): «Музыка» (audio) | «Изображения» (image) | «Раскадровка» | «Видео» (video). One plans
  list and one job log, filtered by the tab's kind: a template's kind comes from its save nodes (`templateMediaKind`: video before audio
  before image; parsed once per template version), a plan's from its results' files and its items' templates (`progress.mediaKinds`,
  carried in the plans report's loose `progress`); a plan or job of unknown kind shows under every tab. Badges per tab: tracks waiting
  by kind, storyboards in review. `/media` and the former `/media/plans`, `/media/jobs` lead to «Музыка»; a plan's review keeps its
  address and returns to the tab it was opened from (`?from=`). «Видео» lists the approved storyboards, each opening on its video.

### 48.4 Takes on every computer and the final file (BL-189, FO-REQ-0025, `docs/roadmap/plans/STORYBOARD_TAKES_PLAN.md`)

- **Takes from every computer.** The take lister moved from the route layer to a composition module, `src/lib/storyboard-takes/`
  (it reads `media-generation`, `gemini-media` and `media-jobs-pool`; no feature module imports it -- the storyboard routes and the
  Factory route do). It adds the other computers' jobs whose `storyboard` link names the storyboard, from their `media-jobs` reports
  (BL-188): a RunPod job is a `media` take, a Gemini job a `gemini` take, each with the computer that ran it. A peer's video is used
  only when its output path is a video inside that job's own `From YTM/<subdir>/<jobId>/` folder (`jobOutputPathOf`), and is played
  from THIS computer's copy (`resolveExchangeFile`); without a copy the card says «Сделан на <computer>; файла на этом компьютере
  пока нет» (`takeState` "elsewhere"). Picks of a peer's take pass the same `isTake` check; picks were already synced.
- **The final file (renders).** `StoryboardRecord.renders` (by id, assigned whole) and `renderDecisions` (by id); both maps are made
  by `create` (a storyboard from before BL-189 gets them with its first render; when two computers each made them before a sync,
  `read` unions every concurrent map via `Automerge.getConflicts`, so no render or verdict is lost). A render counts for the content
  it was attached to (`contentHash`, like a version decision): the screen shows it under that version body only and a verdict on a
  render of a body that lost a concurrent edit is refused (`storyboard_render_not_found`, reason `other_version_content`). `factory_storyboard_attach_render`
  (Factory API 1.18.0) accepts only the approved latest version, a video in the exchange folders (sha256 frozen) and picks that are
  takes of their segment and version on any computer (the Factory route passes `isTake` from `storyboard-takes`). A render's state
  is the owner's newest verdict (`in_review` without one). Owner routes: `renders/[renderId]` (this computer's copy: ok, missing,
  differs), `renders/[renderId]/file` (Range, loopback only), `renders/[renderId]/decision` (POST `{ kind, note? }`; the id comes
  from the address). Screen: «Ролик целиком» lists the version's renders (player or location, takes, notes, verdict buttons), then
  the in-browser preview from the picks.
- **List cards** show the version as a `v{n}` chip after the title (FO-REQ-0025 C).

### 48.5 Not built yet

- `storyboardId` / `segmentId` on `factory_plan_report` rows: the linked jobs cover acceptance step 5, and a file rendered outside the
  app is attached as a render (BL-189); still a follow-up item if wanted.
- Streaming a take or a render between computers (files come by the workspace sync), and a notice for a new render.
- Lineage beyond keyframes (A4: `sourceRef` on a plan result, "made from" for scene images): only a keyframe's parent compare is built.
- Blind A/B (A5), storyboard drafts by the Producer, and an Agent / Producer API read of storyboards.

## BL-229 — the music library per genre (part A, ADR 0054)

On branch `feature/bl-229-music-library`. No schema change; no YouTube call; nothing written.

- **Source.** One factory snapshot per channel, `<workspace>/99 Data Exchange/Sent to YTM/music/library.json`. The adapter
  (`music-library/adapters/files.ts`) validates the workspace, `lstat`s the path (nothing there = `no_file`), then resolves it with
  `workspace-exchange.resolveWorkspaceFile` (real file strictly inside the workspace, a regular file; any refusal = `unreadable`),
  refuses a file over 5 MB unread, and reads it as text. The channel in the request only picks its own workspace.
- **Format** (`music-library/schemas.ts`, a proposal until the factory answers DEV-RESP-0043 Q7/Q8): `format: 1`, `generatedAt`,
  `genres[{id, title, label?, color? #rrggbb, playlist?, status active|stub, batches, tracks, seconds, neverUsedSeconds,
  daysLeft?}]`, `batches[{batch, genre id|null, playlist?, briefVersion?, tracks, date?, source?, reviewed?, accepted?}]`,
  `tracksWithoutGenre`. Unknown fields are stripped; a wrong required field, a duplicate genre, a batch naming an unlisted genre or
  `accepted > reviewed` or `accepted` without `reviewed` makes the whole file unreadable (an optional text may be null = not given) with the first issue as the reason.
- **View** (`services.ts`, pure): hours = `round(seconds / 360) / 10`; acceptance = `round(accepted / reviewed × 100)`, null when
  reviewed is 0 or absent; stale when strictly older than 24 h; batches grouped under their genre, genre-less batches under the
  "without a genre" group, which exists only when `tracksWithoutGenre > 0`.
- **Route / UI.** `GET /api/channels/[channelId]/music-library` (session + active channel) returns the 5-state result as is;
  `MusicLibraryCard` (Media → Music, above the plans, inside a `FeatureErrorBoundary`) polls it once a minute.

### BL-229 part B — the batch review inside the plan review (ADR 0054 amendment 1)

- **Definition.** `PlanDefinition.reviewForm` and `PlanGroup.genre` / `.reviewForm` live in the plan's `definition_json` (no column).
  `schemas.ts`: `reviewFieldSchema`, `reviewFormSchema`, `genreSchema` are plain `z.object` (unknown keys stripped); the wave
  (`groupSchema`) and plan schemas stay strict. `validateDefinition` refuses a field id used twice across the plan's form plus one
  wave's (`duplicateFieldIds`). `normalizeGroup` keeps absent = unchanged on an upsert, null = cleared. `cloneGroup` copies `genre`, `reviewForm` and
  `reviewReasons` to the new wave.
- **Answers.** `review-forms.ts` (pure): `effectiveFields(plan, groupId)` = plan fields then the wave's; `checkAnswers` refuses with
  `plan_answer_*` (unknown id, wrong type, out of range, unknown option, then required missing) and returns the answers in the form's
  order; `keepFittingAnswers` drops, on applying a peer verdict, answers whose field no longer fits (the verdict is kept). The owner
  verdict checks against this device's definition, a peer verdict against the owning device's report.
- **Storage / events / sync.** Schema v112 adds `answers_json` to `generation_plan_results`, `generation_plan_verdict_history` and
  `generation_plan_peer_verdicts` (the store adapter maps empty to null). `planEvents` adds `answers` to `owner_verdict`. Plans report
  version 6 (`sync-gateway/generation-plans/contracts.ts`) carries the forms, the genre and `answers` on verdict rows, history
  entries and sent verdicts; reads 1-6, strict at every level. `generationPlansReportVersionFor` writes 6 only when the report holds
  such content, else 5 (the old build keeps reading it). The screen prefills the form of a rated attempt with its saved answers
  (`savedAnswersOf` / `withSavedAnswers`, applied in `draftOpenedFor` on every draft reset, and to the "sent, waiting" verdicts of
  a peer plan; rating and chips unchanged). A re-check answer keeps the stored verdict's answers on the current row
  (`takeRecheckAnswer`); its history row has none. `errors.plan_answer_*` give the screen a text per refusal code.
- **Screen.** `genre-review-model.ts` (pure): `reasonRowsFor` (two rows only for a genre wave, else `reasonChipsFor`),
  `formSectionsFor`, `missingRequired`, `toggleAnswer`, `answersToSend`, `safeGenreColor` / `genreTintStyle` (`--genre-color`).
  `plan-review-screen.tsx` renders `GenreHeader`, the tint, the chip rows and `ReviewFormSection`; `submit` refuses locally while a
  required answer is missing (the A / R keys too). `generation-plans-panel.tsx` shows `GenreBadges`.

## BL-236 — speech in designed channel voices (ADR 0057)

- **Flow (Gemini):** `factory_speech_create_job { provider: gemini }` → `src/composition/speech.ts` → `gemini-media.createSpeechJob`
  (lock; replay by requestId; `checkSpeechJobRules`; switch / key; the voice resolved through the injected `GeminiVoiceResolver` →
  `voice-registry`; estimate `estimateSpeechUsd` at now; USD limits) → row `kind: speech`, `queued` → worker `runSpeech` (claim CAS →
  `gemini-api.generateSpeech` with the voice's provider id and style → `shared-audio.audioFileOf` → `take-1.wav` → asset
  `generated_audio` → manifest last) → `done` with `speechCostFromUsage` (never below `speechCostFloor` of the file).
- **Flow (ElevenLabs):** the same surface → `elevenlabs-speech.createJob` (character limits per job / day / month + active jobs on this
  computer) → its worker → `elevenlabs-api.textToSpeech` (binary answer, `character-cost` header) → `take-1.mp3` (or `.wav` for
  `pcm_*`) → manifest last → `done`, cost = charged characters × list price.
- **Voices:** `factory_voice_design` → `voice-registry.design` (name check first) → provider port `design` (each paid call recorded as
  a `voice_design` job by the provider module) → preview files → draft row. The owner's pick (Web `POST …/voices/[voiceId]/approve`,
  or `factory_voice_pick`) → provider port `save` (ElevenLabs `POST /v1/text-to-voice`; Gemini: the preview's id) → `approved`.
- **Boundaries:** the registry imports no provider; the providers import only the registry's resolver; `composition/speech.ts` is the
  only place that knows both; generation-plans and the jobs pool know the `elevenlabs` folder as a contract string only.
- **The monthly limit is the account's (BL-250, ADR 0057 amendment 1):** `elevenlabs-speech/services.ts` stores the subscription
  read (`characterLimit`, `characterCount`, `nextResetAt`, `readAt`, key fingerprint) in the app setting `elevenlabs_account_snapshot`
  and checks the month against it (count + this computer's jobs since the read; past the reset, jobs since the reset); the owner's
  `maxCharsPerMonth` only while none is stored for the key. Reads: start / after the reset (`accountTick` in the share loop, switch on),
  before a take when older than 10 min (outside the create lock), key save / check, the owner's «Обновить».
- **Shared ElevenLabs limits and spend (owner msg 3823):** `elevenlabs-speech/settings-sync.ts` (the Gemini rules on the sync-gateway
  `elevenlabs-settings` document) applies the four character limits on the share loop (`instrumentation.ts`, 30 s) and publishes an
  owner's change on save; `spend-share.ts` writes this computer's `elevenlabs-spend` report; `account.ts` sums the peers with the same
  key fingerprint; `createJob` / `designVoice` check day and month against that sum (`usage().account`).
- **Limitations:** ElevenLabs takes are outside the shared jobs report (RISK-142); provider fields unverified
  (RISK-143); Gemini designed voices expire / are capped (RISK-144).

## BL-241 — clips for review (ADR 0061)

- **Module:** `src/lib/clip-reviews/` -- `contracts.ts` (ports, limits, views), `schemas.ts` (strict inputs; the owner's decision
  schema needs a comment for a return), `model.ts` (pure: the deciding record, sort, video type, duration window), `services.ts`
  (the Producer surface `submit/withdraw/list/get`, the owner surface `ownerList/decide/clipFile`), `adapters/files.ts` (the shared
  `resolveWorkspaceFile`, `ffmpeg-host` probe, SHA-256 cached by path + size + mtime), `index.ts` (production wiring, one lock per
  process).
- **Store:** sync family `clip_reviews` (`sync-gateway/clip-reviews`, `-sync`): one Automerge document per channel, fixed genesis
  actor, flat maps `clips` (written once) and `decisions` (fresh ids). The status is derived on read: the earliest owner decision
  (time, then id), else the earliest Producer withdrawal, else pending -- so concurrent offline answers merge to one result.
- **Checks:** submit -- mutation gate, channel connected here, workspace set, extension, the real path inside the workspace, 5–300 s
  (±0.5), range within the clip, duplicate pending path, 50 pending. Decide -- the clip pending here; approve also needs this
  computer's file to match the stored size and SHA-256. The video route re-resolves the path and streams with
  `local-file-response` to loopback requests only.
- **Surfaces:** Producer API 1.15.0 (`session-deps.ts` wires `createClipReviewsProducerCore`); owner routes under
  `/api/channels/[channelId]/clip-reviews` (the only callers of `createClipReviewsOwnerCore`, pinned by a source scan). The owner's screen is Media → «Клипы»
  (`MEDIA_TABS`, mounted by `production-panel.tsx` in its own error boundary, badge from `clip-reviews-badge.ts`); it moved from
  Content on 2026-11-04 (owner msg 4025), and `/content/clips` redirects there.
- **Attachments (BL-246, ADR 0065, plan items 10-17):** `attachments.ts` (pure, shared with the panel: limits, kinds by extension /
  declared type / first bytes, name sanitizing and case-insensitive de-duplication), `adapters/attachments.ts` (staging in
  `clipReviewUploadsDir` as `<id>.json` + `<id>.part`, swept after 24 h idle (the later of the two files) and, once at server start
  (`src/instrumentation.ts`, behind the device gate), also when the clip is no longer pending; the decision-folder writer: a fresh
  `From YTM/clip-reviews/<clipId>/<decisionId>/` through `workspace-exchange.resolveFromYtmFolder`, copy to a temporary name,
  re-hash, rename, the folder removed on any failure). Flow: `POST /[clipId]/uploads` → `PUT /uploads/[uploadId]?offset=` pieces of
  at most 4 MiB (the proxy buffers only 40 MB of a body and truncates silently, so no single-request upload) with the browser's
  SHA-256 checked at the last piece → `POST /decision { attachments: [uploadId] }`: everything re-checked, files written, then
  `addDecision` (on its failure the folder is removed). The record's optional `attachments` field is additive: the store copies the
  maps without a schema and `clipViewOf` reads `?? []`, so older builds ignore it. Serving: `GET /[clipId]/attachments/[decisionId]/
  [index]` (loopback) accepts the stored path only as exactly that decision folder plus one name, resolves it with
  `resolveFromYtmFolderFile` (plain folders, the real file strictly inside), checks size and SHA-256 (`hashClipFile` cache); text
  kinds go out as `text/plain`. Producer API 1.19.0.
- **Limitations:** RISK-149.

## BL-272 — master still images for review (ADR 0076)

- **Module:** `src/lib/image-reviews/` -- `contracts.ts` (ports, limits, views, the file kinds), `schemas.ts` (strict inputs; the owner's
  decision: `approve` takes no comment, `approve_with_note` and `return` need one), `model.ts` (pure: the deciding record through the
  shared rule, sort, file kind), `services.ts` (the Producer surface `submit/withdraw/list/get`, the owner surface `ownerList/
  ownerWaiting/decide/imageFile/previewFile`), `index.ts` (production wiring: one lock per process, `media-preview` for the header read and the 960 px
  preview, `review-notify` nudge, audit).
- **Shared:** `src/lib/review-items/` owns `earliestDecidingRecord` (ADR 0061 §5), the one image status rule (`images.ts`:
  `decidingImageRecord`, `imageReviewStateOf` -- image-reviews' views and the clips' source-image port both use it) and the workspace
  file adapter (`resolveReviewFile`, `hashReviewFile` with an LRU cache of 500, `lru.ts` -- moved from clip-reviews' `adapters/files.ts`,
  which now delegates and keeps its names). The owner kinds of an image
  (`IMAGE_REVIEW_OWNER_KINDS`, `IMAGE_REVIEW_APPROVED_KINDS`) are constants of the sync-gateway family's contract, so clip-reviews and the
  review-notify composition use the same lists without importing image-reviews.
- **Store:** sync family `image_reviews` (`sync-gateway/image-reviews`, `-sync`): the clip-reviews document shape with `images`;
  `run-all-families.ts`, `SyncFamily` / `SYNC_FAMILIES` in `db.ts` and the handoff panel list it.
- **Checks:** submit -- mutation gate, channel connected here; under the lock: a known `requestId` first (same request → the stored image,
  else `image_review_request_conflict`), workspace set, extension, the real path inside the workspace, ≤ 50 MiB, the header's format
  equals the extension's, 16–16384 px, duplicate pending path, 200 pending, 40 per batch. Decide -- pending here; both approvals need
  this computer's file to match the stored size and SHA-256. The owner's list checks this computer's copy only for a pending image
  (`file: null` for the rest); `ownerWaiting` (`GET …/image-reviews?view=count`, the tab's badge) reads the document only.
- **Clip link:** `ClipReviewClip.approvedImageId?` (additive); `ClipReviewsPorts.imageOf?` = `createClipSourceImageLookup(core)`
  (`clip-reviews/adapters/source-image.ts`, `review-items.imageReviewStateOf`), wired in `clip-reviews/index.ts` over
  `createImageReviewsCoreForProduction`; submit refuses a missing port, an unknown id or another channel's
  image (`clip_review_image_not_found`) and any status but the two approvals (`clip_review_image_not_approved`); views carry the key only
  when set (the BL-241 views are unchanged); the owner's list adds `approvedImage` (the still NOW: the clip card shows its status and
  highlights anything but the two approvals, `clip-reviews-model.sourceImageStateOf`; `null` = not in this computer's stills yet).
- **Surfaces:** Producer API 1.28.0 (`session-deps.ts` wires `createImageReviewsProducerCore`); owner routes under
  `/api/channels/[channelId]/image-reviews` (the only callers of `createImageReviewsOwnerCore`, source scan); files to
  `isOwnerBrowserRequest` (loopback or the proxy's remote owner gate, as the clips since BL-251 amendment 2). Screen: Media → «Кадры»
  (`MEDIA_TABS` value `stills`, before `clips`), own error boundary in `production-panel.tsx`. The full-size viewer is an in-page layer
  with `useDialogFocus` (no browser dialog); its keys are the pure `image-reviews-model.viewerKeyAction` (Esc cancels an open
  confirmation first; at 100 % the arrows scroll by ref, PageUp / PageDown switch stills).
- **Wake:** review-notify kind `image` (`composition/review-notify.ts` `imageNoticesOf`, source "images"). A deciding owner return
  with a later owner approval in the document (either arrival order) adds one notice per overridden approval: status `approval_overturned`, decision id
  `<approvalId>-overturned-by-<returnId>`, dated as the approval; the return's own notice carries an "Overturns" line.
