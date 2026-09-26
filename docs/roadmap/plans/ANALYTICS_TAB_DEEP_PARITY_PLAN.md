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

**Update, BL-093 (Slice C1's own live probe, 2026-09-25, run against the real "Tropico Jazz"
channel via the exact `youtubeAnalytics/v2/reports:query` endpoint this app's gateway already
calls):** this plan's own first-draft note above suspected the 2026-09-23 "impressions/CTR
unavailable" conclusion in `contracts.ts` was a simple wrong-metric-name false negative. **That
suspicion was half right and half wrong — corrected here rather than left standing.** Confirmed via
a real probe request:

- `videoThumbnailImpressions`/`videoThumbnailImpressionsClickThroughRate` **are** real, recognized
  identifiers (a query naming an actually-unknown metric returns `"Unknown identifier (X)"` naming
  that metric specifically; these two never appear in that role).
- But every shape tried against the ad-hoc `reports:query` endpoint — channel-level with no
  dimension, with `dimensions=day`, with `dimensions=video`, paired with `views`, filtered to one
  video — returned `"The query is not supported"`, not a metric-name error. Further research (the
  same official docs, `channel_reports`) found why: these two metrics belong to a **separate
  "Reach report" family** (`channel_reach_basic_a1`/`channel_reach_combined_a1`), which lives under
  the **YouTube *Reporting* API v1** (`developers.google.com/youtube/reporting`) — a bulk,
  scheduled-job system (create a reporting job once, then periodically list/download generated
  report files) — **not** the ad-hoc `youtubeAnalytics/v2 reports:query` endpoint
  `youtube-read-gateway/analytics-api.ts` calls everywhere else in this app. No dimension
  combination on the query endpoint will ever return these two metrics, regardless of exact naming.
- **Revised conclusion:** the 2026-09-23 "unavailable" verdict was correct for the API surface this
  app actually uses, for the wrong stated reason (it blamed the metric *name*, when the real
  blocker is that it's a structurally different API integration). Retained in full below (§3.3/3.4)
  as Slice C3's now-corrected scope: full impressions/CTR funnel parity needs a **new Reporting API
  v1 integration** (its own OAuth scope check — `yt-analytics.readonly` may or may not cover it,
  unconfirmed — its own job-creation/polling adapter, no live-request-response symmetry with every
  other slice in this plan) — a materially larger, differently-shaped effort than "add a metric
  name." **Recommend treating C3 as its own separately-scoped future decision, not part of this
  round's assignable slices** (§5 updated accordingly, and since confirmed final -- C3 is
  permanently out of scope, not merely deferred pending a future pickup). The `contracts.ts` doc
  comment's own "genuinely unavailable" conclusion has already been corrected (commit `adea559`)
  to cite this finding instead of the wrong-name theory -- done, not still pending.
