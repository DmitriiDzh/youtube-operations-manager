> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 51. Video numbers given by YT Manager (BL-194 stage 1, ADR 0040)

Plan: `docs/roadmap/plans/VIDEO_COST_PLAN.md` §2 stage 1 (acceptance criteria 1, 2, 8, 9). Schema v95. On branch `feature/bl-194-video-cost`.

- **Module.** `src/lib/video-projects/` is shared (AGENTS.md §M): storyboards, generation plans, `media-generation` and `gemini-media`
  depend on it; it imports none of them. A storyboard's video is read from the synced storyboards document through the sync gateway, a
  plan's from `generation_plans.video` (`db.getGenerationPlanVideo`). One instance per process on `globalThis`, so its lock serializes
  every reservation of this server (Factory route, Web routes, media modules).
- **Next number.** `numbering.nextVideoNumber(knownNumbers(...))`: highest Vn of the channel from the workspace's `MMDD Vn` folders
  (`workspace-videos.listVideoFolders`: `04 Videos/<month>/<MMDD Vn>` or directly under `04 Videos`, empty folders included, never
  through a symlink), `video_registry.csv` (`VNumber`), `publishing_uploads.video`, and every reservation of every computer (cancelled
  included), plus one. Without a readable workspace `createVideo` refuses (`video_workspace_unavailable`); the list still answers from
  reservations and uploads, with `workspace` saying why.
- **Reservations.** `video_reservations` (key `channel_id, video`; `working_title`, `reserved_at`, `state in_work | cancelled`,
  `cancelled_at`, `replaced_by`) holds THIS computer's; device-local (snapshot) and `notApiData` (data policy). After every change, and
  on a list when it differs from the last one published, the whole set goes into this computer's `video-reservations` report
  (`sync-gateway/video-reservations`, the ADR 0028 per-device pattern, `forgetAfterMs: null`), carried by the generic sync runner
  (Syncthing subfolder `video-reservations`, family `video_reservations` in the Merge tab; 16 families in all).
- **List and conflicts.** `buildVideoList` unions every source per number. `state`: published (`Vn_youtube.json` in the folder, a
  registry row, or a finished upload), packaged (`Vn_release.json`, or an upload not failed/cancelled), cancelled (only given-up
  reservations), else in work. Two computers with the number in work = `conflict`: winner = earliest `reservedAt`, then the lower
  device id; `suggestedVideo` only for the losing computer. `renumber` (losing computer only, under the lock) reserves the next number
  with the same working title and cancels the old reservation with `replacedBy`.
- **Links.** `assertAttachable(channelId, video)`: the pattern `^V[1-9][0-9]{0,5}$`; known for the channel, not cancelled, not in
  dispute (`video_not_found` / `video_in_dispute`); a number reserved here with no peer holding it passes without reading the
  workspace. Storyboards: `StoryboardRecord.video` (assigned whole by `setVideo`; not content, no new version); plans:
  `generation_plans.video` (a move clears it). Jobs: `resolveJobVideo` -- an explicit `videoNumber` must pass (the job is refused
  before uploads, the prompt, the Gemini estimate or any charge); otherwise the storyboard's video, else the plan's (same channel
  only); an inherited video that cannot be linked or a failing lookup gives `null` and a log line. The ports are optional in the
  media modules (`videoLink`), so they run without the module; a given number is then refused.
- **Surfaces.** Factory API 1.20.0 (`factory_video_create` gated write, `factory_video_list` read); Web routes under
  `/api/channels/[channelId]/video-projects` with session + active channel (ADR 0004); Content → «Публикация» → «Ролики в работе»
  (own error boundary) and `VideoPicker` on the storyboard screen and the own-plan card.
- **Limits.** A duplicate within the sync delay is resolved by hand; links made before it was seen stay (RISK-129). The cost per video
  is §52.

## 52. The visual cost of each video (BL-194 stages 2-4, ADR 0041)

Plan: `docs/roadmap/plans/VIDEO_COST_PLAN.md` §2 stages 2-4 (criteria 3-9). Schema v95 (the same migration as stage 1). On branch
`feature/bl-194-video-cost`.

- **GPU times.** `jobs.ts` `openProgress` hands every websocket event to `recordTiming`: `execution_start` → `media_jobs.started_at`,
  `execution_success` / `_error` / `_interrupted` → `gpu_finished_at` (`db.recordMediaJobTiming`: first value only, `timestamp_ms`),
  in the background (a failed write is logged). The job's manifest gains `video`.
