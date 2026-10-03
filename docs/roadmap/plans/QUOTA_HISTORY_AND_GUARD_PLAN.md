# Quota History, Reset Time & Batch Quota Guard Plan (BL-117)

Requested by the project owner 2026-10-03 (Telegram): (1) next to the quota bars in Settings, an icon that opens a popup
with the history of what quota was spent on, grouped by work (a batch of 50 translated videos is ONE line: when, what
changed in how many videos, how many units it cost), (2) when the quota reserve refreshes, (3) block a batch that
certainly needs more quota than we have, and automatically create a truncated batch that will certainly pass and offer
to run it instead. Delivered as two slices on one branch (`AGENTS.md` §K.1); slice 2 touches the write path.

## 1. What exists today (read from the code)

- Cloud Monitoring gives the REAL limit and usage per service (`src/lib/cloud-quotas`), project-wide. "Used" is a
  rolling 24 h sum; YouTube's Data API quota day is Pacific-midnight based (`startOfYoutubeQuotaDay`,
  `src/lib/youtube-quota`).
- `gateway_call_events` counts attempts per category for 24 h (no units, no method, no operation, pruned every insert).
  It is the wrong shape for history, so slice 1 adds its own table rather than overloading it.
- Every YouTube Data / Analytics client is built by `createYoutubeClient` / `createYoutubeAnalyticsClient`
  (`read-gateway-inventory.test.ts` forbids any other `googleapis` import) and wrapped by
  `wrapYoutubeClientForQuotaClassification` — the single place that sees every call (the Reporting API client is not
  wrapped and is excluded here: it has no unit cost).
- A Batch row costs: fresh `videos.list` (1) + `videos.update` (50) + read-back verification `videos.list` (1) =
  about 52 units, plus retries and one batched preliminary `videos.list` per 50 videos.
- Quota exhaustion today: Google answers 403 `quotaExceeded`, the batch halts systemically. No pre-check exists
  (only Research collection has its own daily budget).

## 2. Slice 1 — call log, history popup, reset time (read-only accounting)

- **Cost table** in `src/lib/youtube-quota` from Google's official page (developers.google.com/youtube/v3/determine_quota_cost,
  read 2026-10-03): videos.list 1, videos.update 50, playlists.list 1, playlists.insert/update/delete 50,
  playlistItems.list 1, playlistItems.insert/update/delete 50, channels.list 1, channels.update 50, subscriptions.list 1,
  subscriptions.insert/delete 50, comments.list 1, comments.insert/update/delete 50, captions.list 50, captions.insert 400,
  captions.update 450, captions.delete 50, activities.list 1, search.list 1 (own 100/day bucket), Analytics
  `reports.query` 1 (this repo's own live evidence: 28 queries moved usage by 28). An unknown method has cost `null` —
  shown as unknown, never guessed. Google: "every API request, even if invalid, will cost at least one quota point", so a
  failed call is logged as 1 unit (a lower bound) and a 403 quotaExceeded as 0.
- **New table `quota_ledger`** (device-local, 45-day retention): time, service (`data`/`analytics`), method, units (nullable),
  outcome, operation kind/id/label. Recorded in the client wrapper (it now knows the resource name), fire-and-forget:
  recording can never fail, delay or alter an API call.
- **Attribution** by an `AsyncLocalStorage` context kept on `globalThis` (the bundling lesson of BL-116), set where the work
  actually runs: batch execution/recovery, Fix all, channel sync, Analytics collection, Research collection. Calls outside any
  context are grouped as "other" per service and day.
- **History view** (`GET /api/quota/history?service=data|analytics`): one entry per run (a resumed batch is its own entry):
  time, label, what changed ("N videos changed" from the batch ledger's SUCCESS rows, not from the call count — retries
  differ), calls, units. A final row "other device or not attributed" = Google's real usage minus the local sum (the Cloud
  project is shared by every device).
- **Reset time:** Data API: next Pacific midnight, shown in the user's time zone with the time left; "used" for the Data API
  bar switches from rolling 24 h to "since the last Pacific midnight" so it matches the reset (this changes a number already
  on screen, including the operation overlay's quota baseline — stated to the owner). Analytics API: "reset not confirmed".
- **UI:** a small history button next to each quota bar in Settings → a dismissable popup.

## 3. Slice 2 — batch quota guard (write-safety, `AGENTS.md` §A full reading pass first)

- **Enforced in the batch service before the execution claim** (never in the UI only), so every write surface is covered.
- **Estimate** = rows still to write × per-row cost (derived from the call sequence above) + one batched preliminary list per
  50 rows + a safety margin; the numbers are written into the acceptance criteria before code (§L).
- **Remaining quota** from Cloud Monitoring (the other device spends from the same pool), minus local calls inside
  Monitoring's ~1-minute lag, minus a margin. Cloud not connected / query failed => decision pending (owner question 1).
- **Block**: estimate > remaining => the batch does not start; a clear `quota_insufficient` error with the numbers.
- **Truncated batch**: the largest set of WHOLE rows (deterministic order) that fits; created with the existing
  `createBatch`, never a new state; the original's remaining rows keep their existing semantics so no row is applied twice
  and none is lost (owner question 3). The UI offers "run this smaller batch instead".
- **Background reads** (automatic Analytics collection, Research) stop below a reserve so writes keep headroom (owner
  decides the percentage).

## 4. Owner decisions needed for slice 2

1. Remaining quota unknown (Cloud not connected or the lookup failed): block, or allow with a warning?
2. Should Fix all (bulk `videos.update`, 50 units per video) get the same block?
3. After a truncated batch: the original's leftover rows — keep them in the original batch for later (default), or move
   them into a second prepared batch?
4. Reserve for background reads (default proposal 20 %).

## 5. Acceptance criteria (slice 1, before code)

- AC-1: each known method maps to the cost in §2; an unknown method yields `null` units, not a number.
- AC-2: a failed call is logged as 1 unit; a 403 quotaExceeded as 0; a successful one at its table cost.
- AC-3: a failing ledger write never changes the API call's result or throws into the caller.
- AC-4: calls made inside a context are attributed to it, including concurrently running contexts (two contexts do not
  mix); calls outside any context fall into "other".
- AC-5: history groups by run, sums units, and reports "N changed" from the batch ledger's SUCCESS rows.
- AC-6: the next Pacific midnight is correct across DST (hand-computed instants around 2026-11-01 and 2026-03-08).
- AC-7: the history endpoint requires a session and returns no token or internal id.
- AC-8: the new table is classified (device-local in `snapshot/contracts.ts`, authorized in `youtube-data-policy`).

## 6. Risks

- The local log covers this device; Monitoring is project-wide (labelled in the popup).
- A write client built outside `createYoutubeClient` would escape the log: the read-gateway inventory test already forbids it.
- `AsyncLocalStorage` propagation into `after()` callbacks is verified in a real build, not assumed.