- Every other capability this plan flagged as "needs its own live probe" was **also confirmed
  working** in the same probe run, against real data: `elapsedVideoTimeRatio` (retention, paired
  with `audienceWatchRatio`/`relativeRetentionPerformance`), `insightTrafficSourceType` (traffic
  sources), `deviceType`, `ageGroup,gender`, `country`, `subscribedStatus`, and `creatorContentType`
  (Formats) all returned real `200` responses with real rows against the "Tropico Jazz" channel.
  These slices (C2, C4, A2-A4, A6) can proceed with their dimension/metric names confirmed, not
  merely "documented."

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
`dimensions=day` — no new dimension needed for the card-switching chart itself. **Updated
(2026-09-26), superseding this section's own first-draft text below:** the 48-hour realtime panel
is **not** buildable at all via any public API surface — see §2.4's O3 entry for the confirmed
finding (a live probe returned genuinely empty rows for "today"/last-48-hours, and further research
established the underlying 48-72 hour processing delay applies to both the ad-hoc query API and the
bulk Reporting API; Studio's live panel runs on non-public internal infrastructure). The one
genuinely-public piece of that panel, an all-time subscriber count via `channels.list`, is not new
work either — `ChannelOverviewPanel` already displays it. Nothing in this panel needs a new API
call; O3 is out of scope entirely, not merely blocked pending a probe.

### 2.4 Proposed slices

- ~~**Slice O1 — Card-click chart switching + metric tooltip.**~~ **DONE (2026-09-26).** Made the
  three existing metric cards clickable; stores which is selected; redraws the existing
  `AnalyticsLineChart` using the selected metric's own data/axis scale/units; added the explanation
  tooltip (static per-metric copy, no new API call — the numbers are already fetched). Smallest,
  highest-value, zero new API surface.
- ~~**Slice O2 — Chart hover tooltip.**~~ **DONE, smaller than planned (2026-09-26).** This plan's
  own first-draft note above was wrong: `AnalyticsLineChart` already had a crosshair + point
  tooltip before this round (built earlier, BL-072) — never actually re-read before this line was
  written. The real remaining gap was just date formatting: the tooltip showed a raw `YYYY-MM-DD`
  string, not Studio's own "Weekday, Mon D, YYYY" wording. Added `formatChartDate` (`period.ts`,
  parses the date's own UTC components directly so the weekday never shifts with the viewer's local
  timezone) and wired it into the Overview chart. 2 new tests.
