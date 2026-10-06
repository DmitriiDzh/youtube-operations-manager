# Research tab redesign: analysis, design and implementation plan

Owner request (Telegram 2026-10-06, msg 1821): «Сделай анализ раздела Research. Сейчас с точки зрения
пользователя этим интерфейсом неудобно пользоваться. Очень длинная страница и непонятно, что в ней нужно
делать. Проведи исследование и спроектируй обновлённый дизайн этой вкладки. Составь план реализации.»

This document is the analysis, the design and the plan. **It is not an implementation assignment.** The work
below starts only after the owner assigns it (`AGENTS.md` §C). Backlog: BL-140 (proposed). Clickable mockup:
the "Research tab redesign" Artifact linked in the owner thread.

## 1. Current state (measured on the owner's real data, 2026-10-06)

Rendered `/dashboard` → Research in the owner's browser, with 38 watchlist channels and 4,590 observed videos.

| Block (top to bottom) | Height | Controls | Notes |
|---|---:|---:|---|
| Intro line | 20 px | – | "discovery only ever runs on your own explicit request below" |
| Market Overview | 350 px | 1 | Five sections; two of them can never show anything (§2.2) |
| Market research watchlist | 4,764 px | 154 buttons, 3 inputs | Add form, then one card per channel, each with its own "Visible to agents of" chip row |
| Videos | **261,667 px** | 1 | Every observed video, one table, 4,590 rows, no paging, sort or filter |
| Discover channels | 194 px | 2 | Search + candidate list |
| Topics | 162 px | 2 | |
| Trend candidates | 272 px | 2 | |
| YouTube Music chart | 98 px | 2 | |
| Research requests | 110 px | 1 | Agent drafts awaiting approval |
| Collection requests | 130 px | 1 | Agent drafts awaiting approval (they spend quota) |
| **Total page** | **268,031 px** | | ≈ 230 screens of 1,163 px |

The page grows with the data: every list is unbounded (Watchlist, Videos, Discovery candidates, Topics, Trends,
both request histories, every Overview section). The numbers above are today's; the problem gets worse every
collection day.

Code: `src/app/dashboard/page.tsx:395-432` stacks nine `src/components/market-*-panel.tsx` /
`music-chart-panel.tsx` panels in one column. The tab is conditionally mounted, so each visit refetches all of them.

## 2. Problems

### 2.1 Length and order
- Videos alone is 98 % of the page. Everything after it (Discover, Topics, Trends, Music chart, both agent
  request queues) is effectively unreachable.
- The two panels that actually ask the owner to do something (agent research requests and collection
  requests, the only items that wait for a decision) are at the very bottom.
- Nothing on the page says what to do first. Nine panels have the same visual weight.

### 2.2 UI that can never show data
Owner decision Phase 13 D1 = (a) (YouTube API Developer Policies III.E.4.h): no metrics are derived from other
channels' data. `market-intelligence/services.ts` (`DERIVED_METRICS_POLICY_REASON`) withholds velocity,
breakout and emerging assessments for every watchlist channel. The UI still reserves space for them:
- Overview: "Breakout videos" and "Emerging channels" are permanently empty.
- Videos: the "Velocity" and "Relative performance" columns say "not shown (YouTube API policy…)" or "older
  than the 180-day window" on every row.
- Watchlist channel detail: subscriber velocity, upload cadence, a long methodology paragraph, breakout list
  and the emerging verdict.

### 2.3 Repetition and visual weight
- `MarketChannelAssignment` ("Visible to agents of: [channel]…", one chip per connected channel) is repeated on
  every row of six record types. On the watchlist alone that is most of the 154 buttons.
- The per-channel video list in the watchlist expander duplicates the Videos table; breakout/emerging blocks
  duplicate Overview.

### 2.4 Wrong or stale text
- Discovery tooltip still says a search "costs 100 YouTube API units… same daily budget", but searches have
  their own 100-per-day limit (Phase 13).
- Videos' empty state points to the watchlist "below"; it is above. Overview calls the watchlist "Channels".
- Overview rows show raw ids (`channelId · videoId`) instead of titles.
- Watchlist tooltip still says channels are "never automatically discovered".

## 3. Who uses it and for what

Research is global, not scoped to the active channel (Phase 12 D1: «общий сбор и потом выдаем каждому каналу
что нужно ему»). Its users and jobs, in order of how often they come up:

