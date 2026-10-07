# Job progress on other devices (BL-148)

**Decided** by the owner in Telegram on 2026-10-07:
- msg 1976, step 4: "чтобы я видел прогресс работы в том числе если сервер был арендован с другого компьютера";
- the problem behind it: on Windows, Production showed none of the Mac's job progress.

**Why it was missing:**
- BL-144 progress lives in memory on the device that runs the job (`media-generation/job-progress.ts`).
- The BL-138 sessions report (ADR 0028) carries sessions only, so another device never sees it.

## Design

- **The report** (sync-gateway `media-sessions`) goes to **version 2**. Each open session may carry `jobs`:
  - `counts` of its jobs by status: queued, running (`submitted`, `generating`, `transferring`), done, failed, cancelled;
  - `capped: true` when 200 jobs were read (the most a job listing returns), so there may be more;
  - `current` (≤ 5): the non-terminal jobs, running first and then oldest first. Each has `jobId`, `templateId`, `status`,
    `createdBy`, `submittedAt`, the plan item key, and `progress`.
- **`progress`** is the BL-144 live progress without `detail`, which can carry ComfyUI's error text. What is shared:
  - `state` and `percent`;
  - node counts and the current node's type;
  - the step;
  - `startedAt` and `updatedAt`.

  `progress` is null when this device is not watching the job.
- **Compatibility:**
  - A device on this build reads version 1 and version 2 reports. A version 1 report simply has no `jobs`.
  - A device on an older build refuses a version 2 report with the existing "version 2 is newer… update the app" reason in the
    Merge tab, and then shows nothing from that device. **Both devices must be updated.**
- **Freshness:** the report is written on the media watcher tick (about 30 s) and carried by the sync scheduler (30 s) and
  Syncthing, so it is about a minute behind. The view says "as of <age>" on each progress.
- **UI:** Production → "Other devices" adds a line under each open session with the job counts and each current job. The job is
  shown with the same `JobProgress` view as on the running device (one owner for those words, §M), plus its age.

## Acceptance criteria (written before the code)

- AC-XJ-01: an open session's report entry carries the job counts by status and at most 5 current jobs, running first. A session
  that is finished carries no `jobs`.
- AC-XJ-02: a shared job's progress never contains `detail` or any error text. The report schema refuses one that does (strict).
- AC-XJ-03: version 2 reports with jobs are accepted. A version 1 report (no `jobs`) from an older peer is still accepted. Version 3
  is refused as newer.
- AC-XJ-04: `deriveOtherDevices` passes each session's `jobs` through unchanged.
- AC-XJ-05: 200 or more jobs in a session → the counts cover the newest 200 and `capped` is true; fewer → `capped` is false.
