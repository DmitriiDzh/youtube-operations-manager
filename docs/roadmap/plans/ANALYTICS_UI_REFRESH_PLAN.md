# BL-120 — Analytics tab: show the data we now collect

Proposed 2026-10-04 at the owner's request (Telegram): after BL-114 (Reach: impressions/CTR), BL-117 (quota) and BL-118 (channel totals stored locally, history catch-up, channel start date, week/month buckets) the Analytics tab was not updated. **Status 2026-10-04: slices 1–3 assigned by the owner and implemented on `feature/analytics-ui-refresh` (owner answers: Overview on stored data with «Refresh live»; week/month for the chart only; slices 1–3 now; the per-video table replaces the top-5 list, the raw table stays behind its toggle). Slices 4–6 remain proposed.** Inventory below was read from the code (`analytics-tab.tsx` and the panels it mounts), not from a running app.

## What the tab shows today

- **Overview** (`channel-overview-panel.tsx`): period presets 7/28/90/365 days; cards Views / Watch time / Net subscribers with a % delta; one daily line chart; top 5 videos; an amber «uncovered dates» box; the 27 Aug 2026 view-counting banner; «Collect now»; a «raw collected data» table (raw video ids).
- **Content** (`content-analytics-panel.tsx`): Impressions and CTR (`reach-panel.tsx`: totals, daily impressions chart, top 10 videos by raw id) + «Report subscription status» block; traffic sources; top 10 videos; retention curve of a selected video.
- **Audience** (`audience-analytics-panel.tsx`): five breakdown cards (device, geography, age/gender, subscribed status, content format) — all live reads.
- Every panel picks `channels[0]` (this IS the active channel: `listChannels` returns only it) and keeps its own period selector; the UI never sent `granularity`.

## What exists in the backend but the UI does not use

| Data | Where | UI today |
|---|---|---|
| Channel-level daily totals stored locally, with `source` (live/local) and `collectedAt` | `channel_metrics_daily`, `getChannelOverview({ preferLocal })` | Overview is always a live read; `source`/`collectedAt` ignored |
| Channel start date; covered / uncovered / not-applicable (before the channel) / provisional (last 7 days) / covered-without-data ranges | extended data-quality report (`extendDataQualityReport`) | Only «uncovered» count shown; pre-channel dates are not distinguished |
| History catch-up state (running, videos remaining) | `getHistoryCatchUpPlan`, tracked operation `analytics-backfill` | invisible |
| Week / month buckets, `previousPeriod` (full / partial / predates channel) | `granularity.ts`, agent `ChannelAnalyticsContext` | day only; delta shows «no previous data» for every case |
| Impressions + CTR **per video per day** | `getChannelReach` `groupBy: video_day` | top 10 by impressions as raw ids; CTR line not drawn |
| Weekly reports | `analytics/weekly-reports*` | generated on dashboard open, never listed |
| Comparable-age comparison (days since publish) | `analytics/comparable-age` | no UI |
| `relativeRetentionPerformance` | retention route | returned, not drawn |

## Proposed slices (one branch for the phase)

1. **Freshness and coverage strip (Overview).** One compact block replacing the amber box: «Data from local storage, collected <time>» or «live», the channel's start date, covered range, the provisional last days («may still change»), dates before the channel marked «not applicable» (never as a gap), and the history catch-up state («filling history: N videos left» / «complete»). A «Refresh live» button where the source is local.
2. **Overview on stored data.** Cards and chart read the stored channel totals first (no quota, instant), live only on «Refresh live»; day / week / month switch for the chart; delta explains the comparison honestly (previous period «predates the channel» / «partial»); the 27 Aug banner stays and is shown only where it applies.
3. **Impressions and CTR next to the basics.** Impressions and CTR cards on Overview (same period, same delta rules); CTR line on the chart; Content: video titles instead of ids, a per-video drill-down (daily impressions and CTR from `video_day`), and one «packaging» table per video: impressions, CTR, views, watch time.
4. **Compare by days since publish.** A view over `comparable-age` (a video against comparable ones at the same age) and the video titles in the raw table.
5. **Weekly reports list.** Read-only list/detail of the generated weekly reports.
6. **Consistency.** One period selector shared by the three sub-tabs; the panels already use the active channel (checked: `listChannels` returns only it); retention: draw relative performance.

Suggested order: 1 → 2 → 3 (what the owner/agent look at first), then 6, 4, 5. Slices 1–2 need no new backend; 3 needs a thin route for `videoDaily` and a titles join; 4–5 reuse existing routes.

## Open questions for the owner

1. Overview cards: stored data first with «Refresh live» (saves quota, may lag up to a day for the newest days), or keep live by default?
2. Week/month granularity: only for the chart, or also for the cards' deltas?
3. Priority/scope: all six slices, or stop after 1–3?
4. The «raw collected data» table: keep, hide behind a toggle (as now), or replace by the per-video table of slice 3?

## Acceptance criteria (to be refined with the owner before coding; written from the requirement, not from code)

- A day before the channel was created is never shown as a gap or as zero.
- A number from stored data is labelled with its source and collection time; a live number is labelled live.
- A previous period before the channel existed shows an explanation, not «+∞%» or «0».
- Per-video impressions/CTR in the UI equal `agent_query_channel_reach` for the same video and range.
- No panel shows another channel's data.
