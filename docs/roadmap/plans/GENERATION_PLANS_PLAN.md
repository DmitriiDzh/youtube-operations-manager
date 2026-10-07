# Generation plans: plan, slices and acceptance criteria (BL-143)

**Requested** by the Factory Operator (FO-REQ-0006). **Design:** DEV-RESP-0008, revised by the operator's review (FO-MSG-0008).
**Decided** by the owner (Telegram 2026-10-07):
- msg 1929: Q1 verdict in the app and relayed in chat; Q2 warning only; Q3 one plan per session; Q4 Telegram via the operator.
- msg 1931: all three phases; review tools wanted.
- msg 1933: `wavesurfer.js`; starting reason list; loudness match, spectrogram and rating in phase 3.
- msg 1939: the operator's FO-MSG-0008 additions accepted, including moving the cheap review tools into phase 1. These are the
  comment, mark at playhead, rating out of 10, blind mode, re-run request and the R-0001 reason list.

ADR: `docs/decisions/0029-generation-plans.md`. Review tools: `MEDIA_REVIEW_TOOLS.md`.

**Reading pass (AGENTS.md §A):**
- Done: ADRs 0023/0025/0026/0028, the media sections of SYSTEM_MAP and ARCHITECTURE, DEVELOPMENT_PLAYBOOK §6, and the
  TECHNICAL_DEBT entries RISK-105/107/108/109/111.
- `docs/PROJECT_SPEC.md` has nothing on media generation beyond the localization MVP's non-goals (§58), which Phase 14 (ADR 0023)
  already superseded for media.

## 1. Model (phase 1)

Everything here lives on one device and is device-local: snapshot device-local list, `notApiData`. Schema v66, additive.

- **Plan** (`generation_plans`):
  - `planId` is chosen by the caller (the operator names plans, e.g. `R-0001-S1-music`) and follows the pattern
    `^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$`; it is unique on the device.
  - Fields: `title`, `channelId` (a connected channel; outputs go to its workspace), `owner` (`factory` | `operator`),
    `budgetUsd?`, `budgetGpuMinutes?`, `status` (`active` | `completed` | `cancelled`), `note`, and the times.
- **Stages** (`generation_plan_stages`): ordered; `stageId`, `title`, `kind`.
  - `in_app`: fed by jobs.
  - `external`: fed by reports.
  - `owner_review`.
  - At most one stage is `in_app` and at most one is `owner_review`.
- **Groups / waves** (`generation_plan_groups`): `groupId`, `title`, `position`, `dependsOn?` (informational), and a free-text
  `note` for the owner's verdict on the whole wave.
- **Items** (`generation_plan_items`):
  - `itemKey`, `groupId?`, `templateLabel` (free text, as imported), `templateId?` (a real template id, checked only when jobs
    are created).
  - `targetCount`, `mode` (`fixed` | `until_accepted`), `maxAttempts?`.
  - **`params`**: the job parameters, as in `create_job`. **`seeds[]`**: one job per seed.
- **Results** (`generation_plan_results`) are only for `external` and `owner_review` stages. One row per
  `(planId, stageId, itemKey, attemptRef)`; a repeated report replaces the earlier one.
  - `result`: `done` | `failed` | `accepted` | `rejected`.
  - `note`, `reportedBy` (`factory` | `owner`).
  - Review fields: `rating` (1–10), `reasons[]`, `markers[]` (`[start, end]` seconds).
  - Validator fields: `auditionFile?`, `checks[]`, `metrics`.
- **Jobs and sessions:**
  - `media_jobs` gains nullable `plan_id`, `stage_id`, `item_key`, `seed`.
  - `media_sessions` gains nullable `plan_id`.
  - **In-app results are read from the jobs, never copied:** job status maps to queued / running / done / failed.
  - A job failed with "interrupted by a server restart" shows as **interrupted** and can be re-run.
  - `attemptRef` for every stage of one attempt is `job:<jobId>` of its generate job. Imported attempts keep their own refs.
