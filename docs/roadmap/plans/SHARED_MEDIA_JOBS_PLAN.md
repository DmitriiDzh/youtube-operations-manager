# Shared media jobs: one pool of jobs on every computer, the same actions everywhere (BL-188)

- **Request:** owner, Telegram 2026-10-14, msgs 2801/2803:
  - "Можно иметь просто общий пул задач и отображать его везде"
  - both RunPod and Gemini jobs
  - "Одинаковый функционал везде"
  - the viewing computer "should not matter"
- **Status:** plan accepted (owner msg 2806, 2026-10-14). Branch `feature/shared-media-jobs` from `dev` d46a535. Stage 1 built
  (no schema change: the command tables of §3 come with stage 2, the first stage that stores anything).
- **Owner's answers (msg 2806):** Q1 yes (session approve/reject from any computer, stage 2); Q2 7 days of finished jobs;
  Q3 yes (Gemini launch from Media, stage 4); Q4 ok (Operator reads every device's jobs, sends no commands).
- **Amends:** ADR 0028 (sessions across devices) and ADR 0035 (Gemini media, "jobs are device-local"). The amendment is written
  with stage 1.

## 1. Facts (code read 2026-10-14 at `dev` d46a535)

### 1.1 Where jobs live today
- **RunPod / ComfyUI jobs:**
  - Table `media_jobs`. Columns: id, session, channel, template + version, params, status, `createdBy`, outputs, assets,
    error, times, plan link (`plan_id`, stage, item key, seed), storyboard link (v90).
  - **Device-local** (ADR 0023): a job belongs to a session, and a session owns a pod on the device that approved it.
  - Outputs are downloaded to `<workspace>/99 Data Exchange/From YTM/media/<jobId>/` **of that device**.
- **Gemini jobs:**
  - Table `gemini_media_jobs`. Statuses `queued | submitting | running | done | failed`.
  - **Device-local** (ADR 0035): the key is encrypted per device, the limits (per job / day / month, active jobs) are counted
    "on this computer", and the outputs go to that device's `From YTM`.
- **What crosses devices today:**
  - **`media-sessions` family** (ADR 0028, report v2):
    - per open session, the job counts by status and at most 5 unfinished jobs with progress, without error text;
    - Stop works from any device (same RunPod account).
  - **`generation-plans` family:**
    - the owner's verdicts on attempts are relayed to the owning device: the outgoing verdict sits in the giver's report, and the
      owner device applies it once by `verdictId`;
    - the audition file is opened from the **viewer's own copy of the channel workspace** ("not on this device" when missing).
  - **Gemini jobs: nothing.**
- **The transport:** `sync-gateway/per-device-report`.
  - Each device writes only its own JSON report into a Syncthing subfolder and keeps the newest report of every peer.
  - Nothing is merged.
  - Delay: about 1–2 minutes (watcher tick + sync cycle + Syncthing).

### 1.2 Job actions that exist today (the "same functions" to provide everywhere)

| Job type | Action | Where today | Spends money |
|---|---|---|---|
| RunPod | See list, status, progress, plan/storyboard link, outputs, error | Media → kind tabs (journal), this device only | no |
| RunPod | **Run a job** (session + template + params) | Media journal (`POST /api/media-generation/jobs`), Factory `factory_media_create_job` | **yes** (GPU time of a running session) |
| RunPod | **Cancel** a queued/running job | Media journal, `factory_media_cancel_job` | no (stops spend) |
| RunPod | Volume clean-up (janitor) | Servers → Setup | no — per device's own journal, stays per device |
| RunPod | Review verdict on a plan attempt | plan review screen | no — **already cross-device** |
| Gemini | See recent jobs, cost, outputs | Settings → Gemini (recent jobs), storyboard Video tab | no |
| Gemini | Create a job | **Factory only** (`factory_gemini_create_job`) | **yes** |
| Gemini | Cancel | **does not exist** | — |
| Session (context) | Approve / Reject a requested session | owning device only (ADR 0028 §4) | approve: **yes** |
| Session (context) | Stop | any device (ADR 0028) | no |

## 2. Decisions

### 2.1 What "one shared pool" means
- **One list, everywhere.**
  - Every computer shows every computer's jobs in the same Media journal, RunPod and Gemini together:
    status, live progress, channel, template or model, plan/storyboard link, cost, times, `createdBy`.
  - A column "Компьютер" (host name) plus a filter.
  - Nothing distinguishes "mine" from "theirs" except that column and a freshness note when a peer's report is older than 5 min.
- **History:** every unfinished job, plus finished jobs of the last **7 days** (owner msg 2806), capped at **1,000 per device**
  (newest first). Older history stays on its device.
- **Outputs** open from the **viewer's own copy of the channel workspace**, the same rule as plan audition.
  - The file arrives there by the existing workspace sync.
  - Until then the row says «файл ещё не пришёл с <компьютер>».
  - No file is transferred through the report.
- **Errors:** only the job's error **code** and our own short text are shared. Never ComfyUI/Google raw text, URLs, tokens or keys
  (ADR 0028 rule).

### 2.2 Where a job runs: on the computer that owns its session or key (recommended), not "anywhere"
- **Decision (recommended): a job keeps running where it was created.**
- **RunPod jobs:** a job is a prompt sent to a session's pod.
  - Only the device that approved the session holds its ComfyUI URL (with its proxy token) and runs the watcher, the S3 download
    and the money checks.
  - Moving a queued job to another device's session is possible only as "cancel here, create there". The UI may offer exactly
    that as one action ("Перезапустить на …"), but there is no silent hand-over.
- **Gemini jobs:** the key and the limits are per device.
  - Letting any device pick up any queued job would need a shared queue with a claim/lock across devices. With Syncthing's
    1–2 min delay and no atomic step, two devices could both run, and both pay for, one job.
  - So a Gemini job runs where it was created.
- **What the owner gets:** the viewing computer does not matter. Every action works from every computer and is carried to the
  executor (§2.3); the result shows everywhere.

### 2.3 Same actions everywhere: commands relayed to the executor
- **The mechanism is the plan-verdict one, generalized.**
  - An action on another device's job, or on another device's session, is stored on the clicking device as an **outgoing
    command**.
  - The command is published in that device's report.
  - The executing device applies it **once** and publishes the result in **its** report.
- **The command:**
  - `commandId` (UUID);
  - `targetDeviceId`;
  - `kind`;
  - the target (`jobId` | `sessionId`) or, for `create`, the full request (channel, session, template + version, params, plan
    fields);
  - `issuedAt`;
  - `issuedOn` (host name);
  - `actor` (`owner`, only from a Web session).
- **Kinds in this plan:** `cancel_job` (RunPod, and Gemini once a Gemini cancel exists, §2.5), `create_job` (RunPod; Gemini
  in stage 4), and `approve_session` / `reject_session` (owner's yes, msg 2806).
- **Idempotent:**
  - The executor keeps a ledger `media_job_peer_commands` (`commandId` primary key, result, applied time).
  - The same `commandId` twice changes nothing.
  - Its report lists the last 1,000 results.
- **Ordering:** commands for one target are applied by `issuedAt`. A `cancel_job` for a job already finished is applied as
  "already finished", not an error.
- **Expiry:**
  - a `create_job` older than **15 min** when the executor first sees it is refused (`command_expired`): a stale "run" must not
    start spending later, for example after the device wakes up;
  - a `cancel_job` never expires while the job is unfinished.
- **Honest latency in the UI:** «Отправлено на Mac 14:05 · ждёт подтверждения» → «Выполнено на Mac 14:06» or «Отказано: <reason>».
  If the executor's report is older than 5 min: «Mac не на связи с 13:40 — команда выполнится, когда он появится» (a create
  expires as above).
- **Same action on the own device:** called directly, as today. The UI is the same; only the path differs.

### 2.4 Money safety
- **The executor alone decides spend.**
  - A relayed `create_job` goes through **the same service call** as a local one: session open and owned, template valid,
    storyboard gate (ADR 0038), factory/plan limits, the session's own approval.
  - Gemini: the per-job, day, month and active-job limits of the executing device (the owner's Gemini create from Media,
    stage 4, goes through the same checks).
  - A refusal comes back with its code.
- **A remote device never** holds the session URL, the Gemini key or a RunPod key for this, and no command can raise a limit or
  approve spend by itself.
- **Expiry and idempotency** (§2.3) prevent duplicate or late spend.
- **Audit:** every applied command is audited on the executor (`peer_command`, `commandId`, `issuedOn`, result).

### 2.5 Gemini parity
- Today the owner can only see Gemini jobs. After stage 1 they are visible everywhere.
- A Gemini **cancel** for `queued` jobs (before any request to Google) is cheap and safe. It is proposed in stage 2 so that RunPod
  and Gemini have the same buttons.
  - `submitting` / `running` cannot be cancelled at Google for images.
  - For video operations Google offers `operations.cancel`. This is **UNVERIFIED** for Veo; until verified, the button is shown
    disabled with «нельзя отменить после отправки в Google».

### 2.6 Module layout (AGENTS.md §G, §M)
- **A new sync-gateway family `media-jobs`** (per-device report, `sync-gateway/per-device-report`).
  - It is not an extension of `media-sessions`: that report is session-shaped and versioned for ADR 0028.
  - Mixing in a 1,000-job history and commands would force both computers to update for every jobs change.
  - Like every family, it imports nothing from `media-generation` or `gemini-media` (checked by the family's boundary test).
  - It defines its own strict schemas; the feature modules fill and read the report through ports wired in their `index.ts`.
- **A small orchestrating module `src/lib/media-jobs-pool/`.**
  - It merges the device's own rows from both feature modules with the peers' reports into one view.
  - It stores outgoing commands and applies incoming ones by calling the feature modules' existing services.
  - It depends on `media-generation`, `gemini-media` and the family; the feature modules do not depend on it.
  - If it is disabled or broken, each feature's own journal still works locally (§M).
- **Device id and host name:** `presence` / device-id helpers already used by `generation-plans`.

### 2.7 Agent / Factory API
- `factory_media_get_job` and `factory_gemini_get_job` are unchanged: the Operator works on the Mac and acts on the Mac's jobs.
- **New read-only `factory_jobs_list`** (Factory API minor bump): every device's jobs from the pool, with `deviceId`, host and
  report age, filters by channel, kind, status and plan.
  - It gives the Operator the same picture as the owner.
  - No relayed commands for the Operator in this plan (Q4): its actions stay local, under its own limits.

## 3. Data
- **Schema v93** (additive, device-local, not in snapshot/sync):
  - `media_job_commands_out`: this device's outgoing commands with their last seen result;
  - `media_job_peer_commands`: the ledger of applied incoming commands.
- **No change to `media_jobs` or `gemini_media_jobs`.** The report is built from them.
- **Report `ytm-media-jobs` v1:**
  - `deviceId`, `host`, `updatedAt`;
  - `jobs[]`: id, kind `runpod|gemini`, channel, status, progress (BL-144 shape without `detail`), template/model, plan and
    storyboard fields, cost and its basis, times, `createdBy`, output relative paths, error code + our text;
  - `commands[]`: outgoing;
  - `commandResults[]`: last 1,000 applied.
- **Size:** at 1,000 jobs, about 0.5 MB.
- **Both computers must run this build:** an older build ignores the new family folder, so nothing breaks, but nothing shows.

## 4. Acceptance criteria (fixed before code)

### 4.1 Automated
1. A report never contains a session URL, token, key, raw provider error or `detail`. Checked with a schema test and a seeded
   secret-string scan.
2. On device B, the pool view lists A's RunPod and Gemini jobs with host and status. A report older than 5 min is marked stale;
   one older than 7 days is not listed.
3. A history beyond 7 days or 1,000 jobs is cut, newest kept. Unfinished jobs are always kept.
4. A `cancel_job` from B for A's running job:
   - A cancels it through the same service as a local cancel;
   - the same `commandId` twice gives one cancel;
   - a cancel of a finished job gives `already_finished`.
5. A `create_job` from B:
   - A runs the same checks as a local create (closed session, other device's session, gate without an approved storyboard, over
     a limit → refused with the same code; no job row, no prompt sent);
   - a create seen first after 15 min → `command_expired`, nothing created.
6. Commands for one target apply in `issuedAt` order. A command for another device, or from the device itself, is ignored.
7. `sync-gateway/media-jobs` imports nothing from `media-generation` or `gemini-media`. With `media-jobs-pool` disabled, both
   feature modules' existing tests pass unchanged.
8. Gemini cancel: a `queued` job becomes `failed` with `cancelled_by_owner` and is never sent. `submitting` / `running` → refused
   `gemini_cancel_too_late`.
9. `factory_jobs_list` returns every device's jobs, read-only, with `deviceId` and report age.

### 4.2 With the owner (Mac + Windows)
- On Windows, Media shows the Mac's jobs (RunPod and Gemini) within about 2 minutes, with the same buttons.
- Cancel a running Mac job from Windows. The row shows «ждёт подтверждения», then «Выполнено на Mac»; on the Mac the job is
  cancelled.
- Open a finished Mac output on Windows once the file has synced. Before that, the row says the file has not arrived.

## 5. Stages (one branch, merged once on the owner's yes)
1. **One list everywhere** (read-only for peers' jobs):
   - the family, the report, the pool module;
   - the merged Media journal with the "Компьютер" column and filter;
   - outputs from the viewer's workspace copy;
   - Gemini jobs shown in the Media tabs by kind, not only in Settings;
   - ADR 0028/0035 amendments; schema v93.
2. **Same actions everywhere:**
   - outgoing and incoming commands (`cancel_job`, `create_job`), the ledger, the honest status line, expiry;
   - Gemini cancel for `queued` jobs.
   - Session approve/reject from any computer (owner msg 2806).
3. **Factory read:** `factory_jobs_list` and docs.
4. **Gemini launch from Media** (owner msg 2806): a create form in Media's Images/Video tabs for the owner, the same
   service and limits as the Factory create; from another computer it is a relayed `create_job` (§2.3/§2.4).

## 6. Not in this plan
- A job moving silently to another computer, or a shared queue picked up by whichever device is free (§2.2).
- File transfer through the report.
- Relayed commands for the Operator (owner msg 2806: read-only).
- The volume janitor stays per device: it acts on its own download journal.

## 7. Risks
- **Delay.** Peers' state is 1–2 min old. Commands take as long. The UI says so; nothing pretends to be instant.
- **Two clicks on two computers at once:** two creates are two separate jobs, by design. The executor's limits still bound the
  spend; the UI warns when a similar create from another computer is pending for the same session (same template + params hash).
- **Report size and Syncthing churn** at 1,000 jobs: about 0.5 MB, rewritten each minute only when it changed (a hash check before
  writing).
- **Both computers must update together**, as with BL-148/BL-162.

## 8. Questions for the owner
Answered in msg 2806 (see the header).
