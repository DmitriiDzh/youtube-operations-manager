# Automatic device sync: plan and acceptance criteria

**Assigned** by the owner (Telegram, msg 1086, 2026-10-01): *"Мне не нравится что у нас
синхронизация между разными компьютерами все еще требует ручной выгрузки и импорта файлов.
Проведи исследование чтобы найти оптимальный способ как мы это можем автоматизировать. Составь
план реализации. Приступай к выполнению этого плана в автономном режиме. Я одобрю только финальный
мердж в дев."*

This plan supersedes `DEVICE_HANDOFF_AUTO_SYNC_PLAN.md` (2026-09-20). It uses that plan's
design, adapted to what the code looks like today. All slices go on one branch
(`feature/device-auto-sync`). There is one independent-review cycle at the end, then one
merge-approval request (`AGENTS.md` §K.1/§K.2).

## 1. Research: what is manual today, and why

| Data | Transport today | Automatic? |
|---|---|---|
| Change Sets, editorial profiles, AI-connection catalog | `sync-gateway` (Automerge docs in the Syncthing folder) | Yes, but only while a dashboard tab is open. The cycle is driven by the browser (`dashboard/page.tsx` `runSyncCycle`). |
| Batches / ledger / attempts / audit, Details audit, Research (Phase 9), Decisions (Phase 10), market-record assignments | Whole-table snapshot (`src/lib/snapshot`) that the operator exports and imports by hand | **No** |
| `channels`/`videos` | YouTube cache, re-synced per device | n/a |
| Metrics, creative assets, proposals, tokens, workspaces, settings | Device-local by design (`SNAPSHOT_DEVICE_LOCAL_TABLES`) | n/a |

**Why the snapshot tables can't simply join Automerge.** ADR 0009 found that the write pipeline
needs SQL compare-and-set, UNIQUE claims, and rowid ordering. None of these exist in a CRDT.

**Consequence.** The optimal path is to keep the snapshot mechanism's
single-writer/whole-copy semantics and remove the human from the *safe* cases:
- export automatically when local data changed;
- import automatically when the peer published something newer *and* this device has nothing
  unpublished;
- ask a human only when both sides changed (a real divergence).

This is the LiteFS/Litestream-style "one primary at a time, ownership moves by snapshot" model
that the codebase already uses. It is now driven by a scheduler instead of buttons.

The alternatives were considered and rejected:
- A live SQL replication layer (e.g. cr-sqlite, LiteFS) would add a new native dependency and
  would break the CAS guarantees (ADR 0009).
- A cloud database would contradict the local-first product model.
- Automerge for these tables was already rejected by ADR 0009.

**The DB is small.** The current live DB is about 4 MB plus WAL, so a full export (VACUUM INTO,
scrub, VACUUM) takes around a second. Exporting as often as once a minute when something
changed is proportionate. The 2026-09-20 plan's cost concern assumed a much larger DB.

## 2. The blocking gap this plan must close first

`verifySnapshotForImport` compares only snapshot ids. It cannot see **local changes made since the
last snapshot**. Here is the failure scenario:
1. A exports S1.
2. B imports S1, works, and exports S2 (parent S1).
3. Meanwhile, A worked locally too.
4. S2 is a "direct child" of A's lineage, so an import on A passes verification.
5. `applySnapshotToDatabase` then replaces every transferred table and **silently deletes A's
   work**.

Today only operator discipline prevents this. Automation removes that discipline, so the gap
must be closed first.

**Mechanism: a content fingerprint.**
- The fingerprint is a SHA-256 over every transferred table except `schema_meta`, with tables in
  a fixed order, columns sorted by name, and rows ordered by rowid/PK.
- It is recorded next to the lineage pointer (`snapshot_lineage.content_fingerprint`, schema
  v36), in the same statement as the lineage update.
- Export records the fingerprint of the **exported file itself**, computed on the scrubbed staged
  copy, so a mutation that raced the copy still reads as "dirty".
- Import records the fingerprint of the live DB right after the merge, inside the operation lock.
- "Local has unpublished changes" means the current fingerprint differs from the recorded one.
- If no fingerprint has been recorded (a legacy lineage from before v36), the device counts as
  dirty. This fails toward "export/ask", never toward "overwrite".
- A device with no lineage at all counts as clean only if every transferred table is empty.

## 3. Design

### 3.1 Ancestry (catching up across several generations)

A device that was offline may be several generations behind (S2→S3→S4). Today only a direct child
can be imported.
- Each new snapshot carries `lineage.json` (`{ ancestors: [...up to 500 ids, newest first] }`),
  listed in the manifest's `files`, so it is checksummed like `data.db`.
- The manifest schema is unchanged: `.strict()` in older builds rejects unknown manifest fields,
  but an extra file entry is fine.
