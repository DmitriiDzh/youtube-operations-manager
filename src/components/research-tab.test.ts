import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeResearchSummary, RESEARCH_TABS, shouldOpenInbox, type ResearchSummary } from "./research-tab";
import { videosQueryParams } from "./market-videos-panel";
import { isAnotherModalOpen } from "./side-drawer";
import { filterWatchlistRows } from "./market-research-panel";
import { CANDIDATE_FILTERS } from "./market-discovery-panel";
import { describeVisibleTo } from "./market-channel-assignment";

// BL-140 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4, §7 R1; owner decisions msg 1827).

test("AC-R1-1: Research has five sub-tabs in this order: Inbox, Channels, Videos, Discover, Topics & trends", () => {
  assert.deepEqual(RESEARCH_TABS.map((t) => t.label), ["Inbox", "Channels", "Videos", "Discover", "Topics & trends"]);
});

test("AC-R1-1/R1-4: the dashboard renders the ResearchTab shell; the stacked Overview panel is gone", async () => {
  const page = await readFile(path.join(process.cwd(), "src", "app", "dashboard", "page.tsx"), "utf8");
  const research = page.slice(page.indexOf('tab === "research"'), page.indexOf('tab === "decisions"'));
  assert.match(research, /<ResearchTab /);
  assert.doesNotMatch(page, /MarketOverviewPanel/);
  // AC-R1-2: the sidebar's Research item carries the pending count.
  assert.match(page, /item\.value === "research" \? \{ \.\.\.item, badge: researchPending \}/);
});

test("AC-R1-1: every sub-tab stays mounted and is only hidden (switching never refetches)", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  for (const t of RESEARCH_TABS) assert.match(source, new RegExp(`tab === "${t.value}" \\? "space-y-6" : "hidden"`), t.value);
});

// BL-140 review: the old version of this test matched the component's source text (AGENTS.md §L) and so passed while the
// tab still jumped after the owner had picked one. It now checks the decision itself.
test("AC-R1-2: only the first decision opens Inbox, only with something pending, and never after the owner picked a tab", () => {
  assert.equal(shouldOpenInbox({ decided: false, pending: 2 }), true, "first summary, requests waiting: Inbox");
  assert.equal(shouldOpenInbox({ decided: false, pending: 0 }), false, "first summary, nothing waiting: stay on Channels");
  assert.equal(shouldOpenInbox({ decided: true, pending: 2 }), false, "a later poll, or the owner already picked a tab: never move");
});

const full: ResearchSummary = {
  watchlistCount: 38,
  warningCount: 2,
  newDiscoveryCount: 1,
  searches: { usedToday: 3, dailyLimit: 100 },
  collectionBudget: { dailyBudgetUnits: 500, unitsSpentToday: 120, remainingTodayUnits: 380 },
  pending: { researchRequests: 1, collectionRequests: 1, total: 2 },
};

test("AC-R1-4: the summary line names counts, warnings, budget, searches and pending requests, each linking where it belongs", () => {
  assert.deepEqual(describeResearchSummary(full), [
    { text: "38 channels tracked", tone: "plain", goTo: "channels" },
    // Plan §4.1: "warnings open Channels filtered to stale/failed". R1 had no filter to open yet; R3 added it.
    { text: "2 channels need attention", tone: "warn", goTo: "channels", filter: "needs_attention" },
    { text: "1 new discovery", tone: "plain", goTo: "discover" },
    { text: "Collection budget today: 120 of 500 units", tone: "plain" },
    { text: "Searches left today: 97 of 100", tone: "plain" },
    { text: "2 requests waiting for you", tone: "warn", goTo: "inbox" },
  ]);
});

test("the summary line leaves out what is zero or unavailable, and says when automatic collection is off", () => {
  assert.deepEqual(
    describeResearchSummary({
      watchlistCount: null,
      warningCount: 0,
      newDiscoveryCount: 0,
      searches: null,
      collectionBudget: { dailyBudgetUnits: null, unitsSpentToday: 0, remainingTodayUnits: null },
      pending: { researchRequests: 0, collectionRequests: null, total: 0 },
    }),
    [{ text: "Automatic collection is off (no daily budget in Settings → API)", tone: "warn" }]
  );
});

