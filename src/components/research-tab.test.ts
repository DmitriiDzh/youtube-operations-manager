import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTranslator, formatNumber, translate, type UiTextKey } from "@/lib/ui-text";
import { research as researchArea } from "@/lib/ui-text/locales/en/research";
import { describeResearchSummary, RESEARCH_TABS, shouldOpenInbox, type ResearchSummary } from "./research-tab";
import { videosQueryParams } from "./market-videos-panel";
import { isAnotherModalOpen } from "./side-drawer";
import { filterWatchlistRows } from "./market-research-panel";
import { CANDIDATE_FILTERS, defaultTrackReason } from "./market-discovery-panel";
import { describeVisibleTo } from "./market-channel-assignment";

// BL-140 (docs/roadmap/plans/RESEARCH_TAB_REDESIGN_PLAN.md §4, §7 R1; owner decisions msg 1827).

// BL-152: the Research shell, Channels and Discover texts are interface-text keys; the requirement checked here is their
// English wording. `en` translates helper output; `sourceInEnglish` turns `{t("key")}` in a component's source into its
// English wording as a quoted attribute value, so the source checks below keep their English expectations.
const en = createTranslator("en");
const enUi = { t: en, formatNumber: (value: number, options?: Intl.NumberFormatOptions) => formatNumber("en", value, options) };
const sourceInEnglish = (source: string) => source.replace(/\{t\("([^"]+)"\)\}/g, (_m, key: string) => JSON.stringify(translate("en", key as UiTextKey)));

test("AC-R1-1: Research has five sub-tabs in this order: Inbox, Channels, Videos, Discover, Topics & trends", () => {
  assert.deepEqual(RESEARCH_TABS.map((t) => translate("en", t.labelKey)), ["Inbox", "Channels", "Videos", "Discover", "Topics & trends"]);
});

test("AC-R1-1/R1-4: the dashboard renders the ResearchTab shell; the stacked Overview panel is gone", async () => {
  // BL-149: Research is its own page and the sidebar lives in the (app) layout (the single dashboard page is gone; the
  // requirement this test checks is unchanged).
  const research = await readFile(path.join(process.cwd(), "src", "app", "(app)", "research", "layout.tsx"), "utf8");
  const layout = await readFile(path.join(process.cwd(), "src", "app", "(app)", "layout.tsx"), "utf8");
  assert.match(research, /<ResearchTab\b/);
  assert.doesNotMatch(research + layout, /MarketOverviewPanel/);
  // AC-R1-2: the sidebar's Research item carries the pending count.
  assert.match(layout, /item\.value === "research" \? \{ \.\.\.item, badge: researchPending \}/);
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
  assert.deepEqual(describeResearchSummary(en, full), [
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
    describeResearchSummary(en, {
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
  // BL-152: the headers are interface-text keys now; the requirement checked here is the English wording.
  const headers = [...panel.matchAll(/<th[^>]*>\{t\("([^"]+)"\)\}<\/th>/g)].map((m) => translate("en", m[1] as UiTextKey));
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
  const panel = sourceInEnglish(await readFile(path.join(process.cwd(), "src", "components", "market-research-panel.tsx"), "utf8"));
  assert.match(panel, /fetch\("\/api\/market-intelligence\/watchlist-table"\)/);
  const headers = [...panel.matchAll(/<th[^>]*>"([^<"]+)"<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(headers, ["Channel", "Reason", "Subscribers (as of)", "Videos observed", "Last collected", "Status", "Visible to"]);
  assert.match(panel, /\{addOpen && \(\s*<BlockingDialog label="Add a channel to the watchlist"/);
  // The chip editor appears exactly once, inside the drawer's "Visible to agents of" section.
  assert.equal(panel.match(/<MarketChannelAssignment/g)?.length, 1);
  const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
  assert.match(drawer, /<DrawerSection title="Visible to agents of">[\s\S]*<MarketChannelAssignment/);
});

test("AC-R3-2: the drawer holds every action, and Fetch public snapshot asks before spending quota", async () => {
  const panel = sourceInEnglish(await readFile(path.join(process.cwd(), "src", "components", "market-research-panel.tsx"), "utf8"));
  const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
  for (const title of ["Latest observation", "Evidence", "Collection depth", "Visible to agents of", "Remove"]) {
    assert.match(drawer, new RegExp(`<DrawerSection title=\\{?[\`"]${title}`), title);
  }
  // "Recent videos" picks between two keys (with and without its count), so its title is a choice, not one string.
  // Both keys must sit inside ONE DrawerSection's title expression (review: a looser match accepted the key anywhere).
  const recentTitle = drawer.match(/<DrawerSection\s+title=\{((?:(?!<DrawerSection)[\s\S])*?)\}\s*>/g)?.find((m) => m.includes("watchlist.drawer.recentVideos"));
  assert.ok(recentTitle, "a DrawerSection title holds the Recent videos keys");
  assert.match(recentTitle, /t\("watchlist\.drawer\.recentVideosOf"/);
  assert.match(recentTitle, /t\("watchlist\.drawer\.recentVideos"\)/);
  assert.equal(en("watchlist.drawer.recentVideos"), "Recent videos");
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
  // BL-145 (owner, msg 1904): Watch is gone; Promote is "Track"; the old "watching" status shows only for older data.
  assert.deepEqual(CANDIDATE_FILTERS.map((f) => en(f.labelKey)), ["New", "Tracked", "Ignored", "Archived", "Shortlisted (old)"]);
  assert.match(panel, /useState<DiscoveryCandidateStatus>\("new"\)/);
  // The chip editor is only in the drawer; the rows carry the pill.
  assert.equal(panel.match(/<MarketChannelAssignment/g)?.length, 1);
  const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
  assert.match(drawer, /<MarketChannelAssignment/);
});

test("AC-R4-2: the search counter, confirm and tooltip all speak of the separate 100-searches-per-day limit", async () => {
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-discovery-panel.tsx"), "utf8");
  // BL-152: the panel shows each text by its key; the key's English says what the requirement asks.
  assert.match(panel, /t\("discover\.searchesLeft", \{ left: searchesLeft \?\? 0, limit: searchUsage\.dailyLimit \}\)/);
  assert.equal(en("discover.searchesLeft", { left: 97, limit: 100 }), "97 of 100 searches left today");
  assert.match(panel, /t\("discover\.confirm\.channels"/);
  assert.match(en("discover.confirm.channels", { query: "q" }), /This uses 1 of YouTube's 100 searches per day \(a separate quota/);
  assert.match(panel, /<InfoTooltip>\{t\("discover\.tooltip"\)\}<\/InfoTooltip>/);
  assert.match(en("discover.tooltip"), /uses 1 of YouTube’s 100 searches per day, a separate quota from the daily units budget/);
  // The old, wrong tooltip: searches do not cost 100 units of the same daily budget.
  const confirms = [en("discover.confirm.genre", { query: "q" }), en("discover.confirm.genreWithin", { query: "q", days: 30 }), en("discover.confirm.channels", { query: "q" })];
  for (const text of [panel, en("discover.tooltip"), ...confirms]) assert.doesNotMatch(text, /Costs 100 YouTube API units|same daily budget/);
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
  assert.equal(describeVisibleTo(en, [], connected), "No channels");
  assert.equal(describeVisibleTo(en, ["UCb"], connected), "Jazz Room");
  assert.equal(describeVisibleTo(en, ["UCgone"], connected), "1 channel");
  assert.equal(describeVisibleTo(en, ["UCa", "UCb"], connected), "2 channels");
});

// BL-140 R5 (plan §4.6, §2.4, AC-R5-1/2).

// BL-152: the panels' texts are interface-text keys now; `{t("key")}` is resolved to its English wording as a quoted
// attribute value, so the checks below still assert the English requirement unchanged.
test("AC-R5-1: Topics and Trend candidates are compact lists; details, actions and visibility open in a side panel", async () => {
  for (const file of ["market-topics-panel.tsx", "market-trends-panel.tsx"]) {
    const panel = sourceInEnglish(await readFile(path.join(process.cwd(), "src", "components", file), "utf8"));
    assert.equal(panel.match(/<MarketChannelAssignment/g)?.length, 1, file);
    const drawer = panel.slice(panel.indexOf("<SideDrawer"), panel.indexOf("</SideDrawer>"));
    assert.match(drawer, /<DrawerSection title="Visible to agents of">[\s\S]*<MarketChannelAssignment/, file);
    assert.match(panel, /<VisibleToPill /, file);
  }
  const topics = await readFile(path.join(process.cwd(), "src", "components", "market-topics-panel.tsx"), "utf8");
  const topicDrawer = topics.slice(topics.indexOf("<SideDrawer"), topics.indexOf("</SideDrawer>"));
  for (const action of ["<TopicWikipediaSignals", "handleAssign(", "handleRemoveAssignment(", "setDeleteTarget("]) assert.ok(topicDrawer.includes(action), action);
  const trends = sourceInEnglish(await readFile(path.join(process.cwd(), "src", "components", "market-trends-panel.tsx"), "utf8"));
  const trendDrawer = trends.slice(trends.indexOf("<SideDrawer"), trends.indexOf("</SideDrawer>"));
  for (const action of ["handleAddEvidence(", "handleUpdateStatus(", "Reason for this status change"]) assert.ok(trendDrawer.includes(action), action);
  // Status filter on the list, the add form in a dialog.
  assert.match(trends, /useState<TrendCandidateStatus \| "">\(""\)/);
  assert.match(trends, /\{addOpen && \(\s*<BlockingDialog label="Add a trend candidate"/);
});

test("AC-R5-1: Topics & trends shows the two lists side by side on wide screens", async () => {
  const shell = sourceInEnglish(await readFile(path.join(process.cwd(), "src", "components", "research-tab.tsx"), "utf8"));
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
  // BL-152: the shell's, Channels' and Discover's English now lives in their interface-text area.
  assert.doesNotMatch(Object.values(researchArea).join("\n"), /\bbelow\b|never automatically discovered|Costs 100 YouTube API units|same daily budget/);
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

// BL-145 (owner, Telegram 2026-10-07, msg 1904): one Track button adds the channel to the regularly collected list, with a
// reason already filled from the search (editable); there is no separate Watch any more.
test("BL-145: Track pre-fills the reason from the search query; no Watch button is offered", async () => {
  assert.equal(defaultTrackReason(en, { discoveryQuery: "bossa nova cafe" }), 'Found by the search "bossa nova cafe"');
  const panel = await readFile(path.join(process.cwd(), "src", "components", "market-discovery-panel.tsx"), "utf8");
  assert.doesNotMatch(panel, />\s*Watch\s*</);
  assert.doesNotMatch(panel, /handleUpdateStatus\([^)]*"watching"\)/);
});

test("BL-145: a found channel's counts read as one short line; hidden subscribers say so; nothing known shows nothing", async () => {
  const { describeCandidateStats } = await import("./market-discovery-panel");
  const at = "2026-10-07T01:00:00.000Z";
  assert.equal(
    describeCandidateStats(enUi, { subscriberCount: 12300, hiddenSubscriberCount: false, videoCount: 42, viewCount: 4_560_000, channelPublishedAt: "2019-05-01T00:00:00Z", observedAt: at }),
    "12K subscribers · 42 videos · 4.6M views · since 2019"
  );
  assert.equal(
    describeCandidateStats(enUi, { subscriberCount: null, hiddenSubscriberCount: true, videoCount: 1, viewCount: 950, channelPublishedAt: null, observedAt: at }),
    "subscribers hidden · 1 video · 950 views"
  );
  assert.equal(describeCandidateStats(enUi, { subscriberCount: 1500, hiddenSubscriberCount: false, videoCount: null, viewCount: null, channelPublishedAt: null, observedAt: at }), "1.5K subscribers");
  assert.equal(describeCandidateStats(enUi, null), null);
});

test("BL-145 genre: the result line and a channel's match line say what was found, in plain words", async () => {
  const { describeSearchResult, describeCandidateMatch } = await import("./market-discovery-panel");
  assert.equal(
    describeSearchResult(en, { mode: "genre", videosFound: 50, candidatesFound: 31, candidatesNew: 29, topicChannelsSkipped: 4 }),
    'Found 50 music videos from 31 channels, 29 new. Left out 4 auto-generated "- Topic" channels.'
  );
  assert.equal(describeSearchResult(en, { mode: "genre", videosFound: 1, candidatesFound: 1, candidatesNew: 0, topicChannelsSkipped: 0 }), "Found 1 music video from 1 channel, 0 new.");
  assert.equal(describeSearchResult(en, { mode: "channels", candidatesFound: 25, candidatesNew: 24 }), "Found 25, 24 new.");
  assert.equal(describeCandidateMatch(enUi, { query: "q", videoCount: 3, viewCount: 1_234_000 }), "3 matching videos · 1.2M views on them");
  assert.equal(describeCandidateMatch(enUi, { query: "q", videoCount: 1, viewCount: null }), "1 matching video");
  assert.equal(describeCandidateMatch(enUi, null), null);
});
