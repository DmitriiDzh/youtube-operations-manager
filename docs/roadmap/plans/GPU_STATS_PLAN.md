# GPU availability statistics and session wait log (BL-206, FO-REQ-0033)

Owner: go on 2026-10-21 (Telegram msg 3241, "да, да"). Earlier owner decision (msg 3224): statistics only for now — no
automatic datacenter switch; a second volume or a move is decided later from the data. Builds on BL-172
(`GPU_AVAILABILITY_PLAN.md`).

## 1. Facts (code and the real DB read 2026-10-21, read-only)

- **The log exists (BL-172).** `media_gpu_availability_log` (v81), written by `snapshotGpuAvailabilityIfDue`
  (`media-generation/gpu-availability-log.ts`) from the instrumentation timer (`GPU_AVAILABILITY_TICK_MS` 15 min, first after
  5 min). A snapshot is due when the newest is **3 h** old. It covers every Secure Cloud datacenter that offers network volumes
  (21 now), not only the volume's: one overall row per GPU (`*`) plus one row per such datacenter, NONE when not listed. GPUs
  under 24 GB, Community Cloud and datacenters without network volumes are not stored (a volume cannot live there). Retention
  90 days. Read over MCP by `factory_media_list_gpu_availability_log` (rows or `summary: true`).
- **Size.** Real DB: 87 snapshots, 56,653 rows (651 a snapshot), **92 % NONE**, 7.5 MB. At 15 min for 90 days the same layout
  would be 8,640 snapshots ≈ 5.6 M rows ≈ 750 MB — too much for a 68 MB DB. So NONE rows must stop being stored.
- **Sessions.** `media_sessions` has `createdAt, approvedAt, startedAt, readyAt, stoppedAt, usdCharged, error, gpuTypeId,
  datacenterId, gpuPlanJson (candidates, minVramGb, maxPricePerHr), capacityAttempts`. `media_capacity_attempts` logs every
  placement try (`placed | no_capacity | error | container_stuck`, 90 days); its `datacenter_id` is always the volume's.
- **Gap:** `approvedAt` is rewritten on every re-placement and capacity retry (`sessions.ts` ~1010, 1213, 1259), so the real
  wait (first approval → ready) is lost. Candidates refused before any try ("not offered in EU-RO-1", over the price cap) are
  only in an error message (`resolveGpuCandidates().skipped`), not stored.

## 2. Design

### A. Snapshots every 15 minutes, stored compactly (FO-REQ §1)
- Interval 3 h → **15 min**; the timer ticks every **5 min** and a snapshot is due at ≥ 14 min, so the gap stays ≤ ~20 min
  while the server runs. The retry after a failed reading drops from 1 h to 15 min (added while building), so a failure costs one snapshot. Not a user setting (FO-REQ says "configurable"; a constant is enough for now — said in the DEV-RESP).
- **Schema v100:** new table `media_gpu_availability_snapshots (at PK, rows, min_cuda_version)` — one row per snapshot.
  The log stores only rows with stock ≠ NONE (and the overall `*` row always); a snapshot without a row for a GPU×datacenter
  means NONE. Migration: copy each existing distinct `at` into the new table; old NONE rows stay (no rewrite of 56 k rows).
  Estimate: ~55 rows a snapshot → ~0.5 M rows / 90 days ≈ 60 MB at most.
- `factory_media_list_gpu_availability_log`: `summary` counts NONE as snapshots − other levels (same numbers as today);
  the plain row list no longer contains per-datacenter NONE rows from v100 on — a contract change, in the API history.
- Retention stays 90 days (FO-REQ asks ≥ 60). Device-local, as before; each computer keeps its own.

### B. Session wait log (FO-REQ §2)
- **v100 columns on `media_sessions`:** `first_approved_at` (written once at the approval, never rewritten) and
  `gpu_skipped_json` (the skipped candidates with their reason from the first placement).
- A session's wait record (derived, no new table): candidates (`gpuPlanJson`, else the Settings' list), datacenter, first
  approval, ready (or the failure: the `error` code prefix, e.g. `media_no_capacity`), GPU obtained, wait minutes =
  ready − first approval, capacity attempts, skipped candidates, `usdCharged`.
- Sessions from before v100: `first_approved_at` backfilled from the earliest capacity attempt, marked `waitApproximate`.

