# Re-checks of rated tracks: a fixed version, or a question about one spot (BL-173, FO-REQ-0017)

**Status: IN PROGRESS** on `feature/fo-req-0017-rechecks`. Owner, Telegram 2026-10-10 msg 2516 («Ок») to "Берём в работу
(BL-173)?" after DEV-RESP-0020 (the proposal this plan builds). One branch, two review rounds, then the owner's merge decision.

## 1. Facts (code read 2026-10-10, `dev` 207acf8; the Mac's database read-only)

- **Result rows** are keyed (plan, stage, item, attempt) and a repeat replaces every column (`upsertGenerationPlanResults`). A revised
  file reported as a row would overwrite the original's checks, or (new `attemptRef`) count as a new attempt with no link.
- **Waiting** = no row at the owner-review stage (`progress.ts` `reviewCandidates`); a rated attempt never comes back.
- **Relayed rows** at the review stage are refused once the owner rated (`report`, `plan_mismatch`).
- **Owner verdicts**: `recordOwnerVerdict` writes the review-stage row and a `generation_plan_verdict_history` row (v69);
  `owner_verdict` events are derived, one per history row. `applyPeerVerdicts` applies verdicts given on another computer
  (`generation_plan_peer_verdicts`, carried in the plans report). Report version 3 (BL-162); every level of the report is strict.
- **Playback**: `resolveAudition` plays the latest stage's `auditionFile` (relative to the channel's `Sent to YTM/`), else the job
  output; the A/B switch of the review screen plays a plan reference as B at the same position, loudness-matched.
- **Live data**: plan `R-0001-S1-music` is active on the Mac; C14/V04 `job:8c4a4827…` (validator accepted, owner rejected 2026-10-09);
  C14/V03 `job:22b11bf2…`, V05 `job:4dc29700…`, V06 `job:a92befa1…` accepted by the owner. `C14-XL_V04_s1811__r1.mp3` is next to the
  original in the Japan workspace.
- **Delivery to `01 Audio`** is not in this repository; the Operator copies files. YT Manager only names the current file.

## 2. Design

### 2.1 The re-check record (schema v82, device-local, on the plan's owning computer)

`generation_plan_rechecks` (PK `plan_id, recheck_id`): `item_key, attempt_ref, kind (revision | question), title, note,
audition_file, markers_json, checks_json, metrics_json, previous_verdict_json, status (open | answered | withdrawn), opened_at,
closed_at (ms), answer_json, withdraw_note, close_reason`.

- `previousVerdict`: the attempt's current verdict when the re-check opened (result, rating, reasons, markers, note, device, at).
- `answer`: `{ result, kept, rating, reasons, markers, note, device, at }` of the answer that closed it.
- `generation_plan_verdict_history` and `generation_plan_peer_verdicts` gain `recheck_id TEXT` and `kept INTEGER`. One migration:
  `CREATE TABLE IF NOT EXISTS` plus four `ALTER TABLE … ADD COLUMN`, each behind the `isDuplicateColumnError` guard (the v68 pattern),
  so a half-applied run converges. The new table is classified like `generation_plan_verdict_history` (`notApiData`; device-local
  in the snapshot contracts); the schema pin in `db-merge-numbering.test.ts` becomes 82.

### 2.2 Factory tools (Factory API 1.11.0, writes, device gate, actor `factory`)

- `factory_plan_request_recheck { planId, itemKey, attemptRef, recheckId, kind, title (<= 60), note (<= 1000), auditionFile?,
  markers? (<= 50), checks? (<= 50), metrics? (<= 50) }` -> `{ recheck }`.
  - `recheckId`: `[A-Za-z0-9][A-Za-z0-9._-]{0,119}`, unique within the plan. Same id and same content again -> the stored one
    (idempotent); different content -> `plan_recheck_exists` (409).
  - Refused: plan closed (`plan_closed`) or not here (`plan_not_found`); unknown item or attempt, no verdict at the review stage
    (own, relayed, or a verdict from another computer waiting to be applied -- `pendingPeerVerdicts`, so the test wires `peers`),
    an open re-check on the attempt, a revision without
    `auditionFile`, a question with one (`plan_mismatch`); a file not found under the channel's `Sent to YTM/` or of a type the
    player does not serve (`plan_invalid`).
  - Event `recheck_requested { recheckId, kind, itemKey, attemptRef, title }`.