test("AC-R2-1: the Videos request always asks the server for one page of 50, with only the filters that are set", () => {
  const base = { page: 2, sort: "published" as const, channelId: "", topicId: "", q: "", publishedAfter: "", publishedBefore: "" };
  assert.equal(videosQueryParams(base).toString(), "page=2&limit=50&sort=published");
  assert.equal(
    videosQueryParams({ ...base, page: 1, sort: "views", channelId: "UCx", q: "rain", publishedAfter: "2026-10-01" }).toString(),
    "page=1&limit=50&sort=views&channelId=UCx&q=rain&publishedAfter=2026-10-01"
  );
});

test("AC-R2-3: the Videos table has no derived-metric columns", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-videos-panel.tsx"), "utf8");
  const headers = [...panel.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(headers, ["Title", "Channel", "Published", "Views (as of)", "Topic"]);
  assert.doesNotMatch(panel, /formatFieldVelocity|formatBreakout|\.velocity|\.breakout/);
});

// BL-140 R3 (plan §4.3, §4.7, AC-R3-1..3).

type Row = Parameters<typeof filterWatchlistRows>[0][number];
function row(channelId: string, handleOrUrl: string | null, reason: string, status: Row["status"]): Row {
  return { channelId, handleOrUrl, reason, addedAt: "2026-10-01T00:00:00.000Z", latestObservation: null, videosObserved: 0, latestRun: null, dataQualityFlags: [], status };
}
const rows: Row[] = [
  row("UCaaaaaaaaaaaaaaaaaaaaaa", "@lofigirl", "lofi reference", "current"),
  row("UCbbbbbbbbbbbbbbbbbbbbbb", "@jazzhop", "late uploads", "attention"),
  row("UCcccccccccccccccccccccc", null, "chill beats", "failed"),
  row("UCdddddddddddddddddddddd", "@newone", "agent request", "never_collected"),
];
const noFilter = { query: "", status: "" as const, visibleTo: "", assignments: new Map<string, string[]>() };
const ids = (r: Row[]) => r.map((x) => x.channelId.slice(0, 3));

test("AC-R3-1: the Channels table searches name, id and reason, case-insensitively", () => {
  assert.deepEqual(ids(filterWatchlistRows(rows, noFilter)), ["UCa", "UCb", "UCc", "UCd"]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, query: "JAZZ" })), ["UCb"]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, query: "ucccc" })), ["UCc"]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, query: "beats" })), ["UCc"]);
  assert.deepEqual(filterWatchlistRows(rows, { ...noFilter, query: "nothing like this" }), []);
});

test("AC-R3-1/§4.1: 'needs attention' is every status but current -- the set the summary's warning count covers", () => {
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, status: "needs_attention" })), ["UCb", "UCc", "UCd"]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, status: "failed" })), ["UCc"]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, status: "current" })), ["UCa"]);
});

test("§4.3/decision 3: 'visible to channel X' keeps only channels assigned to X; unassigned channels are never visible", () => {
  const assignments = new Map([
    ["UCaaaaaaaaaaaaaaaaaaaaaa", ["UCmine1", "UCmine2"]],
    ["UCcccccccccccccccccccccc", ["UCmine2"]],
  ]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, visibleTo: "UCmine2", assignments })), ["UCa", "UCc"]);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, visibleTo: "UCmine1", assignments })), ["UCa"]);
  assert.deepEqual(filterWatchlistRows(rows, { ...noFilter, visibleTo: "UCother", assignments }), []);
  assert.deepEqual(ids(filterWatchlistRows(rows, { ...noFilter, visibleTo: "UCmine2", status: "failed", assignments })), ["UCc"]);
});

