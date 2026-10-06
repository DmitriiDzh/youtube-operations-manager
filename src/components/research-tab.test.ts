import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { describeResearchSummary, RESEARCH_TABS, type ResearchSummary } from "./research-tab";
import { filterWatchlistRows } from "./market-research-panel";

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

test("AC-R1-2: the first summary opens Inbox only when something is pending; later polls never switch the tab", async () => {
  const source = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  assert.match(source, /useState<ResearchSubTab>\("channels"\)/);
  assert.match(source, /if \(!openedOnce\.current\) \{\s*openedOnce\.current = true;\s*if \(data\.pending\.total > 0\) setTab\("inbox"\);/);
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

test("AC-R2-1/3: the Videos table asks the server for one page and has no derived-metric columns", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-videos-panel.tsx"), "utf8");
  assert.match(panel, /new URLSearchParams\(\{ page: String\(page\), limit: String\(PAGE_SIZE\), sort \}\)/);
  assert.match(panel, /const PAGE_SIZE = 50;/);
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
  // The button only opens the confirm; the POST happens in the confirm's handler.
  assert.match(drawer, /onClick=\{\(\) => setConfirmSnapshot\(true\)\}/);
  assert.match(panel, /\{confirmSnapshot && \(\s*<ConfirmDialog[\s\S]*?onConfirm=\{handleFetchPublicSnapshot\}/);
  assert.match(panel, /removeTarget && \(\s*<ConfirmDialog/);
});

test("§4.3: the policy-withheld blocks are gone from Channels (velocity, cadence, breakout, emerging, methodology)", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-research-panel.tsx"), "utf8");
  assert.doesNotMatch(panel, /formatFieldVelocity|subscriberVelocity|uploadCadence|recentBreakoutVideos|emergingChannel|methodology/);
});

test("§4.3: 'Show all in Videos' opens Videos filtered to the channel, and the summary's warning link filters Channels", async () => {
  const shell = await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8");
  assert.match(shell, /onShowVideos=\{\(channelId\) => \{\s*setVideosChannelFilter\(\{ channelId, nonce: Date\.now\(\) \}\);\s*setTab\("videos"\);/);
  assert.match(shell, /<MarketVideosPanel channelFilter=\{videosChannelFilter\?\.channelId \?\? null\} channelFilterNonce=\{videosChannelFilter\?\.nonce\} \/>/);
  assert.match(shell, /statusFilterRequest=\{channelsStatusRequest\}/);
});