- **Slice O3 — Realtime panel — CONFIRMED INFEASIBLE via the public API (2026-09-26 probe +
  research), not merely unconfirmed.** A direct probe against a real channel for "today"/"the last
  48 hours" via the same `youtubeAnalytics/v2 reports:query` endpoint this app already uses
  returned genuinely empty rows — confirming (again) the documented 48-72 hour processing delay
  this app's own `computeDefaultAutoCollectionRange` already works around. Further research found
  this delay applies to **both** the ad-hoc query API and the bulk Reporting API — neither public
  surface can produce Studio's live, updating-every-few-seconds 48h hourly bar chart or live
  subscriber ticker; that panel is built on Studio's own internal, non-public infrastructure, the
  same class of gap as C3's impressions/CTR funnel (§3.3) and the cross-channel-affinity cards
  (§4.3). The one genuinely-public piece of this panel — an all-time subscriber count via
  `channels.list` — is not new: `ChannelOverviewPanel` already displays it ("Current subscribers
  (all-time)"). **Nothing to build here; moved to permanently out of scope, not merely deferred.**
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

- **Retention curve — CONFIRMED (BL-093 live probe, 2026-09-25).** `dimensions=elapsedVideoTimeRatio`,
  `metrics=audienceWatchRatio,relativeRetentionPerformance`, `filters=video==<id>` returned a real
  100-row curve (elapsed ratio 0.01→1.00) against a real Tropico Jazz video. The four
  Intro/Top-moments/Spikes/Dips *modes* are still believed to be a client-side classification Studio
  computes over this same underlying curve, not four separate API reports — not independently
  confirmed this round. **Updated (2026-09-26):** the exact classification rule (e.g. "top moment" =
  a local maximum well above the smoothed baseline) was not Slice C4's first task as actually
  delivered — C4 shipped Intro-mode only and deliberately excluded classification altogether,
  deferring it to its own follow-up slice (see §3.4's own Slice C4 entry and §5's status). It does
  not block C1/C2 either way.
- **Traffic sources — CONFIRMED.** `dimensions=insightTrafficSourceType`, `metrics=views` returned
  real rows (`SUBSCRIBER`, `RELATED_VIDEO`, `YT_SEARCH`, etc.) with real view counts.
- **Impressions/CTR funnel — CONFIRMED UNAVAILABLE via this app's existing API integration, for a
  different reason than first suspected.** See §0's corrected finding: `videoThumbnailImpressions`/
  `videoThumbnailImpressionsClickThroughRate` are real identifiers but belong to the YouTube
  *Reporting* API v1's bulk "Reach report" job system, not the ad-hoc `youtubeAnalytics/v2
  reports:query` endpoint this app's gateway uses everywhere else. Achieving this specific card
  needs a new, structurally different API integration (scheduled report jobs, not live queries) —
  its own separately-scoped future decision (§3.4, §5), not a slice of this round.
- **Top videos:** no new capability — this app already has per-video view counts.

### 3.4 Proposed slices

- ~~**Slice C1 — Live probe.**~~ **DONE (BL-093, 2026-09-25).** See §0 and §3.3 above for the full
  result: retention and traffic-source dimensions confirmed working against real data; impressions/
  CTR confirmed to need a structurally different API (Reporting API v1, not this app's existing
  query-based gateway) — not a naming fix.
- ~~**Slice C2 — Traffic sources card.**~~ **DONE (BL-095, 2026-09-26).** Confirmed-feasible, no
  funnel/curve complexity — sub-tab bar breakdown, matching Studio's shape.
- **Slice C3-deferred — Impressions/CTR funnel card.** Moved out of this round's assignable set per
  §0/§3.3's corrected finding — building it means integrating the YouTube Reporting API v1 (a new
  OAuth-scope check, a new job-creation/polling adapter with no precedent anywhere in this codebase
  today), not adding a metric name to the existing gateway pattern every other slice in this plan
  uses. Recommend the owner treat "is this new integration worth it for one funnel card" as its own
  explicit decision before assigning it, rather than folding it into this round.
- ~~**Slice C4 — Retention curve + video list.**~~ **DONE, "Intro" mode only (BL-097, 2026-09-26).**
  Confirmed-feasible (dimension/metrics live-verified). Shipped the raw curve for whichever video is
  selected, deliberately without top-moment/spike/dip classification logic (the largest, most novel
  piece — new chart type, a two-series comparison, per-video selection state — scoped down to its
  simplest useful form first); Top moments/Spikes/Dips remains a follow-up slice once a
  classification approach is validated against real data, per commit `4ddc0c9`.
- ~~**Slice C5 — Top videos card.**~~ **DONE (BL-096, 2026-09-26).** No new API surface; extracted a
  shared `use-top-videos.ts` hook (`AGENTS.md` §D) rather than a third, standalone implementation.
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
- **Watch time from subscribers — CONFIRMED (BL-094 live probe, 2026-09-25).**
  `dimensions=subscribedStatus`, `metrics=estimatedMinutesWatched` returned real
  `SUBSCRIBED`/`UNSUBSCRIBED` rows against Tropico Jazz.
- **Formats (Video/Shorts/Live split) — CONFIRMED.** `dimensions=creatorContentType` returned a
  real row (`videoOnDemand`, this channel has no Shorts/Live yet — the dimension itself works;
  whether it returns the other two values for a channel that has them was not testable against this
  channel's real catalog, a real gap this specific channel's data can't close).
- **New/Casual/Regular viewer split:** **not tested this round** (no obvious single dimension name
  to probe blindly) — still unclear whether this is a literal API dimension or a Studio-computed
  segmentation over `subscribedStatus` + a returning-viewer heuristic. Still needs its own live
  probe before committing to an exact reproduction; do not assume a 1:1 dimension exists.
- **When viewers are on YouTube (heatmap):** **not tested this round** — no publicly documented
  hour-of-day view dimension was found in this session's research. Still flagged as **needs its own
  dedicated feasibility research spike** before any slice promises it; may not be reproducible from
  the public API at all.
- **Channels/What your audience watches:** **not tested this round** — still flagged as likely
  infeasible via public API; treat as **out of scope** for this plan's slices unless a future
  research spike finds otherwise.

### 4.4 Proposed slices

- ~~**Slice A1 — Live probe.**~~ **PARTIALLY DONE (BL-094, 2026-09-25).** Device type, age/gender,
  geography, subscribed-status, and `creatorContentType` all confirmed working against real data
  (§4.3 above) — A2/A3/A4/A6 below are now confirmed-feasible, not merely "likely." The three
  harder open questions (new/casual/regular segmentation, the hour-of-day heatmap, cross-channel
  affinity data) were **not** resolved this round — no obvious dimension name existed to try blindly
  the way the other five did; each still needs its own dedicated research pass before A5/A7 can be
  assigned (see below).
- ~~**Slice A2 — Device type card.**~~ **DONE (BL-095, 2026-09-26).** Confirmed-feasible, no open
  questions, smallest standalone win.
- ~~**Slice A3 — Age/gender + Top geographies cards.**~~ **DONE (BL-095, 2026-09-26).** Both
  confirmed-feasible, same shape (ranked breakdown + percentage), shipped together.
- ~~**Slice A4 — Watch time from subscribers card.**~~ **DONE (BL-095, 2026-09-26).** Confirmed-feasible, small.
- **Slice A5 — Audience by watch behavior + Popular with different audiences.** Still blocked on
  the unresolved new/casual/regular segmentation question above.
- ~~**Slice A6 — Formats card.**~~ **DONE (BL-095, 2026-09-26).** Confirmed-feasible
  (`creatorContentType`), with the caveat that this channel's own data can only exercise the
  `videoOnDemand` value; Shorts/Live values are unverified against a real response and should be
  treated as "documented, not observed" until tested against a channel that actually has that
  content type.
- **Slice A7-deferred — When your viewers are on YouTube (heatmap), Videos growing your audience,
  Channels/What your audience watches.** Each still has an open feasibility question, unresolved by
  this round's probe; do not assign any of these three until that research exists, per the same
  discipline `STUDIO_PARITY_PLAN.md` §4 already applies to Home's comments/subscribers cards.

## 5. Recommended first assignment, if the owner wants to start now

Smallest-risk-first, mirroring `STUDIO_PARITY_PLAN.md` §6's own reasoning style. **Updated
2026-09-26 — every slice this section originally recommended is now either done or definitively
resolved as out of scope** (all held un-merged as one batch pending the owner's own end-of-batch
approval, per their instruction):

1. **DONE: O1, O2, C1, C2, C4 ("Intro" mode only), C5, A2, A3, A4, A6.** **PARTIALLY DONE: A1**
   (independent review round 4, 2026-09-26 -- flagged for consistency with §4.4's own "PARTIALLY
   DONE" label for this same slice: 5 of 8 Audience dimensions confirmed, 3 harder questions
   unresolved, see §4.3/§4.4). Card-click chart switching + tooltip date formatting (Overview); both
   research probes; traffic sources, retention curve, and top videos (Content); device type,
   age/gender, geography, subscribed status, and content format (Audience). All live-verified in the
   browser against the real "Tropico Jazz" channel with real data; `npm test` clean at every step
   (1465/1465 as of the last independent-review fix, dev's own baseline was 1432); no console
   errors. Seven backlog rows (BL-092 through BL-098) record the detailed history; BL-098's own
   Notes column is the single running tally of independent-review rounds and findings — see there
   for the current count rather than a number restated here.
2. **CONFIRMED OUT OF SCOPE, not merely deferred: O3 (realtime panel) and C3 (impressions/CTR
   funnel).** Both need infrastructure this app's existing gateway pattern cannot reach at all —
   O3 needs Studio's own non-public real-time system (the public API's 48-72h processing delay
   applies uniformly, confirmed by a direct probe); C3 needs a structurally different API (YouTube
   Reporting API v1's bulk job system, not the ad-hoc query endpoint). Neither should be assigned
   as a normal slice of this plan; each would need its own separate scoping decision if ever
   pursued.
3. **Still genuinely blocked on an unresolved research question: A5** (new/casual/regular
   segmentation) **and A7-deferred** (hour-of-day heatmap, cross-channel affinity, "videos growing
   your audience"). Unlike O3/C3 above, these were never actually probed this round (no obvious
   dimension name existed to try) — a real, separate research pass could still resolve them; do not
   assign until one does.
4. **O4-stub (Advanced-mode explorer), C6-deferred (Top Remixed)** — still not recommended for this
   round, unchanged from the original assessment.
