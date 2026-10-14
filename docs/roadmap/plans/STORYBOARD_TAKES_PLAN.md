# Storyboard takes on every computer, the attached final loop, version on the cards (FO-REQ-0025, BL-189)

- **Status:** BUILT on `feature/fo-req-0025-storyboard-takes` (from `dev` 5ee13a2), both stages; not merged. Owner go: Telegram
  msgs 2813/2814 (2026-10-14). As built: `docs/ARCHITECTURE.md` §48.4.
- **Request:** FO-REQ-0025 (Operator, 2026-10-14). Reply: DEV-RESP-0030.
- **Builds on:** BL-184 (`STORYBOARD_PLAN.md`, ADR 0038; storyboards sync family, picks) and BL-188 (`SHARED_MEDIA_JOBS_PLAN.md`;
  the per-device `media-jobs` report that already carries every job's `storyboard` link and its output paths).

## 1. Facts

- **Why Windows shows no takes.** The takes route (`storyboards/takes.ts`) lists only THIS computer's media and Gemini jobs
  (`listJobsByStoryboard` of each module). The jobs ran on the Mac, so the Windows list is empty.
- **The data is already on Windows.** Since BL-188 every computer publishes its jobs in the `media-jobs` report: status, label,
  `storyboard { storyboardId, versionNumber, segmentId }`, `outputs` relative to `99 Data Exchange/` (`From YTM/<media|gemini>/
  <jobId>/<file>`), error code only.
- **Picks already sync.** `StoryboardRecord.picks` lives in the storyboards Automerge document, and `factory_storyboard_get`
  returns it. A pick made on Windows was refused only because the pick check (`isTake`) found no such take there.
- **Files.** A job's output stays in the executing computer's copy of the channel workspace; the other computer has it only
  after the workspace sync brings it. The `bar_loop` takes are in Tropico `From YTM/media/<jobId>/` on the Mac's T9 disk.

## 2. Decisions

1. **Takes = this computer's linked jobs + the other computers' linked jobs from their `media-jobs` reports** (BL-188's
   transport, no new channel). A peer's RunPod job is a `media` take, a Gemini job a `gemini` take, as for own jobs. A take
   carries the computer that made it (`device`, null for this one).
2. **Playing a peer's take** uses this computer's own copy of the file (the report's output path, resolved by the
   workspace-exchange rules inside that job's own `From YTM/<subdir>/<jobId>/` folder). When the copy is not here yet, the card
   says where it is: «Сделан на {computer}; файла на этом компьютере пока нет». No streaming between computers (the server binds to
   127.0.0.1 and serves local files to this computer only; ADR 0029 decision 5).
3. **Picks from any computer.** The pick check accepts a peer's take of that version and segment. Picks stay in the storyboards
   document (synced), so `factory_storyboard_get` on the Mac returns a pick made on Windows (§3 step 2).
4. **The final loop is a render attached to a version** (B):
   - `factory_storyboard_attach_render({ channelId, storyboardId, versionNumber, file, picks?, notes? })`, WRITE, Factory API
     1.18.0. `file` is relative to `99 Data Exchange/` (`Sent to YTM/...` or a job's `From YTM/<media|gemini>/<jobId>/...`), a video
     (`.mp4`, `.mov`, `.m4v`, `.webm`); its sha256 and size are frozen.
   - Only the **approved latest version** takes a render (a render of an unapproved or older version is refused with
     `storyboard_not_approved`).
   - `picks` (`{ segmentId: { source: media | gemini, jobId } }`): every segment id must be a segment of that version and every job a
     take of exactly that segment and version, on any computer; omitted = the owner's current picks for that version are recorded.
   - Stored in the storyboards document under `renders` (a map by id, assigned whole); a second attach adds a new render, none is
     edited. `notes` <= 4000.
5. **The owner's verdict on a render** (Web UI, either computer): «Одобрить ролик» / «Запросить изменения» with an optional note,
   stored under `renderDecisions` (a map by id). A render's state is its newest decision: `in_review` (none), `approved`,
   `changes_requested`. `factory_storyboard_get` returns `renders` with their state and decisions.
6. **«Ролик целиком»** shows the attached renders of the version (newest first): the player (this computer's copy, or where it
   is), the takes it uses, the notes, the state, and the two buttons. The in-browser assembled preview from the picks stays below.
7. **Version on the cards (C):** a `v{n}` chip right after the title on the storyboard list and the «Видео» links.
8. **Module boundaries (AGENTS.md §M).** The storyboards module still imports no video module: the route layer's take lister
   moves to a composition module, `src/lib/storyboard-takes/`, which reads the two job modules and the jobs pool; the Factory
   route and the storyboard routes both use it for `isTake`.

## 3. Acceptance (FO-REQ-0025 §3, fixed before the code)

1. On Windows, `bar_loop` v3 lists S1–S4 with 2 takes each (the Mac's 8 jobs): playable when the file is in Windows' copy of the
   workspace, otherwise «Сделан на Mac-mini-Violetta…; файла на этом компьютере пока нет».
2. The owner picks one take per segment on Windows; after a sync `factory_storyboard_get` on the Mac returns those `picks`.
3. The Operator attaches `v3_chain_s8.mp4` (copied under `Sent to YTM/`) with `factory_storyboard_attach_render`; the owner plays it
   on both computers (where the file is) and approves it or requests changes; `factory_storyboard_get` shows the verdict.
4. Refusals (automated): a file outside `Sent to YTM/` / `From YTM/<media|gemini>/`, `..` or an absolute path; not a video; a
   missing file; an unknown storyboard, version or segment; a version that is not the approved latest; a pick of a job that is
   not a take of that segment and version; a channel not connected here.
5. The list cards show `v3` next to the title.

## 4. Stages (one branch, merged once on the owner's yes)

1. **A + C:** `storyboard-takes` module with peer takes, the take card's location text, picks of peer takes, the `v{n}` chip.
2. **B:** the `renders` / `renderDecisions` fields, the Factory tool (1.18.0), the owner's routes and «Ролик целиком».

## 5. Not in this plan

- Streaming a take or a render between computers (files come by the workspace sync).
- Notices for a new render (the owner sees it under «Ролик целиком»; a later item if wanted).
- `storyboardId` / `segmentId` on `factory_plan_report` rows (BL-184 §5, still deferred).

## 6. Risks

- **Both computers must run this build** to see renders (an older build ignores the new document fields) and peer takes.
- **A peer's report is 1–2 minutes behind**, and lists finished jobs of the last 7 days only (BL-188): an older take of another
  computer drops out of the list, while a pick that names it stays and shows as «дубль не найден».