- **Split.** `cost-split.ts` `splitSessionCost` (pure): jobs ordered by start; start = `started_at`, else max(submit, previous finish on
  the pod); finish = `gpu_finished_at`, else `finished_at`; either fallback = `estimated`; never reached ComfyUI = 0 s. Charge in
  1/10000 USD, shares by GPU seconds, largest remainder (ties to the earlier job); no GPU time at all = equal shares (estimated);
  `overhead = share − seconds × costPerHr / 3600` (capped at the share). `splitEndedSessionCosts` runs over
  `db.listMediaSessionsNeedingCostSplit` (ended sessions with a job whose `allocation_session_usd` is null or differs from the
  charge) and stores each share (`setMediaJobCostShare`); a session with a running job waits. `media.splitEndedSessionCosts()` is
  called by the `videoCostsLoop` (5 min since BL-270, was 60 s; behind the device-mutation gate) in `instrumentation.ts`, which then
  calls `publishAndRefresh`: this computer's report is built once for the publish and the refresh, and the refresh walks the channels'
  videos, storyboards and cost files only when some computer's runs changed (reports compared without `updatedAt`) or 30 minutes
  passed; a pass with a failed channel is not remembered.
- **Cost lines.** `video-costs/services.ts` `buildOwnRuns` maps `db.listVideoCostRunpodJobs` (template name joined; media kind from
  the output kinds), `listVideoCostSessionsWithoutJobs` (ended, charged, no job; the plan's video) and `listVideoCostGeminiJobs`
  (`cost_usd` with its basis, else the estimate as `estimate`) field by field. `selectReportRuns` applies the retention (states from
  `video-projects.listVideos` per connected channel; a channel that cannot be listed keeps everything) and the 20 000 bound.
- **Report and view.** `publishOwnReport` writes `ytm-video-costs` when it changed and at least every 10 min (sync-gateway
  `video-costs`, the per-device-report core, `forgetAfterMs: null`; family `video_costs`, 17 in all). `summary` / `videoCost` read
  this computer's fresh report plus every peer's (an unreadable peer set or storyboard document is logged and skipped), keep the
  channel's lines, attach the computer and the result (`chosenTakes` from every version's picks and every render's picks), and sum in
  1/10000 USD. A channel not connected here is `video_costs_unavailable`.
- **`Vn_cost.json`.** `upload-runner.ts` record step calls the optional `deps.costFile` (`publishing/index.ts`: a lazy import of
  `video-costs`) with the package folder; `steps.cost` = written | failed (+ a note; never `step_failed`). `writeCostFile` builds the
  file (`ytm.video-cost` v1: totals, runs, computers, `revision`, `writtenBy`, `previous`, `note`); `adapters/cost-file.ts` checks
  the name `^V\d+_cost\.json$` and the real folder inside the workspace, writes a temp file then renames. `refreshCostFiles`
  (the same loop; its own report, the peers', and per channel the video list and storyboards read once per tick) merges the current
  runs into an existing file by computer + run id -- never removing one, adding new ones, updating a changed cost or result -- only
  on the computer named in `writtenBy`, and not at all while the peers' reports cannot be read.
- **Older runs.** `backfill.ts`: `proposals` (storyboards without a video whose render's basename and bytes match a video file of a
  `MMDD Vn` folder, then `hashOf` equals the render's sha256; `adapters/backfill-files.ts` caches hashes by path, size and mtime),
  `withoutVideo` (storyboards with unlinked runs here, for a hand pick) and `linkable` (storyboards / plans with a video and unlinked
  runs here: `db.countUnlinkedJobsByOrigin`). `confirmStoryboard` checks the video (`assertAttachable`), sets it through the port
  `setStoryboardVideo` (the route wires `storyboards.ownerSetVideo`), then `db.linkUnlinkedJobsToVideo`; `linkRuns` links runs of an
  already-linked storyboard or plan. Old sessions are split by stage 2 as estimates.
- **Surfaces.** Routes in `src/app/api/channels/[channelId]/video-costs/` (session + active channel; the channel and ids from the
  address); `factory_video_get_cost` (Factory API 1.20.0, read, lazy import in the Factory route); `video-projects-panel.tsx` (a
  total chip per video from its own fetch, `video-cost-dialog.tsx`, `video-costs-backfill.tsx` in its own `FeatureErrorBoundary`).
- **Limits.** RunPod jobs are `pending` (0) until their session ends; a published video's lines leave the reports after 120 days
  (`Vn_cost.json` keeps them); runs that left every database are lost (RISK-130).
