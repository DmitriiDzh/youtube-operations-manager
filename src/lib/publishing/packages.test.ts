import assert from "node:assert/strict";
import test from "node:test";
import { chapterProblems, chapterStarts, imageKindOf, isSafeRelativePath, packageProblems, parseReleasePackage, tagsLength, type ChannelExpectations, type PackageFacts, type ReleasePackage } from "./packages";

// BL-182 stage 2. Requirements, with their sources:
// - FO-REQ-0023 §4 A: the manifest `yt-release-package/1`, files relative to the package folder; §4 B2: the file exists with its
//   size and ffprobe duration, title ≤ 100 characters without < >, description ≤ 5000 BYTES, tags ≤ 500, chapters (first 00:00, at
//   least 3, each ≥ 10 s), a JPEG/PNG thumbnail, the en/en defaults, not already on YouTube (no `Vn_youtube.json`, no same title);
// - YouTube Data API videos resource: title "maximum length of 100 characters ... except < and >", description "5000 bytes ...
//   except < and >", tags "500 characters ... includes commas between items ... a tag with a space ... quotation marks count";
// - thumbnails.set: JPEG or PNG, at most 2 MB;
// - FO-REQ-0022: the channel's language baseline is the truth (a package in another language is not uploaded as it is).
// Expected values below are counted by hand.

const MANIFEST = {
  schema: "yt-release-package/1",
  channelId: "UC_tropico",
  video: "V65",
  mix: 49,
  plannedPublishDate: "2026-10-24",
  files: { video: "V65 Tropico Jazz.mp4", thumbnail: "Thumbnail_V65_A.jpg" },
  sizeBytes: 839640730,
  durationSeconds: 7223.66,
  title: "Cuban Jazz at Sunrise",
  description: "Intro\n\n00:00 Suena la Vieja Radio\n02:52 Ecos de Costa Serena\n05:50 Última Brisa\n",
  tags: ["cuban jazz", "jazz"],
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  ready: true,
  problems: [],
};
const CHANNEL: ChannelExpectations = { channelId: "UC_tropico", defaultLanguage: "en", defaultAudioLanguage: "en" };
const FACTS: PackageFacts = {
  video: { exists: true, sizeBytes: 839640730, durationSeconds: 7223.4 },
  thumbnail: { exists: true, sizeBytes: 414808, kind: "jpeg" },
  youtubeRecordExists: false,
  sameTitleVideoId: null,
};
const pkg = (over: Partial<typeof MANIFEST> = {}): ReleasePackage => {
  const { pkg: parsed, problems } = parseReleasePackage({ ...MANIFEST, ...over });
  assert.deepEqual(problems, []);
  return parsed!;
};
const codes = (p: ReleasePackage, facts: Partial<PackageFacts> = {}, channel: Partial<ChannelExpectations> = {}) =>
  packageProblems(p, { ...FACTS, ...facts }, { ...CHANNEL, ...channel }).map((problem) => problem.code);

test("the request's example package is valid as it is", () => {
  assert.deepEqual(codes(pkg()), []);
});

test("the manifest shape: another schema, a path leaving the folder, a missing field or an impossible date is refused", () => {
  assert.deepEqual(parseReleasePackage({ ...MANIFEST, schema: "yt-release-package/2" }).problems, [{ code: "unknown_schema", params: { schema: "yt-release-package/2" } }]);
  assert.equal(parseReleasePackage(null).problems[0].code, "not_a_package");
  for (const [field, over] of [
    ["files.video", { files: { video: "../V65.mp4", thumbnail: "t.jpg" } }],
    ["files.thumbnail", { files: { video: "v.mp4", thumbnail: "/Users/x/t.jpg" } }],
    ["plannedPublishDate", { plannedPublishDate: "2026-02-30" }],
    ["title", { title: 5 }],
    ["tags", { tags: ["ok", 3] }],
    ["video", { video: "65" }],
  ] as const) {
    const { pkg: parsed, problems } = parseReleasePackage({ ...MANIFEST, ...over });
    assert.equal(parsed, null, field);
    assert.ok(problems.some((p) => p.params?.field === field), `${field}: ${JSON.stringify(problems)}`);
  }
  assert.equal(parseReleasePackage({ ...MANIFEST, plannedPublishDate: null }).pkg?.plannedPublishDate, null, "no planned date is allowed");
});

