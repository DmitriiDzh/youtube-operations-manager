import assert from "node:assert/strict";
import test from "node:test";
import { changedPackageFields, approvedPackageOf } from "./approved-package";
import { captionsProblems, PACKAGE_WARNING_CODES, packageProblems, parseReleasePackage, type CaptionFacts, type ChannelExpectations, type PackageFacts } from "./packages";
import { effectivePublishingSettings, parsePublishingSettingsPatch, DEFAULT_PUBLISHING_SETTINGS } from "./settings";

// BL-269 AC-CAP-01..08, AC-CAP-10 (VIDEO_CAPTIONS_PLAN.md §3.1, §7; ADR 0074 §2–§3). Requirements, not the code:
// - `yt-release-package/2` gains optional `captions: [{ language, file, name, sha256 }]`; v1 with it -> field_invalid; absent/[] = none;
// - captions only where the channel's switch is on (WWE, default off) and on a horizontal long video (V code); S, vertical or unknown
//   frame refused; one entry, language exactly "en"; name 0-150 characters without < > ("" allowed, the Operator's bundle writes it);
//   a .srt/.vtt file inside the folder; 1 byte to 10 MiB (10 485 760); SHA-256 equal; the format check passes;
// - both codes block (never warnings); captions are packaging: a re-package changing them is taken by a queued row.
// Expected values written by hand from those rules.

const SHA = "a".repeat(64);
const CAPTION = { language: "en", file: "V27_captions.en.vtt", name: "", sha256: SHA };
const BASE = {
  schema: "yt-release-package/2",
  channelId: "UC_wwe",
  video: "V27",
  mix: null,
  plannedPublishDate: null,
  files: { video: "V27.mp4", thumbnail: "V27.jpg" },
  sizeBytes: 1000,
  durationSeconds: 600,
  title: "Long video",
  description: "Text.",
  tags: [],
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  ready: true,
  problems: [],
};
const WWE: ChannelExpectations = { channelId: "UC_wwe", defaultLanguage: "en", defaultAudioLanguage: "en", captionsEnabled: true };
const goodFile: CaptionFacts = { file: CAPTION.file, exists: true, sizeBytes: 1200, sha256: SHA, check: { ok: true, format: "vtt", cues: 10, lastEndMs: 590_000 } };
const facts = (over: Partial<PackageFacts> = {}): PackageFacts => ({
  video: { exists: true, sizeBytes: 1000, durationSeconds: 600 },
  thumbnail: { exists: true, sizeBytes: 1000, kind: "jpeg" },
  youtubeRecordExists: false,
  sameTitleVideoId: null,
  captions: [goodFile],
  orientation: "horizontal",
  ...over,
});
const parse = (extra: Record<string, unknown>) => parseReleasePackage({ ...BASE, ...extra });
const problemsOf = (extra: Record<string, unknown>, f: PackageFacts = facts(), channel: ChannelExpectations = WWE) => {
  const { pkg, problems } = parse(extra);
  assert.deepEqual(problems, []);
  return packageProblems(pkg!, f, channel);
};
const reasons = (list: Array<{ code: string; params?: Record<string, string | number> }>) => list.map((p) => (p.code === "captions_invalid" ? `invalid:${p.params?.reason}` : p.code));

test("AC-CAP-01 no captions (absent or []) on WWE: ready as before", () => {
  assert.deepEqual(problemsOf({}), []);
  const empty = parse({ captions: [] });
  assert.equal(empty.pkg!.captions, null);
  assert.deepEqual(packageProblems(empty.pkg!, facts(), WWE), []);
  // Off channel without captions: nothing to say either.
  assert.deepEqual(problemsOf({}, facts(), { ...WWE, captionsEnabled: false }), []);
});

test("AC-CAP-01 a valid caption entry on WWE (switch on, horizontal V code) passes", () => {
  const { pkg } = parse({ captions: [CAPTION] });
  assert.deepEqual(pkg!.captions, [CAPTION]);
  assert.deepEqual(packageProblems(pkg!, facts(), WWE), []);
});

test("AC-CAP-02 the channel's switch off (or never set) -> captions_invalid channel_disabled", () => {
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts(), { ...WWE, captionsEnabled: false })), ["invalid:channel_disabled"]);
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts(), { channelId: "UC_wwe", defaultLanguage: "en", defaultAudioLanguage: "en" })), ["invalid:channel_disabled"]);
  assert.equal(DEFAULT_PUBLISHING_SETTINGS.captionsEnabled, false);
});

test("AC-CAP-03 an S code, a vertical frame, or an unknown frame -> not_horizontal / orientation_unknown", () => {
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts({ orientation: "vertical" }))), ["invalid:not_horizontal"]);
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts({ orientation: null }))), ["invalid:orientation_unknown"]);
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts({ orientation: undefined }))), ["invalid:orientation_unknown"]);
  // A Short is refused even when the frame reads horizontal.
  assert.deepEqual(reasons(captionsProblems([CAPTION], [goodFile], { captionsEnabled: true, video: "S14", orientation: "horizontal", durationSeconds: 60 })), ["invalid:not_horizontal"]);
});

test("AC-CAP-04 file absent -> captions_missing with the file; an unsafe path -> field_invalid captions", () => {
  const missing = problemsOf({ captions: [CAPTION] }, facts({ captions: [{ ...goodFile, exists: false, sizeBytes: null, sha256: null, check: null }] }));
  assert.deepEqual(missing, [{ code: "captions_missing", params: { file: CAPTION.file } }]);
  for (const file of ["../V27.vtt", "/abs/V27.vtt", "a/../b.vtt", "C:/x.vtt", "sub\\V27.vtt", "V27.txt"]) {
    assert.deepEqual(parse({ captions: [{ ...CAPTION, file }] }).problems, [{ code: "field_invalid", params: { field: "captions" } }], file);
  }
});

