import assert from "node:assert/strict";
import test from "node:test";
import { packageProblems, parseReleasePackage, type ChannelExpectations, type PackageFacts } from "./packages";

// BL-225 stage 2 (WEEKLY_PUBLISHING_PLAN.md AC-WP-20..22; FO-REQ-0040 item 2; owner msg 3511 answer 4). Requirements:
// - `yt-release-package/2` is additive to v1: slotId, localizations { <lang>: { title, description } }, containsSyntheticMedia
//   (absent: the channel's setting), thumbnails [{ file, role: default | test }] with exactly one default (the uploaded one);
// - every thumbnail (default and test) is JPEG/PNG and at most 2 MB (2 097 152 bytes);
// - translations follow the shared rules with a video's limits: a YouTube language, title ≤ 100 characters, description ≤ 5000
//   bytes, no < or >, never the package's own language.
// Expected values counted by hand.

const V2 = {
  schema: "yt-release-package/2",
  channelId: "UC_japan",
  video: "V64",
  mix: null,
  plannedPublishDate: "2026-10-26",
  files: { video: "V64 Rural Japan Morning.mp4" },
  thumbnails: [
    { file: "Thumbnail_V64_A.jpg", role: "default" },
    { file: "thumbnails/Thumbnail_V64_B.jpg", role: "test" },
    { file: "thumbnails/Thumbnail_V64_C.png", role: "test" },
  ],
  sizeBytes: 1000,
  durationSeconds: 10800,
  title: "Rural Japan Morning",
  description: "Rice fields at dawn.",
  tags: [],
  defaultLanguage: "en",
  defaultAudioLanguage: "zxx",
  ready: true,
  problems: [],
  slotId: "w44-mon",
  containsSyntheticMedia: true,
  localizations: { ja: { title: "日本の田舎の朝", description: "夜明けの田んぼ。" }, de: { title: "Ländlicher Morgen in Japan", description: "Reisfelder im Morgengrauen." } },
};
const CHANNEL: ChannelExpectations = { channelId: "UC_japan", defaultLanguage: "en", defaultAudioLanguage: "zxx" };
const FACTS: PackageFacts = {
  video: { exists: true, sizeBytes: 1000, durationSeconds: 10800 },
  thumbnail: { exists: true, sizeBytes: 500_000, kind: "jpeg" },
  testThumbnails: [
    { file: "thumbnails/Thumbnail_V64_B.jpg", exists: true, sizeBytes: 400_000, kind: "jpeg" },
    { file: "thumbnails/Thumbnail_V64_C.png", exists: true, sizeBytes: 300_000, kind: "png" },
  ],
  youtubeRecordExists: false,
  sameTitleVideoId: null,
};

test("AC-WP-20: a v2 manifest gives its slot, translations, AI flag and thumbnails; the default is the uploaded thumbnail", () => {
  const { pkg, problems } = parseReleasePackage(V2);
  assert.deepEqual(problems, []);
  assert.equal(pkg!.schemaVersion, 2);
  assert.equal(pkg!.slotId, "w44-mon");
  assert.equal(pkg!.containsSyntheticMedia, true);
  assert.deepEqual(Object.keys(pkg!.localizations!).sort(), ["de", "ja"]);
  assert.equal(pkg!.files.thumbnail, "Thumbnail_V64_A.jpg");
  assert.deepEqual(pkg!.thumbnails!.map((t) => t.role), ["default", "test", "test"]);
  assert.deepEqual(packageProblems(pkg!, FACTS, CHANNEL), []);
});

test("AC-WP-20: v2 fields are optional; a v1 manifest parses as before and ignores v2-only fields", () => {
  const bare: Record<string, unknown> = { ...V2 };
  for (const key of ["slotId", "localizations", "containsSyntheticMedia", "thumbnails"]) delete bare[key];
  const minimal = parseReleasePackage({ ...bare, files: { video: "V64.mp4", thumbnail: "T.jpg" } });
  assert.deepEqual(minimal.problems, []);
  assert.deepEqual([minimal.pkg!.slotId, minimal.pkg!.localizations, minimal.pkg!.containsSyntheticMedia], [null, null, null]);
  assert.deepEqual(minimal.pkg!.thumbnails, [{ file: "T.jpg", role: "default" }]);
  const v1 = parseReleasePackage({ ...V2, schema: "yt-release-package/1", files: { video: "V64.mp4", thumbnail: "T.jpg" } });
  assert.deepEqual(v1.problems, []);
  assert.equal(v1.pkg!.schemaVersion, 1);
  assert.equal(v1.pkg!.slotId, null, "a v1 manifest's slotId is not read");
  assert.equal(v1.pkg!.localizations, null);
});

