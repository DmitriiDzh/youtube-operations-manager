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
- Rows: every completed poll of a stream with a broadcast (live: viewers as read; not live yet, e.g. `ready`: viewers null,
  no viewers read); none when YouTube ended the broadcast (its event records it) or there is no broadcast. A failed write
  is swallowed with a `viewer_sample_failed` event -- the poll that stops an ended stream never breaks.
- Retention: keep everything (owner's defaults, msg 3370: reversible, cadence unchanged, Mac only). ≈ 288 rows per
  channel per day at 5 min, plus ~9 per (re)start from the 1-minute window.
- The summariser (peak, average, viewer-hours, interruptions) belongs to stage 3, which displays it; an interruption is
  defined there against the poll's 1-minute/5-minute rhythm, not a single fixed interval.
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

**Built (2026-10-22, owner msg 3372: all four in one branch).** Stage 1 schema v105; stage 3 `src/lib/live-analytics/summarise.ts`
(rules below) + `GET .../live-stream/analytics?days=1..90` + `live-stream-analytics.tsx`; stage 2 `collect.ts`, schema v106,
hourly loop in `instrumentation.ts` (first pull 1 h after the last sample, final 4 days later, 4 broadcasts per tick, retry
6 h × 5; a report refused with 400 is `unsupported`, 403/404 on all three is `unavailable`); stage 4 Producer API 1.11.0.
Summary rules: an interval a→b of at most 10 min belongs to sample a (state, UTC day/hour, broadcast), a longer one is a data
gap; viewer-hours = Σ a.viewers × interval over live intervals with a count, average = that / time with a count; interruptions
= `encoder_run_exit` with a cause other than `pass_end` (the helper restarted the run). Not verified before merge: what the
API returns for a broadcast whose recording is not kept or was deleted (first real pulls after the restart).

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
   **Answered 2026-10-25 (owner msgs 3479/3482): yes, on every computer — stage 5 (BL-222).**
4. Recording deletion stays outside the app (Studio / the Operator by hand)? If the app should delete them, that is a
   separate write feature with its own approval (write gateway, Live writes) and is not part of this plan.

## 6. Stage 5 — the summary on the other computers (BL-222)

Owner, Telegram msg 3479 (2026-10-25): «аналитику по трансляции даже при том что она запущена на другом компьютере»; msg 3482
chose the option proposed in msg 3481: the computer that runs the stream shares a ready summary, no extra YouTube call.

- **Own per-device report family `live_analytics`** (`ytm-live-analytics` v1, Syncthing subfolder `live-analytics`), not a
  field in `ytm-live-streams`: that schema is strict with `version: 1`, so any change there would make a computer that is not
  updated yet refuse the whole report and lose the stream's state. A build without this family never sees the new folder.
- **What is shared:** for each channel with samples in the last 90 days, the four summaries the card offers (1, 7, 30, 90 days),
  each exactly what `GET .../live-stream/analytics?days=N` answers locally (totals, days, hours, broadcasts, and the YouTube
  Analytics views — never the per-minute `curve`), plus the range. Raw samples are not shared. Strict schema: ids, ISO dates,
  fixed codes and numbers only, no free text. A computer with no samples publishes `channels: []`.
- **Who and how often:** the `live-analytics` module publishes its own report every 5 minutes (the sampling cadence) in its own
  loop in `instrumentation.ts` (AGENTS.md §M: it imports nothing from `live-streams`). Cost: four local summaries per channel
  every 5 minutes; no YouTube call.
- **Which source the route answers from:** local when this computer has samples for the channel in the range; otherwise the
  newest peer report (by `updatedAt`) whose channel entry for that range has samples; otherwise local (empty). A `days` value
  outside 1/7/30/90 is answered only locally (the UI never asks one). The answer gains
  `source: {kind: "local"} | {kind: "peer", deviceId, hostName, updatedAt}` (additive). A peer silent for 7 days is forgotten
  (`PEER_FORGET_AFTER_MS`), so a retired computer's history disappears a week after its last report.
- **UI:** the «Эфиры» card is also shown where the stream runs elsewhere (Windows: under the other computer's stream card), with
  «По данным <computer>, <time>» when the figures come from a peer. Texts in every language.
- **Out of scope:** `producer_live_analytics` stays local-only (stage 4) unless the owner asks.
- **Acceptance needs the other computer updated:** until Windows runs this build, the Mac publishes and nobody reads.

### Acceptance criteria (stage 5, fixed before code)

- AC-LA5-01: the report schema refuses free text (an unknown field, a bad broadcast id, a `days` other than 1/7/30/90).
- AC-LA5-02: the publisher puts four ranges per channel with samples in the last 90 days, each equal to the local summary for
  that range; a channel with no samples in 90 days is left out; nothing sampled → `channels: []`.
- AC-LA5-03: route source — local samples present → `local`, even when a peer has more; none → the newest peer entry with
  samples for that range (`peer`, its host and time); a peer whose entry for the range has 0 samples is skipped; no peer →
  `local` with zero figures; `days=3` with no local samples → `local`.
- AC-LA5-04: a peer report of an older `updatedAt` never replaces a newer one (the per-device core's rule, unchanged).
- AC-LA5-05: the card renders on a computer without the stream host when a peer reports the channel, and names the peer.
