# BL-124 acceptance criteria — send approved changes from the Languages tab

Written **before** implementation (AGENTS.md §L) from the owner's instruction (Telegram, 2026-10-04), `docs/PROJECT_SPEC.md`
(batch idempotency §22, write safety §21/§27/§30), ADR 0005/0016/0020. Expected values are computed by hand from the fixture below.

## Fixture F (one channel `UC_A`, change set `CS1`, language `es`)

| change | video | field | approval | validation | conflict |
|---|---|---|---|---|---|
| c1 | v1 | title | approved | valid | none |
| c2 | v1 | description | approved | valid | none |
| c3 | v2 | title | approved | valid | none |
| c4 | v2 | description | pending | valid | none |
| c5 | v3 | title | rejected | valid | none |
| c6 | v3 | description | approved | invalid | none |
| c7 | v4 | title | approved | valid | conflict |
| c8 | v5 | title | approved, then `proposedValue` edited (approvedValue differs) | valid | none |

Sendable = {c1, c2, c3}. Expected batch: 1 live batch, `dryRun=false`, **2 ledger rows** (v1 with `[c1,c2]`, v2 with `[c3]`).

## Criteria

- **AC-SEND-01 (selection).** Sending `CS1` creates exactly the batch above. c4, c5, c6, c7, c8 are in no ledger row and in no payload.
- **AC-SEND-02 (toggle off).** With Live writes off the send route answers the named error `live_writes_disabled` (HTTP 503), creates **no** batch and no ledger row, and the YouTube write gateway receives 0 calls.
- **AC-SEND-03 (nothing to send).** A change set with 0 sendable changes (e.g. only c4..c8) answers `send_nothing_to_send` (HTTP 409) and creates no batch.
- **AC-SEND-04 (channel scoping).** Sending `CS1` through the route for another channel `UC_B` (even with a valid session) is refused (`change_set_not_found`, 404), creates no batch. A route for a channel that is not the session's active channel is refused by `assertActiveChannel` before anything else.
- **AC-SEND-05 (edited after approval).** If c1's `proposedValue` is edited after approval (so `approvedValue != proposedValue`, as c8), c1 is not selected; if the edit happens **between** the batch creation and the write, the executor's per-row `isApprovalStillValid` re-check fails that row (no write for that video), as already guaranteed by AC-BATCH-03.
- **AC-SEND-06 (one batch per click).** Two `send` calls issued concurrently for `CS1` produce exactly **1** batch; the second answers `send_already_in_progress` with the first batch's id (HTTP 409). A third call made after the first batch reached a terminal state (COMPLETED/ABORTED) creates a new batch.
- **AC-SEND-07 (pipeline unchanged).** After `send`, executing the returned batch through the existing execute path with a fake gateway writes exactly 2 `videos.update` calls (v1, v2), each containing only `snippet.localizations.es.title/description` for its own change ids (and no other field); a video with an existing unrelated localization keeps it (AGENTS §F).
- **AC-SEND-08 (partial failure is not settled).** If v2's write fails, the batch has ledger statuses `SUCCESS` (v1) and `FAILED` (v2); the summary and the pop-up report 1 written / 1 not written; BL-125's planner keeps the set and the batch (not purged).
- **AC-SEND-09 (interruption).** A live batch left `PENDING` (browser closed between send and execute) writes nothing; a new send click returns `send_already_in_progress` with its id, executing that id completes it with exactly 2 writes. A batch interrupted after v1 was written resumes with 1 further write (v2), never a second write for v1 (existing AC-RESUME-01 behaviour, re-verified through this entry path).
- **AC-SEND-10 (no new write call site).** `write-path-inventory.test.ts` stays green without any new allowlist entry: the send route and the Languages UI never reference `executeBatch`, `WriteExecutor` or `createLiveWriteExecutorIfEnabled`.
- **AC-SEND-11 (UI).** In the Languages change-set review a button "Send approved to YouTube" is enabled only when the set has ≥1 approved change; clicking it opens a progress pop-up showing rows done/total, failed/conflict rows, and a Cancel button (ADR 0016); with Live writes off the pop-up shows "Live writes is off — nothing was sent" and no batch exists; on success the pop-up shows the success state with "N written"; the resulting batch and its log are visible on the Batches tab. No native `confirm/alert/prompt` is used.
- **AC-SEND-12 (quota).** A quota refusal from execute (BL-117) is shown with the existing quota dialog (split / run anyway), not as a generic error.
