import assert from "node:assert/strict";
import test from "node:test";
import { createPackageScan, type DirEntry, type PackageScanDeps, type ScannedPackage } from "./package-scan";

// BL-182 stage 2 (FO-REQ-0023 §4 A1/A2, §4 B1, §6 question 1). Requirements:
// - packages are found by scanning `04 Videos/**/V*_release.json` in the channel workspace (the factory's layout is
//   `04 Videos/<MM Month>/<MMDD Vn>/`); nothing else is a package, and the scan never edits anything;
// - each package is checked again; its state is: not ready (and why) / ready / uploaded private / scheduled / published;
// - after an upload `Vn_youtube.json` sits next to the package and names the video: that is what makes it "uploaded";
// - the factory's text files carry a BOM.

const WS = "/ws";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

type FakeFile = { text?: string; bytes: number; head?: Uint8Array };

function manifest(video: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: "yt-release-package/1",
    channelId: "UC_t",
    video,
    mix: 1,
    plannedPublishDate: "2026-10-24",
    files: { video: `${video} Tropico Jazz.mp4`, thumbnail: `Thumbnail_${video}_A.jpg` },
    sizeBytes: 1000,
    durationSeconds: 7200,
    title: `Title ${video}`,
    description: "00:00 A\n10:00 B\n20:00 C",
    tags: ["jazz"],
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    ready: true,
    problems: [],
    ...over,
  });
}

function packageFiles(folder: string, video: string, over: Record<string, unknown> = {}): Record<string, FakeFile> {
  return {
    [`${folder}/${video}_release.json`]: { text: `﻿${manifest(video, over)}`, bytes: 500 },
    [`${folder}/${video} Tropico Jazz.mp4`]: { bytes: 1000 },
    [`${folder}/Thumbnail_${video}_A.jpg`]: { bytes: 4000, head: JPEG },
  };
}

function deps(files: Record<string, FakeFile>, extra: Partial<PackageScanDeps> = {}, symlinkDirs: string[] = []): PackageScanDeps {
  const all = new Map(Object.entries(files).map(([rel, file]) => [`${WS}/${rel}`, file]));
  return {
    workspace: async () => WS,
    validateWorkspace: async () => ({ ok: true }),
    listDir: async (abs) => {
      const prefix = `${abs}/`;
      const names = new Map<string, DirEntry["kind"]>();
      for (const file of all.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [first, ...rest] = file.slice(prefix.length).split("/");
        const childPath = `${prefix}${first}`;
        names.set(first, rest.length === 0 ? "file" : symlinkDirs.includes(childPath) ? "other" : "dir");
      }
      return [...names.entries()].map(([name, kind]) => ({ name, kind }));
    },
    resolveFile: async (_ws, relative) => {
      const file = all.get(`${WS}/${relative}`);
      return file ? { path: `${WS}/${relative}`, bytes: file.bytes } : null;
    },
    readText: async (abs) => all.get(abs)?.text ?? "",
    readHead: async (abs) => all.get(abs)?.head ?? new Uint8Array(),
    probeDuration: async () => 7200.2,
    channel: async () => ({ channelId: "UC_t", defaultLanguage: "en", defaultAudioLanguage: "en" }),
    videos: async () => [],
    join: (...parts) => parts.join("/"),
    clock: { now: () => new Date("2026-10-13T12:00:00Z") },
    ...extra,
  };
}

test("finds the packages in the factory's layout, by planned date then number; other files are not packages", async () => {
  const files = {
    ...packageFiles("04 Videos/10 October/1024 V65", "V65"),
    ...packageFiles("04 Videos/10 October/1023 V64", "V64", { plannedPublishDate: "2026-10-23" }),
    ...packageFiles("04 Videos/10 October/1025 V66", "V66", { plannedPublishDate: null }),
    "04 Videos/10 October/1024 V65/V65_Report.txt": { bytes: 10, text: "x" },
    "04 Videos/video_registry.csv": { bytes: 10, text: "x" },
    "06 Workflows/_data/releases/V65_release.json": { bytes: 10, text: "{}" },
  };
  const result = await createPackageScan(deps(files)).scan("UC_t");
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.packages.map((p) => [p.video, p.state]), [["V64", "ready"], ["V65", "ready"], ["V66", "ready"]]);
  assert.equal(result.packages[1].manifestPath, "04 Videos/10 October/1024 V65/V65_release.json");
  assert.equal(result.packages[1].thumbnailPath, "04 Videos/10 October/1024 V65/Thumbnail_V65_A.jpg");
});