1. **Decide on agents' requests**: approve or reject an agent's search request or collection request (ADR 0021:
   approval is Web-only; the ADR records the owner's decision as "I approve such requests on the Research tab"). Each approval may spend quota.
2. **Look after the watchlist**: which competitors are tracked and why, are they collected and current, which
   channel's agents may see each one.
3. **Look at competitors' videos**: latest observed views, titles, publish dates; find a channel's recent uploads.
4. **Find new channels**: run a search (quota), triage candidates, promote one to the watchlist.
5. **Organize**: topics (labels for channels and videos, with Wikipedia signals) and trend candidates with
   evidence and a lifecycle.
6. **Look something up**: the YouTube Music chart for a region (quota, not stored).

## 4. Design

### 4.1 Structure: one summary line, then sub-tabs

```
Research   38 channels · collected today 12:05 · quota 120 / 500 units · 2 warnings
[ Inbox 2 ] [ Channels ] [ Videos ] [ Discover ] [ Topics & trends ]
```

- **Summary line** replaces the Overview panel. Every item is a link: warnings open Channels filtered to
  stale/failed; the quota figure opens Settings → API.
- **Sub-tabs** use the Production pattern (`production-panel.tsx` `PRODUCTION_TABS`): pill strip, every sub-tab
  stays mounted and is hidden with CSS, so switching is instant and nothing refetches (the owner asked for this
  in Settings). Research itself stays conditionally mounted as today.
- **Default sub-tab**: Inbox when something is pending, otherwise Channels. The sidebar's Research item shows the
  pending count as a badge, like Merge does for conflicts.

### 4.2 Inbox (new; replaces the two request panels)
- One queue of everything an agent asked for: research (search) requests and collection requests, newest first.
  Each card: what was asked, by which channel's agent, why, the cost (searches or units, against today's budget),
  and **Approve** / **Reject** (reason required). The existing confirm dialogs, overlays and fencing stay.
- History of resolved requests below, collapsed, 20 at a time.
- Empty state: "Nothing is waiting for you. Agents' requests to search or to collect appear here."

### 4.3 Channels (the watchlist)
- **Table**, one row per channel: name (and handle), reason (one line, truncated), latest subscribers *as of
  date*, videos observed, last collected, status pill (current / stale / failed / never collected), visible to
  (a "2 channels" pill).
- Toolbar: search by name, filter by status, filter "visible to channel X", **Add channel** (opens a form in a
  dialog instead of a permanent form at the top).
- **Row click opens a side panel** (drawer) with sections: Latest observation (the observed values and their
  dates), Recent videos (20, then "Show all in Videos" which opens Videos filtered to this channel), Evidence,
  Collection depth, Visible to agents of (the chip editor lives here only), Remove.
- Removed: velocity, upload cadence, methodology paragraph, breakout and emerging blocks (§2.2).

### 4.4 Videos
- Server-paged table, 50 rows per page: Title, Channel, Published, Views (as of date), Topic.
- Sort: published (default, newest first) or latest observed views. Filters: channel, topic, published
  after/before, title search.
- **Policy boundary**: only raw observed values with their observation time (III.E.4.f). No velocity, ratios,
  ranks or "growth" columns may be added; sorting by an observed value is allowed.

### 4.5 Discover
- Search box with "N of 100 searches left today", the confirm dialog as today.
- Candidates with a status filter (New by default; Watching, Ignored, Promoted, Archived), paged, with Watch /
  Ignore / Archive / Promote. Promoted ones leave the New list.
- **Music chart** moves here as a second card ("YouTube Music chart: what is trending in a region"), still
  fetched only on the button (it spends quota).
- Corrected tooltip (searches have their own limit).

### 4.6 Topics & trends
- Two lists side by side (stacked on narrow screens): Topics (assignments, Wikipedia signals in the detail) and
  Trend candidates (status filter, evidence, change status in the detail). Same drawer pattern as Channels.

### 4.7 Visibility to agents, everywhere
- Lists show a compact "Visible to: 2 channels" pill; editing happens in the record's drawer. Same model and
  same `PUT /api/market-assignments` call; this changes presentation only.

## 5. What does not change
- No MCP tool, schema, error code or agent API version changes. `agent_list_market_records` and the other agent
  tools are untouched; the withheld fields keep their place in the agent response shape.
- Approval stays Web-only (ADR 0021). Quota rules, the 30-day retention and the no-derived-metrics rule (Phase 13)
  stay exactly as they are.
- Settings → API keeps the daily budget and default collection depth.

