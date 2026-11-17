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
// (review round 3) vid74's YouTube publishedAt 2026-11-01T00:00Z is before the check, so the check saw it.
const visible74 = async () => [{ videoId: "vid74", title: "Title V74", privacyStatus: "private", publishAt: null, publishedAt: "2026-11-01T00:00:00.000Z" }];

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
      videos: async () => [...(await visible74()), { videoId: "vid73", title: "Title V73", privacyStatus: "private", publishAt: null, publishedAt: "2026-11-01T00:00:00.000Z" }],
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

// BL-243 review round 3, item 6 (AC-WP-80): the copy keeps no "first seen" time, so "on the channel" (true) also needs YouTube's
// publishedAt not later than the completed removed check -- a video published (or uploaded) after it is unknown (null).
test("BL-243 AC-WP-80: a video published after the removed check is not 'on the channel' (null)", async () => {
  const after = async () => [{ videoId: "vid74", title: "Title V74", privacyStatus: "private", publishAt: null, publishedAt: "2026-11-04T09:00:00.000Z" }];
  const result = await createPackageScan(deps(uploadedFiles(), { videos: after, removedVideos: async () => [], videosCheckedAt: async () => SYNCED })).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  const v74 = result.packages.find((p) => p.video === "V74")!;
  assert.deepEqual([v74.state, v74.existsOnChannel, v74.checkedAt], ["uploaded_private", null, SYNCED]);
  const exact = async () => [{ videoId: "vid74", title: "Title V74", privacyStatus: "private", publishAt: null, publishedAt: SYNCED }];
  const same = await createPackageScan(deps(uploadedFiles(), { videos: exact, removedVideos: async () => [], videosCheckedAt: async () => SYNCED })).scan("UC_t");
  assert.equal(same.status === "ok" ? same.packages.find((p) => p.video === "V74")?.existsOnChannel : "x", true, "published at the check's moment: seen");
});

// BL-243 review round 4, item 5: a caller's checkedAt (the calendar's) replaces the scan's own read of it.
test("BL-243: scan(channelId, { checkedAt }) uses the given check time for every package", async () => {
  let ownReads = 0;
  const result = await createPackageScan(
    deps(uploadedFiles(), {
      videos: visible74,
      removedVideos: async () => [],
      videosCheckedAt: async () => {
        ownReads += 1;
        return "2026-10-01T00:00:00.000Z";
      },
    })
  ).scan("UC_t", { checkedAt: SYNCED });
  if (result.status !== "ok") return assert.fail(result.status);
  assert.equal(ownReads, 0);
  assert.deepEqual([...new Set(result.packages.map((p) => p.checkedAt))], [SYNCED]);
  assert.equal(result.packages.find((p) => p.video === "V74")?.existsOnChannel, true);
});

// BL-243 review round 6, item 2 (AC-WP-84): the scan's own removed-list read failed; the plan progress read the list itself and passes
// it back in -- the packages then say deleted_on_youtube exactly as with a working read, so packages and rows agree.
test("BL-243 AC-WP-84: a removed list passed in replaces a failed read; V73 is deleted_on_youtube again", async () => {
  const failingRead = {
    videos: visible74,
    removedVideos: async (): Promise<Array<{ videoId: string; removedAt: string }>> => {
      throw new Error("db busy");
    },
    videosCheckedAt: async () => SYNCED,
  };
  const without = await createPackageScan(deps(uploadedFiles(), failingRead)).scan("UC_t");
  if (without.status !== "ok") return assert.fail(without.status);
  assert.equal(without.packages.find((p) => p.video === "V73")?.state, "uploaded_unknown");
  const withList = await createPackageScan(deps(uploadedFiles(), failingRead)).scan("UC_t", { removedVideos: [{ videoId: "vid73", removedAt: REMOVED }] });
  if (withList.status !== "ok") return assert.fail(withList.status);
  const v73 = withList.packages.find((p) => p.video === "V73")!;
  assert.deepEqual([v73.state, v73.existsOnChannel, v73.youtube?.removedAt], ["deleted_on_youtube", false, REMOVED]);
});

// ---- BL-257 (ADR 0070, PACKAGE_REVIEW_PLAN.md AC-PR-01/02/03/04/06/07): the owner-review gate in the scan ----
// Expected states are written from the plan: a channel without the gate scans exactly as before; with it, a package that would be
// ready waits (`owner_review_pending`) until the owner approved THIS manifest with THIS thumbnail file; a return keeps it out with
// the comment; an uploaded package and one with another problem are not touched; a gate that cannot be read holds everything.

