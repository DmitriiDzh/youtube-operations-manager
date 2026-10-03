import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile, lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPathInsideOrEqual, validateWorkspacePath } from "@/lib/local-path-validation/services";
import { createNodeExportFs } from "./adapters/fs";
import { DomainError, type LedgerFileRecord, type WatchlistContextForExport } from "./contracts";
import { createResearchExportServices, type ResearchExportDeps } from "./services";
import { realpath, stat } from "node:fs/promises";

// Expected rows/files are written out by hand from the plan's acceptance criteria (docs/roadmap/plans/RESEARCH_EXPORT_PLAN.md), not from the
// implementation's output (AGENTS.md §L).

const NOW = new Date("2026-10-04T07:15:30.000Z");

function context(id: string, handle: string | null, videos: number): WatchlistContextForExport {
  return {
    channel: { channelId: id, handleOrUrl: handle },
    evidenceCount: 2,
    channelSnapshots: [
      { observedAt: "2026-10-02T10:00:00.000Z", subscriberCount: 1200, viewCount: 90000, videoCount: 40, hiddenSubscriberCount: false, source: "youtube.channels.list" },
    ],
    videoSnapshots: Array.from({ length: videos }, (_, i) => ({
      videoId: `${id}-v${i}`,
      observedAt: "2026-10-02T10:00:00.000Z",
      viewCount: 100 + i,
      likeCount: 1,
      commentCount: 0,
      publishedAt: "2026-09-20T08:00:00.000Z",
      title: i === 0 ? '=cmd|"x", y' : `Video ${i}`,
      source: "youtube.videos.list",
    })),
    dataQualityFlags: [],
  };
}

async function setup(overrides: Partial<ResearchExportDeps> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ytom-export-"));
  const workspace = path.join(root, "workspace");
  const appData = path.join(root, "appdata");
  await mkdir(workspace);
  await mkdir(appData);
  const ledger: LedgerFileRecord[] = [];
  const deleted: string[] = [];
  const contexts = new Map<string, WatchlistContextForExport>([
    ["UCneiro", context("UCneiro", "@TheNeiro", 50)],
    ["UCother", context("UCother", null, 3)],
  ]);
  const deps: ResearchExportDeps = {
    now: () => NOW,
    randomSuffix: () => "ab12",
    newId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    getWorkspacePath: async () => workspace,
    isPathInsideOrEqual,
    validateWorkspacePath: (candidate) =>
      validateWorkspacePath(candidate, { appDataDir: appData, realpath, stat: async (p) => ({ isDirectory: (await stat(p)).isDirectory() }) }),
    listWatchlistChannelIds: async () => [...contexts.keys()],
    getWatchlistContext: async (id) => {
      const found = contexts.get(id);
      if (!found) throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "nope", details: { channelId: id } });
      return found;
    },
    getOwnChannel: async (channelId) => ({ channelId, title: "Rural Japan Music" }),
    listOwnVideos: async () => [
      { videoId: "own1", publishedAt: "2026-09-01T10:00:00Z", privacyStatus: "public", title: "Mine", viewCount: 7, likeCount: 1, commentCount: 0, lastSyncedAt: new Date("2026-10-03T12:00:00Z") },
      { videoId: "own2", publishedAt: "2026-09-02T10:00:00Z", privacyStatus: "private", title: "Secret", viewCount: 1, likeCount: 0, commentCount: 0, lastSyncedAt: new Date("2026-10-03T12:00:00Z") },
    ],
    fs: createNodeExportFs(),
    ledger: {
      insert: async (r) => void ledger.push(r),
      listExpired: async (now) => ledger.filter((r) => r.expiresAt && r.expiresAt <= now && !deleted.includes(r.id)),
      markDeleted: async (id) => void deleted.push(id),
    },
    ...overrides,
  };
  return { root, workspace, ledger, deleted, contexts, services: createResearchExportServices(deps) };
}

