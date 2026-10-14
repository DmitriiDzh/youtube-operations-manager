import assert from "node:assert/strict";
import test from "node:test";
import { buildPickerRows, type PickerInputs, type PickerVideo } from "./picker";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4, acceptance §4.1 "Picker matching"). Fixtures are written by hand from the
// Tropico layout read on the Mac (§1.2): `04 Videos/<MM Month>/<MMDD Vn>/Vn Tropico Jazz.mp4`, source clips beside it,
// `0906 8H` without a V-number. Matching, strongest first: the Operator's map (exact file), `Vn_youtube.json`, the registry
// row for the folder; sources that disagree give no match; a video not of the channel is never a match; suggestions by
// duration (±1 s) are only offered, never chosen.

const NOW = new Date("2026-10-14T12:00:00Z");
const V39_FILE = "04 Videos/09 September/0928 V39/V39 Tropico Jazz.mp4";
const V40_FILE = "04 Videos/10 October/1002 V40/V40 Tropico Jazz.mp4";

function video(videoId: string, over: Partial<PickerVideo> = {}): PickerVideo {
  return {
    videoId,
    title: `Title ${videoId}`,
    privacyStatus: "public",
    publishAt: null,
    publishedAt: "2026-09-28T15:00:00Z",
    durationSeconds: 7200,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    ...over,
  };
}

function inputs(over: Partial<PickerInputs> = {}): PickerInputs {
  return {
    files: [
      { relativePath: V39_FILE, bytes: 5_000_000_000, durationSeconds: 7200.4 },
      { relativePath: "04 Videos/09 September/0928 V39/Seedance clip 3.mp4", bytes: 50_000_000, durationSeconds: 10 },
      { relativePath: "04 Videos/09 September/0906 8H/Tropico 8H.mp4", bytes: 20_000_000_000, durationSeconds: 28800 },
    ],
    uploadRecords: {},
    registry: [{ vNumber: "V39", videoId: "AAAAAAAAA39", folder: "09 September/0928 V39" }],
    sources: [],
    channelVideos: [video("AAAAAAAAA39")],
    rotation: [],
    showAll: false,
    now: NOW,
    ...over,
  };
}

const row = (rows: ReturnType<typeof buildPickerRows>, file: string) => rows.find((r) => r.file === file);

test("a release file with a registry row of a public channel video is matched and available", () => {
  const rows = buildPickerRows(inputs());
  assert.equal(rows.length, 1, "only the release file is listed by default");
  const v39 = row(rows, V39_FILE)!;
  assert.equal(v39.vNumber, "V39");
  assert.equal(v39.release, true);
  assert.equal(v39.state, "available");
  assert.equal(v39.match?.videoId, "AAAAAAAAA39");
  assert.equal(v39.match?.source, "registry");
  assert.deepEqual(v39.conflict, []);
});

test("source clips and folders without a V-number appear only with «show all files», and are not matched by folder sources", () => {
  const rows = buildPickerRows(inputs({ showAll: true }));
  assert.equal(rows.length, 3);
  const clip = row(rows, "04 Videos/09 September/0928 V39/Seedance clip 3.mp4")!;
  assert.equal(clip.release, false);
  assert.equal(clip.match, null);
  const eightHours = row(rows, "04 Videos/09 September/0906 8H/Tropico 8H.mp4")!;
  assert.equal(eightHours.vNumber, null);
  assert.equal(eightHours.match, null);
  assert.equal(eightHours.state, "needs_choice");
});

test("a folder with two V39 files: both listed, neither matched by the folder's registry row", () => {
  const second = "04 Videos/09 September/0928 V39/V39 Tropico Jazz (alt).mp4";
  const rows = buildPickerRows(
    inputs({
      files: [
        { relativePath: V39_FILE, bytes: 1, durationSeconds: 7200 },
        { relativePath: second, bytes: 1, durationSeconds: 7200 },
      ],
    }),
  );
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.match, null);
    assert.equal(r.state, "needs_choice");
  }
});

test("a registry row naming a video that is not this channel's gives no match", () => {
  const rows = buildPickerRows(inputs({ registry: [{ vNumber: "V39", videoId: "ZZZZZZZZZZZ", folder: "09 September/0928 V39" }] }));
  assert.equal(row(rows, V39_FILE)!.match, null);
  assert.equal(row(rows, V39_FILE)!.state, "needs_choice");
});

test("the registry and Vn_youtube.json disagreeing: a conflict, no match, both offered", () => {
  const rows = buildPickerRows(
    inputs({
      uploadRecords: { "04 Videos/09 September/0928 V39": "BBBBBBBBB39" },
      channelVideos: [video("AAAAAAAAA39"), video("BBBBBBBBB39", { durationSeconds: 3600 })],
    }),
  );
  const v39 = row(rows, V39_FILE)!;
  assert.equal(v39.match, null);
  assert.equal(v39.state, "conflict");
  assert.deepEqual(v39.conflict.map((c) => [c.source, c.videoId]).sort(), [
    ["registry", "AAAAAAAAA39"],
    ["upload_record", "BBBBBBBBB39"],
  ]);
  assert.deepEqual(v39.suggestions.map((s) => s.videoId).sort(), ["AAAAAAAAA39", "BBBBBBBBB39"]);
});

