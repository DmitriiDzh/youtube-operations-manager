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
    // Default depth (cap 50, no date); a channel with 50 stored videos has reached the cap.
    collectionProgress: { maxVideosPerChannel: 50, publishedAfter: null, videosStored: videos, complete: videos >= 50, completeReason: videos >= 50 ? "cap" : null },
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

test("AC-RE-1 (the agent's retest): one watchlist channel with 1 channel snapshot and 50 video snapshots -> row counts equal the read tool's, files sit in <workspace>/99 Data Exchange/From YTM", async () => {
  const { workspace, services } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  const real = await realpath(workspace);
  assert.equal(result.exportsDir, path.join(real, "99 Data Exchange", "From YTM")); // fixed folder name, owner decision 2026-10-04 (was "exports")
  const byDataset = Object.fromEntries(result.files.map((f) => [f.dataset, f]));
  assert.equal(byDataset.research_channel_snapshots.rows, 1);
  assert.equal(byDataset.research_video_snapshots.rows, 50);
  assert.equal(result.files.length, 3); // + own channel
  for (const file of result.files) assert.ok(file.path.startsWith(result.exportsDir + path.sep));
  const lines = (await readFile(byDataset.research_video_snapshots.path, "utf8")).split("\r\n");
  assert.equal(lines.length, 50 + 2); // header + 50 + trailing empty after the last CRLF
  assert.equal(lines[0], "channel,channelId,videoId,publishedAt,observedAt,viewCount,likeCount,commentCount,title,durationSeconds,liveBroadcastContent");
});