test("AC-RE-1 (the agent's retest): one watchlist channel with 1 channel snapshot and 50 video snapshots -> row counts equal the read tool's, files sit in <workspace>/exports", async () => {
  const { workspace, services } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  const real = await realpath(workspace);
  assert.equal(result.exportsDir, path.join(real, "exports"));
  const byDataset = Object.fromEntries(result.files.map((f) => [f.dataset, f]));
  assert.equal(byDataset.research_channel_snapshots.rows, 1);
  assert.equal(byDataset.research_video_snapshots.rows, 50);
  assert.equal(result.files.length, 3); // + own channel
  for (const file of result.files) assert.ok(file.path.startsWith(result.exportsDir + path.sep));
  const lines = (await readFile(byDataset.research_video_snapshots.path, "utf8")).split("\r\n");
  assert.equal(lines.length, 50 + 2); // header + 50 + trailing empty after the last CRLF
  assert.equal(lines[0], "channel,channelId,videoId,publishedAt,observedAt,viewCount,likeCount,commentCount,title");
});

test("AC-RE-2: CSV content is exactly the hand-written expectation (header order, hostile title guarded and quoted), file names carry no title/handle", async () => {
  const { services, contexts } = await setup();
  contexts.set("UCneiro", context("UCneiro", "@TheNeiro", 1));
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"], includeOwnChannel: false });
  const channelFile = result.files.find((f) => f.dataset === "research_channel_snapshots")!;
  assert.equal(
    await readFile(channelFile.path, "utf8"),
    "channel,channelId,observedAt,subscriberCount,viewCount,videoCount,hiddenSubscriberCount,videoSnapshotCount,evidenceCount,dataQualityFlags\r\n" +
      "@TheNeiro,UCneiro,2026-10-02T10:00:00.000Z,1200,90000,40,false,1,2,\r\n"
  );
  const videoFile = result.files.find((f) => f.dataset === "research_video_snapshots")!;
  assert.equal(
    await readFile(videoFile.path, "utf8"),
    "channel,channelId,videoId,publishedAt,observedAt,viewCount,likeCount,commentCount,title\r\n" +
      "@TheNeiro,UCneiro,UCneiro-v0,2026-09-20T08:00:00.000Z,2026-10-02T10:00:00.000Z,100,1,0,\"'=cmd|\"\"x\"\", y\"\r\n"
  );
  assert.equal(path.basename(videoFile.path), "research-video-snapshots-20261004T071530Z-ab12.csv");
});

test("AC-RE-3: the JSON twin keeps text exactly as stored (no spreadsheet guard)", async () => {
  const { services, contexts } = await setup();
  contexts.set("UCneiro", context("UCneiro", "@TheNeiro", 1));
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"], includeOwnChannel: false, formats: ["json"] });
  const file = result.files.find((f) => f.dataset === "research_video_snapshots")!;
  assert.equal(file.format, "json");
  const parsed = JSON.parse(await readFile(file.path, "utf8"));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, '=cmd|"x", y');
});

test("AC-RE-4: our own channel comes out with the same columns as the competitor video file, public videos only, no expiry", async () => {
  const { services } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  const own = result.files.find((f) => f.dataset === "own_video_snapshots")!;
  const comp = result.files.find((f) => f.dataset === "research_video_snapshots")!;
  assert.equal(own.rows, 1);
  assert.equal(own.expiresAt, null);
  assert.equal((await readFile(own.path, "utf8")).split("\r\n")[0], (await readFile(comp.path, "utf8")).split("\r\n")[0]);
  assert.equal(
    (await readFile(own.path, "utf8")).split("\r\n")[1],
    "Rural Japan Music,UCown,own1,2026-09-01T10:00:00.000Z,2026-10-03T12:00:00.000Z,7,1,0,Mine"
  );
});