const M65 = "6".repeat(64);
const M65B = "7".repeat(64);
const TH65 = "c".repeat(64);
const TH65B = "d".repeat(64);
const reviewHashes = (manifest = M65, thumb = TH65) => async (abs: string) => {
  const name = abs.split("/").pop() ?? "";
  if (name === "V65_release.json") return manifest;
  if (name === "Thumbnail_V65_A.jpg") return thumb;
  return "0".repeat(64);
};
const ownerDecision = (id: string, manifest: string, kind: "approved" | "returned", thumb: string | null, at = "2026-11-15T10:00:00.000Z") =>
  ({ id, manifestSha256: manifest, video: "V65", thumbnailSha256: thumb, kind, comment: kind === "returned" ? "the intro is cut" : null, by: "owner" as const, device: "Mac", at }) as {
    id: string; manifestSha256: string; video: string; thumbnailSha256: string | null; kind: "approved" | "returned"; comment: string | null; by: "owner"; device: string; at: string; videoSha256?: string; videoSizeBytes?: number;
  };
/** BL-265: the mp4 the V65 package states (its `sha256` and `sizeBytes`, as `packageFiles` writes them with `over`). */
const MP4_65 = "e".repeat(64);
const mediaDecision = (id: string, manifest: string, kind: "approved" | "returned", at = "2026-11-15T10:00:00.000Z") => ({ ...ownerDecision(id, manifest, kind, TH65, at), videoSha256: MP4_65, videoSizeBytes: 1000 });
async function gate(required: boolean | null, decisions: ReturnType<typeof ownerDecision>[]) {
  const { ownerReviewStateOf, reviewGateOf } = await import("@/lib/package-reviews/model");
  return reviewGateOf(ownerReviewStateOf({ exists: true, required: required === null ? null : { value: required, updatedAt: "", by: "owner", device: null }, decisions: Object.fromEntries(decisions.map((d) => [d.id, d])) }));
}
async function scanV65(extra: Partial<PackageScanDeps>, files = packageFiles("04 Videos/10 October/1024 V65", "V65")) {
  const result = await createPackageScan(deps(files, { sha256: reviewHashes(), ...extra })).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  return result.packages[0];
}

test("AC-PR-01: no gate port, a gate that is off, or no document: the same state and problems as before, and no thumbnail hashed", async () => {
  const hashed: string[] = [];
  const counting = async (abs: string) => {
    hashed.push(abs.split("/").pop() ?? "");
    return reviewHashes()(abs);
  };
  const before = await scanV65({ sha256: counting });
  assert.deepEqual([before.state, before.problems], ["ready", []]);
  const { ownerReviewStateOf, reviewGateOf } = await import("@/lib/package-reviews/model");
  for (const g of [await gate(false, []), reviewGateOf(ownerReviewStateOf({ exists: false, required: null, decisions: {} }))]) {
    const scanned = await scanV65({ sha256: counting, ownerReview: async () => g });
    assert.deepEqual([scanned.state, scanned.problems], ["ready", []]);
  }
  assert.deepEqual([...new Set(hashed)], ["V65_release.json"], "only the manifest is hashed, as before");
});

test("AC-PR-02: gate on, no decision -> not_ready with owner_review_pending", async () => {
  const scanned = await scanV65({ ownerReview: async () => gate(true, []) });
  assert.deepEqual([scanned.state, scanned.problems], ["not_ready", [{ code: "owner_review_pending" }]]);
});

// AC-PR-03 changed by BL-265 (owner TG 2340, ADR 0072 §1): the thumbnail is packaging and no longer part of the approval.
test("AC-MG-09 (was AC-PR-03): a BL-257 approval of this manifest -> ready whatever the thumbnail; a re-packaged manifest -> pending once", async () => {
  const approved = [ownerDecision("d1", M65, "approved", TH65)];
  assert.deepEqual((await scanV65({ ownerReview: async () => gate(true, approved) })).state, "ready");
  const newThumb = await scanV65({ sha256: reviewHashes(M65, TH65B), ownerReview: async () => gate(true, approved) });
  assert.deepEqual([newThumb.state, newThumb.problems], ["ready", []]);
  const repackaged = await scanV65({ sha256: reviewHashes(M65B, TH65), ownerReview: async () => gate(true, approved) });
  assert.deepEqual([repackaged.state, repackaged.problems], ["not_ready", [{ code: "owner_review_pending" }]]);
});

