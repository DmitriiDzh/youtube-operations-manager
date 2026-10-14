import assert from "node:assert/strict";
import test from "node:test";
import { isNamedAfterRelease, isVideoFileName, parseUploadRecord, parseVideoRegistry, videoNumberOfFolder, walkVideosFolder, type DirEntry } from "./index";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §1.2, §2.4). Expected values come from the factory's layout read on the Mac
// (2026-10-14): `04 Videos/<MM Month>/<MMDD Vn>/Vn Tropico Jazz.mp4`, source clips beside it, folders without a V-number
// (`0906 8H`), `Vn_youtube.json` after an upload by YT Manager, and `video_registry.csv` written outside this repository
// (a BOM, quoted titles with commas).

test("a release folder is `MMDD Vn`; any other folder name has no release number", () => {
  assert.equal(videoNumberOfFolder("0928 V39"), "V39");
  assert.equal(videoNumberOfFolder("0928 v39"), "V39");
  assert.equal(videoNumberOfFolder("0906 8H"), null);
  assert.equal(videoNumberOfFolder("09 September"), null);
  assert.equal(videoNumberOfFolder("V39"), null);
  assert.equal(videoNumberOfFolder("0928 V39x"), null);
});

test("a file is named after release Vn only when Vn is followed by a space, `_`, `.` or the end (V3 is not V39)", () => {
  assert.equal(isNamedAfterRelease("V39 Tropico Jazz.mp4", "V39"), true);
  assert.equal(isNamedAfterRelease("v39_final.mp4", "V39"), true);
  assert.equal(isNamedAfterRelease("V39.mp4", "V39"), true);
  assert.equal(isNamedAfterRelease("V39 Tropico Jazz.mp4", "V3"), false);
  assert.equal(isNamedAfterRelease("Seedance V39.mp4", "V39"), false);
  assert.equal(isVideoFileName("V39 Tropico Jazz.mp4"), true);
  assert.equal(isVideoFileName("clip.MOV"), true);
  assert.equal(isVideoFileName("V39_release.json"), false);
  assert.equal(isVideoFileName("._V39.mp4"), false);
});

test("the upload record names the video; a BOM is accepted; anything else is no record", () => {
  assert.deepEqual(parseUploadRecord('﻿{"videoId":"abcdefghijk","privacyStatus":"private"}'), { videoId: "abcdefghijk" });
  assert.equal(parseUploadRecord("{nope"), null);
  assert.equal(parseUploadRecord('{"videoId":""}'), null);
  assert.equal(parseUploadRecord('{"id":"abcdefghijk"}'), null);
  assert.equal(parseUploadRecord("null"), null);
});

test("the registry gives video id and folder per row; quoted commas and a BOM are read; bad rows are skipped", () => {
  const csv = [
    "﻿VNumber,FolderDate,PublishedAtUtc,ScheduledPublishAtUtc,Status,YouTubeVideoId,Title,Folder,MixNumber,ImageFile,ImageFileSource,MatchMethod,Note",
    'V1,2026-08-05,2026-08-05T16:00:08Z,,public,jSYuVT-HJlE,"2 Hours of Jazz ☀️ Café Music for Work, Study & Relaxation",08 August/0805 V1,,,,folder-date,',
    'V2,2026-08-07,,,public,U8DAksN-QEU,"A ""quoted"" title",08 August/0807 V2,,,,folder-date,',
    "V3,2026-08-11,,,public,not-an-id,Title,08 August/0811 V3,,,,folder-date,",
    "V4,2026-08-13,,,public,2xnoB8-359I,Title,,,,,folder-date,",
    "",
  ].join("\r\n");
  assert.deepEqual(parseVideoRegistry(csv), [
    { vNumber: "V1", videoId: "jSYuVT-HJlE", folder: "08 August/0805 V1" },
    { vNumber: "V2", videoId: "U8DAksN-QEU", folder: "08 August/0807 V2" },
  ]);
});

test("a registry without the id or folder column gives no rows (its format is not a contract)", () => {
  assert.deepEqual(parseVideoRegistry("VNumber,VideoId,Folder\nV1,jSYuVT-HJlE,08 August/0805 V1\n"), []);
  assert.deepEqual(parseVideoRegistry(""), []);
  assert.deepEqual(parseVideoRegistry("garbage"), []);
});

test("the walk lists files under `04 Videos/` three levels deep, never through a symlink or a hidden folder", async () => {
  const tree: Record<string, DirEntry[]> = {
    "/ws/04 Videos": [
      { name: "09 September", kind: "dir" },
      { name: "linked", kind: "other" },
      { name: ".cache", kind: "dir" },
      { name: "top.mp4", kind: "file" },
    ],
    "/ws/04 Videos/09 September": [{ name: "0928 V39", kind: "dir" }],
    "/ws/04 Videos/09 September/0928 V39": [
      { name: "V39 Tropico Jazz.mp4", kind: "file" },
      { name: "V39_release.json", kind: "file" },
      { name: "deeper", kind: "dir" },
    ],
    "/ws/04 Videos/09 September/0928 V39/deeper": [{ name: "too-deep.mp4", kind: "file" }],
    "/ws/04 Videos/linked": [{ name: "outside.mp4", kind: "file" }],
    "/ws/04 Videos/.cache": [{ name: "hidden.mp4", kind: "file" }],
  };
  const listed = await walkVideosFolder({ listDir: async (p) => tree[p] ?? [], join: (...parts) => parts.join("/") }, "/ws", isVideoFileName);
  assert.deepEqual(listed, ["04 Videos/09 September/0928 V39/V39 Tropico Jazz.mp4", "04 Videos/top.mp4"]);
});

// Independent review (LIVE_STREAMS_FIELDS_PLAN.md §2.4 item 3: the registry row "whose `Folder` equals the file's folder", read
// tolerantly -- its format is not a contract): a folder written relative to the workspace, i.e. the file's own folder
// `04 Videos/<MM Month>/<MMDD Vn>`, names the same release folder as one written relative to `04 Videos/`.
test("a registry folder written as the workspace-relative `04 Videos/...` path names the same folder", () => {
  const csv = "YouTubeVideoId,Folder\njSYuVT-HJlE,04 Videos/08 August/0805 V1\nU8DAksN-QEU,04 Videos\\08 August\\0807 V2\\\n";
  assert.deepEqual(
    parseVideoRegistry(csv).map((r) => r.folder),
    ["08 August/0805 V1", "08 August/0807 V2"],
  );
});
