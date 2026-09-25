# Analytics tab — deep Studio parity plan (Overview / Content / Audience)

Produced 2026-09-25, per the project owner's Telegram request: *"Проведи глубокое исследование
youtube studio. Проверь что отображается на закладке Overview... Content и Audience (Trends — не
нужно)... создай план как имплементировать отображения такой же информации у нас... Нужен не
просто экраны в первом приближении, но и учитывая области которые появляются при нажатии."*

**This is a plan, not an implementation.** Nothing here authorizes writing UI code, extending the
read-gateway's analytics adapter, or requesting a new OAuth scope — each slice below needs its own
explicit assignment (`AGENTS.md` §C), same as every other roadmap item.

This document is the detailed follow-up `docs/roadmap/plans/STUDIO_PARITY_PLAN.md` §4 explicitly
deferred: that plan's S6b (Overview) shipped at a first-approximation level (BL-072, 2026-09-23);
S6c (Content-analytics) and S6d (Audience) were left unspecified pending "S6a's foundation
actually exist[ing] and ha[ving] been validated against real data" — true as of this session (the
2026-09-25 analytics-freshness debugging fixed real bugs against two real channels' real
collection history). This document supersedes S6b/S6c/S6d's one-paragraph sketches in
`STUDIO_PARITY_PLAN.md` §4 with acceptance-oriented slices; it does not touch that file's already-
resolved open questions (§5) or its Content/Languages/Home sections, which are unrelated to this
one.

**Scope boundary:** Overview, Content, and Audience sub-tabs of Studio's own "Analytics" section
only. Trends is explicitly excluded (owner: "Trends — не нужно"). "Content" here means the
*Analytics* tab's Content sub-tab (per-video performance/retention/traffic), not this app's own
top-level "Content" tab (the video list) — the two share a name in Studio's own IA but are
unrelated screens; this plan does not touch the video-list Content tab at all.

## 0. Research method and provenance