test("AC-MG-01/02 (scan): a media approval keeps a re-packaged manifest of the same mp4 ready; a manifest stating another sha256 or size is pending; nothing but the manifest is hashed", async () => {
  const hashed: string[] = [];
  const counting = (manifest: string) => async (abs: string) => {
    hashed.push(abs.split("/").pop() ?? "");
    return reviewHashes(manifest, TH65B)(abs);
  };
  const approved = [mediaDecision("d1", M65, "approved")];
  const files = (over: Record<string, unknown>) => packageFiles("04 Videos/10 October/1024 V65", "V65", { sha256: MP4_65, ...over });
  const same = await scanV65({ sha256: counting(M65B), ownerReview: async () => gate(true, approved) }, files({ title: "A new title" }));
  assert.deepEqual([same.state, same.problems], ["ready", []]);
  const otherSha = await scanV65({ sha256: counting(M65B), ownerReview: async () => gate(true, approved) }, files({ sha256: "f".repeat(64) }));
  assert.deepEqual([otherSha.state, otherSha.problems], ["not_ready", [{ code: "owner_review_pending" }]]);
  assert.deepEqual([...new Set(hashed)], ["V65_release.json"]);
});

test("AC-PR-04: returned -> not_ready with owner_review_returned and the comment; a later approval -> ready", async () => {
  const returned = [ownerDecision("d1", M65, "returned", TH65)];
  const scanned = await scanV65({ ownerReview: async () => gate(true, returned) });
  assert.deepEqual([scanned.state, scanned.problems], ["not_ready", [{ code: "owner_review_returned", params: { comment: "the intro is cut" } }]]);
  const later = [...returned, ownerDecision("d2", M65, "approved", TH65, "2026-11-15T11:00:00.000Z")];
  assert.equal((await scanV65({ ownerReview: async () => gate(true, later) })).state, "ready");
});

test("AC-PR-06: an uploaded package gets no review problem; a package with another problem keeps only that problem", async () => {
  const files = { ...packageFiles("04 Videos/10 October/1024 V65", "V65"), "04 Videos/10 October/1024 V65/V65_youtube.json": { text: JSON.stringify({ videoId: "vid65" }), bytes: 20 } };
  const uploaded = await scanV65({ ownerReview: async () => gate(true, []), videos: async () => [{ videoId: "vid65", title: "Title V65", privacyStatus: "private", publishAt: null }] }, files);
  assert.deepEqual([uploaded.state, uploaded.problems], ["uploaded_private", []]);
  const noThumb = packageFiles("04 Videos/10 October/1024 V65", "V65");
  delete noThumb["04 Videos/10 October/1024 V65/Thumbnail_V65_A.jpg"];
  const other = await scanV65({ ownerReview: async () => gate(true, []) }, noThumb);
  assert.deepEqual(other.problems.map((p) => p.code), ["thumbnail_missing"]);
});

test("AC-PR-07: a gate port that fails holds the package (owner_review_pending), never a failed scan", async () => {
  const scanned = await scanV65({ ownerReview: async () => Promise.reject(new Error("document unreadable")) });
  assert.deepEqual([scanned.state, scanned.problems], ["not_ready", [{ code: "owner_review_pending" }]]);
});

// BL-259 (owner msg 4397): the frame mark. Taller than wide (1080x1920) is vertical; wider (1920x1080) or square is horizontal; the
// frame read on this computer is remembered by video number and used when the mp4 is gone; nothing known -> null.
test("BL-259: orientation from the probed frame, remembered; the memo stands in when the mp4 is gone; unknown is null", async () => {
  const remembered: Array<[string, string, string]> = [];
  const memo = (known: Record<string, "vertical" | "horizontal">) => ({ get: async () => known, remember: async (c: string, v: string, o: "vertical" | "horizontal") => void remembered.push([c, v, o]) });
  const vertical = await scanV65({ probeFrame: async () => ({ width: 1080, height: 1920 }), orientations: memo({}) });
  assert.equal(vertical.orientation, "vertical");
  assert.deepEqual(remembered, [["UC_t", "V65", "vertical"]]);
  assert.equal((await scanV65({ probeFrame: async () => ({ width: 1920, height: 1080 }) })).orientation, "horizontal");
  assert.equal((await scanV65({ probeFrame: async () => ({ width: 1080, height: 1080 }) })).orientation, "horizontal");
  // Already remembered the same way: not written again.
  remembered.length = 0;
  await scanV65({ probeFrame: async () => ({ width: 1080, height: 1920 }), orientations: memo({ V65: "vertical" }) });
  assert.deepEqual(remembered, []);
  // The mp4 deleted after upload: the memo answers.
  const files = packageFiles("04 Videos/10 October/1024 V65", "V65");
  delete files["04 Videos/10 October/1024 V65/V65 Tropico Jazz.mp4"];
  assert.equal((await scanV65({ probeFrame: async () => ({ width: 1920, height: 1080 }), orientations: memo({ V65: "vertical" }) }, files)).orientation, "vertical");
  // No frame and no memo; or a frame port that fails.
  assert.equal((await scanV65({}, files)).orientation, null);
  assert.equal((await scanV65({ probeFrame: async () => Promise.reject(new Error("ffprobe")) })).orientation, null);
});

