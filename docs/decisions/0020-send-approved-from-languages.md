# 0020. Send approved changes to YouTube from the Languages tab (one click, same batch pipeline)

Status: Accepted

**Date:** 2026-10-04.

**Assigned by** the owner (Telegram, 2026-10-04, answers to questions A/B): after approving changes in the
Languages UI there is a button that sends the approved changes to YouTube without a trip to the Batches tab,
a progress pop-up opens, and with the Live writes toggle off the task is blocked and the pop-up says so.
Plan: `docs/roadmap/plans/DRAFT_SEND_AND_RETENTION_PLAN.md` (BL-124).

## Context

Today a live write needs two deliberate human steps in two places: approve changes (Languages) and then, on
the Batches tab, create a live batch and press Execute (or "Send all approved", which asks for a confirmation
dialog). The owner considers the second step a repeat of the approval ("Approved means it may be written").

## Decision

1. **Only the second manual step is removed, and only on this path.** A new route
   `POST /api/channels/[channelId]/change-sets/[changeSetId]/send` selects, on the server, the change set's
   sendable changes and creates a **live batch** from them through the existing `createBatch` service. The
   Languages UI then runs the **existing** `POST .../batches/[batchId]/execute` route and polls the existing
   batch read for the progress pop-up. There is no new write call site: the executor, the single write gateway
   (ADR 0005) and `assertLiveWritesAuthorized` are unchanged, `execute/route.ts` stays the only file allowed to
   reference live-write symbols (`write-path-inventory.test.ts` is untouched and still green).
2. **A change is sendable** only if it is `approved`, `valid`, `conflictStatus none` and passes
   `isApprovalStillValid` (the frozen `approvedValue` still equals `proposedValue`). Pending, rejected,
   invalid, conflicting and edited-after-approval changes are never selected. The selection is made on the
   server from the stored change set, never from a list the browser sends.
3. **Live writes off => nothing is created.** The send route refuses first with the named error
   `live_writes_disabled` (no batch row is created). The execute route keeps its own Layer 1 and Layer 2
   checks, so a toggle flipped between the two calls still cannot cause a write.
4. **Every other safeguard stays:** channel identity check (`assertActiveChannel` + `assertWriteChannel`),
   per-video backup, diff/merge, the fresh pre-write conflict check, `isApprovalStillValid` re-checked per
   row, the ledger and audit trail, read-back verification, the quota guard (BL-117, incl. split and
   "run anyway"), cooperative cancel (ADR 0016), the per-video execution lock, and resume of an interrupted
   batch. The write scope is unchanged: title/description per language, plus the one existing authorized
   default-language baseline exception.
5. **One batch per click.** A second send for a change set that already has a non-terminal live batch holding
   any of the same changes does not create another batch: it answers `send_already_in_progress` carrying the
   existing `batchId`, and the UI attaches to it (execute is resumable; a batch that is genuinely running
   answers `batch_already_running`). Creation of the live batch for one channel is serialized in-process.
6. **A batch that does not finish cleanly is not "settled".** Failed/conflict/unknown/cancelled rows stay
   visible on the Batches tab; BL-125's retention never purges them.

## Consequences

- The Batches tab keeps its manual path (select changes, dry run, Execute) unchanged; this ADR adds a second
  entry into the same pipeline, not a second pipeline.
- A browser closed between the two calls leaves a PENDING live batch. It writes nothing until executed and is
  resumed by the next send click (decision 5) or from the Batches tab.
- Not done here: auto-send on approval (the owner asked for a button), a dry-run option in the pop-up (the
  Batches tab still offers dry runs).
