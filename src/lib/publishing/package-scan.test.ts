import assert from "node:assert/strict";
import test from "node:test";
import { createPackageScan, isPackageThumbnailPath, type DirEntry, type PackageScanDeps, type ScannedPackage } from "./package-scan";

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
    sha256: async (abs) => `sha:${abs.split("/").pop()}`,
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
  assert.equal(result.packages[1].manifestSha256, "sha:V65_release.json", "the manifest's own hash, for the approval");
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

test("the preview serves only an image under 04 Videos", () => {
  assert.equal(isPackageThumbnailPath("04 Videos/10 October/1024 V65/Thumbnail_V65_A.jpg"), true);
  assert.equal(isPackageThumbnailPath("04 Videos/x/t.PNG"), true);
  for (const bad of ["03 Audio/t.jpg", "04 Videos/../secrets/t.jpg", "04 Videos/x/t.txt", "04 Videos//t.jpg", "04 Videos\\x\\t.jpg", "/04 Videos/t.jpg"]) {
    assert.equal(isPackageThumbnailPath(bad), false, bad);
  }
});

// Review #5 (LOW, BL-225): packages naming the same weekly-plan slot. None uploads while two wait for it (`slot_duplicate`); once
// one of them is uploaded, the others are refused (`slot_taken`).
test("review #5: two packages naming one slot are both not ready; with one uploaded, the other is", async () => {
  const { markSharedSlots } = await import("./package-scan");
  const pkg = (video: string, uploaded: boolean) =>
    ({ video, state: uploaded ? "scheduled" : "ready", problems: [], youtube: uploaded ? { videoId: "x", privacyStatus: "private", publishAt: null } : null, pkg: { slotId: "s1" } }) as never;
  const both = markSharedSlots([pkg("V64", false), pkg("V65", false)]) as Array<{ state: string; problems: Array<{ code: string }> }>;
  assert.deepEqual(both.map((p) => [p.state, p.problems.map((x) => x.code)]), [["not_ready", ["slot_duplicate"]], ["not_ready", ["slot_duplicate"]]]);
  const taken = markSharedSlots([pkg("V64", true), pkg("V65", false)]) as Array<{ state: string; problems: Array<{ code: string }> }>;
  assert.deepEqual(taken.map((p) => [p.state, p.problems.map((x) => x.code)]), [["scheduled", []], ["not_ready", ["slot_taken"]]]);
});

// BL-243 (WEEKLY_PUBLISHING_PLAN.md AC-WP-66..68): the sync's removed mark. Fixed values: last video sync 2026-11-04T08:00:00.000Z;
// V73's video vid73 removed at 2026-11-03T19:54:00.000Z; V74's vid74 visible (private, no date); V75's vid75 not in the copy.
const SYNCED = "2026-11-04T08:00:00.000Z";
const REMOVED = "2026-11-03T19:54:00.000Z";

function uploadedFiles() {
  return {
    ...packageFiles("04 Videos/11 November/1109 V73", "V73"),
    ...packageFiles("04 Videos/11 November/1110 V74", "V74"),
    ...packageFiles("04 Videos/11 November/1111 V75", "V75"),
    ...packageFiles("04 Videos/11 November/1112 V76", "V76"),
    "04 Videos/11 November/1109 V73/V73_youtube.json": { text: JSON.stringify({ videoId: "vid73" }), bytes: 20 },
    "04 Videos/11 November/1110 V74/V74_youtube.json": { text: JSON.stringify({ videoId: "vid74" }), bytes: 20 },
    "04 Videos/11 November/1111 V75/V75_youtube.json": { text: JSON.stringify({ videoId: "vid75" }), bytes: 20 },
  };
}
const visible74 = async () => [{ videoId: "vid74", title: "Title V74", privacyStatus: "private", publishAt: null }];

test("BL-243 AC-WP-66: a removed video's package is deleted_on_youtube; unknown stays for a video not in the copy", async () => {
  const result = await createPackageScan(
    deps(uploadedFiles(), { videos: visible74, removedVideos: async () => [{ videoId: "vid73", removedAt: REMOVED }], videosCheckedAt: async () => SYNCED })
  ).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  const by = Object.fromEntries(result.packages.map((p) => [p.video, p]));
  assert.equal(by.V73.state, "deleted_on_youtube");
  assert.deepEqual(by.V73.problems, [{ code: "video_deleted_on_youtube" }]);
  // (review round 2 added the record's uploadedAt -- none in this record)
  assert.deepEqual(by.V73.youtube, { videoId: "vid73", privacyStatus: null, publishAt: null, removedAt: REMOVED, uploadedAt: null });
  assert.equal(by.V73.existsOnChannel, false);
  assert.equal(by.V73.checkedAt, SYNCED);
  assert.equal(by.V74.state, "uploaded_private");
  assert.equal(by.V74.existsOnChannel, true);
  assert.equal(by.V74.youtube?.removedAt, null);
  assert.equal(by.V75.state, "uploaded_unknown");
  assert.equal(by.V75.existsOnChannel, null);
  assert.equal(by.V76.state, "ready");
  assert.equal(by.V76.existsOnChannel, null, "no upload record: nothing to say");
  assert.equal(by.V76.checkedAt, SYNCED);
});