// BL-263 (SHORT_VIDEO_CODE_PLAN.md §2 rows 4–7, AC-SC-02/03/04): an S package scans like a V package; a manifest naming another
// code than its folder and file is a problem and is never uploaded; every V package scans exactly as before.
test("BL-263 AC-SC-02: `1120 S14 Short/S14_release.json` (video S14) scans ready, with its record, orientation and date order", async () => {
  const files = {
    ...packageFiles("04 Videos/11 November/1120 S14 Short", "S14", { plannedPublishDate: "2026-11-20" }),
    ...packageFiles("04 Videos/11 November/1120 V27", "V27", { plannedPublishDate: "2026-11-20" }),
    ...packageFiles("04 Videos/11 November/1120 S2 Short", "S2", { plannedPublishDate: "2026-11-20" }),
    ...packageFiles("04 Videos/11 November/1119 S15 Short", "S15", { plannedPublishDate: "2026-11-19" }),
    "04 Videos/11 November/1119 S15 Short/S15_youtube.json": { text: JSON.stringify({ videoId: "vidS15" }), bytes: 20 },
  };
  const remembered: string[] = [];
  const result = await createPackageScan(
    deps(files, { probeFrame: async () => ({ width: 1080, height: 1920 }), orientations: { get: async () => ({}), remember: async (_c, v) => void remembered.push(v) } }),
  ).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  // By date; on a tie the shared comparator (V before S, then numeric: S2 before S14).
  assert.deepEqual(result.packages.map((p) => [p.video, p.state, p.youtube?.videoId ?? null]), [
    ["S15", "uploaded_unknown", "vidS15"],
    ["V27", "ready", null],
    ["S2", "ready", null],
    ["S14", "ready", null],
  ]);
  const s14 = result.packages[3];
  assert.equal(s14.manifestPath, "04 Videos/11 November/1120 S14 Short/S14_release.json");
  assert.equal(s14.orientation, "vertical");
  assert.deepEqual(s14.problems, []);
  assert.ok(remembered.includes("S14"));
});

test("BL-263 AC-SC-03: S14 in a folder of S15, or a manifest saying S014, is field_invalid (video) and never ready", async () => {
  const mismatch = {
    "04 Videos/11 November/1120 S15 Short/S15_release.json": { text: manifest("S14"), bytes: 500 },
    "04 Videos/11 November/1120 S15 Short/S14 Tropico Jazz.mp4": { bytes: 1000 },
    "04 Videos/11 November/1120 S15 Short/Thumbnail_S14_A.jpg": { bytes: 4000, head: JPEG },
  };
  const zero = packageFiles("04 Videos/11 November/1121 S14 Short", "S14", { video: "S014" });
  const v14InS = packageFiles("04 Videos/11 November/1122 S16 Short", "S16", { video: "V16" });
  const result = await createPackageScan(deps({ ...mismatch, ...zero, ...v14InS })).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  assert.equal(result.packages.length, 3);
  for (const p of result.packages) {
    assert.equal(p.state, "not_ready", p.manifestPath);
    assert.deepEqual(p.problems, [{ code: "field_invalid", params: { field: "video" } }], p.manifestPath);
    assert.equal(p.pkg, null);
  }
  // A file named S014_release.json is not a package at all (S is strict in names too).
  const strict = await createPackageScan(deps({ "04 Videos/11 November/1121 S014 Short/S014_release.json": { text: manifest("S014"), bytes: 500 } })).scan("UC_t");
  assert.deepEqual(strict.status === "ok" ? strict.packages : null, []);
});

test("BL-263 AC-SC-04: a V package whose manifest names another V (today's behaviour) still scans as before; a legacy V07 folder is read", async () => {
  // Before BL-263 the scan never compared a V manifest with its folder; that stays so (plan §3: nothing existing changes meaning).
  const files = {
    ...packageFiles("04 Videos/10 October/1024 V65", "V65", { video: "V66" }),
    ...packageFiles("04 Videos/10 October/1007 V07", "V07"),
  };
  const result = await createPackageScan(deps(files)).scan("UC_t");
  if (result.status !== "ok") return assert.fail(result.status);
  assert.deepEqual(result.packages.map((p) => p.video).sort(), ["V07", "V66"]);
});