test("sources that agree give one match, named by the strongest source", () => {
  const rows = buildPickerRows(
    inputs({
      sources: [{ videoId: "AAAAAAAAA39", originalPath: V39_FILE }],
      uploadRecords: { "04 Videos/09 September/0928 V39": "AAAAAAAAA39" },
    }),
  );
  assert.equal(row(rows, V39_FILE)!.match?.source, "operator_map");
  assert.equal(row(rows, V39_FILE)!.state, "available");
});

test("a match to a private or scheduled video is shown but not available, with the reason", () => {
  const priv = buildPickerRows(inputs({ channelVideos: [video("AAAAAAAAA39", { privacyStatus: "private" })] }));
  assert.equal(row(priv, V39_FILE)!.state, "not_public");
  assert.equal(row(priv, V39_FILE)!.match?.privacyStatus, "private");
  const scheduled = buildPickerRows(inputs({ channelVideos: [video("AAAAAAAAA39", { privacyStatus: "private", publishAt: "2026-10-20T15:00:00Z" })] }));
  assert.equal(row(scheduled, V39_FILE)!.state, "not_public");
  assert.equal(row(scheduled, V39_FILE)!.match?.publishAt, "2026-10-20T15:00:00Z");
  const publicButFuture = buildPickerRows(inputs({ channelVideos: [video("AAAAAAAAA39", { publishAt: "2026-10-20T15:00:00Z" })] }));
  assert.equal(row(publicButFuture, V39_FILE)!.state, "not_public");
});

test("a video already in the rotation (by id, or its file) is greyed out", () => {
  const byId = buildPickerRows(inputs({ rotation: [{ videoId: "AAAAAAAAA39", originalPath: "elsewhere.mp4" }] }));
  assert.equal(row(byId, V39_FILE)!.state, "in_rotation");
  const byFile = buildPickerRows(inputs({ registry: [], rotation: [{ videoId: "CCCCCCCCCCC", originalPath: V39_FILE }] }));
  assert.equal(row(byFile, V39_FILE)!.state, "in_rotation");
});

test("with no match, suggestions are channel videos within 1 s of the file, public ones newest first; never chosen", () => {
  const rows = buildPickerRows(
    inputs({
      registry: [],
      files: [{ relativePath: V40_FILE, bytes: 1, durationSeconds: 7200.4 }],
      channelVideos: [
        video("OLDPUBLIC01", { durationSeconds: 7200, publishedAt: "2026-08-01T00:00:00Z" }),
        video("NEWPUBLIC01", { durationSeconds: 7201, publishedAt: "2026-10-01T00:00:00Z" }),
        video("PRIVATE0001", { durationSeconds: 7200, privacyStatus: "private", publishedAt: "2026-10-05T00:00:00Z" }),
        video("TOOLONG0001", { durationSeconds: 7202 }),
        video("INROTATION1", { durationSeconds: 7200 }),
      ],
      rotation: [{ videoId: "INROTATION1", originalPath: "x.mp4" }],
    }),
  );
  const v40 = row(rows, V40_FILE)!;
  assert.equal(v40.match, null);
  assert.equal(v40.state, "needs_choice");
  assert.deepEqual(
    v40.suggestions.map((s) => s.videoId),
    ["NEWPUBLIC01", "OLDPUBLIC01", "PRIVATE0001"],
  );
});

test("a file whose duration is unknown gets no duration suggestions", () => {
  const rows = buildPickerRows(
    inputs({ registry: [], files: [{ relativePath: V40_FILE, bytes: 1, durationSeconds: null }], channelVideos: [video("AAAAAAAAA40")] }),
  );
  assert.deepEqual(row(rows, V40_FILE)!.suggestions, []);
});

test("rows are ordered by release number, files without one last", () => {
  const rows = buildPickerRows(
    inputs({
      showAll: true,
      registry: [],
      files: [
        { relativePath: "04 Videos/10 October/1002 V40/V40 Tropico Jazz.mp4", bytes: 1, durationSeconds: 1 },
        { relativePath: "04 Videos/09 September/0906 8H/Tropico 8H.mp4", bytes: 1, durationSeconds: 1 },
        { relativePath: "04 Videos/08 August/0805 V9/V9 Tropico Jazz.mp4", bytes: 1, durationSeconds: 1 },
      ],
    }),
  );
  assert.deepEqual(
    rows.map((r) => r.vNumber),
    ["V9", "V40", null],
  );
});