- **Derived numbers:**
  - Per stage: planned / queued / running / done / failed / interrupted / accepted / rejected.
  - Spend: the sum over the plan's sessions, `usdCharged` once final, live until then.
  - ETA: the mean duration of finished generate jobs on the **same GPU type** × what is left; "—" below 3 finished.
  - Budget warnings at 80 % and 100 %, computed, never stored.
  - Events for `factory_plan_get`, derived with a `since` cursor:
    - job done / failed;
    - session ready / stopped with `stopReason`;
    - budget thresholds;
    - each verdict;
    - items waiting for review.

## 2. Factory API 1.5.0 (additive)

Every write passes the device mutation gate and is audited as actor `factory`. Error codes: `plan_not_found`, `plan_closed`,
`plan_mismatch`, `plan_invalid`.

- `factory_plan_create`
- `factory_plan_import` (the `ytm-generation-plan/1` file, including the operator's real `plan_status.json`: 47 items, 292 results)
- `factory_plan_update` (title, note, budget; add stages / groups / items; change `targetCount` or `params`; a stage or item with
  results cannot be removed)
- `factory_plan_close`
- `factory_plan_get`
- `factory_plan_list`
- `factory_plan_todo`
- `factory_plan_report` (bulk, ≤ 200 rows per call, ≤ 50 checks per row, note ≤ 2000, detail ≤ 200)
- `factory_plan_run_stage { planId, sessionId, itemKeys? | groupId? }`: creates the jobs still missing (one per unused seed, or up to
  what `targetCount` / `until_accepted` still needs) in a **running session the factory started for this plan's channel**.
- `factory_plan_rerun { planId, sessionId, itemKey, seed? }`
- `factory_plan_clone_group { planId, groupId, newGroupId, title?, paramsPatch? }`
- Optional `planId` / `stageId` / `itemKey` / `seed` on `factory_media_create_job`, and `planId` on `factory_media_start_session`.

The app never starts a session or a job by itself. `run_stage` and `rerun` act only when the operator calls them, inside a
session already approved under the owner's factory limits (ADR 0026).

## 3. Web UI (phase 1)

Production gets a new **Plans** tab, between Jobs and Models:
- Active and History lists.
- Plan detail: the stage bars, groups with their notes, the current session, the last events, and the budget.
- The review screen, which follows `MEDIA_REVIEW_TOOLS.md` group A plus the owner's additions:
  - `wavesurfer.js` player with the waveform, the validator `atSeconds` markers as regions, and "mark at playhead";
  - the review queue, with keyboard shortcuts;
  - Accept / Reject with the reasons list from FO-MSG-0008 §6, a comment, and a rating out of 10;
  - blind mode (toggle, off by default);
  - "ask for a re-run", recorded as an event for the operator. The app does not start anything.
- The audition file route serves by plan + item + attempt only:
  - `auditionFile` is checked through `workspace-exchange`'s `Sent to YTM` helper; the job's own output goes through a new
    `From YTM` helper.
  - Allowlisted audio/image/video types, Range requests, symlinks refused, loopback only.
  - A missing file returns 404 with a message.

## 4. Acceptance criteria (written before the code; tests derive from these)

**Model and tools**
- AC-GP-01: `create` then `get` returns the stages, groups and items as given. A second plan with the same id is refused with
  `plan_invalid`. A bad id pattern, an unknown channel, two `in_app` stages, or an item in an unknown group are each refused, and
  nothing is stored.
- AC-GP-02: `import` of a `ytm-generation-plan/1` file with free-text template labels (e.g. `"a / b"`) and imported attempts
  stores them. Counts per stage equal the file's results, e.g. generate done 96, owner_review accepted 19 / rejected 37 for the
  real file. A second import of the same planId is refused.
- AC-GP-03: `report` is idempotent: the same `(plan, stage, item, attemptRef)` twice gives one row with the second value.
  Reports are refused with `plan_mismatch` when:
  - the stage is `in_app`;
  - the item is unknown;
  - the plan is closed (`plan_closed`).

  Bounds are enforced: 201 rows, 51 checks or a 2001-char note → `validation_failed`, nothing stored. A check's `pass` and
  `severity` are kept independently.
- AC-GP-04: `auditionFile` must be relative, with no `..`, no `\` and no leading `/`; anything else is refused at report time.
- AC-GP-05: `close` changes only the status. Jobs, sessions and files stay. Every write on a closed plan → `plan_closed`.
- AC-GP-06: `update` cannot remove a stage or item that has results. It can raise or lower `targetCount` and change `params`.
- AC-GP-07: `todo` lists:
  - items short of target, counting accepted for `until_accepted` and done for `fixed`;
  - items waiting for owner review (validator accepted, no owner verdict);
  - failed or interrupted attempts not re-run.

**Job linkage**
- AC-GP-08: a job created with plan fields stores them, and the plan's generate counts follow the job status with no extra call:
  queued → queued, generating → running, done → done, failed → failed, "interrupted by a server restart" → interrupted.
- AC-GP-09: `run_stage` creates exactly the missing jobs:
  - `fixed`: one per seed not yet used; without seeds, up to `targetCount` minus existing non-failed attempts.
  - `until_accepted`: while accepted + open < target and attempts < `maxAttempts`.

  Each job carries the item's `params` (plus `seed` when the template has a seed parameter). Every job is in the given session.
- AC-GP-10: `run_stage` / `rerun` are refused with `plan_mismatch` and create **no job** when:
  - the session is not running or not the factory's;
  - the session's channel ≠ the plan's;
  - the plan is closed;
  - the item or group is unknown;
  - the template id is missing or unknown;
  - the item's params fail the template's validation.

  The check runs before the first job, so it is all or nothing.
- AC-GP-11: spend counts each of the plan's sessions once (`usdCharged` when final), and the 80/100 % warnings appear exactly when
  crossed. ETA uses only same-GPU-type durations, and is "—" below 3.
- AC-GP-12: `clone_group` copies the items with new keys (`<newGroupId>/<rest>`), applies `paramsPatch`, copies no results, and sets
  `dependsOn` to the source group.

**Review and UI**
- AC-GP-13: the owner's verdict is stored with `reportedBy: owner`, rating 1–10, reasons, markers and a comment. The operator can
  read it in `factory_plan_get`. A relayed factory verdict shows as reported by the factory.
- AC-GP-14: the audition route serves only a file that belongs to the plan's item/attempt:
  - another plan's attempt, a path in the query, a symlink, or a disallowed type → refused;
  - `Range: bytes=0-99` → 206 with exactly 100 bytes;
  - a missing file → 404 with a message.
- AC-GP-15: Production tab order becomes Sessions, Jobs, **Plans**, Models, Templates, Setup (`production-panel.test.ts`,
  justified by this plan).

**Independence (§M)**
- AC-GP-16: `media-generation` imports nothing from `generation-plans`. With the plans module absent from the wiring, every media
  test passes unchanged.

## 5. Slices (one branch `feature/generation-plans-phase-1`, one merge)

1. Schema v66 + `src/lib/generation-plans/` core + the factory tools without job linkage (create / import / update / close / get /
   list / todo / report). AC-01..07.
2. Job and session linkage, `run_stage` / `rerun` / `clone_group`, spend / ETA / events, `planId` on start_session. AC-08..12, 16.
3. Plans tab: list, detail, groups, history. AC-15.
4. Review screen + audition route + `wavesurfer.js`. AC-13, 14.

Phase 2 (other devices: a `generation-plans` sync family, read-only plans, verdicts from any device) and phase 3 (notices and
badge, agent read tools, loudness match, A/B against the library, spectrogram, loop region) get their own plans when phase 1 is
merged.

## 6. Risks

- **RISK-109 grows:** `run_stage` creates N jobs per call, still only inside a session the factory limits allowed.
- **RISK-107:** an interrupted job is visible as such and can be re-run.