test("BL-243 AC-WP-67: the mark cleared -> uploaded again; never synced -> checkedAt null; a removed video's title is not 'on the channel'", async () => {
  const back = await createPackageScan(
    deps(uploadedFiles(), {
      videos: async () => [...(await visible74()), { videoId: "vid73", title: "Title V73", privacyStatus: "private", publishAt: null }],
      removedVideos: async () => [],
      videosCheckedAt: async () => SYNCED,
    })
  ).scan("UC_t");
  if (back.status !== "ok") return assert.fail(back.status);
  const v73 = back.packages.find((p) => p.video === "V73")!;
  assert.equal(v73.state, "uploaded_private");
  assert.equal(v73.existsOnChannel, true);
  assert.deepEqual(v73.problems, []);

  const never = await createPackageScan(deps(uploadedFiles(), { removedVideos: async () => [], videosCheckedAt: async () => null })).scan("UC_t");
  if (never.status !== "ok") return assert.fail(never.status);
  assert.deepEqual(never.packages.map((p) => [p.video, p.state, p.checkedAt, p.existsOnChannel]), [
    ["V73", "uploaded_unknown", null, null],
    ["V74", "uploaded_unknown", null, null],
    ["V75", "uploaded_unknown", null, null],
    ["V76", "ready", null, null],
  ]);

  // The removed video had V80's title: the same-title check reads only the videos still on the channel.
  const sameTitle = await createPackageScan(
    deps(packageFiles("04 Videos/11 November/1113 V80", "V80"), { videos: async () => [], removedVideos: async () => [{ videoId: "old80", removedAt: REMOVED }] })
  ).scan("UC_t");
  if (sameTitle.status !== "ok") return assert.fail(sameTitle.status);
  assert.equal(sameTitle.packages[0].state, "ready");
  assert.deepEqual(sameTitle.packages[0].problems, []);
});

test("BL-243 AC-WP-68: a deleted package holds no slot and is never marked; uploaded_unknown still holds it", async () => {
  const { markSharedSlots } = await import("./package-scan");
  const pkg = (video: string, state: string, videoId: string | null) =>
    ({ video, state, problems: state === "deleted_on_youtube" ? [{ code: "video_deleted_on_youtube" }] : [], youtube: videoId ? { videoId, privacyStatus: null, publishAt: null } : null, pkg: { slotId: "s1" } }) as never;
  const codes = (list: unknown[]) => (list as Array<{ video: string; state: string; problems: Array<{ code: string }> }>).map((p) => [p.video, p.state, p.problems.map((x) => x.code)]);
  assert.deepEqual(codes(markSharedSlots([pkg("V73", "deleted_on_youtube", "vid73"), pkg("V80", "ready", null)])), [
    ["V73", "deleted_on_youtube", ["video_deleted_on_youtube"]],
    ["V80", "ready", []],
  ]);
  assert.deepEqual(codes(markSharedSlots([pkg("V73", "deleted_on_youtube", "vid73"), pkg("V80", "ready", null), pkg("V81", "ready", null)])), [
    ["V73", "deleted_on_youtube", ["video_deleted_on_youtube"]],
    ["V80", "not_ready", ["slot_duplicate"]],
    ["V81", "not_ready", ["slot_duplicate"]],
  ]);
  assert.deepEqual(codes(markSharedSlots([pkg("V75", "uploaded_unknown", "vid75"), pkg("V80", "ready", null)])), [
    ["V75", "uploaded_unknown", []],
    ["V80", "not_ready", ["slot_taken"]],
  ]);
});

// BL-243 review (AC-WP-66/67): the mark's and the sync time's reads never fail the scan -- an unreadable mark is "none known" (the
// package reads as before: uploaded_unknown) and an unreadable sync time is null.
test("BL-243: an unreadable removed list or sync time keeps the scan going (none known, checkedAt null)", async () => {
  const result = await createPackageScan(
    deps(uploadedFiles(), {
      videos: visible74,
      removedVideos: async () => {
        throw new Error("db busy");
      },
      videosCheckedAt: async () => {
        throw new Error("db busy");
      },
    })
  ).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  assert.deepEqual(result.packages.map((p) => [p.video, p.state, p.checkedAt]), [
    ["V73", "uploaded_unknown", null],
    ["V74", "uploaded_private", null],
    ["V75", "uploaded_unknown", null],
    ["V76", "ready", null],
  ]);
  assert.deepEqual(result.removedVideoIds, []);
  const read = await createPackageScan(deps(uploadedFiles(), { videos: visible74, removedVideos: async () => [{ videoId: "vid73", removedAt: REMOVED }] })).scan("UC_t");
  assert.deepEqual(read.status === "ok" ? read.removedVideoIds : null, ["vid73"]);
});

// BL-243 review round 2, items 3 and 8 (AC-WP-78, AC-WP-76): "on the channel" (true) needs a completed removed check -- without one
// a visible video is unknown (null), while a removed mark still proves a deletion (false); the record's uploadedAt is carried.
test("BL-243 AC-WP-78: no completed removed check -> existsOnChannel never true; a removed mark is still false; uploadedAt read", async () => {
  const files = uploadedFiles();
  files["04 Videos/11 November/1110 V74/V74_youtube.json"] = { text: JSON.stringify({ videoId: "vid74", uploadedAt: "2026-11-02T10:00:00.000Z" }), bytes: 40 };
  const result = await createPackageScan(
    deps(files, { videos: visible74, removedVideos: async () => [{ videoId: "vid73", removedAt: REMOVED }], videosCheckedAt: async () => null })
  ).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  const by = Object.fromEntries(result.packages.map((p) => [p.video, p]));
  assert.deepEqual([by.V74.state, by.V74.existsOnChannel, by.V74.checkedAt], ["uploaded_private", null, null]);
  assert.deepEqual([by.V73.state, by.V73.existsOnChannel], ["deleted_on_youtube", false]);
  assert.equal(by.V74.youtube?.uploadedAt, "2026-11-02T10:00:00.000Z");
  assert.equal(by.V73.youtube?.uploadedAt, null, "no uploadedAt in the record");
});
