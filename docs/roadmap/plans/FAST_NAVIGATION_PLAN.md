# A click in the menu answers at once and opens fast (BL-203)

**Status: assigned 2026-10-19 (owner, Telegram msgs 3056/3062); in progress on `feature/bl-203-fast-navigation`.**

The owner (msg 3056): after BL-195 a click in the left menu waits long with no sign that it was taken, and the blocks of the new
page fill in slowly. Analysis sent as msg 3061, accepted ("да", msg 3062).

## 1. Findings (measured 2026-10-19 on the Mac, `dev` a22180ab)

- **The server stalls.** Node runs everything on one thread. Two Automerge paths load whole documents and block it:
  - `GET /api/change-drafts/conflicts-summary`, polled every 20 s by every open tab, takes 1.2–2 s. `listConflicts` runs
    `Automerge.load` on each channel's document, about 0.6–0.8 s per channel.
  - The change-drafts sync cycle takes 5.8 s, with single blocks up to 2.3 s. It loads, saves, merges and fully re-projects
    every document even when nothing changed. Measured on a copy of the real data: the other 16 sync families take 30–140 ms.
  - Each tab also POSTs `/api/change-drafts/sync` on mount and every 60 s, beside the server's own 60 s scheduler
    (`instrumentation.ts`).
- **What a click costs.** A sidebar click opens the page in 22–50 ms when the server is free, and in 650–1500 ms during such a
  poll. A 3 ms request waited 600 ms.
- **The sync does the same work over and over.** The local document file is byte-identical to this device's file in the
  shared folder. One channel's peer file is also byte-identical. `Automerge.save(Automerge.load(b))` returns exactly `b`.
  sha256 of a 0.7 MB document takes 0.4 ms; `Automerge.load` takes 600–700 ms.
- **The menu gives no feedback.** It highlights a section only once the new URL is committed, so nothing shows while the
  request waits.
- **BL-195 did not slow the server.** Its Activity poll costs 3 ms. The conflict poll dates from the CD6 slice. BL-195's
  per-block placeholders made the staggered loading more visible.

## 2. Changes

### Stage 1: the server stops redoing unchanged work (`src/lib/sync-gateway/change-drafts/`)

All caches are content-addressed: the key is the sha256 of the document bytes. The same bytes always mean the same document, so
no cache entry can ever go stale. Each cache is module-level and bounded (small LRU). It is module-level because
`run-all-families.ts` builds a new core every cycle. Caches are empty after a restart, so the first cycle after a start is a
full pass (merge + projection), as today.

- **`listConflicts`:** reuses the conflicts computed for the same bytes.
- **`exportBytes`:** reuses the save output for the same stored bytes.
- **`mergeIncoming`:** returns `{ newConflicts: [] }` without loading, saving or projecting in two cases. In both, the local
  bytes must also be marked "projected cleanly":
  - the incoming bytes equal the local bytes;
  - this exact (local, incoming) pair was recorded after a merge whose save projected with zero failures. The saved result
    contains the incoming document, so merging it again changes nothing.

  To support this, `saveDocument` now reports whether the projection fully succeeded. A failed projection is never recorded, so
  the next cycle repairs it exactly as today.
- **Sync transport (`writeDeviceFile`):** does not rewrite the device file when its content is already identical. This also
  stops ~1.4 MB/min of Syncthing churn.
- **`(app)/layout.tsx`:** the browser no longer POSTs `/api/change-drafts/sync`, neither on mount nor every 60 s. The server's
  own scheduler runs every 60 s regardless of tabs (AC-CRDT-07 is unchanged). "Sync now" on the Merge tab keeps the route.
  One consequence: after a server restart the first draft sync runs at 60 s, not when the tab opens.

### Stage 2: a click answers at once (`src/components/app-shell.tsx`)

- The clicked item is highlighted at once. A small spinner shows on it (`useLinkStatus`) until the new page is committed.
- A thin progress bar runs at the top of the content area while a navigation is pending.

### Stage 3: slow section requests

- **`/api/settings`, 0.4–0.5 s.** Each call made ~8 live Cloud Monitoring calls for the quota status, and the Settings tab
  mounts about a dozen blocks that each fetch the route. Batches and every operation window fetch it too. The quota status is now
  one shared read (`cloud-quotas/cached-status.ts`): callers arriving together share it, and a finished read is reused for 30 s.
  A failed read is never reused. Cloud Monitoring's own figures lag by minutes, so 30 s changes nothing visible.
- **Servers tab, left unchanged.** Runtimes take ~1.2 s and devices ~0.3 s. These are live RunPod S3/API reads (network I/O,
  not a blocked thread). The Operator changes runtimes from outside this process, so a cache could show a stale list. That
  would be a separate decision for the owner.

### Out of scope (recorded in `docs/TECHNICAL_DEBT.md`)

- A real merge still blocks the thread for about 2 s while it runs. This happens only when a draft actually changed.
- The documents only grow with history (0.7 MB, ~650 ms per load). Compaction or a worker thread is a separate task.
- Until the other computer runs this build, it still rewrites its own device file every minute with the same bytes. Unchanged
  bytes still hit the cache, so this costs the Mac nothing.

## 3. Acceptance criteria (written before the code)

- **AC-NAV-01 (AC-CRDT-08 kept).** `listConflicts` reflects the stored document right after any change. Example: a document
  with no conflicts returns 0. After a merge introduces one conflict, the next call returns exactly 1 with no restart. A second
  call on unchanged bytes returns the same 1 without loading the document again.
- **AC-NAV-02.** Two cycles with unchanged local and peer bytes: the second cycle does not save the local document, does not run
  the projection, and does not rewrite this device's file. Byte content and mtime stay the same.
- **AC-NAV-03 (AC-CRDT-07 kept).** A peer file that gains one conflicting edit is merged in the next cycle. `newConflicts` lists
  that one conflict, and the local document changes.
- **AC-NAV-04.** If the previous merge's projection reported a failure, the next cycle with unchanged bytes runs the full merge
  and projection again.
- **AC-NAV-05.** After `discardLocalAndAdoptPeer` (local bytes replaced), a still-unchanged second peer file is merged again in
  full, not skipped.
- **AC-NAV-06.** The browser shell sends no `POST /api/change-drafts/sync`. The route still serves "Sync now".
- **AC-NAV-07.** Re-run of the measurements on a copy of the real data:
  - a second `change_drafts` cycle on unchanged data takes under 100 ms;
  - `listConflicts` on unchanged bytes takes under 10 ms.

  Live, once deployed: a sidebar click while the conflict poll runs commits in under 100 ms.
- **AC-NAV-08.** Within 100 ms of a click the clicked menu item shows as selected, with a pending mark. The mark goes away once the
  page is committed.
