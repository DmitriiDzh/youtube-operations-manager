# 0012. Automatic device sync on top of the snapshot handoff

Status: Accepted

**Date:** 2026-10-01.

**Assigned by** the owner (Telegram, msg 1086): the owner wants sync between computers to stop
requiring manual export and import. The full plan and acceptance criteria are in
`docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md`.

## Context

Draft data already syncs continuously through `sync-gateway` (Automerge). The rest travels only
in the whole-table snapshot, which the operator exports and imports by hand:
- the write pipeline;
- the Details audit;
- Research;
- Decisions;
- market-record assignments.

ADR 0009 rules out moving those tables to a CRDT: they need SQL compare-and-set, UNIQUE claims,
and rowid ordering.

## Decision

Keep the snapshot's single-writer, whole-copy semantics, and drive it from a server-side
scheduler (`src/lib/device-sync`, started in `src/instrumentation.ts`). The scheduler takes the
human out of the safe cases only:

1. **Content fingerprint** (schema v36, `snapshot_lineage.content_fingerprint`). A SHA-256 over
   the transferred tables at the lineage head decides whether this device has unpublished changes.
   An unknown fingerprint counts as dirty.
   - Without it, an automatic import that passes the existing lineage check could silently
     replace local work. The check compared snapshot ids only.
2. **Ancestry** (`lineage.json`, a checksummed data file listed in the manifest). A device several
   generations behind can fast-forward in one import. The manifest schema is unchanged, so older
   builds still read new snapshots.
3. **Decision table:**
   - dirty with nothing newer: export, at most once a minute;
   - clean with a fast-forward available: import;
   - anything else is a divergence, shown on both computers via the header bell.

   A divergence is resolved only by an explicit human choice:
   - "keep mine" publishes the local state as a child of the peer's tip;
   - "take theirs" imports past the lineage check, backup first. It then publishes a marker
     naming this device's abandoned branch as ancestors, and never deletes from the shared folder.
     A concurrent opposite resolution then fails closed, and both computers ask again.
4. **Safety.**
   - Every automatic action is re-checked inside the operation lock.
   - Nothing runs during a running Batch, in recovery mode, or while a lock is held.
   - Transfers still in progress are retried silently.
   - There is no export in signal handlers, since a stale operation lock is never auto-released.
   - A dedicated DB connection is used, so no unrelated in-process write can join the import
     transaction.

The draft `sync-gateway` cycle also runs from the same scheduler, so it no longer needs an open
tab.

## Alternatives rejected

- **Live SQL replication** (cr-sqlite, LiteFS): a new native dependency, and it breaks ADR 0009's
  compare-and-set guarantees.
- **A cloud database:** contradicts the local-first model.
- **Automerge for these tables:** rejected by ADR 0009.
- **Export on every mutation:** unnecessary. The DB is a few MB, and a one-minute debounce is
  proportionate.

## Consequences

- This is still one active writer at a time. Concurrent work on two computers produces a
  divergence that a human resolves, never a merge.
- The manual handoff panel stays as a fallback.
- Residual risks are tracked in `docs/TECHNICAL_DEBT.md` RISK-89.

## Addendum 2026-10-06 — false divergences (BL-139)

Owner, Telegram msgs 1758/1764. Real conflicts on 4 and 5 October had no human edit behind them:
on 10-04 both branches held row-for-row identical data (an app update), on 10-05 both computers
ran the dashboard's automatic Market Intelligence collection (rows with clock times, never
identical, so the gate below is what addresses that case). Changes:

- Another computer's branch whose content equals this device's head content is recorded as an
  ancestor of the head (head and data unchanged); a clean device facing several identical tips
  imports one. An earlier head-switching version was dropped after review (it could leave a
  stale prompt where "take theirs" lost a row).
- Boot migrations rebaseline the lineage fingerprint by compare-and-set, as the 30-day purge does.
- The automatic collection first runs one sync tick and is skipped unless this computer is caught
  up (`backgroundWriteVerdict`).
- A real divergence is decided in the Merge tab, which shows what each side would lose.

Still one active writer at a time; a real content conflict is still a human decision.