## 6. API changes (web routes only, additive)
- `GET /api/market-intelligence/videos-overview` gains `page`, `limit` (≤ 100), `sort`
  (`published|views`), `channelId`, `topicId`, `publishedAfter`, `publishedBefore`, `q`, and returns
  `{ rows, total, page }`. Without parameters it keeps today's response for compatibility, but the UI always
  passes them. Addresses RISK-78 for this read.
- Discovery candidates and request histories: `status` / `limit` / `offset` on the existing list routes.
- A small `GET /api/market-intelligence/summary` (counts, last collection, warnings, today's quota, pending
  inbox count) for the summary line and the sidebar badge, or the same from the existing overview route.

## 7. Slices (one branch `feature/research-tab-redesign`, merged once — `AGENTS.md` §K.1)

Each slice leaves a fully working tab. Acceptance criteria are stated from the requirement (§L).

**R1 — Shell, summary line and Inbox**
Until R2 ships paging, the Videos sub-tab stays conditionally mounted (rendered only while selected), so the
4,590-row table is never rendered hidden. The shell starts on Channels and switches to Inbox once the pending
count arrives non-zero, so the page does not flash. Inbox cards carry the same "Visible to" pill and drawer
editor as other records (requests are an assignment kind; ownership is recorded when the agent creates one).
- AC-R1-1: Research shows the summary line and five sub-tabs; switching sub-tabs does not refetch (all mounted).
- AC-R1-2: with a pending research or collection request, Research opens on Inbox and the sidebar shows the count;
  with none, it opens on Channels and no badge shows.
- AC-R1-3: approving and rejecting work exactly as today (same routes, same confirmations, reason required).
- AC-R1-4: Overview's breakout and emerging sections are gone; its useful parts (counts, warnings, new discoveries)
  are in the summary line and link to the right sub-tab.

**R2 — Videos with server paging**
- AC-R2-1: the Videos sub-tab never renders more than 50 rows; page 2 shows the next 50 by the chosen sort.
- AC-R2-2: filters by channel, topic, dates and title narrow `total` correctly (tested against fixed data).
- AC-R2-3: no column or sort is derived from other channels' data; Velocity and Relative performance are gone.
- AC-R2-4: the route without parameters returns the old shape (no break for any other caller).

**R3 — Channels table and drawer**
- AC-R3-1: the watchlist is a table with the columns in §4.3; the add form is a dialog.
- AC-R3-2: the drawer holds evidence, collection depth, visibility, recent videos and Remove; every action works
  as before (Fetch public snapshot still asks before spending quota).
- AC-R3-3: no chip rows in the table; "visible to" is a pill, edited in the drawer.
- AC-R3-4: with 38 channels the sub-tab fits in about two screens.

**R4 — Discover and Music chart**
- AC-R4-1: candidates filter by status, New by default; promoted candidates leave New.
- AC-R4-2: the search counter and confirm dialog match the separate 100-search limit; the tooltip says so.
- AC-R4-3: the Music chart is never fetched without the button.

**R5 — Topics & trends, text cleanup**
- AC-R5-1: topics and trends use the list + drawer pattern; every existing action still works.
- AC-R5-2: no stale text remains (§2.4): Discovery tooltip, "below" pointers, the "Channels" naming, raw ids in
  Overview rows.

Tests: route tests for the new query parameters (fixed fixtures, expected rows written by hand), source-level UI
tests in the style of `production-panel.test.ts`, and a live check of each sub-tab on the owner's data before the
merge request. Independent review once, before the merge (owner rule).

## 8. Docs to update with the implementation
`docs/SYSTEM_MAP.md` §2.9v (Research UI), `docs/ARCHITECTURE.md` §18 (9H UI areas), RISK-78 (videos read now
paged), `docs/roadmap/BACKLOG.md` BL-140, `docs/ROADMAP_STATUS.md` after the merge.

## 9. Decisions for the owner
1. **Default sub-tab**: Inbox when something is pending, otherwise Channels. *Recommended.*
2. **Remove the policy-withheld UI** (breakout, emerging, velocity, relative performance) rather than keep it
   greyed out. The agent API keeps the fields. *Recommended.*
3. **"Visible to channel X" filter** across Channels, Videos, Discover and Topics & trends, to see what one
   channel's agents see. Recommended as a filter, off by default.
4. **Music chart under Discover.** *Recommended.*
5. **Area list.** Owner spec §30 named the areas Market Overview / Channels / Videos / Trends / Opportunities, in
   that order. This design replaces it with Inbox / Channels / Videos / Discover / Topics & trends, folds Overview
   into the summary line and leaves Opportunities out (it was never built). Please confirm.