test("AC-RE-2: CSV content is exactly the hand-written expectation (header order, hostile title guarded and quoted), file names carry no title/handle", async () => {
  const { services, contexts } = await setup();
  contexts.set("UCneiro", context("UCneiro", "@TheNeiro", 1));
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"], includeOwnChannel: false });
  const channelFile = result.files.find((f) => f.dataset === "research_channel_snapshots")!;
  assert.equal(
    await readFile(channelFile.path, "utf8"),
    "channel,channelId,observedAt,subscriberCount,viewCount,videoCount,hiddenSubscriberCount,videoSnapshotCount,evidenceCount,dataQualityFlags,uniqueVideoCount,latestVideoSnapshotAt\r\n" +
      "@TheNeiro,UCneiro,2026-10-02T10:00:00.000Z,1200,90000,40,false,1,2,,1,2026-10-02T10:00:00.000Z\r\n"
  );
  const videoFile = result.files.find((f) => f.dataset === "research_video_snapshots")!;
  assert.equal(
    await readFile(videoFile.path, "utf8"),
    "channel,channelId,videoId,publishedAt,observedAt,viewCount,likeCount,commentCount,title,durationSeconds,liveBroadcastContent\r\n" +
      "@TheNeiro,UCneiro,UCneiro-v0,2026-09-20T08:00:00.000Z,2026-10-02T10:00:00.000Z,100,1,0,\"'=cmd|\"\"x\"\", y\",,\r\n"
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
    "Rural Japan Music,UCown,own1,2026-09-01T10:00:00.000Z,2026-10-03T12:00:00.000Z,7,1,0,Mine,,"
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
  assert.equal((await readdir(workspace)).includes("99 Data Exchange") ? (await readdir(path.join(workspace, "99 Data Exchange", "From YTM")).catch(() => [])).length : 0, 0);
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

test("AC-RE-9: a 99 Data Exchange/From YTM folder that is a symlink out of the workspace is refused and nothing lands outside", async () => {
  const { services, root, workspace } = await setup();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(workspace, "99 Data Exchange"));
  await assert.rejects(services.exportResearchData({ channelId: "UCown" }), (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE");
  assert.deepEqual(await readdir(outside), []);
});

test("AC-RE-10: a write failure part-way leaves no file of that call behind; every row recorded for it is marked deleted (changed after review: rows are recorded BEFORE writing, so a file can never exist without one)", async () => {
  const real = createNodeExportFs();
  let renames = 0;
  const { services, workspace, deleted, ledger } = await setup({
    fs: {
      ...real,
      rename: async (from, to) => {
        if (++renames === 2) throw new Error("disk full");
        return real.rename(from, to);
      },
    },
  });
  await assert.rejects(services.exportResearchData({ channelId: "UCown" }), (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_EXPORT_WRITE_FAILED");
  assert.deepEqual(await readdir(path.join(workspace, "99 Data Exchange", "From YTM")), []);
  assert.equal(deleted.length, ledger.length);
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
    uniqueVideoCount: 50,
    latestVideoSnapshotAt: "2026-10-02T10:00:00.000Z",
    evidenceCount: 2,
    dataQualityFlags: [],
    collection: { maxVideosPerChannel: 50, publishedAfter: null, videosStored: 50, complete: true, completeReason: "cap" },
  });
  assert.deepEqual(first.channels[1].collection, { maxVideosPerChannel: 50, publishedAfter: null, videosStored: 3, complete: false, completeReason: null });
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

test("AC-RE-17 (review): if recording in the ledger fails, NOTHING has been written (no file can exist without a ledger row)", async () => {
  let calls = 0;
  const { services, workspace } = await setup({
    ledger: {
      insert: async () => {
        if (++calls === 2) throw new Error("database is locked");
      },
      listExpired: async () => [],
      markDeleted: async () => undefined,
    },
  });
  await assert.rejects(services.exportResearchData({ channelId: "UCown" }), /database is locked/);
  const dir = path.join(workspace, "99 Data Exchange", "From YTM");
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});

test("AC-RE-19 (review): the sweep also removes a leftover temp file of a crashed write", async () => {
  const { services } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"], includeOwnChannel: false });
  const tmp = path.join(result.exportsDir, `.${path.basename(result.files[0].path)}.tmp`);
  await writeFile(tmp, "half written");
  const swept = await services.sweepExpiredExports(new Date("2026-11-02T00:00:00Z"));
  assert.deepEqual(swept, { deleted: 2, alreadyGone: 0, skipped: 0 });
  await assert.rejects(lstat(tmp));
});

test("AC-RE-20 (review): a record whose folder is no longer the recorded real folder (e.g. now reached through a link) is skipped and nothing is deleted", async () => {
  const { services, root, ledger } = await setup();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"], includeOwnChannel: false });
  const link = path.join(root, "link-to-inbox");
  await symlink(result.exportsDir, link);
  for (const record of ledger) record.exportsDir = link; // the ledger now names the folder through a link
  const swept = await services.sweepExpiredExports(new Date("2026-11-02T00:00:00Z"));
  assert.deepEqual(swept, { deleted: 0, alreadyGone: 0, skipped: 2 });
  assert.ok((await lstat(result.files[0].path)).isFile());
});

test("AC-RE-21 (owner exception 2026-10-04): the first export creates exactly <workspace>/99 Data Exchange/From YTM and writes nowhere else in the workspace", async () => {
  const { services, workspace } = await setup();
  await writeFile(path.join(workspace, "project-notes.md"), "mine");
  await mkdir(path.join(workspace, "03 Assets"));
  const before = (await readdir(workspace)).sort();
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  assert.equal(path.basename(result.exportsDir), "From YTM");
  assert.equal(path.dirname(path.dirname(result.exportsDir)), await realpath(workspace));
  assert.deepEqual((await readdir(path.join(workspace, "99 Data Exchange"))).sort(), ["From YTM", "Sent to YTM"]);
  assert.deepEqual((await readdir(workspace)).sort(), [...before, "99 Data Exchange"].sort()); // only the inbox was added at the workspace level
  assert.deepEqual((await readdir(path.join(workspace, "03 Assets"))), []); // untouched subfolder
  for (const entry of await readdir(result.exportsDir)) assert.ok(/^(research|own)-.*-\d{8}T\d{6}Z-[0-9a-f]{4}\.(csv|json)$/.test(entry), entry); // only our files, no stray temp files
  assert.equal(await readFile(path.join(workspace, "project-notes.md"), "utf8"), "mine");
});

test("AC-RE-22 (owner exception): a file the user put into 99 Data Exchange/From YTM is never modified or deleted -- not by an export, not by the expiry sweep", async () => {
  const { services, workspace } = await setup();
  const inbox = path.join(workspace, "99 Data Exchange", "From YTM");
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, "my-own-script-output.csv"), "do not touch");
  const result = await services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] });
  await services.sweepExpiredExports(new Date("2026-12-01T00:00:00Z")); // far past every expiry
  assert.equal(await readFile(path.join(inbox, "my-own-script-output.csv"), "utf8"), "do not touch");
  const left = await readdir(result.exportsDir);
  assert.deepEqual(left.filter((n) => n.startsWith("research-")), []); // our expired research files are gone
  assert.ok(left.includes("my-own-script-output.csv"));
});

test("AC-RE-23 (owner exception): if 99 Data Exchange/From YTM cannot be created, a clear named error and nothing is written or recorded", async () => {
  const real = createNodeExportFs();
  const { services, ledger, workspace } = await setup({
    fs: {
      ...real,
      mkdir: async () => {
        throw new Error("EACCES: permission denied");
      },
    },
  });
  await assert.rejects(
    services.exportResearchData({ channelId: "UCown", researchChannelIds: ["UCneiro"] }),
    (e: unknown) => e instanceof DomainError && e.code === "RESEARCH_EXPORT_WORKSPACE_UNAVAILABLE" && /99 Data Exchange could not be created/.test(e.message)
  );
  assert.deepEqual(await readdir(workspace), []);
  assert.equal(ledger.length, 0);
});