- `factory_plan_withdraw_recheck { planId, recheckId, note? }` -> `{ recheck }`: open -> withdrawn, event
  `recheck_withdrawn { recheckId, note? }`. Not open -> `plan_recheck_closed` (409, details: status).

### 2.3 The owner's answer

- Web: `POST /api/generation-plans/[planId]/recheck { recheckId, kept?: true, result?, rating?, reasons?, markers?, note? }`; another
  computer's plan: `POST …/peers/[deviceId]/[planId]/recheck` (carried as a peer verdict with `recheckId`, applied on the owner's tick).
- **Verdict answer** (a revision; a question's "Change"): `result` required. Under the plan lock: the current verdict is seeded into
  the history if needed, the review-stage row is replaced (reportedBy owner), a history row with `recheckId` is added, the re-check
  becomes `answered`, event `recheck_answered { recheckId, kind, kept: false, result, device }`. No `replace` question: the re-check is
  the request. No `group_reviewed` (the attempt was already reviewed, so no wave's waiting count changes).
- **Keep answer** (question only): `kept: true`, only `note` beside it. The row is untouched; a history row with `kept` and
  `recheckId` keeps the note (result = the current verdict's, rating null); it gives **no** `owner_verdict` event and moves no count;
  event `recheck_answered { recheckId, kind, kept: true, note? }`.
- A re-check that is not open -> `plan_recheck_closed`. The answer ends this computer's claim on the track.
- A normal re-rating of the same track (its wave, `replace: true`) leaves an open re-check open.
- **Where a kept history row must be told apart** (it is a note, not a verdict; `result` stays the accepted/rejected enum, `kept` is
  a flag, never a new result value):
  - `historyEntryOfVerdict` skips kept rows (the current verdict's device is never a kept answer's);
  - `planEvents` gives no `owner_verdict` for a kept row;
  - `historyOf` keeps kept rows among the shown 10 (the owner sees the note), marked;
  - `pendingPeerVerdicts` ignores verdicts with a `recheckId` (they are re-check answers, §2.7);
  - `applyPeerVerdicts` never weighs a kept answer as "newer/older than the stored verdict": it never replaces the row;
  - `seedHistory` only reads the result row, never a history row: unaffected.

### 2.4 Current file

- An attempt's current file = the `auditionFile` of its newest re-check of kind revision whose answer accepted it (not kept), else
  what `resolveAudition` played before. `resolveAudition` (the attempt's player everywhere) plays it.
- `GET …/[planId]/recheck-audition?recheckId=` plays a re-check: the revised file, or for a question the attempt's current file.
  Peer variant from the report.

### 2.5 Reads

- `factory_plan_todo`: `rechecks: [{ recheckId, kind, itemKey, attemptRef, openedAt }]` (open only).
- `factory_plan_get` / list / the owner's plan views: `progress.rechecksOpen`, `progress.groups[].counts.rechecks` (open per wave);
  `factory_plan_get` also `progress.rechecks[]`: every re-check with status, answer and `currentFile` of its attempt.
- Events: `recheck_requested`, `recheck_answered`, `recheck_withdrawn` (recorded); `owner_verdict` from a history row with a
  `recheckId` carries it; a `kept` row gives none.
- `waitingReview`, the notices, the badge and the channel summary do not count re-checks.

### 2.6 Moving and closing

- `movePlan` is refused (`plan_invalid`, `reason: recheck_open`) while a re-check is open; its file check includes every
  re-check's `auditionFile`.
- Closing a plan withdraws its open re-checks: `recheck_withdrawn { recheckId, reason: "plan_closed" }`.

### 2.7 Two computers (plans report version 4)

- The shared plan carries `rechecks` (the open ones, with what the screen shows); a shared review entry carries `currentFile` when
  it differs from its reported file; history entries and peer verdicts carry `recheckId` / `kept`. Read 1-4; a version 3 build
  refuses version 4 ("update the app").
- A re-check answer from another computer: refused unless that computer's report lists the re-check open, or one was already sent
  from here (`plan_recheck_closed`). Applied on the owning computer's tick:
  - open re-check -> applied as in §2.3 (a verdict answer older than the stored verdict goes to the history only);
  - already answered -> a verdict answer is applied like any peer verdict (newest wins, the same rule as BL-157 AC-TC-05; both stay
    in the history), a kept one to the history only; both keep `recheckId`. The re-check's stored `answer` stays the first one
    (the row follows the newest verdict anyway);
  - withdrawn -> history only, the verdict does not change.
  Each is handled once (`peer_verdict` event with `verdictId`, now also `recheckId`).
- Pending on the owning computer: an answer sent from another computer and not applied yet shows the re-check as "answered on
  <computer>, being applied" and it no longer counts as open. Pending re-check answers are not pending verdicts (no `replace`
  question for the track).
- Claims: the track claim (plan, item, attempt) as for any track; `claimReview` also accepts an attempt named by an open re-check.
- An answer sent from here is one of this computer's outgoing verdicts: a later ordinary re-rating of the same track from here asks
  "already rated here -- replace?" (`recordPeerVerdict`), as after any verdict sent from here. Intended, not a leak.

### 2.8 Screen (Media → Review)

- The wave picker gets «Повторные проверки (N)» above the waves (id `~rechecks`; `?wave=~rechecks` opens it). Re-check entries never
  mix into a wave's list or its counts.
- Each entry: «Исправлено: <title>» / «Вопрос: <title>», the Operator's note, the previous verdict (result, rating, reasons, note,
  markers).
- Revision: plays the fixed file (A); the A/B switch offers «Было» (the attempt's current file) as B, at the same position,
  loudness-matched (A's loudness from the revision's metrics, else measured). The entry's `stages` = the attempt's own rows, then
  one row `{ stageId: "recheck", result: "done", checks/metrics of the revision }` when the revision has checks or metrics; the
  middle column labels that row «Исправленная версия».
- Question: plays the attempt's current file. The entry's `stages` = the attempt's own rows, then -- when the current file is an
  accepted revision -- that revision's `recheck` row (the validator never saw the revision otherwise). The markers on the waveform
  and one button per marker («к 0:25»).
- Answers: revision -- Accept / Reject with rating, reasons, marks, note; question -- «Оставить оценку» (note optional) or
  Accept / Reject as a changed verdict. No "Replace?" dialog for re-checks.
- The plan card shows «Повторные проверки: N» (opens the screen on them); the history lines name re-check answers and kept ones.
- Every new text in English and Russian.

## 3. Acceptance criteria (fixed before the code)

- **AC-RC-01 Open a revision.** On an attempt the owner rejected, `factory_plan_request_recheck` (kind revision, `__r1` file present)
  stores an open re-check with `previousVerdict` = that verdict; event `recheck_requested`; todo lists it; the validate and
  postprocess rows and the review-stage row are unchanged (deep-equal before/after).
- **AC-RC-02 Refusals.** Each refusal of §2.2 with its code, and nothing stored: unknown attempt; attempt without a verdict; second open
  re-check on the attempt; revision without file; question with file; missing file; closed plan; same id with other content
  (`plan_recheck_exists`). Same id and same content returns the stored re-check and records no second event.
- **AC-RC-03 Revision answer.** Accepting it: review-stage row becomes accepted (reportedBy owner); history = [the 2026-10-09-style
  rejected verdict unchanged, the new one with `recheckId`]; events have `owner_verdict { recheckId }` and `recheck_answered`;
  re-check `answered`; no `group_reviewed`; the item's accepted count +1; `resolveAudition` now names the `__r1` file;
  `progress.rechecks[0].currentFile` is it.
- **AC-RC-04 Question kept.** Opening `…__q1` (marker 25-35 s) and answering Keep with a note: the row is unchanged (still accepted,
  same rating), a history row with `kept` and `recheckId` holds the note, no new `owner_verdict` event, `recheck_answered
  { kept: true, note }`, counts unchanged; the question plays the attempt's current file.
- **AC-RC-05 Question changed.** Changing the verdict to rejected replaces the row, history keeps both, `owner_verdict { recheckId }`.
- **AC-RC-06 Answer refusals.** A withdrawn or answered re-check refuses an answer (`plan_recheck_closed`); a revision refuses Keep;
  a verdict answer without `result` is refused (`validation_failed`).
- **AC-RC-07 Withdrawal.** Withdraw -> status withdrawn, gone from todo and the screen's list, event `recheck_withdrawn`; a second
  withdraw -> `plan_recheck_closed`.
- **AC-RC-08 Counts.** An open re-check counts in `rechecksOpen` and its wave's `counts.rechecks`, never in `waitingReview`, the
  `review_waiting` notice or the summary.
- **AC-RC-09 Move and close.** Move refused while open; closing withdraws with `reason: plan_closed`.
- **AC-RC-10a Report v4.** A version 4 report with `rechecks`, `currentFile`, history and verdicts with `recheckId`/`kept`
  validates; version 5 is refused; a version 3 report (no such fields) still reads.
- **AC-RC-10b Peer answers.** On the other computer, a kept and a verdict answer are stored with `recheckId`/`kept` and listed in
  its outgoing verdicts; a second answer to the same re-check from there is refused (`plan_recheck_closed`); on the owning computer
  each is applied exactly once (a second tick changes nothing) as in §2.3.
- **AC-RC-10c Pending.** Before the owning computer applies a peer answer, its own review view shows the re-check pending
  ("answered on <computer>") and not open; the pending answer is not a pending verdict for the track.
- **AC-RC-10d Withdrawn.** A peer answer to a withdrawn re-check goes to the history (with `recheckId`) and changes no row.
- **AC-RC-11 Compatibility.** Existing tests unchanged: `factory_plan_report`, `plan_verdict_exists`/`replace`, relayed rows, events,
  `group_reviewed`; history rows without `recheckId` read as before; `historyEntryOfVerdict` never picks a kept row.
- **AC-RC-12 MCP.** Both tools in the allowlists (write), strict inputs, version 1.11.0; the endpoint maps them to the core with actor
  factory; neither matches the read-tool rule.
- **AC-RC-13 Screen helpers.** The pure helpers: re-check entries built from a queue and re-checks (own and peer), the picker's
  re-check option and count, the marker buttons, history labels -- tested; the screen checked in Chrome on the Mac after the merge.

## 4. Changed while building (2026-10-10)

- **Error codes** are `plan_recheck_exists` and `plan_recheck_closed` (409), following `plan_verdict_exists`; DEV-RESP-0020 wrote
  `recheck_exists`. The DEV-REL names them.
- **`currentFile`** in `progress.rechecks[]` is never null for an attempt with a reported file: the accepted revision's file, else
  the attempt's latest reported `auditionFile` (null only when the attempt has nothing but its job output) -- the file to deliver.
- **`plan.review` on the screen of the other computer** may not hold an attempt beyond the report's 500 entries; its re-check entry
  then shows without the attempt's own rows (the re-check's own data is complete).

## 5. Build order

1. Contracts, schemas, DB (v82), store adapter, services (open, withdraw, answer, current file, counts, move/close), events.
2. Sync report v4 (schemas, share, peer answers, apply, pending).
3. Routes (answer, recheck-audition, peers), MCP tools, endpoint.
4. Screen, plan card, texts (en/ru).
5. Docs: interfaces, SYSTEM_MAP, ARCHITECTURE, TECHNICAL_DEBT (RISK-119 -> report v4), BACKLOG, ROADMAP_STATUS; DEV-REL after merge.