test("title: 100 characters is fine, 101 is not (an emoji is one character); < and > are refused", () => {
  assert.deepEqual(codes(pkg({ title: "a".repeat(100) })), []);
  assert.deepEqual(codes(pkg({ title: "a".repeat(101) })), ["title_too_long"]);
  assert.deepEqual(codes(pkg({ title: "🌅".repeat(100) })), [], "100 emoji are 100 characters (200 UTF-16 units)");
  assert.deepEqual(codes(pkg({ title: "Jazz <live>" })), ["title_angle_brackets"]);
  assert.deepEqual(codes(pkg({ title: "   " })), ["title_empty"]);
});

test("description: limited in BYTES -- 5000 ASCII bytes pass, 2501 Cyrillic letters (5002 bytes) do not", () => {
  assert.deepEqual(codes(pkg({ description: "a".repeat(5000) })), []);
  assert.deepEqual(codes(pkg({ description: "я".repeat(2501) })), ["description_too_long"]);
  assert.deepEqual(codes(pkg({ description: "a > b" })), ["description_angle_brackets"]);
});

// FO-MSG-0017 §2: a package's tags get the same checks as the channel's -- YouTube does not accept < or > in a tag.
test("tags: a tag with < or > is a problem; ordinary tags are not", () => {
  assert.deepEqual(codes(pkg({ tags: ["jazz", "<b>bold</b>"] })), ["tags_angle_brackets"]);
  assert.deepEqual(codes(pkg({ tags: ["a > b"] })), ["tags_angle_brackets"]);
  assert.deepEqual(codes(pkg({ tags: ["cuban jazz", "piano"] })), []);
});

test("tags as YouTube counts them: commas count, and a tag with a space counts its two quotes", () => {
  // "cuban jazz" = 10 + 2 quotes, "jazz" = 4, one comma: 17.
  assert.equal(tagsLength(["cuban jazz", "jazz"]), 17);
  assert.equal(tagsLength([]), 0);
  // 50 tags of 9 letters: 450 + 49 commas = 499 -> fine; one letter more on one tag -> 500 -> fine; two more -> 501.
  const fifty = Array.from({ length: 50 }, () => "abcdefghi");
  assert.deepEqual(codes(pkg({ tags: fifty })), []);
  assert.deepEqual(codes(pkg({ tags: [...fifty.slice(1), "abcdefghij"] })), []);
  assert.deepEqual(codes(pkg({ tags: [...fifty.slice(1), "abcdefghijk"] })), ["tags_too_long"]);
});

test("chapters: first at 0:00, at least three, each at least 10 s, the last one up to the video's end; none is no problem", () => {
  assert.deepEqual(chapterStarts("\ufeff00:00 A\n02:52 B\n1:05:50 C\nno 3:00 here"), [0, 172, 3950]);
  assert.deepEqual(chapterProblems("plain text", 7200), []);
  assert.deepEqual(chapterProblems("0:05 A\n1:00 B\n2:00 C", 7200).map((p) => p.code), ["chapters_first_not_zero"]);
  assert.deepEqual(chapterProblems("0:00 A\n1:00 B", 7200).map((p) => p.code), ["chapters_too_few"]);
  assert.deepEqual(chapterProblems("0:00 A\n0:09 B\n1:00 C", 7200).map((p) => p.code), ["chapter_too_short"]);
  assert.deepEqual(chapterProblems("0:00 A\n0:10 B\n1:00 C", 7200), [], "exactly 10 s is long enough");
  assert.deepEqual(chapterProblems("0:00 A\n1:00 B\n1:55:55 C", 6964).map((p) => p.code), ["chapter_too_short"], "the last chapter has 9 s left");
});

test("languages: the channel baseline decides; no baseline refuses", () => {
  assert.deepEqual(codes(pkg({ defaultLanguage: "es" })), ["language_differs"]);
  assert.deepEqual(codes(pkg({ defaultAudioLanguage: "zxx" })), ["audio_language_differs"]);
  assert.deepEqual(codes(pkg(), {}, { defaultLanguage: null, defaultAudioLanguage: null }), ["no_channel_baseline"]);
});