test("AC-WP-20/21: thumbnails need exactly one default, files inside the folder, no file twice; files.thumbnail must be the default", () => {
  const codes = (over: Record<string, unknown>) => parseReleasePackage({ ...V2, ...over }).problems.map((p) => p.code);
  assert.deepEqual(codes({ thumbnails: [{ file: "a.jpg", role: "test" }] }), ["thumbnails_default_count"]);
  assert.deepEqual(codes({ thumbnails: [{ file: "a.jpg", role: "default" }, { file: "b.jpg", role: "default" }] }), ["thumbnails_default_count"]);
  assert.deepEqual(codes({ thumbnails: [{ file: "../a.jpg", role: "default" }] }), ["field_invalid"]);
  assert.deepEqual(codes({ thumbnails: [{ file: "a.jpg", role: "default" }, { file: "a.jpg", role: "test" }] }), ["field_invalid"]);
  assert.deepEqual(codes({ thumbnails: [{ file: "a.jpg", role: "cover" }] }), ["field_invalid"]);
  assert.deepEqual(codes({ thumbnails: [] }), ["field_invalid"]);
  assert.deepEqual(codes({ files: { video: "v.mp4", thumbnail: "other.jpg" } }), ["field_invalid"]);
  assert.deepEqual(codes({ files: { video: "v.mp4", thumbnail: "Thumbnail_V64_A.jpg" } }), []);
  assert.deepEqual(codes({ slotId: "w 44" }), ["field_invalid"]);
  assert.deepEqual(codes({ containsSyntheticMedia: "yes" }), ["field_invalid"]);
  assert.deepEqual(codes({ localizations: ["ja"] }), ["field_invalid"]);
});

test("AC-WP-21: every test thumbnail is held to 2 MB and JPEG/PNG; 2 097 152 bytes passes, one byte more does not", () => {
  const pkg = parseReleasePackage(V2).pkg!;
  const withTest = (test: NonNullable<PackageFacts["testThumbnails"]>[number]) => packageProblems(pkg, { ...FACTS, testThumbnails: [test] }, CHANNEL);
  assert.deepEqual(withTest({ file: "b.jpg", exists: true, sizeBytes: 2_097_152, kind: "jpeg" }), []);
  assert.deepEqual(withTest({ file: "b.jpg", exists: true, sizeBytes: 2_097_153, kind: "jpeg" }), [{ code: "test_thumbnail_too_large", params: { file: "b.jpg", bytes: 2_097_153, max: 2_097_152 } }]);
  assert.deepEqual(withTest({ file: "b.gif", exists: true, sizeBytes: 10, kind: "other" }).map((p) => p.code), ["test_thumbnail_not_image"]);
  assert.deepEqual(withTest({ file: "b.jpg", exists: false, sizeBytes: null, kind: null }).map((p) => p.code), ["test_thumbnail_missing"]);
  assert.deepEqual(packageProblems(pkg, { ...FACTS, thumbnail: { exists: true, sizeBytes: 2_097_153, kind: "jpeg" } }, CHANNEL).map((p) => p.code), ["thumbnail_too_large"]);
});

test("AC-WP-22: translations by the shared rules -- the package's own language, a 101-character title, 5001 bytes, < > and a non-YouTube code are refused", () => {
  const problemsWith = (localizations: Record<string, unknown>) => packageProblems(parseReleasePackage({ ...V2, localizations }).pkg!, FACTS, CHANNEL);
  const ok = { title: "T", description: "D" };
  assert.deepEqual(problemsWith({ ja: ok }), []);
  for (const [language, entry, reason] of [
    ["en", ok, "baseline_language"],
    ["ja", { title: "x".repeat(101), description: "D" }, "title_too_long"],
    ["ja", { title: "T", description: "x".repeat(5001) }, "description_too_long"],
    ["ja", { title: "a <b>", description: "D" }, "title_angle_brackets"],
    ["ja", { title: "T", description: "a > b" }, "description_angle_brackets"],
    ["xx-yy", ok, "unsupported_language"],
  ] as const) {
    const problems = problemsWith({ [language]: entry });
    assert.equal(problems.length, 1, `${language} ${reason}`);
    assert.equal(problems[0].code, "localizations_invalid");
    assert.match(String(problems[0].params?.languages), new RegExp(`${language} \\(${reason}\\)`));
  }
  // Exactly 100 characters and 5000 bytes are accepted.
  assert.deepEqual(problemsWith({ ja: { title: "x".repeat(100), description: "x".repeat(5000) } }), []);
});
