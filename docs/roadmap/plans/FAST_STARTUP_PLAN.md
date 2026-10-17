# A page reload does not run the startup work again (BL-196)

**Status: approved 2026-10-17 (owner, Telegram msgs 2969/2972), on `feature/bl-196-fast-startup`.**

The owner asked (msgs 2963/2967/2969): why does every reload show the long "Loading your data…" window, and why is the check slow when
the data is known to be fresh? The window (owner msg 2004) waits for four requests. When nothing is due, two of them still do
expensive work before their own cheap freshness check.

## 1. Findings (code as of `2bae237d`)

- **The window** is shown on every mount of the `(app)` layout, which includes every reload (F5).
- **`/api/youtube/channel-info`** makes a live `channels.list` call. It runs first, so it delays the other steps.
- **`/api/analytics/auto-collect-all`** has two kinds of work that run on every reload:
  - It imports the other computer's day files. It does this before checking freshness: one `readdir` and about 45 `stat` calls per
    peer on the shared folder.
  - Then the quota guard (`isBackgroundReadAllowed`) runs before `collectMetrics`'s freshness gate. That is 8 Cloud Monitoring
    calls with no cache, plus a read of the other computer's quota ledger.
- **`/api/market-intelligence/collect-if-stale`** runs a full device-sync tick on every load. A tick scans the snapshot folder,
  takes a full-table fingerprint and sometimes exports a snapshot. It also queues behind the 30 s scheduler tick. Then it
  resolves credentials, which is a live tokeninfo call. The staleness claim comes only after all of that.
- **`/api/reach/sync-all {onlyIfDue}`** checks freshness first (stored timestamps). But it first imports the other computer's day
  files, as above.

## 2. Changes (the collection rules themselves do not change)

### A. The window: once per tab per server run

- **When it shows.** The `(app)` layout shows the startup window only when this tab has not shown it yet for the running server.
  The server id is a `globalThis`-held `randomUUID()`, given to the page as a `<meta name="ytom-boot">` rendered by the root layout
  (React hoists it into the head). The tab remembers it in `sessionStorage`.
- **Opening the app or restarting the server.** A first open shows the window, and so does the first load after a restart.
  A reload in the same tab does not.
- **Channel switch.** It keeps its own window, unchanged.
- **The startup work itself** still runs on every load, in the background. The conflict centre still waits until it is really
  done. It is gated on progress, never on whether the window is shown.
- **The header channel.** It is shown at once from the tab's last answer (`sessionStorage`) and replaced by the live answer.
  The three collection requests still wait for the live answer, so the server has recorded the session's channel first.
  `channel-info` itself is unchanged: it still activates the OAuth session's channel on every call (ADR 0004).

### B. Analytics: quotas only when a collection is really due

- The automatic collection gets an opt-in `beforeCollect` hook. It is called right after the freshness gate and before credentials.
  When it returns false, the run ends with `ranCollection: false` and nothing is marked.
- **Who passes it.** Only the automatic wrapper in `index.ts` passes the quota guard as this hook. A manual "Collect now" stays
  unguarded, as before.
- **Peer import.** `auto-collect-all` imports the other computer's rows only when the active channel is not current. The check
  is a new read-only `isAutoCollectionCurrent`, which applies the same rule as the gate.
- **Inside `after()`.** On such a load the active channel's part also runs after the answer: its weekly report and catch-up plan.
  So do the import, the background channels, the milestones and the rest, in the same order as on a collecting load. A failing
  check falls back to the full path.
- **As built:** the quota hook is `runAutoCollectionIfStale`'s own `beforeCollect` option, asked after `freshnessGate`, which was
  moved out of `collectMetrics` unchanged. `collectMetrics` itself is unchanged, and the evening path keeps its guard. The reserve is
  now asked after the active-channel check. So a background channel whose user switched away while the reserve was low ends as
  "failed" (6 h backoff) instead of "current".

### C. Market Intelligence: sync and credentials only when a channel is due

- A new read-only `countResearchChannelsDue` uses the claim's own conditions without writing. Those conditions are: stale or
  never collected, not claimed (or the claim expired), not paused, and not recently failed.
- **Nothing due.** The route answers `skipped_not_stale` with no device-sync tick, no credential resolve and no inactivity pass.
- **Something due.** The path is exactly as before: sync first, then collect.
- **Inactivity pass.** Skipping it when nothing is due delays a pause by at most one stale window (24 h). The next due run
  evaluates first, as today. This is accepted.

### D. Reach: peer import only when a channel is due

- The route checks first whether any channel's Reach or other report type is due (the existing `onlyIfDue` rule, read-only).
  If none is, it answers without importing the other computer's rows.

## 3. Acceptance (expected values stated from the owner's rules)

- **AC-FS-01:** a tab that has shown the startup window for this server id shows none on reload. A first open shows it. A new
  server id shows it again. A channel switch still shows the switch window.
- **AC-FS-02:** with the window not shown, the conflict centre still opens only after the startup steps finish.
- **AC-FS-03:** when analytics is current, `runAutoCollectionIfStale` returns `ranCollection: false` without calling the quota guard.
  When analytics is stale and the guard says no, there is no Analytics API call and no mark is set. A manual `collectMetrics`
  never calls the guard.
- **AC-FS-04:** when no research channel is due, there is no device-sync tick and no credential resolve, and the answer is
  `skipped_not_stale`. When one is due, sync runs before the collection.
- **AC-FS-05:** when no reach channel is due, there is no peer import. When one is due, the import runs before the sync.
- **AC-FS-06:** `channel-info` still activates the session's channel on every call.
- **AC-FS-07:** every new text, if any, exists in English and Russian.

## 4. Out of scope

- `getAuthenticatedYoutube` sets no `expiry_date`, so an expired token costs three round-trips. This is a read-gateway change
  (ADR 0007) and gets its own item.
- A failed Reach attempt keeps the active channel due on every load (`throttleFailed: !isActive`, by design). Such a load still
  imports, resolves credentials and calls the Reporting API.
- Caching the Cloud Monitoring quota snapshot.