test("the files: missing, another size (an unfinished copy), another duration, an unreadable file, a wrong or large thumbnail", () => {
  assert.deepEqual(codes(pkg(), { video: { exists: false, sizeBytes: null, durationSeconds: null } }), ["video_missing"]);
  assert.deepEqual(codes(pkg(), { video: { exists: true, sizeBytes: 400_000_000, durationSeconds: 7223.4 } }), ["video_size_differs"]);
  assert.deepEqual(codes(pkg(), { video: { exists: true, sizeBytes: 839640730, durationSeconds: 7225 } }), ["video_duration_differs"], "1.34 s off");
  assert.deepEqual(codes(pkg(), { video: { exists: true, sizeBytes: 839640730, durationSeconds: 7224.6 } }), [], "0.94 s off is rounding");
  assert.deepEqual(codes(pkg(), { video: { exists: true, sizeBytes: 839640730, durationSeconds: null, probeFailed: true } }), ["video_unreadable"]);
  assert.deepEqual(codes(pkg(), { video: { exists: true, sizeBytes: 839640730, durationSeconds: null, noProbe: true } }), ["ffprobe_missing"], "not the file's fault");
  assert.deepEqual(codes(pkg(), { thumbnail: { exists: false, sizeBytes: null, kind: null } }), ["thumbnail_missing"]);
  assert.deepEqual(codes(pkg(), { thumbnail: { exists: true, sizeBytes: 1000, kind: "other" } }), ["thumbnail_not_image"]);
  assert.deepEqual(codes(pkg(), { thumbnail: { exists: true, sizeBytes: 2 * 1024 * 1024 + 1, kind: "png" } }), ["thumbnail_too_large"]);
  assert.deepEqual(codes(pkg(), { thumbnail: { exists: true, sizeBytes: 2 * 1024 * 1024, kind: "png" } }), [], "exactly 2 MB is allowed");
});

test("not twice: the same title already on the channel refuses unless the upload record says it is this package", () => {
  assert.deepEqual(codes(pkg(), { sameTitleVideoId: "abc123" }), ["same_title_on_channel"]);
  assert.deepEqual(codes(pkg(), { sameTitleVideoId: "abc123", youtubeRecordExists: true }), []);
});

test("the factory's own verdict and the channel: not ready, its problems, or another channel's package", () => {
  assert.deepEqual(codes(pkg({ ready: false })), ["factory_not_ready"]);
  assert.deepEqual(codes(pkg({ problems: ["thumbnail missing"] as never[] })), ["factory_not_ready"]);
  assert.deepEqual(codes(pkg({ channelId: "UC_japan" })), ["other_channel"]);
});

test("paths and image types", () => {
  assert.equal(isSafeRelativePath("V65 Tropico Jazz.mp4"), true);
  assert.equal(isSafeRelativePath("sub/thumb.jpg"), true);
  for (const bad of ["", "../x", "a/../b", "/abs", "C:\\x", "a\\b", "a//b", "./x"]) assert.equal(isSafeRelativePath(bad), false, bad);
  assert.equal(imageKindOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(imageKindOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(imageKindOf(new Uint8Array([0x47, 0x49, 0x46, 0x38])), "other");
});

// BL-209 (AUTO_PRIVATE_UPLOAD_PLAN.md §2 item 2, FO-REQ-0036): yt-release-package/1 may carry a top-level `sha256` -- the hex
// SHA-256 of the video file. It is read as lower-case hex; absent or not 64 hex digits it is null (the package then uploads only on
// the owner's approval, AC-AU-03) and never a problem: a manual upload does not need it.
test("BL-209: the manifest's optional sha256 -- read as lower-case hex; absent or malformed is null and no problem", () => {
  const upper = "ABCDEF0123456789".repeat(4);
  const read = (sha256: unknown) => parseReleasePackage({ ...MANIFEST, sha256 });
  assert.equal(read(upper).pkg?.sha256, "abcdef0123456789".repeat(4));
  assert.equal(parseReleasePackage(MANIFEST).pkg?.sha256, null);
  for (const bad of ["abc", "g".repeat(64), "a".repeat(63), 42, null]) {
    assert.deepEqual([read(bad).pkg?.sha256, read(bad).problems], [null, []], String(bad));
  }
  assert.deepEqual(codes(read(upper).pkg!), []);
});
