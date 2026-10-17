# 0040. Video numbers given by YT Manager: per-device reservations, and the duplicate rule

Status: Accepted for stage 1 on branch `feature/bl-194-video-cost` (not merged; owner msgs 2870/2872, 2026-10-16).

**Date:** 2026-10-17. **Plan:** `docs/roadmap/plans/VIDEO_COST_PLAN.md` (BL-194) §2 stage 1. Stages 2-4 (the cost split per RunPod
job, totals, `Vn_cost.json`, older runs) are ADR 0041.

## Context

The cost of a video's visuals needs every run tied to the video's number (`Vn`). Until now the factory chose the number when it made
the `04 Videos/<MM Month>/<MMDD Vn>/` folder, so nothing in YT Manager knew it while the video was being made. The owner wants a whole
video made from YT Manager by scripts, without agents, so YT Manager gives the number when work starts (msg 2872). The factory still
makes the folder, and the date is still set only at publishing.

There is no shared database between the computers, and no shared file may be edited by two of them (ADR 0028). Two computers can
therefore hand out the same number within the sync delay, or while one is offline.

## Decision

1. **A shared module `src/lib/video-projects/`** (AGENTS.md §M). It depends on no feature module (`boundaries.test.ts`); the
   storyboards, the plans and both media modules depend on it, and a storyboard's or a plan's video reaches it through ports wired in
   `index.ts` (the storyboards document is read through the sync gateway, a plan's video from its row).
2. **The next number** is the highest Vn of the channel known from every source, plus one: the `MMDD Vn` folders (an empty one
   included), `video_registry.csv`, this computer's `publishing_uploads`, and every computer's reservations -- cancelled ones included,
   so a number is never given twice. Without a readable workspace no number is given (`video_workspace_unavailable`): an existing
   folder could be missed.
3. **Reservations are per device.** Each computer stores its own (`video_reservations`, schema v95) and publishes them in its own
   report, the sync family `video-reservations` (format `ytm-video-reservations` v1, the ADR 0028 per-device-report pattern). A peer's
   report is never forgotten (as BL-160's agent tokens): a number a quiet computer reserved stays taken. The list of videos is the
   union of every report, the folders, the registry and the uploads; its state is derived, never stored twice.
4. **The duplicate rule.** A number reserved (in work) by two computers is a conflict, shown on both. The earlier `reservedAt` keeps
   it; equal times go to the lower device id. The losing computer is offered the next free number in a dialog -- never renumbered
   silently; its old reservation is kept as cancelled with `replacedBy`. Nothing can be linked to a number in dispute
   (`video_in_dispute`).
5. **Links.** Storyboards (a field of the Automerge record, last change wins, not content) and plans (a column) may name a video of
   their channel. A RunPod or Gemini job may name one (`videoNumber`); otherwise it takes its storyboard's video, else its plan's,
   resolved at creation and stored on the job row (`media_jobs.video`, `gemini_media_jobs.video`). An explicit number of another
   channel, a cancelled one or one in dispute refuses the job before anything is uploaded, sent or charged. An inherited video that
   cannot be linked, or a failing lookup, leaves the job unlinked -- the media modules keep working when this module fails.
6. **Factory API 1.20.0, additive:** `factory_video_create` (write, gated), `factory_video_list` (read), `videoNumber` on the job,
   storyboard and plan tools. Web/API routes `/api/channels/[channelId]/video-projects` (`/videos` is the YouTube video list).

## Consequences

- A duplicate is possible within the sync delay and is resolved by hand (the dialog), which is rare: a computer reserves only after
  reading every report it has.
- A link made on a computer that had not yet seen a duplicate stays on the number the winner keeps (RISK-129).
- The number is known before the folder exists; the factory names the folder after it.
