# Send approved changes from Languages + retention of settled drafts (BL-124, BL-125)

Owner requests 2026-10-04 (Telegram), answers to questions A/B and the retention proposal.
Status: **plan only, not assigned for implementation yet.**

## Decisions already given by the owner

1. After approving changes in the Languages UI there is a **"send approved changes to YouTube" button** (no trip to Batches).
2. The button opens a **progress pop-up**. If the **Live writes toggle is off**, nothing is written and the pop-up says so.
3. A batch with a failed row, a conflict or a verification mismatch is **not "settled"**; nothing about it is deleted until the owner decides (answer B: agreed).
4. The write uses the **same gateway and the same safety chain** as Batches (identity check, backup, diff, conflict check right before the write, ledger, read-back verification). The ledger and write log stay **visible on the Batches page**.
5. **Retention, two settings** (Settings tab):
   - settled drafts (rejected change sets; approved change sets whose batch completed with verification passed): default **7 days**;
   - write log / batch ledger and audit: default **30 days, minimum 7** (cannot be set lower).
   `in_review` and `canceled` are never purged.
6. Deletion must **not come back through device sync**.
7. Compaction of the Automerge file is a future task: RISK-100.

## Design

### BL-124 — "Send to YouTube" button (UI orchestration over the existing batch pipeline)
- One server route, e.g. `POST /api/channels/[id]/change-sets/[csId]/send`, that creates a batch from that set's approved changes and runs prepare -> execute through the **existing** batch services. No second write path: the batch services already call the single write gateway (ADR 0005) and `assertLiveWritesAuthorized`.
- With Live writes off the route answers with a named code (the pop-up shows it); no batch is executed. (Today a batch created while the toggle is off is dry-run only; keep that rule.)
- Progress pop-up polls the existing batch/ledger read (rows done / total, failed, conflicts). Cancel stays available (existing `cancel`).
- "Approved = may write" removes only the second human click; each change stays approved + valid + conflict-free at write time (`isApprovalStillValid` unchanged). Approval integrity (a change edited after approval is not written) is unchanged.
- Needs: an ADR amendment (the batch no longer needs its own manual execute click on this path), spec reference update, acceptance criteria written **before** code (AGENTS §L): toggle off -> no write; wrong channel -> refused; changed-after-approval -> skipped; partial failure -> not settled; interrupted -> resumable with no duplicate write; double click -> one batch.

### BL-125 — Retention
- Settings: two integers with validation (`7 <= ledgerDays`; drafts >= 1). Stored with the other settings.
- A sweep (same pattern as `sweepExpiredResearchExports`, runs at startup and periodically) that:
  1. deletes settled drafts (set + its changes + provenance) from the **Automerge document** with a real delete and re-projects SQL;
  2. deletes ledger/audit rows older than the ledger setting, **only** for batches that are settled.
- "Settled" = rejected set, or approved set whose batch is `COMPLETED` with no failed/conflict/unverified row. Anything else is kept.
- Sync: a delete inside the shared document merges as a delete on the other device; the old records are not re-introduced by merging a peer that never touched them. A peer that **edited** a record concurrently with the delete can keep that record; this is acceptable (the owner has not decided on it) and is covered by a test.
- Tests (independent of the implementation): two-device merge after purge; purge never touches in_review/canceled; partial-failure batch kept; setting below 7 days refused; purge idempotent; a purged set stays gone after restart and re-projection.

## Slices
1. Retention settings + sweep (BL-125) — independent, low risk.
2. Send button + progress pop-up + Live-writes-off message (BL-124) — safety-critical, needs the ADR amendment, acceptance criteria and independent review; merge only with the owner's explicit yes.
3. Batches page shows the write log with retention (can ride with slice 1).

## Open points (to confirm when assigned)
- Which "settled" ledger rows the 30-day log covers when the batch is still referenced by a kept change set.
- Whether the sweep needs a "dry list" in Settings ("what will be deleted next") — recommended, cheap.