test("a package deeper than the factory's layout or behind a symlinked folder is not scanned", async () => {
  const files = {
    ...packageFiles("04 Videos/10 October/1024 V65/extra", "V65"),
    ...packageFiles("04 Videos/linked/1024 V70", "V70"),
  };
  const result = await createPackageScan(deps(files, {}, [`${WS}/04 Videos/linked`])).scan("UC_t");
  assert.deepEqual(result.status === "ok" ? result.packages : null, []);
});

test("not ready, with its reasons: a broken manifest, a missing thumbnail, an unfinished video copy", async () => {
  const files: Record<string, FakeFile> = {
    "04 Videos/10 October/1020 V61/V61_release.json": { text: "{ not json", bytes: 10 },
    ...packageFiles("04 Videos/10 October/1021 V62", "V62"),
    ...packageFiles("04 Videos/10 October/1022 V63", "V63"),
  };
  delete files["04 Videos/10 October/1021 V62/Thumbnail_V62_A.jpg"];
  files["04 Videos/10 October/1022 V63/V63 Tropico Jazz.mp4"] = { bytes: 400 };
  const result = await createPackageScan(deps(files)).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  const byPath: Record<string, ScannedPackage> = Object.fromEntries(result.packages.map((p) => [p.manifestPath.split("/").pop(), p]));
  assert.deepEqual(byPath["V61_release.json"].problems.map((p) => p.code), ["invalid_json"]);
  assert.equal(byPath["V61_release.json"].state, "not_ready");
  assert.deepEqual(byPath["V62_release.json"].problems.map((p) => p.code), ["thumbnail_missing"]);
  assert.deepEqual(byPath["V63_release.json"].problems.map((p) => p.code), ["video_size_differs"]);
});

test("after an upload: Vn_youtube.json names the video, and the synced copy decides private / scheduled / published", async () => {
  const files = {
    ...packageFiles("04 Videos/10 October/1015 V56", "V56"),
    ...packageFiles("04 Videos/10 October/1016 V57", "V57"),
    ...packageFiles("04 Videos/10 October/1017 V58", "V58"),
    ...packageFiles("04 Videos/10 October/1018 V59", "V59"),
    "04 Videos/10 October/1015 V56/V56_youtube.json": { text: JSON.stringify({ videoId: "vid56" }), bytes: 20 },
    "04 Videos/10 October/1016 V57/V57_youtube.json": { text: JSON.stringify({ videoId: "vid57" }), bytes: 20 },
    "04 Videos/10 October/1017 V58/V58_youtube.json": { text: JSON.stringify({ videoId: "vid58" }), bytes: 20 },
    "04 Videos/10 October/1018 V59/V59_youtube.json": { text: JSON.stringify({ videoId: "vid59" }), bytes: 20 },
  };
  const videos = async () => [
    { videoId: "vid56", title: "Title V56", privacyStatus: "public", publishAt: null },
    { videoId: "vid57", title: "Title V57", privacyStatus: "private", publishAt: "2026-10-16T12:00:00Z" },
    { videoId: "vid58", title: "Title V58", privacyStatus: "private", publishAt: null },
  ];
  const result = await createPackageScan(deps(files, { videos })).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  assert.deepEqual(result.packages.map((p) => [p.video, p.state, p.youtube?.videoId]), [
    ["V56", "published", "vid56"],
    ["V57", "scheduled", "vid57"],
    ["V58", "uploaded_private", "vid58"],
    ["V59", "uploaded_unknown", "vid59"],
  ]);
  assert.deepEqual(result.packages[0].problems, [], "an uploaded package is not 'not ready' because its title is now on the channel");
});

test("the same title already on the channel without an upload record is not ready (never upload twice)", async () => {
  const videos = async () => [{ videoId: "old1", title: "Title V65", privacyStatus: "public", publishAt: null }];
  const result = await createPackageScan(deps(packageFiles("04 Videos/10 October/1024 V65", "V65"), { videos })).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  assert.equal(result.packages[0].state, "not_ready");
  assert.deepEqual(result.packages[0].problems, [{ code: "same_title_on_channel", params: { videoId: "old1" } }]);
});

test("no workspace set, or one that cannot be used now", async () => {
  assert.deepEqual(await createPackageScan(deps({}, { workspace: async () => null })).scan("UC_t"), { status: "no_workspace" });
  assert.deepEqual(await createPackageScan(deps({}, { validateWorkspace: async () => ({ ok: false, reason: "drive not mounted" }) })).scan("UC_t"), {
    status: "workspace_unavailable",
    reason: "drive not mounted",
  });
});
