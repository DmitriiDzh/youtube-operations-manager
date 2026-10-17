# 0041. The visual cost of each video: RunPod charge split per job, the `video-costs` report, `Vn_cost.json`, older runs

Status: Accepted for stages 2-4 on branch `feature/bl-194-video-cost` (not merged; owner msgs 2870/2871, 2026-10-16).

**Date:** 2026-10-17. **Plan:** `docs/roadmap/plans/VIDEO_COST_PLAN.md` (BL-194) §2 stages 2-4, criteria 3-9. Builds on ADR 0040
(video numbers).

## Context

The owner wants one total per video for its visuals -- every RunPod and Gemini run that went into it, tests and rejected takes
included -- and, on a click, every run with its cost (msg 2870). RunPod bills a session (pod creation to confirmed termination), not a
job, and pod start and idle time belong to none of the jobs; the owner chose to spread that overhead across the session's jobs so they
add up to the RunPod charge, and to show each job's overhead share (msg 2871). The two computers share no database, and the
cross-device media-jobs report forgets finished jobs after 7 days.

## Decision

1. **Real GPU times (stage 2).** ComfyUI runs one pod's prompts one at a time. `media_jobs.started_at` / `gpu_finished_at` (schema
   v95, ms) store the first `execution_start` and the first `execution_success` / `_error` / `_interrupted` of the job's websocket
   (`jobs.ts` `recordTiming`); a re-sent `executing` after a late connect is not a start. Written in the background: a failed write
   only makes the job's share an estimate.
2. **The split (stage 2).** `media-generation/cost-split.ts`: once a session has ended and all its jobs are final, its charge
   (`usd_charged`) is split in proportion to GPU seconds -- a missed start is the later of the job's submit and the previous job's
   finish on the pod, a missed finish is the job's `finished_at` (both mark the share `estimated`); a job that never reached ComfyUI
   gets 0; with no GPU time at all the jobs share equally (estimated). **Rounding:** units of 1/10000 USD, largest remainder, ties to
   the earlier job -- the shares add up to the charge exactly (the charge itself is kept to the cent). Stored per job:
   `gpu_seconds`, `allocated_usd`, `overhead_usd` (the share above its own seconds at the hourly price), `allocation_basis`,
   `allocation_session_usd` (a later change of the charge splits again). Run every minute by the `video-costs` loop in
   `instrumentation.ts`, old sessions included (stage 4: every share estimated). A session without jobs stays one session-level line,
   counted for its plan's video.
3. **One module, independent (stage 3).** `src/lib/video-costs/` reads this computer's run rows from `db.ts` (no prompt, parameter or
   path is selected), the peers' reports and the storyboards document through the sync gateway, and video states through
   `video-projects`. No media module, the storyboards module or Publishing imports it (`boundaries.test.ts`); Publishing, the routes
   and the Factory endpoint load it lazily, so Servers, Media and Publishing work when it fails.
4. **The `video-costs` sync family.** Per-device report `ytm-video-costs` v1 (ADR 0028 pattern, strict, ≤ 20 000 lines, peers never
   forgotten). A line: `runId`, `source`, `kind` (job | session), channel, video, label (template / model), media kind, storyboard
   segment, plan, status, `usd`, `basis` (measured | estimated | pending for RunPod; Gemini's `cost_basis`, or `estimate` while it
   runs), `overheadUsd`, `gpuSeconds`, times. **Retention** (by the reporting computer): a cancelled video's lines go; a published
   video's stay 120 days after the run; unlinked lines 90 days. A video's total = this computer's lines + every peer's, summed in
   1/10000 USD, so it is the same on both computers once the reports have synced.
5. **Result of a run** (computed where it is shown, from the synced storyboards): `chosen` (an owner's pick, or a take a render
   uses), `rejected` (another take of a storyboard segment), `failed`, `active`, `test` (outside any storyboard segment), `session`.
   An estimate is marked `≈`.
6. **`Vn_cost.json`.** Written next to `Vn_release.json` at the upload's record step (atomic temp + rename, the real folder inside
   the workspace): totals, every run, the computers counted with their report age, `computedAt`, `revision`, `writtenBy`. Only the
   computer that wrote it rewrites it -- when a later report changes the total (`previous` + `note`), one writer per file in the
   synced folder. A failure is a note on the upload, never a failed step.
7. **Older runs (stage 4).** Each computer goes over the jobs its database still holds. A storyboard with no video whose render file
   is the video file of a `MMDD Vn` folder (same name and size, then sha256) is proposed for that video; the owner confirms it, or
   picks a video by hand, and only then the storyboards module sets the storyboard's video (it syncs) and this computer's unlinked
   jobs of it are linked. Runs of a storyboard or plan that already has a video are linked on the owner's click, on each computer.
8. **Surfaces.** Routes `GET /api/channels/[id]/video-costs`, `/video-costs/[video]`, `/video-costs/backfill`, `POST
   /video-costs/backfill/storyboards/[storyboardId]`, `/video-costs/backfill/runs` (session + active channel); Factory API 1.20.0
   `factory_video_get_cost` (read); Content → «Ролики в работе»: a total per video, the runs window, «Старые запуски».

## Consequences

- A RunPod job counts 0 (`pending`) until its session ends; the split is then exact for the session but its per-job parts rest on
  ComfyUI's events (RISK-130).
- Lines of a published video leave the reports after 120 days; `Vn_cost.json` is the durable record. A video published without the
  app's upload has no file, and its runs leave the other computer's view after that window (RISK-130).
- Runs that left every database before this feature cannot be recovered.
