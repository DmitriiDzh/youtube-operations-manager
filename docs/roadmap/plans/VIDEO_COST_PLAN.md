# Video numbers from YT Manager and the visual cost of each video (BL-194)

**Status: stage 1 built on branch `feature/bl-194-video-cost` (2026-10-17: ADR 0040, Factory API 1.20.0, schema v95; not merged). Stages 2-4 not started.** Deviation: the routes are `/api/channels/<id>/video-projects` (`/videos` is the channel's YouTube video list), and the link field on job, storyboard and plan inputs is `videoNumber` (Gemini's `video` is already the video settings); `factory_video_get_cost` comes with stage 3. Owner, Telegram 2026-10-16: the request (msg 2867), the answers (msg 2870), YT Manager
numbers videos itself and may add MCP tools (msg 2872). Analysis sent as msgs 2869 and 2871.

## 1. Why

The owner wants to know how much the visuals of each released video cost: every RunPod and Gemini run that went into it, including
tests and rejected takes. Music is counted separately and is not part of this item. The total is stored against the video.

Today no record ties a run to a video:
- Jobs know their storyboard and segment, and RunPod jobs also know their plan.
- No job, session, plan or storyboard knows the video number (`Vn`), and no release package knows its storyboard.
- RunPod cost exists only per session (pod time × hourly price). A session runs many jobs, and pod start and idle time belong to none
  of them.
- Cross-device job reports drop finished jobs after 7 days.

**Direction (msg 2872).** The goal is to make a whole video from YT Manager with scripts and no agent. So the video number is created by
YT Manager when work on a video starts, not by the factory when it makes the folder. The publication date is still set only at
publishing (the Content window already does that). The Operator is told about the new tools after release (a DEV-REL note), and the
repository holds the tools, never the Operator's procedure (AGENTS.md §B).

## 2. Design

### Stage 1: video numbers (the "video" record)

- **Module** `src/lib/video-projects/` (contracts, schemas, services, adapters; a shared module both media modules depend on, AGENTS.md §M).
- **A video record**: `{ channelId, video: "V49", workingTitle, state: in_work | packaged | published | cancelled, createdAt, deviceId }`.
  `state` is derived where possible: packaged when `Vn_release.json` exists, published when `Vn_youtube.json` exists.
- **Next number**: the highest Vn of the channel known from every source, plus one. The sources are:
  - `MMDD Vn` folders under `04 Videos/`;
  - `video_registry.csv`;
  - `publishing_uploads`;
  - every computer's reservations.
- **Across computers**: each computer writes only its own reservations to a per-device file in the sync folder (the ADR 0028
  per-device-report pattern; no shared file is edited by two computers). The list of videos is the union of all of them.
- **Duplicate numbers**: two computers can reserve the same number within the sync delay, or while one is offline. When that
  happens:
  - Both show a warning.
  - The earlier reservation keeps the number (ties are broken by deviceId).
  - The other one is offered the next free number in a dialog (never renumbered silently).
  - Nothing is attached to a number that is in dispute.
- **Where a number is used**:
  - Storyboards and plans get an optional `video` field.
  - RunPod and Gemini job creation (Web UI, API, MCP) accepts an optional `video`. When it is omitted, a job inherits the video of its
    storyboard, else of its plan.
  - A run with no video counts as «не привязано».
- **Tools (scripts and MCP)**:
  - routes `POST/GET /api/channels/<id>/videos`;
  - Factory MCP tools `factory_video_create`, `factory_video_list`, `factory_video_get_cost`;
  - an optional `video` on `factory_media_create_job`, `factory_gemini_create_job`, `factory_storyboard_*` and `factory_plan_create`.
  - Every route and tool checks that the video belongs to its channel (AGENTS.md §F).
- **UI**: in Content, a «Новый ролик» button (it reserves the next number, with an optional working title) and the list of videos in
  work. A storyboard or plan gets a video picker.

### Stage 2: the cost of each RunPod job

- ComfyUI runs one pod's jobs one at a time, although they are submitted together. The real start and finish of a job are known only
  from the websocket (`execution_start` and `execution_success`, `job-progress.ts`), and today they live in memory only.