test("shape: malformed entries and a v1 manifest with captions are field_invalid", () => {
  const bad = [{ ...CAPTION, sha256: "xyz" }, { ...CAPTION, name: 5 }, { language: "en", file: CAPTION.file, sha256: SHA }, "V27.vtt", null];
  for (const entry of bad) assert.deepEqual(parse({ captions: [entry] }).problems, [{ code: "field_invalid", params: { field: "captions" } }]);
  assert.deepEqual(parse({ captions: "V27.vtt" }).problems, [{ code: "field_invalid", params: { field: "captions" } }]);
  assert.deepEqual(parse({ schema: "yt-release-package/1", captions: [CAPTION] }).problems, [{ code: "field_invalid", params: { field: "captions" } }]);
  // Upper-case hex is the same hash.
  assert.equal(parse({ captions: [{ ...CAPTION, sha256: "A".repeat(64) }] }).pkg!.captions![0].sha256, SHA);
});

test("AC-CAP-05 SHA-256 differs -> captions_invalid sha256", () => {
  const other = "a".repeat(63) + "b";
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts({ captions: [{ ...goodFile, sha256: other }] }))), ["invalid:sha256"]);
});

test("AC-CAP-06 0 bytes or 10 MiB + 1 -> size; exactly 10 MiB with valid content is accepted", () => {
  const MiB10 = 10 * 1024 * 1024;
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts({ captions: [{ ...goodFile, sizeBytes: 0 }] }))), ["invalid:size"]);
  assert.deepEqual(reasons(problemsOf({ captions: [CAPTION] }, facts({ captions: [{ ...goodFile, sizeBytes: MiB10 + 1 }] }))), ["invalid:size"]);
  assert.deepEqual(problemsOf({ captions: [CAPTION] }, facts({ captions: [{ ...goodFile, sizeBytes: MiB10 }] })), []);
});

test("AC-CAP-07 two entries, or language de / en-US -> count / language", () => {
  const second = { ...CAPTION, file: "V27_b.vtt" };
  const two = problemsOf({ captions: [CAPTION, second] }, facts({ captions: [goodFile, { ...goodFile, file: second.file }] }));
  assert.deepEqual(reasons(two), ["invalid:count"]);
  assert.deepEqual(reasons(problemsOf({ captions: [{ ...CAPTION, language: "de" }] })), ["invalid:language"]);
  assert.deepEqual(reasons(problemsOf({ captions: [{ ...CAPTION, language: "en-US" }] })), ["invalid:language"]);
});

test("AC-CAP-08 name: 151 characters or < -> name; \"\" and 150 characters accepted", () => {
  assert.deepEqual(reasons(problemsOf({ captions: [{ ...CAPTION, name: "x".repeat(151) }] })), ["invalid:name"]);
  assert.deepEqual(reasons(problemsOf({ captions: [{ ...CAPTION, name: "Eng <b>" }] })), ["invalid:name"]);
  assert.deepEqual(problemsOf({ captions: [{ ...CAPTION, name: "x".repeat(150) }] }), []);
  assert.deepEqual(problemsOf({ captions: [{ ...CAPTION, name: "" }] }), []);
});

test("AC-CAP-09 (scan side) a format failure is captions_invalid format with the detail", () => {
  const bad = problemsOf({ captions: [CAPTION] }, facts({ captions: [{ ...goodFile, check: { ok: false, detail: "no cue" } }] }));
  assert.deepEqual(bad, [{ code: "captions_invalid", params: { reason: "format", detail: "no cue" } }]);
});

test("AC-CAP-10 both codes block (never warnings); captions are packaging (changedPackageFields names them)", () => {
  assert.equal(PACKAGE_WARNING_CODES.includes("captions_invalid"), false);
  assert.equal(PACKAGE_WARNING_CODES.includes("captions_missing"), false);
  const before = approvedPackageOf(parse({}).pkg!, { manifestPath: "04 Videos/11 November/1120 V27/V27_release.json", folder: "04 Videos/11 November/1120 V27" }, { channelTags: [] });
  const after = approvedPackageOf(parse({ captions: [CAPTION] }).pkg!, { manifestPath: before.manifestPath, folder: "04 Videos/11 November/1120 V27", orientation: "horizontal" }, { channelTags: [] });
  assert.deepEqual(after.captions, { language: "en", file: "04 Videos/11 November/1120 V27/V27_captions.en.vtt", name: "", sha256: SHA });
  assert.equal(after.orientation, "horizontal");
  assert.equal(before.captions, undefined);
  assert.deepEqual(changedPackageFields(before, after), ["captions"]);
});

test("the switch is a publishing default: boolean only, saved like the others", () => {
  assert.deepEqual(parsePublishingSettingsPatch({ captionsEnabled: true }), { ok: true, patch: { captionsEnabled: true } });
  assert.equal(parsePublishingSettingsPatch({ captionsEnabled: "yes" }).ok, false);
  assert.equal(effectivePublishingSettings({ captionsEnabled: true }).settings.captionsEnabled, true);
  assert.equal(effectivePublishingSettings({ captionsEnabled: 1 }).settings.captionsEnabled, false);
});
