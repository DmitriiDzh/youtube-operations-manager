# BL-198 — Send several change sets together, and a "Written to YouTube" category

**Assigned by** the owner, Telegram 2026-10-18: msg 2996 (request), msg 2998 (my proposal), msg 2999 (answers A/B/C).
Builds on ADR 0020 (one-click send) and DEC-OQ-1 (one ledger row per video).

## Why

Quota is charged per API call, not per field: one video costs `UNITS_PER_WRITTEN_VIDEO` = 52 units whether its row carries
1 language or 10. Today the Languages tab sends one change set per batch. Two change sets touching the same videos therefore
cost two writes per video. The data model already allows one row per video holding changes from several sets
(`createBatch` checks only that each change belongs to the row's video). Only the UI and the send service are tied to one set.

## Scope (owner's answers)

1. **Send together, Languages tab.** Tick several change sets in «Одобренные» → «Отправить вместе». A summary shows videos,
   languages, changes and estimated quota. Confirming creates one live batch with one row per video carrying every selected
   set's sendable changes, then runs it through the existing execute route and progress pop-up (ADR 0020 unchanged).
2. **Send together, Batches tab.** Step 1 can tick several change sets. "Create batch from selected sets" uses the same
   server service, so the same summary and conflict window apply. Dry run stays available there.
3. **Merge-conflict window (answer A).** When two selected sets change the same target, nothing is created. Instead a window
   lists each conflict and the owner picks which set's variant goes into the batch. The variants not chosen are **rejected**
   (`approvalStatus: rejected`), so they can never be sent later and overwrite the chosen one. The rejection is recorded as a
   `MERGE` audit event on the new batch's affected rows.
4. **No merging of already created batches (answer B).** Dropped.
5. **«Одобренные» = waiting to be sent (answer C).** A change set all of whose approved changes are written and verified moves
   to a new sub-tab «Записаны в YouTube». A partly written set stays in «Одобренные» with «записано N из M».

## Definitions

- **Sendable change** (unchanged, ADR 0020 §2): approved, valid, no conflict, and `isApprovalStillValid`, minus changes already
  written (a SUCCESS row of a real batch at least as new as the change's `updatedAt`, `excludeAlreadyWritten`).
- **Target** of a change: `(videoId, language lower-cased, field)`.
- **Merge conflict**: within one video and language, changes from two or more different selected sets where either
  - two of them have the same field, or
  - one of them is a `delete` (a delete removes the whole language, so it collides with any change of that language).
  Changes from different sets for different fields of the same language, neither a delete, do not conflict. They go into the
  same row (the payload builder already merges them).
- **Conflict unit** shown to the owner: one `(video, language)` with its options, one option per set. Each option is that set's
  changes for that video and language (title / description / delete).
- **Resolution**: for each unit, the chosen `changeSetId`. Every change of the other sets in that unit that conflicts with the
  chosen option is rejected. A same-field change conflicts; with a delete on either side every change of that language conflicts.
- **Written change set**: at least one approved change, and every approved change in it is written (as defined above).

## Server

- `src/lib/batches/send-approved.ts`:
  - `planSendTogether({ channelId, changeSetIds })` is read only and returns:
    - `{ videoCount, changeCount, languageCount, estimatedUnits, conflicts[] }`, with `estimatedUnits = videoCount × UNITS_PER_WRITTEN_VIDEO`;
    - each conflict as `{ videoId, videoTitle, language, options: [{ changeSetId, changeSetLabel, changes: [{ changeId, field, changeType, proposedValue }] }] }`;
    - `nothingToSend`, when that applies.
  - `createBatchForChangeSets({ channelId, changeSetIds, resolutions, dryRun })` runs these steps in order:
    1. Live writes check first, only when `dryRun` is false; it fails with `live_writes_disabled` as today.
    2. Takes the same per-channel lock as today, so creation is serialized.
    3. Checks every set exists and belongs to the channel.
    4. Selects the sendable changes. An unresolved conflict fails with `send_merge_conflicts`, carrying the plan's `conflicts`.
       A resolution that names a set outside the unit's options fails with `validation_failed`.
    5. Runs the in-flight check (`send_already_in_progress`).
    6. Live only: rejects the losing changes through the changesets service, which recomputes each set's status.
    7. Calls `createBatch`.
    8. Records a `MERGE` audit event per affected row: `{ changeSetIds, keptChangeSetId, rejectedChangeIds }`.

    A dry run never rejects anything. Losers are left out of its selection instead.
  - `createLiveBatchForChangeSet` (one set) delegates to it with one id. Behaviour unchanged, since one set has no
    cross-set conflicts.
- `createBatch` gains a defence-in-depth guard. A row whose change ids contain two changes for the same target, or a delete
  plus any other change of the same language, fails with `duplicate_target_in_row`. This also covers the Batches tab's
  manual checkbox path, where `buildSafeLocalizationsPayload` would otherwise let the last change win silently.
- Routes (session, `assertActiveChannel`, same error mapping as the single send route):
  - `POST /api/channels/[channelId]/change-sets/send-together/plan` with `{ changeSetIds }` returns the plan.
  - `POST /api/channels/[channelId]/change-sets/send-together` with `{ changeSetIds, resolutions?, dryRun? }` returns 201
    `{ batchId, changeCount, videoCount, rejectedChangeIds }`.
- Change-set list: each set gets `sendableCount` and `writtenCount` (approved changes written), computed on the server from
  the channel's batches. The Languages sub-tab filter uses them.

## UI

- `SendApprovedButton`'s create-and-run logic is extracted into a hook. The single-set button and the new "send together"
  action share it: create, then execute and show progress; `send_already_in_progress` attaches to the existing batch; the
  quota block and split behave as today.
- Languages: the «Одобренные» list gets a checkbox per set and the action «Отправить вместе (N)». It opens the summary dialog;
  with conflicts it opens the conflict window, one row per unit with a radio choice per set showing that set's proposed values.
  «Отправить» is enabled once every unit is resolved.
- New sub-tab «Записаны в YouTube». «Одобренные» shows approved or partly approved sets that are not fully written, with
  «записано N из M» when N > 0.
- Batches tab step 1: checkboxes on the change-set buttons, plus «Создать пакет из выбранных наборов» with the same dialog and
  a dry-run choice. The existing single-set step 2 with per-change checkboxes stays.
- Every text is in `en` and `ru` (BL-152).

## Acceptance criteria

Each expected value comes from the definitions above.

- **AC-ST-01**: sets A (es title + es description for v1, v2) and B (fr title for v1, v2, v3) produce one batch with 3 rows:
  v1 with 3 change ids, v2 with 3, v3 with 1. The plan says `videoCount` 3, `changeCount` 7, `languageCount` 2,
  `estimatedUnits` 156.
- **AC-ST-02**: A has es title for v1 and B has es title for v1, both sendable. Without resolutions the create call fails with
  `send_merge_conflicts` and creates no batch. The conflict is unit (v1, es) with options A and B.
- **AC-ST-03**: in that case, resolving with B creates a batch whose v1 row holds B's change only. A's es-title change is
  `rejected` afterwards, and set A's status is recomputed.
- **AC-ST-04**: A deletes `de` for v1 and B has a de title for v1. They conflict even though the fields differ. Choosing A
  rejects B's de title; choosing B rejects both of A's de delete changes (title and description).
- **AC-ST-05**: A has an es title for v1 and B an es description for v1. No conflict; one row with both.
- **AC-ST-06**: a dry run with a resolution rejects nothing and leaves the losers out of the batch.
- **AC-ST-07**: with Live writes off, a live create fails with `live_writes_disabled`, rejects nothing and creates nothing. A
  dry run is still allowed.
- **AC-ST-08**: a set from another channel, or unknown, fails with `not_found` and nothing changes.
- **AC-ST-09**: changes already written are not sent again. A selection with nothing left fails with `send_nothing_to_send`.
- **AC-ST-10**: changes held by a live PENDING/RUNNING batch fail with `send_already_in_progress` and its `batchId`. No losers
  are rejected.
- **AC-ST-11**: `createBatch` with a row holding two es-title changes, or a de delete plus a de title, fails with
  `duplicate_target_in_row`.
- **AC-ST-12**: written-set classification:
  - 2 approved changes, both with a newer SUCCESS row of a real batch: written, shown under «Записаны в YouTube»;
  - 1 of 2 written: «Одобренные», written 1 of 2;
  - a dry-run SUCCESS does not count;
  - a change edited after its write is not written.
- **AC-ST-13**: the single-set send still behaves as before (the existing AC-SEND tests stay green, unchanged).
- **AC-ST-14**: a resolution naming a set outside the unit, or a unit left unresolved while others are resolved, fails with
  `validation_failed` / `send_merge_conflicts`; nothing is rejected or created.

## Not changed

The executor, the write gateway, Live writes Layers 1 and 2, backup, the pre-write conflict check, read-back verification,
the quota guard and split, cancel, and the write scope (title/description per language plus the existing default-language
exceptions). No schema change: the `MERGE` audit event uses the existing `audit_events` table, whose `event_type` is free
text.