Live-verified 2026-09-25 by walking the real Studio UI (`claude-in-chrome`, real "Rural Japan
Music" channel, `UC-IdugmwWRvRo9-j0yK5AbA`) for every screen and click-triggered element described
below — not reconstructed from memory or a written description. API feasibility for each new data
point was then checked against official Google documentation (`developers.google.com/youtube/
analytics/{dimensions,metrics}`) via web search, not assumed. Per `AGENTS.md` §L's spirit ("derive
expected behavior from... official YouTube API documentation, never from reading the
implementation"), every "available via public API" claim below cites the specific dimension/metric
name found; every claim of *unavailability* is flagged as needing its own live probe before a
slice starts, exactly as this codebase already does for `CHANNEL_OVERVIEW_METRIC_NAMES` (see that
constant's own doc comment in `src/lib/analytics/contracts.ts` for the precedent this plan follows).

**One correction to that existing precedent, found this session:** that doc comment records a
2026-09-23 live probe of `"impressions"`/`"impressionClickThroughRate"` as rejected ("Unknown
identifier") and concludes impressions/CTR are "genuinely unavailable via the public Analytics
API." Official documentation found this session shows Google added exactly this capability to the
public API on **2026-01-15**, under different identifiers: `videoThumbnailImpressions` and
`videoThumbnailImpressionsClickThroughRate` (a source used the shorter `videoThumbnailImpressionsClickRate`
for the same metric in one place — the exact spelling needs confirming against the live API
reference or a real probe response, not asserted here). The 2026-09-23 conclusion was very likely
a wrong-identifier-name false negative, not a real platform limitation — **Slice C3 below starts
by re-probing with the correct name(s) before doing anything else**, and if confirmed, the existing
"genuinely unavailable" doc comment in `contracts.ts` needs correcting alongside it (never leave a
disproven claim standing once its slice starts touching that file).

## 1. Cross-cutting technical notes (apply to every slice below)

- **No dimension other than `day` is requested anywhere in this codebase today.**
  `src/lib/youtube-read-gateway/analytics-api.ts`'s `queryVideoAnalyticsReport`/
  `queryChannelAnalyticsReport` both hardcode `dimensions: "day"`. Every slice below that needs a
  different dimension (`country`, `deviceType`, `ageGroup,gender`, `insightTrafficSourceType`,
  `elapsedVideoTimeRatio`, `subscribedStatus`, ...) needs a **new exported function in that same
  gateway child module** (`AGENTS.md` §G — extend the existing read gateway, never a parallel
  `googleapis` call site), following the existing two functions' own shape (typed args in, typed
  rows out, no dimension/metric string ever hand-built at a call site).
- **Persistence model — follow `getChannelOverview`'s existing precedent, not `collectMetrics`'s.**
  Everything in this plan is a period-scoped comparison view (current vs. previous N days), exactly
  like the existing Overview cards — not a per-video-per-day historical archive a user pages
  through later. `getChannelOverview` already establishes the right pattern for this shape: a live,
  on-demand Analytics API read for the selected period, never persisted to `video_metrics_daily` or
  any new table. Recommend every new slice below follow that same pattern (no new persisted table),
  unless a specific slice's own acceptance criteria genuinely need history beyond what a live read
  provides — call that out explicitly in that slice's own task if so, rather than defaulting to a
  new table.
- **OAuth scope:** every dimension/metric identified below is covered by the same
  `yt-analytics.readonly` scope already granted (`YOUTUBE_ANALYTICS_READ_SCOPE`) — nothing in this
  plan needs new consent. If a specific slice's live probe finds otherwise, that slice's own task
  must say so explicitly before writing any UI against it.
- **Per-category read toggle / Gate:** every new call funnels through
  `youtube-read-gateway/analytics-api.ts`'s existing `createYoutubeAnalyticsClient`, so the
  existing `getAnalyticsReadsEnabled` toggle (`AGENTS.md` §G) already covers all of this for free —
  no new toggle needed.
- **Small-channel empty states are real, not a bug to route around.** Several Studio panels showed
  "Not enough demographic data to show this report" / "Not enough eligible audience data" live
  against the real, small "Rural Japan Music" channel. Any slice touching those panels must design
  for that empty state explicitly (matching Studio's own wording/tone) rather than assuming data
  will always be present — this app's own real channels are exactly this size today.

## 2. Overview sub-tab

### 2.1 What this app already has (BL-072, `ChannelOverviewPanel`)

Three metric cards (Views / Watch time / Subscribers, each with a %-vs-previous-period delta), a
period selector (7/28/90/365 days), **one chart that always plots Views** (`chartData` in
`channel-overview-panel.tsx` is hardcoded to `row.views`), a local-data "Top content" list, a data-
quality warning banner, and a "Collect now" button. No card-click chart-switching, no tooltips
explaining each metric, no realtime panel.

### 2.2 What real Studio does (live-verified)

- **Headline sentence** above the cards: "Your channel got N views in the last 28 days" (always
  phrased around Views specifically, regardless of which card is selected below).
- **Three metric cards act as a tab strip, not static tiles.** Exactly one is "selected" at a time
  (a lighter background); clicking a card (a) selects it, (b) redraws the single chart below using
  *that* card's own metric and its own native units/axis scale, (c) opens a floating tooltip
  anchored to the card showing: the metric's exact value, "Compared to the previous N days" + the
  %, a one-paragraph plain-language explanation of what the metric means, and a "Learn more" link
  to YouTube's help center. Clicking anywhere outside the tooltip dismisses it; the chart's new
  selection persists.
- **The chart itself** is a single-series area/line chart with small triangular markers along the
  x-axis (one per video published in the range) — clicking one pins a vertical crosshair through
  the chart at that date (no popover content was visible for this specific interaction; treat as
  a "highlight, not disclose" control, not urgent to reproduce exactly). Hovering any point on the
  line shows a small tooltip: `Weekday, Mon D, YYYY` + the exact value for that day.
- **"See more"** below the chart navigates to a full "Advanced mode" explorer (`/explore?...`) — a
  separate, much larger self-service report builder (comparison charts, a sortable per-video data
  table, dimension/metric pickers, chart-type/granularity selectors, CSV export). This exists in
  real Studio behind every "See more" link this session found (Overview's chart, "Top videos,"
  "Top geographies," etc.) — it is a single shared destination, not a bespoke expansion per card.
  **Recommend treating full Advanced-mode parity as its own, separately-scoped future item, out of
  this plan's slices** — it is a materially larger, general-purpose BI surface, not part of
  "Overview/Content/Audience the ordinary user sees."
- **Realtime panel** (right column, Overview only): "Realtime" header with an "Updating live" pill,
  current subscriber count + "See live count" button, a 48-hour hourly bar chart of views with "Now"
  marking the current hour, and its own "Top content, last 48 hours" mini-list with "See more."
- **"Your top content in this period"** section below the chart (present but not fully captured in
  this pass — same shape as the existing local "Top content" list this app already has, likely
  needing no new work beyond what BL-072 already built).

### 2.3 API feasibility

Everything here already works with metrics this app already requests
(`CHANNEL_OVERVIEW_METRIC_NAMES`: views, estimatedMinutesWatched, subscribersGained/Lost) at
`dimensions=day` — no new dimension needed for the card-switching chart itself. The 48-hour
realtime panel is the one new capability: YouTube's Analytics API supports an explicit "estimated,
last-48-hours, near-real-time" report mode (`startDate`/`endDate` around `now`, hourly granularity)
— needs its own live probe to confirm exact parameters (this app has never queried at hourly
granularity or this recently before); the live subscriber count is likely already available via
the existing channel-info read (`youtube-read-gateway/data-api.ts`), not the Analytics API at all
— check that before assuming a new call is needed.

### 2.4 Proposed slices

- **Slice O1 — Card-click chart switching + metric tooltip.** Make the three existing metric cards
  clickable; store which is selected; redraw the existing `AnalyticsLineChart` using the selected
  metric's own data/axis scale/units; add the explanation tooltip (static per-metric copy, no new
  API call — the numbers are already fetched). Smallest, highest-value, zero new API surface.
- **Slice O2 — Chart hover tooltip (exact value + date).** `AnalyticsLineChart` currently has no
  hover interaction at all (confirm by reading that component before starting) — add a crosshair +
  point tooltip, matching this app's own `dataviz` skill conventions rather than copying Studio's
  markup.
- **Slice O3 — Realtime panel.** New adapter function for the 48h/hourly report (own live probe
  first), a new small "Realtime" card component, live subscriber count (check whether an existing
  read already has this before adding a call). Independent of O1/O2.
- **Slice O4-stub — Advanced-mode explorer.** Explicitly deferred, not part of this plan's
  recommended first assignment (§5) — flag as a future, separately-scoped item only.

## 3. Content sub-tab (Analytics → Content, per-video performance)

### 3.1 What this app already has

Nothing under this name today. The closest existing capability is `getComparableAgeComparison`
(Phase 8 follow-up) — a different feature (aligns videos by days-since-publish for direct
comparison), not this tab's own per-video-in-period breakdown. Treat as unrelated, do not conflate.

### 3.2 What real Studio does (live-verified)

- **"Key moments for audience retention"** — a per-video list (title/thumbnail, "latest videos,
  last 365 days") with a headline retention number per video (e.g. "95%... still watching at
  0:30"), four toggle modes above it — **Intro / Top moments / Spikes / Dips** — each filtering
  *which* videos appear in the list (Top moments/Spikes/Dips only show videos that actually had
  one; a video without one is silently excluded, with an explicit "your other recently published
  videos did not have any top moments" note + "Learn more"). Selecting a video row loads its own
  retention curve on the right: an embedded video player, a line chart ("This video" vs. "Typical
  retention" as two distinct series), a small (ⓘ) marker at the specific moment of interest, and a
  "Chart guide" (?) tooltip explaining how to read the curve.
- **"How viewers find your videos"** — sub-tabs (Overall / External / YouTube search / Suggested
  videos / Playlists), each rendering a horizontal-bar breakdown with percentages, "See more."
- **"Impressions and how they led to watch time"** — a *funnel* visualization (visually narrowing,
  not a bar chart): Thumbnail impressions → (an (ⓘ) breaking down "X% from YouTube recommending
  your content") → Thumbnail click-through rate → Engaged views from impressions → Average view
  duration → Watch time from impressions. Five stages, each its own number.
- **"Top videos"** — ranked list by views, horizontal bar + count, "See more."
- **"Top Remixed"** — Shorts-remix-specific ("your content used to create Shorts"): remix-view
  count, remix count, per-source-video breakdown. Needs its own feasibility check (Shorts-remix
  data may be a newer/narrower API surface); low priority given this app's real channels are
  long-form-only today — **recommend deferring this specific card past the first assignment**.

### 3.3 API feasibility

- **Retention curve:** publicly documented (`elapsedVideoTimeRatio` dimension,
  `audienceWatchRatio`/`relativeRetentionPerformance` metrics, per-video). The four
  Intro/Top-moments/Spikes/Dips *modes* are very likely a client-side classification Studio itself
  computes over the same underlying curve (e.g. "top moment" = a local maximum well above the
  smoothed baseline) rather than four separate API reports — this needs confirming against the
  actual shape of a real retention response before committing to an exact algorithm; do not assume
  Google exposes these four labels directly.
- **Traffic sources:** `insightTrafficSourceType` dimension, publicly documented.
- **Impressions/CTR funnel:** see §0's correction above — likely available under
  `videoThumbnailImpressions`/`videoThumbnailImpressionsClickThroughRate` (name to confirm by live
  probe), added to the public API 2026-01-15. "Engaged views from impressions" and "watch time from
  impressions" are more specialized derived figures; confirm the exact metric name(s) Google
  exposes for these two specifically (may not exist as a direct metric — could require combining
  impressions with a filtered views/watch-time query) before committing to full funnel parity in
  one slice.
- **Top videos:** no new capability — this app already has per-video view counts.

### 3.4 Proposed slices

- **Slice C1 — Live probe: confirm the 4 new capabilities above against a real API response**
  (retention dimension/metrics, traffic-source dimension, impressions/CTR metric names, and
  whether "engaged views"/"watch time from impressions" exist as direct metrics). Small, no UI,
  pure research-with-code (a throwaway probe script, not shipped) — de-risks every slice below
  before any of them start. This is the single most valuable next step given this session's own
  finding that a wrong-name false negative already happened once.
- **Slice C2 — Traffic sources card.** Lowest-risk of the four (dimension already confirmed
  public, no funnel/curve complexity) — sub-tab bar breakdown, matching Studio's shape.
- **Slice C3 — Impressions/CTR funnel card.** Depends on C1's probe result for exact metric names
  and whether the full 5-stage funnel is achievable or a narrower 2-3-stage version ships first.
- **Slice C4 — Retention curve + video list.** The largest, most novel piece (new chart type, a
  two-series comparison, per-video selection state, a genuinely new visual language for this app).
  Recommend shipping "Intro" mode alone first (simplest: no top-moment/spike/dip classification
  logic needed, just the raw curve for whichever video is selected), then Top moments/Spikes/Dips
  as a follow-up slice once the classification approach is validated against real data.
- **Slice C5 — Top videos card.** No new API surface; smallest possible standalone slice, could
  ship independently or bundled with any of the above.
- **Slice C6-deferred — Top Remixed.** Explicitly not part of the first assignment (§3.2 above).

## 4. Audience sub-tab

### 4.1 What this app already has

Nothing today.

### 4.2 What real Studio does (live-verified)

- **Two metric cards** (Monthly audience, Subscribers) + one trend chart, same card-tab-strip shape
  as Overview's cards (not independently re-verified for click-to-switch this session, but Studio's
  own UI consistency makes it very likely the same interaction pattern — confirm during
  implementation rather than assuming).
- **"Audience by watch behavior"** — a stacked horizontal bar (New / Casual / Regular viewers, as
  percentages of "monthly audience"), each label with its own (ⓘ) definition tooltip.
- **"Videos growing your audience"** — per-video list with a categorical "New viewers who returned"
  rating (High / Moderate / Low) + a trend icon, not a raw number.
- **"Popular with different audiences"** — filter chips (New / Casual / Regular) over a ranked
  top-videos-by-views list, re-querying per chip.
- **"Channels your audience watches" / "What your audience watches"** — both showed "Not enough
  eligible audience data to show this report" live against the real small channel; these are
  YouTube's own cross-channel affinity/recommendation-graph features and may not be exposed via the
  public Analytics API **at all** (this needs its own explicit research spike before promising
  either, exactly as `STUDIO_PARITY_PLAN.md` §4 already flagged for Home's comments/subscribers
  feeds — do not assume feasibility here either).
- **"When your viewers are on YouTube"** — a day-of-week × hour-of-day heatmap, in the viewer's own
  local time, with a static disclaimer ("Publish time is not known to directly affect the long-term
  performance of a video. Learn more").
- **"Watch time from subscribers"** — Subscribed vs. Not-subscribed watch-time split.
- **"Formats your viewers watch on YouTube"** — three horizontal *percentile gauges* (Videos /
  Shorts / Live), each spanning "Nobody watches" → "Everybody watches" — a distinct visualization
  from a normal percentage bar; worth a deliberate design decision (probably: don't reproduce the
  exact gauge semantics without understanding what percentile it actually represents — confirm via
  Studio's own help text before building a chart whose meaning isn't fully understood).
- **"Device type"** — stacked bar + legend (Computer / Mobile / TV / Tablet, percentages).
- **"Age and gender"** — showed "Not enough demographic data" live; needs a channel with real
  demographic data to verify the populated-state layout before committing to a specific chart type.
- **"Top geographies"** — ranked country list with percentages, "See more."

### 4.3 API feasibility

- **Device type:** `deviceType` dimension, publicly documented.
- **Age/gender:** `ageGroup`, `gender` dimensions, publicly documented.
- **Geography:** `country` dimension, publicly documented (also `province`/`continent` sub-
  dimensions likely exist if a future drill-down is wanted, per `AGENTS.md` §M's design-for-
  extension principle — not needed for a first slice).
- **Watch time from subscribers:** `subscribedStatus` dimension, publicly documented.
- **New/Casual/Regular viewer split:** unclear whether this is a literal API dimension or a Studio-
  computed segmentation over `subscribedStatus` + a returning-viewer heuristic — needs its own live
  probe before committing to an exact reproduction; do not assume a 1:1 dimension exists.
- **When viewers are on YouTube (heatmap):** no publicly documented hour-of-day view dimension was
  found in this session's research — flag as **needs its own dedicated feasibility research spike**
  before any slice promises it; may not be reproducible from the public API at all.
- **Channels/What your audience watches:** flagged above as likely infeasible via public API —
  treat as **out of scope** for this plan's slices unless a future research spike finds otherwise.
- **Formats (Video/Shorts/Live split):** likely `creatorContentType` dimension (documented
  elsewhere in the API's dimension list) — needs its own confirmation, not yet independently
  checked this session.

### 4.4 Proposed slices

- **Slice A1 — Live probe: confirm the open questions in §4.3** (new/casual/regular segmentation,
  hour-of-day heatmap feasibility, `creatorContentType`, and whether channels/what-audience-watches
  are reachable at all) — same rationale as Slice C1, do this before committing UI work to any of
  the uncertain panels.
- **Slice A2 — Device type card.** Confirmed-feasible, no open questions, smallest standalone win.
- **Slice A3 — Age/gender + Top geographies cards.** Both confirmed-feasible, same shape (ranked
  breakdown + percentage), can ship together or split further if preferred at assignment time.
- **Slice A4 — Watch time from subscribers card.** Confirmed-feasible, small.
- **Slice A5 — Audience by watch behavior + Popular with different audiences.** Depends on A1's
  answer for the new/casual/regular segmentation approach.
- **Slice A6 — Formats card.** Depends on A1 confirming `creatorContentType` (or the correct real
  dimension).
- **Slice A7-deferred — When your viewers are on YouTube (heatmap), Videos growing your audience,
  Channels/What your audience watches.** Each has an open feasibility question A1 must answer
  first; do not assign any of these three until that research exists, per the same discipline
  `STUDIO_PARITY_PLAN.md` §4 already applies to Home's comments/subscribers cards.

## 5. Recommended first assignment, if the owner wants to start now

Smallest-risk-first, mirroring `STUDIO_PARITY_PLAN.md` §6's own reasoning style:

1. **O1 (card-click chart switching)** — zero new API surface, immediately visible, matches the
   owner's own explicit ask ("можно переключать views / hours / subscribers... 3 разных графика")
   most directly of everything in this plan.
2. **C1 + A1 (the two live-probe research spikes)** — cheap, de-risk everything downstream,
   surfaces exactly which of §3/§4's "likely feasible" claims actually hold before any UI is built
   on top of a wrong assumption (this session already found one real false-negative from the same
   failure mode, §0).
3. Once C1/A1 land: **O2, O3, C2, C5, A2, A3, A4** are all independently assignable, confirmed-
   feasible, no-open-question slices — any subset can proceed in any order without blocking each
   other.
4. **C3, C4, A5, A6** depend on their respective probe's findings — assign after C1/A1's results
   are in.
5. **O4-stub, C6-deferred, A7-deferred** — explicitly not recommended for this round; each needs
   either a separate scoping decision (Advanced-mode explorer) or its own dedicated feasibility
   research the relevant probe slice doesn't already cover (Shorts-remix data, the heatmap
   dimension, cross-channel affinity data).