- Older builds just verify the extra file's hash.
- An incoming snapshot is a **fast-forward** of the local lineage iff one of these holds:
  - its parent is the local head;
  - the local head appears in its `ancestors`;
  - the local lineage is empty.

  If `lineage.json` is absent (older builds), only the direct-parent rule applies.

### 3.2 Decision table (every tick)

| Local dirty? | Peer tip is a fast-forward? | Action |
|---|---|---|
| no | yes | **auto-import** the newest fast-forward snapshot |
| yes | no newer snapshot | **auto-export** |
| yes | yes | **divergence**: notify, change nothing |
| no | newer snapshot exists but is not a fast-forward | **divergence**: notify, change nothing |
| no | nothing newer | nothing |

"Newer snapshot" means a published snapshot from **another** device whose id is neither the local
head nor one of its ancestors. It must be listed by UUID-named directories only: the Syncthing
root also holds `change-drafts/`, `editorial-profile/`, and similar folders, which the current
`listPublishedSnapshotIds` wrongly returns as snapshot ids.

### 3.3 Preconditions for an automatic action (all re-checked inside the operation lock)

- The auto-sync toggle is on, and a Syncthing folder is configured.
- The device is not in recovery mode.
- No batch is `RUNNING`, and there are no `video_execution_locks` rows. The mutation gate stops
  new mutations but not an already-executing Batch.
- For import: the fingerprint is re-checked **inside** the lock, immediately before the merge,
  and it must still be clean.

### 3.4 Error classification for unattended import

| Error | Handling |
|---|---|
| `snapshot_file_missing`, `snapshot_checksum_mismatch`, `snapshot_incomplete`, `snapshot_manifest_invalid` | Syncthing is usually still transferring files, and it doesn't order them within a directory. Retry silently on the next tick. After 10 minutes with the same snapshot still failing, show a notice. |
| `snapshot_divergent_lineage`, or the in-lock dirty check fails | divergence notice |
| `schema_version_unsupported` | "Update the app on this computer" notice. No retry storm: the result is remembered per snapshot id. |
| `device_in_recovery_mode` | recovery notice |
| `operation_lock_held` | skip this tick |

### 3.5 Scheduler

- It runs server-side, from `src/instrumentation.ts`, in the web server process only.
- It ticks every 30 s.
- Export happens at most once per 60 s, only when dirty.
- It also runs just before the idle auto-shutdown exits, when nothing is in flight.
- There is no export in the SIGTERM handler. A process killed mid-export would leave a stale
  operation lock that is, by design, never auto-released. The residual loss window on a manual
  stop is at most about one minute; that data is exported on the next boot of the same device.
- Changes made by MCP/CLI while the web server is down are caught by the fingerprint at the next
  boot.
- The existing browser-driven draft `sync-gateway` cycle also runs from the same server scheduler
  (every 60 s), so drafts sync without an open tab. The browser loop stays in place, and cycles
  are idempotent.

### 3.6 Resolving a divergence (explicit human choice, never automatic)

**Amendment 2026-10-06 (owner, Telegram msgs 1758/1764, BL-139).** A divergence whose two sides
hold *identical* transferred data is no longer shown: the device takes the peer tip as its lineage
head (no row changes, no import, no backup, nothing published) and keeps its own branch in its
ancestry. Only a real content difference reaches a human, with the two choices below, now made in
the Merge tab, which shows what differs (`GET /api/device-sync/divergence`). See ARCHITECTURE §23.


- **"Keep this computer's data"** exports the local state as a snapshot whose parent is the
  peer's tip, with the peer's ancestors included. The peer then sees it as a fast-forward and
  imports it automatically if the peer is clean.
- **"Take the other computer's data"** imports the peer's tip, skipping only the lineage
  check. Checksum verification, the recovery-mode refusal, the backup-before-merge, and schema
  migration of the staged copy all stay.

Both go through the app's own `ConfirmDialog` (never a native dialog), and the dialog states
what will be overwritten.

### 3.7 UI

- A notification bell sits in the app-shell header. It shows:
  - the sync state (last export/import time, "synced", "waiting for Syncthing");
  - divergence, with the two resolution buttons;
  - "update the app", recovery mode, or a persistent transfer failure;
  - a "Sync now" button.
- It reads a new `GET /api/device-sync/status`.
- A Settings card has an "Automatic device sync" toggle, on by default and persisted in
  `app_settings`.
- The manual Handoff panel stays as a fallback and is unchanged.

### 3.8 Retention

- The scheduler deletes this device's **own** older published snapshots from the Syncthing
  folder, keeping the newest 5 and never the local head. Ancestry lives inside the tip, so pruning
  never breaks a catch-up.
