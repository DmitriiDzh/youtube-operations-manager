# Live stream analytics (BL-211..BL-214)

Owner: question 2026-10-22 (Telegram msg 3360): collect analytics from live streams so a producer can analyse them and
YT Manager can show them. Follow-ups msgs 3362/3364: streams run 24/7 and may have **no recordings** (a recording that
appears may be deleted), so the statistics must not depend on a recording surviving. "ок" to a plan + backlog: msg 3366.

**Plan only.** Nothing here is assigned; each stage needs the owner's own "да" (AGENTS.md §C).

## 1. Facts (code and real DB read 2026-10-22)

- **Viewers are already read, never kept.** `runner.ts` calls `supervisor.checkBroadcast` after every encoder (re)start,
  every minute for 10 minutes, then every 5 minutes. While `lifeCycleStatus = live` it reads the concurrent viewers
  (`readViewers` → `getLiveViewerCounts`, Data API `videos.list liveStreamingDetails`, read gateway) and the stream health,
  and writes only the latest value to the per-channel `youtube` poll file. No history exists.
- **Segments.** BL-205 cuts a 24/7 stream into broadcasts of 660 min by default (`SEGMENT_*_MINUTES` 15..705) so YouTube
  keeps each recording. `live_stream_segments` holds `broadcast_id`, `started_at`, `ended_at`, `recorded`. Real DB: 5
  segments per channel on both channels since 2026-10-19, one open each.
- **Daily Analytics already covers broadcasts while their video exists.** A broadcast id is a video id; the daily per-video
  collection picks it up, live ones included (real DB: 28 rows each for the first four segments, `metric_date` up to
  2026-10-19 on 2026-10-22, the usual 2-3 day lag). Stored `video_metrics_daily` rows are never deleted by the code, even
  when the video disappears from YouTube.
- **Channel-level breakdown by content type** already exists (`analytics/contracts.ts`: `contentFormat`,
  `creatorContentType`, minutes watched), so the live share of the channel is partly visible today.
- **`live_streams` is device-local** (a stream runs from one computer only, the Mac).
- **Producer MCP** (`producer_*`, read-only, local data only) has nothing about live streams.
- **No app path deletes recordings.** `deleteVideoById` (write gateway) is used only by the G1 upload probe (ADR 0037).

### YouTube Analytics API (official docs, checked 2026-10-22)

- `averageConcurrentViewers`, `peakConcurrentViewers`: per video; with the `livestreamPosition` dimension, per position
  of the stream (usually one minute). The "concurrent viewers" channel report requires `filters=video==<id>`.
  <https://developers.google.com/youtube/analytics/metrics>, <https://developers.google.com/youtube/analytics/channel_reports>
- `liveOrOnDemand` (`LIVE` / `ON_DEMAND`) splits activity watched live from activity watched later; not combinable with
  `averageViewPercentage`. <https://developers.google.com/youtube/analytics/dimensions>
- Not yet verified on a real channel (stage 2's first task): whether these reports answer for a broadcast whose recording
  was not kept (> 12 h) or was deleted, and how a deleted live video appears in channel-level totals.

## 2. Design

The principle the owner's 24/7-without-recordings case forces: **our own samples are the primary record**; YouTube
Analytics is pulled per broadcast as soon as it can answer and kept locally, because after a recording is deleted it may
answer nothing.

### Stage 1 — viewer samples (BL-211)

- New table `live_viewer_samples` (`channel_id`, `broadcast_id`, `sampled_at`, `viewers` nullable, `life_cycle_status`,
  `stream_status`, `health_status`), additive migration, device-local like `live_streams`.
- Written by `checkBroadcast` from the reads it already makes: **no new YouTube call, no quota**. A failed read is stored
  as a row with `viewers = null`, never 0 (a gap stays visible).
- Retention: owner decision (§5 Q1); default proposal: keep everything (≈ 290 rows per channel per day).
- Lives in `src/lib/live-streams/` (writer) + a small pure `live-analytics` summariser (shared by UI and MCP, §M).

### Stage 2 — per-broadcast Analytics pull (BL-212)

- When a segment has ended (and again after the 3-day lag), query per broadcast through the read gateway's Analytics
  child: the concurrent-viewers report (`livestreamPosition`, per minute) and totals split by `liveOrOnDemand` (views,
  minutes watched, subscribers gained). Store in a new table keyed by broadcast id; never deleted.
- Runs inside the existing analytics collection (same toggle, same cooling-down rules), not a parallel scheduler.
- First task of the stage: verify on a real ended segment, and on one not recorded, what the API returns (§1 last bullet).

### Stage 3 — «Эфиры» summary in the Web UI (BL-213)

- On Контент → «Трансляции»: per day and per broadcast — hours on air, interruptions, peak / average concurrent viewers,
  viewer-hours (from samples), and the Analytics figures from stage 2 when present; a viewers-over-time chart.
- Each figure names its source (our samples vs YouTube Analytics); missing data is "—", never 0.
- Every text as ui-text keys in all languages (AGENTS.md §H).

### Stage 4 — producer tool (BL-214)

- `producer_live_analytics` (read-only, local data only, like `producer_portfolio_overview`): per channel and date range —
  broadcasts/segments, hours on air, uptime, interruptions, peak/average viewers, viewer-hours, Analytics totals split
  live/on-demand, and per broadcast `analyticsCollected` (whether stage 2's pull is complete — what tells anyone deleting
  a recording that its numbers are already safe). Agent API minor version bump; Windows reads it from the synced report
  only if the owner wants it there (§5 Q3).

## 3. Acceptance criteria (to be fixed by hand before each stage's code)

- Stage 1: a 5-minute poll while live writes exactly one row; a failed viewers read writes `viewers = null`; no extra
  YouTube call is made (counted in a test double); a stream that is off writes nothing.
- Summary math on a hand-made sample set (e.g. 12 samples at 5 min: 10, 20, null, 30 …): peak, average over non-null
  samples, viewer-hours = Σ viewers × 5 min / 60, an interruption = a gap > 2 poll intervals — values computed by hand.
- Stage 2: a segment that has not ended is not queried; an ended one is queried once now and once after the lag; a
  deleted/unavailable video is recorded as such, not retried forever.
- Stage 4: producer tool returns null (not 0) for a figure with nothing stored.

## 4. Build order and risks

1 → 3 (cheap, no quota, useful at once) → 2 → 4. One branch per stage group per AGENTS.md §K.1.
Risks: schema change (additive only); Analytics quota for stage 2 (one or two queries per segment, ≈ 4-6 per channel per
day); data the API may refuse after a recording is deleted (hence samples first).

## 5. Open questions for the owner

1. Sample retention: keep all, or e.g. 90 days of 5-minute samples plus daily totals forever?
2. Should a faster sampling rate be used while live (e.g. every minute)? It costs Data API quota (1 unit per read).
3. Should the summary also be visible on Windows (via the `live-streams` sync report) or only on the Mac?
4. Recording deletion stays outside the app (Studio / the Operator by hand)? If the app should delete them, that is a
   separate write feature with its own approval (write gateway, Live writes) and is not part of this plan.