test("AC-RE-5: research files expire 30 days after the oldest API observation (2026-10-02 + 30 d = 2026-11-01); each file is recorded in the ledger", async () => {
  const { services, ledger } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  for (const file of result.files.filter((f) => f.dataset.startsWith("research_"))) assert.equal(file.expiresAt, "2026-11-01T10:00:00.000Z");
  assert.equal(ledger.length, 3);
  assert.ok(ledger.every((r) => r.channelId === "UCown" && r.exportsDir === result.exportsDir));
});

test("AC-RE-6 (decision В): no workspace folder -> named error, nothing written, nothing recorded", async () => {
  const { services, ledger, root } = await setup({ getWorkspacePath: async () => null });
  await assert.rejects(services.exportResearchData({ channelId: "UCown" }), (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_EXPORT_WORKSPACE_NOT_CONFIGURED");
  assert.equal(ledger.length, 0);
  assert.deepEqual(await readdir(path.join(root, "workspace")), []);
});

test("AC-RE-7: a request naming a channel the caller cannot see fails before ANY file is written", async () => {
  const { services, ledger, workspace } = await setup();
  await assert.rejects(
    services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro", "UChidden"] }),
    (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_CHANNEL_NOT_AVAILABLE"
  );
  assert.equal(ledger.length, 0);
  assert.equal((await readdir(workspace)).includes("exports") ? (await readdir(path.join(workspace, "exports"))).length : 0, 0);
});

test("AC-RE-8: with no ids given, only the channels the caller may see (deps' narrowed list) are exported", async () => {
  const { services, contexts } = await setup({ listWatchlistChannelIds: async () => ["UCother"] });
  void contexts;
  const result = await services.exportResearchData({ channelId: "UCown", includeOwnChannel: false });
  assert.equal(result.watchlistChannels.exported, 1);
  const channels = result.files.find((f) => f.dataset === "research_channel_snapshots")!;
  const text = await readFile(channels.path, "utf8");
  assert.ok(text.includes("UCother"));
  assert.ok(!text.includes("UCneiro"));
});

test("AC-RE-9: an exports folder that is a symlink out of the workspace is refused and nothing lands outside", async () => {
  const { services, root, workspace } = await setup();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(workspace, "exports"));
  await assert.rejects(services.exportResearchData({ channelId: "UCown" }), (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE");
  assert.deepEqual(await readdir(outside), []);
});

test("AC-RE-10: a write failure part-way leaves no file of that call behind and records nothing", async () => {
  const real = createNodeExportFs();
  let renames = 0;
  const { services, ledger, workspace } = await setup({
    fs: {
      ...real,
      rename: async (from, to) => {
        if (++renames === 2) throw new Error("disk full");
        return real.rename(from, to);
      },
    },
  });
  await assert.rejects(services.exportResearchData({ channelId: "UCown" }), (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_EXPORT_WRITE_FAILED");
  assert.deepEqual(await readdir(path.join(workspace, "exports")), []);
  assert.equal(ledger.length, 0);
});

test("AC-RE-11: unknown fields (a path or file name chosen by the caller) are rejected", async () => {
  const { services } = await setup();
  await assert.rejects(services.exportResearchData({ channelId: "UCown", path: "/etc" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  await assert.rejects(services.exportResearchData({ channelId: "UCown", fileName: "x.csv" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
});

test("AC-RE-12 (sweeper): deletes exactly the expired recorded files; keeps unexpired and no-expiry ones; counts an already-missing file; never touches a symlink", async () => {
  const { services, workspace, ledger, deleted } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  const dir = result.exportsDir;
  const unrelated = path.join(dir, "my-own-notes.txt");
  await writeFile(unrelated, "keep me");
  const researchChannel = result.files.find((f) => f.dataset === "research_channel_snapshots")!;
  const researchVideo = result.files.find((f) => f.dataset === "research_video_snapshots")!;
  const own = result.files.find((f) => f.dataset === "own_video_snapshots")!;
  await rm(researchVideo.path); // already gone
  // a recorded file replaced by a symlink to something precious
  const precious = path.join(workspace, "precious.txt");
  await writeFile(precious, "precious");
  void ledger;

  const before = await services.sweepExpiredExports(new Date("2026-10-30T00:00:00Z")); // before the 2026-11-01 expiry
  assert.deepEqual(before, { deleted: 0, alreadyGone: 0, skipped: 0 });

  await rm(researchChannel.path);
  await symlink(precious, researchChannel.path);
  const after = await services.sweepExpiredExports(new Date("2026-11-02T00:00:00Z"));
  assert.deepEqual(after, { deleted: 0, alreadyGone: 1, skipped: 1 });
  assert.equal(await readFile(precious, "utf8"), "precious");
  assert.equal((await lstat(researchChannel.path)).isSymbolicLink(), true); // left alone
  assert.equal(await readFile(unrelated, "utf8"), "keep me");
  assert.ok((await lstat(own.path)).isFile()); // no expiry -> never swept
  assert.equal(deleted.length, 1);
});

test("AC-RE-13 (sweeper): an expired intact file is deleted and recorded as deleted, and only once", async () => {
  const { services, deleted } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"], includeOwnChannel: false });
  const first = await services.sweepExpiredExports(new Date("2026-11-02T00:00:00Z"));
  assert.deepEqual(first, { deleted: 2, alreadyGone: 0, skipped: 0 });
  for (const file of result.files) await assert.rejects(lstat(file.path));
  const second = await services.sweepExpiredExports(new Date("2026-11-03T00:00:00Z"));
  assert.deepEqual(second, { deleted: 0, alreadyGone: 0, skipped: 0 });
  assert.equal(deleted.length, 2);
});

test("AC-RE-14 (bulk read): pages the visible watchlist, newest snapshot + counts per channel, nextOffset null on the last page", async () => {
  const { services, contexts } = await setup();
  contexts.set("UCthird", context("UCthird", "@Third", 0));
  const first = await services.listResearchOverview({ limit: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 2);
  assert.deepEqual(first.channels.map((c) => c.channelId), ["UCneiro", "UCother"]);
  assert.deepEqual(first.channels[0], {
    channelId: "UCneiro",
    handleOrUrl: "@TheNeiro",
    latestChannelSnapshot: { observedAt: "2026-10-02T10:00:00.000Z", subscriberCount: 1200, viewCount: 90000, videoCount: 40, hiddenSubscriberCount: false },
    channelSnapshotCount: 1,
    videoSnapshotCount: 50,
    evidenceCount: 2,
    dataQualityFlags: [],
  });
  const second = await services.listResearchOverview({ limit: 2, offset: 2 });
  assert.deepEqual(second.channels.map((c) => c.channelId), ["UCthird"]);
  assert.equal(second.nextOffset, null);
});

test("AC-RE-15 (bulk read): named channels keep their order and duplicates collapse; an unavailable one fails the call; a channel with no snapshot has a null latest snapshot", async () => {
  const { services, contexts } = await setup();
  contexts.set("UCempty", { ...context("UCempty", null, 0), channelSnapshots: [] });
  const result = await services.listResearchOverview({ channelIds: ["UCempty", "UCneiro", "UCempty"] });
  assert.deepEqual(result.channels.map((c) => c.channelId), ["UCempty", "UCneiro"]);
  assert.equal(result.channels[0].latestChannelSnapshot, null);
  assert.equal(result.total, 2);
  await assert.rejects(services.listResearchOverview({ channelIds: ["UChidden"] }), (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_CHANNEL_NOT_AVAILABLE");
});

test("AC-RE-16 (bulk read): limit above 200, offset below 0 and unknown fields are rejected", async () => {
  const { services } = await setup();
  for (const bad of [{ limit: 201 }, { limit: 0 }, { offset: -1 }, { sortBy: "views" }]) {
    await assert.rejects(services.listResearchOverview(bad), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  }
});