- It never deletes another device's snapshots, since Syncthing would propagate the deletion.
- It also prunes `pre-import-*.db` backups, keeping the newest 10. This addresses part of
  RISK-41.

## 4. Slices

| Slice | Content |
|---|---|
| S1 | Fingerprint and schema v36 (`snapshot_lineage.content_fingerprint`). Export and import record it. `isLocalDirty`. |
| S2 | `lineage.json` ancestry on export, `isFastForward`, UUID-only snapshot listing. |
| S3 | `device-sync` module: decision function (pure), tick runner with in-lock rechecks, error classification, retention, divergence resolution services. |
| S4 | Scheduler wiring (`instrumentation.ts`, idle-shutdown flush), server-side draft cycle, toggle in `app_settings`. |
| S5 | API (`/api/device-sync/status`, `/sync-now`, `/resolve`) and UI (bell + Settings card). |
| S6 | Docs: ARCHITECTURE, SYSTEM_MAP, RELEASE_LAYOUT §4, TECHNICAL_DEBT, ROADMAP_STATUS, BACKLOG, ADR 0012. |

## 5. Acceptance criteria (derived from §2–§3, written before the code, `AGENTS.md` §L)

- **AC-AS-01 (no silent overwrite).** A has changed a transferred table since its last recorded
  fingerprint, and B publishes a direct child of A's head. A tick on A does **not** import. It
  reports divergence, and A's rows are unchanged.
- **AC-AS-02 (clean fast-forward).** A is clean, and B publishes a direct child. A tick on A
  imports it. Afterwards:
  - A's transferred tables equal B's;
  - A's lineage head is B's snapshot;
  - A is clean.
- **AC-AS-03 (multi-generation catch-up).** A is clean at S1, and the folder holds S2 and S3
  (S3's ancestors include S1). A imports **S3** directly.
- **AC-AS-04 (dirty → export).** A changed a row, and there is no newer peer snapshot. A tick
  exports one snapshot, and the next tick with no further change exports nothing.
- **AC-AS-05 (race-safe export fingerprint).** A row that is changed after the export's copy was
  taken leaves the device dirty.
- **AC-AS-06 (legacy/unknown fingerprint is dirty).** A lineage with a NULL fingerprint counts as
  dirty. An empty lineage with non-empty transferred tables also counts as dirty. An empty lineage
  with all-empty tables counts as clean.
- **AC-AS-07 (in-lock recheck).** A local change that lands between the decision and the import
  aborts the import. The live data is unchanged.
- **AC-AS-08 (preconditions).**
  - With the toggle off, or no Syncthing folder, a tick does nothing.
  - With recovery mode or a live operation lock, a tick neither imports nor exports.
  - *Revised by the cross-system audit (2026-10-01) and its reviews.* While this computer's data
    holds an unfinished Batch, automatic sync pauses in BOTH directions with a `batch_in_progress`
    notice. Unfinished means:
    - a batch `RUNNING` (set at claim time, before any per-video lock exists);
    - or any row `AWAITING_EXECUTION`, `APPLYING` or `UNKNOWN`.

    An export would hand another computer an executable copy without this computer's device-local
    per-video locks. An import would replace the batch tables under a Prepare/Execute. The check
    reads transferred data, never the locks, which some abort paths leak (RISK-90). The notice gives
    no "execute it" advice, because the Batch's origin cannot be told. Manual handoff stays
    available.
- **AC-AS-09 (transient transfer).** A snapshot missing `data.db`, or with a checksum mismatch,
  produces no notice on the first tick and no data change. It produces a notice only after it has
  persisted past the grace period.
- **AC-AS-10 (listing).** Non-UUID directories (`change-drafts`, `.staging-*`, `.stfolder`) are
  never treated as snapshots.
- **AC-AS-11 ("keep mine").** After "keep mine" on A, B's next tick, if B is clean, fast-forwards
  to A's data.
- **AC-AS-12 ("take theirs").** After "take theirs" on A, A's transferred tables equal B's tip, and
  a pre-import backup exists. It is refused in recovery mode.
- **AC-AS-13 (retention).** Pruning keeps this device's newest 5 snapshots plus the head, and
  never touches another device's snapshots.
- **AC-AS-14 (older build compatibility).** A snapshot with `lineage.json` still passes the
  existing `verifySnapshotForImport`, whose manifest schema is unchanged. A snapshot without it is
  a fast-forward only by direct parent.
- **AC-AS-15 (own snapshots ignored).** This device's own published snapshots are never
  candidates for import.

## 6. Not in scope

- Making the device-local tables travel: metrics, creative assets, proposals. These are separate
  owner decisions (RISK-52).
- Concurrent editing of the write pipeline on two machines. That is still single-writer by
  design; this plan only automates the handoff.