test("AC-R3-1/R3-3: Channels is a table read from the watchlist-table route, the add form is a dialog, no chip rows in the list", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-research-panel.tsx"), "utf8");
  assert.match(panel, /fetch\("\/api\/market-intelligence\/watchlist-table"\)/);
  const headers = [...panel.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(headers, ["Channel", "Reason", "Subscribers (as of)", "Videos observed", "Last collected", "Status", "Visible to"]);
  assert.match(panel, /\{addOpen && \(\s*<BlockingDialog label="Add a channel to the watchlist"/);
  // The chip editor appears exactly once, inside the drawer's "Visible to agents of" section.
  assert.equal(panel.match(/<MarketChannelAssignment/g)?.length, 1);
  const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
  assert.match(drawer, /<DrawerSection title="Visible to agents of">[\s\S]*<MarketChannelAssignment/);
});

test("AC-R3-2: the drawer holds every action, and Fetch public snapshot asks before spending quota", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-research-panel.tsx"), "utf8");
  const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
  for (const title of ["Latest observation", "Recent videos", "Evidence", "Collection depth", "Visible to agents of", "Remove"]) {
    assert.match(drawer, new RegExp(`<DrawerSection title=\\{?[\`"]${title}`), title);
  }
  // The button only opens the confirm, for the channel it was clicked on; the POST happens in the confirm's handler.
  assert.match(drawer, /onClick=\{\(\) => setConfirmSnapshotChannelId\(selected\.channelId\)\}/);
  assert.match(panel, /\{confirmSnapshotChannelId && \(\s*<ConfirmDialog[\s\S]*?onConfirm=\{handleFetchPublicSnapshot\}/);
  assert.match(panel, /removeTarget && \(\s*<ConfirmDialog/);
});

test("§4.3: the policy-withheld blocks are gone from Channels (velocity, cadence, breakout, emerging, methodology)", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-research-panel.tsx"), "utf8");
  assert.doesNotMatch(panel, /formatFieldVelocity|subscriberVelocity|uploadCadence|recentBreakoutVideos|emergingChannel|methodology/);
});

test("§4.3: 'Show all in Videos' opens Videos filtered to the channel, and the summary's warning link filters Channels", async () => {
  const shell = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  assert.match(shell, /onShowVideos=\{\(channelId\) => \{\s*setVideosChannelFilter\(\{ channelId, nonce: Date\.now\(\) \}\);\s*pickTab\("videos"\);/);
  assert.match(shell, /<MarketVideosPanel active=\{tab === "videos"\} channelFilter=\{videosChannelFilter\?\.channelId \?\? null\} channelFilterNonce=\{videosChannelFilter\?\.nonce\} \/>/);
  assert.match(shell, /statusFilterRequest=\{channelsStatusRequest\}/);
});

// BL-140 R4 (plan §4.5, AC-R4-1..3).

test("AC-R4-1: Discover lists candidates by status, New by default, one server page at a time", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-discovery-panel.tsx"), "utf8");
  assert.deepEqual(CANDIDATE_FILTERS.map((f) => f.label), ["New", "Watching", "Ignored", "Promoted", "Archived"]);
  assert.match(panel, /useState<DiscoveryCandidateStatus>\("new"\)/);
  // The chip editor is only in the drawer; the rows carry the pill.
  assert.equal(panel.match(/<MarketChannelAssignment/g)?.length, 1);
  const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
  assert.match(drawer, /<MarketChannelAssignment/);
});

test("AC-R4-2: the search counter, confirm and tooltip all speak of the separate 100-searches-per-day limit", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-discovery-panel.tsx"), "utf8");
  assert.match(panel, /\{searchesLeft\} of \{searchUsage\.dailyLimit\} searches left today/);
  assert.match(panel, /This uses 1 of YouTube's 100 searches per day \(a separate quota/);
  assert.match(panel, /uses 1 of YouTube&rsquo;s 100 searches per day, a separate quota from the daily units budget/);
  // The old, wrong tooltip: searches do not cost 100 units of the same daily budget.
  assert.doesNotMatch(panel, /Costs 100 YouTube API units|same daily budget/);
});

test("AC-R4-3: the Music chart is fetched only from the Show chart button", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "music-chart-panel.tsx"), "utf8");
  assert.equal(panel.match(/fetch\(/g)?.length, 1, "one fetch, inside load()");
  assert.deepEqual([...panel.matchAll(/load\(/g)].length, 1, "load() has exactly one caller");
  assert.match(panel, /onClick=\{\(\) => void load\(region\)\}/);
  const effects = [...panel.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
  for (const body of effects) assert.doesNotMatch(body, /load|fetch/);
});

test("§4.7: the 'Visible to' pill names no channel, the one channel, or how many", () => {
  const connected = [
    { channelId: "UCa", title: "Lofi Den" },
    { channelId: "UCb", title: "Jazz Room" },
  ];
  assert.equal(describeVisibleTo([], connected), "No channels");
  assert.equal(describeVisibleTo(["UCb"], connected), "Jazz Room");
  assert.equal(describeVisibleTo(["UCgone"], connected), "1 channel");
  assert.equal(describeVisibleTo(["UCa", "UCb"], connected), "2 channels");
});

// BL-140 R5 (plan §4.6, §2.4, AC-R5-1/2).

test("AC-R5-1: Topics and Trend candidates are compact lists; details, actions and visibility open in a side panel", async () => {
  for (const file of ["market-topics-panel.tsx", "market-trends-panel.tsx"]) {
    const panel = await readFile(path.join(process.cwd(), "src", "components", file), "utf8");
    assert.equal(panel.match(/<MarketChannelAssignment/g)?.length, 1, file);
    const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
    assert.match(drawer, /<DrawerSection title="Visible to agents of">[\s\S]*<MarketChannelAssignment/, file);
    assert.match(panel, /<VisibleToPill /, file);
  }
  const topics = await readFile(path.join(process.cwd(), "src", "components", "market-topics-panel.tsx"), "utf8");
  const topicDrawer = topics.slice(topics.indexOf("<SideDrawer"), topics.indexOf("</SideDrawer>"));
  for (const action of ["<TopicWikipediaSignals", "handleAssign(", "handleRemoveAssignment(", "setDeleteTarget("]) assert.ok(topicDrawer.includes(action), action);
  const trends = await readFile(path.join(process.cwd(), "src", "components", "market-trends-panel.tsx"), "utf8");
  const trendDrawer = trends.slice(trends.indexOf("<SideDrawer"), trends.indexOf("</SideDrawer>"));
  for (const action of ["handleAddEvidence(", "handleUpdateStatus(", "Reason for this status change"]) assert.ok(trendDrawer.includes(action), action);
  // Status filter on the list, the add form in a dialog.
  assert.match(trends, /useState<TrendCandidateStatus \| "">\(""\)/);
  assert.match(trends, /\{addOpen && \(\s*<BlockingDialog label="Add a trend candidate"/);
});

test("AC-R5-1: Topics & trends shows the two lists side by side on wide screens", async () => {
  const shell = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  const topics = shell.slice(shell.indexOf('tab === "topics"'));
  assert.match(topics, /<div className="grid items-start gap-6 xl:grid-cols-2">\s*<FeatureErrorBoundary label="Research — Topics">/);
});

test("AC-R5-2: no stale text is left in the Research components (§2.4)", async () => {
  const dir = path.join(process.cwd(), "src", "components");
  const files = ["research-tab.tsx", "market-research-panel.tsx", "market-videos-panel.tsx", "market-discovery-panel.tsx", "music-chart-panel.tsx", "market-topics-panel.tsx", "market-trends-panel.tsx", "market-research-requests-panel.tsx", "market-collection-requests-panel.tsx"];
  for (const file of files) {
    const source = await readFile(path.join(dir, file), "utf8");
    assert.doesNotMatch(source, /\bbelow\b|never automatically discovered|Costs 100 YouTube API units|same daily budget/, file);
  }
  // The Overview panel is gone entirely, not only unmounted.
  await assert.rejects(readFile(path.join(dir, "market-overview-panel.tsx"), "utf8"));
});

// BL-140 review (findings 3, 4, 5).

test("the drawer keeps Escape for a dialog opened on top of it, and closes on Escape when it is the only modal", () => {
  const drawer = { id: "drawer" } as unknown as Element;
  const confirm = { id: "confirm" } as unknown as Element;
  const root = (open: Element[]) => ({ querySelectorAll: () => open as unknown as NodeListOf<Element> });
  assert.equal(isAnotherModalOpen(drawer, root([drawer])), false);
  assert.equal(isAnotherModalOpen(drawer, root([drawer, confirm])), true);
});

test("each summary link opens its list showing what it counted, and sub-tabs refresh after changes elsewhere", async () => {
  const shell = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  // "38 channels tracked" clears the Channels status filter; "N need attention" sets it; "N new discoveries" shows New.
  assert.match(shell, /if \(part\.goTo === "channels"\) setChannelsStatusRequest\(\{ status: part\.filter \?\? "", nonce: Date\.now\(\) \}\);/);
  assert.match(shell, /if \(part\.goTo === "discover"\) setDiscoverStatusRequest\(\{ status: "new", nonce: Date\.now\(\) \}\);/);
  // Inbox, Channels and Discover report changes so the summary line and badges follow at once.
  for (const panel of ["MarketResearchRequestsPanel", "MarketCollectionRequestsPanel", "MarketResearchPanel", "MarketDiscoveryPanel"]) {
    assert.match(shell, new RegExp(`<${panel}[^>]*onChanged=\\{onChanged\\}`), panel);
  }
  for (const [panel, tab] of [["MarketResearchPanel", "channels"], ["MarketVideosPanel", "videos"], ["MarketDiscoveryPanel", "discover"]]) {
    assert.match(shell, new RegExp(`<${panel}[^>]*active=\\{tab === "${tab}"\\}`), panel);
  }
});