- **Persist** `started_at` and `gpu_finished_at` on `media_jobs` from those events.
  - When an event is missed, a job's start is estimated as the later of its submission and the previous job's finish on the same pod.
  - Such a job is marked as an estimate.
- **At session close**, the session's final cost is split across its jobs in proportion to their GPU seconds. This includes pod start
  and idle time, so the jobs always add up exactly to what RunPod charged.
- Each job stores:
  - `allocated_usd`;
  - `allocation_basis`: measured or estimated;
  - its share of overhead, so the popup can show it.
- A session with no jobs keeps its cost at session level: the video of its plan, else «не привязано».
- Gemini needs no split, because each job already has its exact or table-priced cost (`cost_usd`, `cost_basis`).

### Stage 3: totals, the popup and `Vn_cost.json`

- **Across computers**: a per-device report family `video-costs`. Each computer publishes one line per run linked to a video of the
  channel:
  - job id and source (RunPod or Gemini);
  - storyboard and segment;
  - status;
  - USD and its basis;
  - time.
- It is not limited to 7 days. Lines of cancelled videos are dropped, and published videos keep their lines for a bounded period after
  publishing.
- **Content**: each video shows one total (RunPod, Gemini, all). A click opens a popup with every run:
  - kind, model or template, storyboard segment, result (chosen, rejected, failed or test);
  - cost (an estimate is marked);
  - which computer ran it;
  - the RunPod overhead share.
- **`Vn_cost.json`** is written next to `Vn_release.json` when the video is uploaded, in the synced workspace:
  - totals and the per-run breakdown;
  - `computedAt`;
  - the computers whose data it includes.
- If a late report from another computer changes the total, the file is rewritten and says so. It is the durable record, so cleaning
  the exchange folder or the report window does not lose the number.

### Stage 4: older runs

- Each computer goes over the jobs its own database still holds. Whatever has already left every database cannot be recovered, and
  the plan says so.
- **Matching storyboards to videos**: the app proposes a match when a storyboard's render file matches a video file in a `MMDD Vn`
  folder (by name and size, then a hash). The owner confirms each match or picks the video by hand in a list. Nothing is linked without
  that confirmation.
- Old RunPod jobs are split by their submitted/finished times, made sequential per pod, and marked as estimates. Gemini jobs keep their
  exact cost.
- Both computers run it, and the results travel by the stage 3 report.

## 3. Order and branches

- Stage 1 is independent of BL-193 and can start on `feature/bl-194-video-cost` (from `dev`).
- Stages 2 and 3 touch the same job, worker and report files as BL-193, so they start after BL-193 is merged.
- One branch for all stages, and one merge request to the owner when the feature works end to end (AGENTS.md §K.1).
- A new ADR records the per-device video reservations, the duplicate rule and the cost split.

## 4. Acceptance criteria (fixed before the code)

1. «Новый ролик» on either computer gives a number one above the highest known Vn of that channel (folders, registry, uploads,
   reservations). Two reservations of the same number on two computers are both shown as a conflict, and nothing is renumbered without a
   choice.
2. A job created for a storyboard or plan linked to V49 is counted for V49 without passing `video`. An explicit `video` of another
   channel is refused.
3. A RunPod session of $1.00 with jobs of 60 and 30 GPU seconds, linked to V49 and V50, gives $0.6667 and $0.3333 (the jobs add up to
   the session exactly). A session with no jobs stays a session-level line.
4. A Gemini job keeps its own `cost_usd`; an estimate is marked as such in the popup.
5. Content shows the same total for V49 on both computers once their reports have synced.
6. Uploading V49 writes `V49_cost.json` next to `V49_release.json`, with the same total as Content.
7. Older runs: a storyboard whose render matches the video file in `0928 V39` is proposed for V39 and linked only after confirmation.
   Old RunPod splits are marked as estimates.
8. Servers, Media and Publishing keep working when the cost report or the video module fails (AGENTS.md §M).
9. No YouTube write, no paid call, no secret in any report or file.

## 5. Not in this item

- Music cost.
- Moving or renaming any folder: the factory still creates `MMDD Vn` folders.
- The Operator's scripts. The DEV-REL note lists the new tools after release, and the Operator updates its own pipeline.