// BL-265 (MEDIA_GATE_PLAN.md §3.1 "Entry point", §3.4 "One comparison rule"; AC-MG-36/38): an uploaded package's row says whether its
// manifest's texts differ from the synced copy -- on any channel, with or without the review gate. Title exact; description with CR
// line ends or trailing line breaks is the same text; an unknown video (not in the copy) is null.
test("AC-MG-36/38: the uploaded package's 'packaging differs from YouTube' fields, by the one comparison rule, on a channel without the gate", async () => {
  const folder = "04 Videos/10 October/1024 V65";
  const files = { ...packageFiles(folder, "V65", { description: "Line 1\r\nLine 2" }), [`${folder}/V65_youtube.json`]: { text: JSON.stringify({ videoId: "vid65" }), bytes: 20 } };
  const synced = (title: string, description: string) => async () => [{ videoId: "vid65", title, description, privacyStatus: "public", publishAt: null }];
  const same = await scanV65({ videos: synced("Title V65", "Line 1\nLine 2\n\n") }, files);
  assert.deepEqual([same.state, same.youtubeTextsDiffer], ["published", []]);
  const retitled = await scanV65({ videos: synced("Old title", "Line 1\nLine 2") }, files);
  assert.deepEqual(retitled.youtubeTextsDiffer, ["title"]);
  const both = await scanV65({ videos: synced("Old title", "Other text") }, files);
  assert.deepEqual(both.youtubeTextsDiffer, ["title", "description"]);
  const unknown = await scanV65({ videos: async () => [] }, files);
  assert.equal(unknown.youtubeTextsDiffer, null);
  const notUploaded = await scanV65({});
  assert.equal(notUploaded.youtubeTextsDiffer, null);
});

// BL-269 (VIDEO_CAPTIONS_PLAN.md §3.1, AC-CAP-01/05/09): the scan reads the caption file a v2 package names (workspace rule), its
// SHA-256 and the format of its bytes, with the channel's captions switch and the frame; a valid one keeps the package ready.
test("BL-269 captions: a valid VTT on a switched-on channel with a horizontal frame is ready; a wrong hash or bad content is not", async () => {
  const { createHash } = await import("node:crypto");
  const folder = "04 Videos/11 November/1120 V27";
  const scanWith = async (bytes: Uint8Array, stated: string, extra: Partial<PackageScanDeps> = {}) => {
    const files: Record<string, FakeFile> = {
      ...packageFiles(folder, "V27", { schema: "yt-release-package/2", captions: [{ language: "en", file: "V27_captions.en.vtt", name: "", sha256: stated }] }),
      [`${folder}/V27_captions.en.vtt`]: { bytes: bytes.length, head: bytes },
    };
    const base = deps(files);
    const result = await createPackageScan({
      ...base,
      channel: async () => ({ channelId: "UC_t", defaultLanguage: "en", defaultAudioLanguage: "en", captionsEnabled: true }),
      probeFrame: async () => ({ width: 1920, height: 1080 }),
      sha256: async (abs) => (abs.endsWith(".vtt") ? createHash("sha256").update(files[abs.slice(WS.length + 1)].head!).digest("hex") : base.sha256(abs)),
      ...extra,
    }).scan("UC_t");
    assert.equal(result.status, "ok");
    return result.status === "ok" ? result.packages[0] : null;
  };
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const vtt = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n");
  const ready = await scanWith(vtt, hash(vtt));
  assert.deepEqual([ready?.state, ready?.problems], ["ready", []]);
  const wrongHash = await scanWith(vtt, "0".repeat(64));
  assert.deepEqual([wrongHash?.state, wrongHash?.problems.map((p) => p.params?.reason)], ["not_ready", ["sha256"]]);
  const srtInVtt = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:03,000\nHello\n");
  const badFormat = await scanWith(srtInVtt, hash(srtInVtt));
  assert.deepEqual(badFormat?.problems.map((p) => p.params?.reason), ["format"]);
  const off = await scanWith(vtt, hash(vtt), { channel: async () => ({ channelId: "UC_t", defaultLanguage: "en", defaultAudioLanguage: "en" }) });
  assert.deepEqual(off?.problems.map((p) => p.params?.reason), ["channel_disabled"]);
  const vertical = await scanWith(vtt, hash(vtt), { probeFrame: async () => ({ width: 1080, height: 1920 }) });
  assert.deepEqual(vertical?.problems.map((p) => p.params?.reason), ["not_horizontal"]);
});