### C. `factory_media_get_gpu_stats` (FO-REQ §3; READ, no RunPod call, no cost)
Input: `from`, `to` (ISO, default the last 7 days, at most 90), `gpuTypeIds?`, `dataCenterIds?`, `hoursUtc?: {from, to}`
(0–24, end exclusive), `weekdays?` (1 = Monday … 7 = Sunday, ISO), `includeSessions?` (list each session, default false).
Output:
- `availability[]` per GPU × datacenter: `snapshots`, `inStock` (stock ≠ NONE), `inStockShare`, counts per level,
  `byHourUtc[24]` and `byWeekday[7]` (`snapshots`, `inStockShare`) — all counted inside the hour/weekday filter.
- `sessions`: `count`, `ready`, `failed`, `failureRate`, `medianWaitMinutes`, `p90WaitMinutes`, the same per candidate list
  (`byCandidates`) and per GPU obtained (`byGpu`), failures per reason; `list` with `includeSessions`.
- Factory API 1.25.0 → **1.26.0** (new tool + the list change in A).

### D. Not built now
- **Weekly summary (FO-REQ §4):** the tool answers it for any week; a file or page is added only if the owner asks.
- **Second-volume note (FO-REQ §5):** written by the developer after ≥ 7 days of 15-min data (and the session log) — a note in
  the Inbox, no code; storage cost from RunPod's network-volume price × the model set's size.
- No change to the GPU rule; no automatic datacenter switch (owner, msg 3224).

## 3. Acceptance criteria (fixed before the code; expected values computed by hand)

- **AC-GS-01** The snapshot is due at ≥ 14 min since the newest and not before; a 5-min tick over 1 h of fake clock gives 4–5
  snapshots and no gap > 20 min.
- **AC-GS-02** A snapshot stores the overall rows and only non-NONE datacenter rows, plus one `snapshots` row. Fixture: 2 GPUs ×
  3 volume DCs, one GPU LOW in one DC → 2 overall + 1 DC row, `rows` = 3.
- **AC-GS-03** `summary` of the list tool over a mix of old (NONE stored) and new (NONE implied) snapshots gives the same counts
  as if NONE had been stored: 2 old + 2 new snapshots, GPU X in DC A LOW in one old and one new → LOW 2, NONE 2.
- **AC-GS-04** (FO-REQ acceptance) "how often was a 4090 obtainable in EU-RO-1 between 12:00 and 18:00 UTC on weekdays":
  fixture of 8 snapshots — Mon 11:45 (LOW), Mon 12:00 (LOW), Mon 17:45 (NONE), Mon 18:00 (HIGH), Tue 13:00 (MEDIUM),
  Wed 15:00 (NONE), Sat 14:00 (LOW), Sun 12:30 (LOW). With `hoursUtc {12,18}`, `weekdays [1..5]` → 4 snapshots
  (Mon 12:00, Mon 17:45, Tue 13:00, Wed 15:00), inStock 2, share 0.5; `byHourUtc[12]` = 1 snapshot, share 1.0.
- **AC-GS-05** `first_approved_at` survives a re-placement and a capacity retry (`approvedAt` moves, it does not); the wait is
  ready − first approval. Fixture: approved 10:00, retry 10:20, ready 10:24 → 24 min, not 4.
- **AC-GS-06** Wait statistics: waits 2, 4, 6, 8, 30 min and 1 `media_no_capacity` failure → median 6, p90 30 (nearest-rank),
  failureRate 1/6; failures are excluded from the wait percentiles.
- **AC-GS-07** Skipped candidates are stored ("not offered in EU-RO-1") and shown on the session's record.
- **AC-GS-08** The tool refuses `from` > `to` and a window over 90 days (`invalid_request`), and never calls RunPod.
- **AC-GS-09** v100 migration: existing snapshots appear in the new table with their row counts; old sessions get an
  approximate first approval from their earliest capacity attempt; a session with no attempts keeps null.

## 4. Build order
1. v100 schema + compact snapshots + 15 min (A), list-tool compatibility (AC-GS-01..03, 09).
2. Session columns + wait record (B) (AC-GS-05, 07).
3. `factory_media_get_gpu_stats` (C), API 1.26.0, docs (AC-GS-04, 06, 08).
4. Review, merge on the owner's "да", restart; DEV-REL. After 7 days: the §D note.
