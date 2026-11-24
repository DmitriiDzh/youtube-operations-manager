import assert from "node:assert/strict";
import test from "node:test";
import { approvedPackageOf, changedPackageFields } from "./approved-package";
import { parseReleasePackage, RELEASE_PACKAGE_MAX_PLAYLISTS } from "./packages";
import { estimateUploadUnits } from "./publish-dates";

// Package playlists (owner, Telegram 4858/4859, 2026-11-24). Requirements:
// - `yt-release-package/2` gains `playlists`: a list of 0..10 playlist ids, each of the publishing settings' own id pattern
//   (letters, digits, `_` and `-`, 2..64 characters); [] or absent means none; it is checked with the manifest (so a package with a
//   bad list is not ready and cannot be queued);
// - a v1 manifest has no such field (refused, like v1 `captions`); the same id twice is refused;
// - the upload row freezes the list; a re-package that changes it is a packaging change.
// Expected values worked out by hand.

const V2 = {
  schema: "yt-release-package/2",
  channelId: "UC_wwe",
  video: "V70",
  mix: null,
  plannedPublishDate: null,
  files: { video: "V70 Long.mp4", thumbnail: "Thumbnail_V70_A.jpg" },
  sizeBytes: 1000,
  durationSeconds: 3600,
  title: "Long video",
  description: "Text.",
  tags: [],
  defaultLanguage: "en",
  defaultAudioLanguage: "en",
  ready: true,
  problems: [],
};

const parse = (extra: Record<string, unknown>) => parseReleasePackage({ ...V2, ...extra });

test("AC-PP-01: a v2 package names its playlists; absent or [] is none", () => {
  assert.equal(RELEASE_PACKAGE_MAX_PLAYLISTS, 10);
  const named = parse({ playlists: ["PLaaaa_1", "PL-bbbb2"] });
  assert.deepEqual(named.problems, []);
  assert.deepEqual(named.pkg!.playlists, ["PLaaaa_1", "PL-bbbb2"]);
  assert.equal(parse({}).pkg!.playlists ?? null, null);
  assert.equal(parse({ playlists: [] }).pkg!.playlists ?? null, null);
  assert.equal(parse({ playlists: null }).pkg!.playlists ?? null, null);
});

test("AC-PP-02: ten playlists are allowed, eleven are refused", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `PL_${i}x`);
  assert.deepEqual(parse({ playlists: ten }).problems, []);
  const eleven = [...ten, "PL_10x"];
  const refused = parse({ playlists: eleven });
  assert.equal(refused.pkg, null);
  assert.deepEqual(refused.problems, [{ code: "field_invalid", params: { field: "playlists" } }]);
});

test("AC-PP-03: an id outside the settings pattern, a non-list, a non-string or the same id twice is refused", () => {
  for (const bad of [["PL bad"], ["P"], ["x".repeat(65)], ["PL/../x"], "PLaaaa", [42], [null], ["PLaaaa", "PLaaaa"]]) {
    const result = parse({ playlists: bad });
    assert.equal(result.pkg, null, JSON.stringify(bad));
    assert.deepEqual(result.problems, [{ code: "field_invalid", params: { field: "playlists" } }], JSON.stringify(bad));
  }
  // Two characters and 64 characters are the pattern's bounds.
  assert.deepEqual(parse({ playlists: ["PL", "y".repeat(64)] }).problems, []);
});

test("AC-PP-04: a v1 manifest carrying playlists is refused, never read without them", () => {
  const result = parseReleasePackage({ ...V2, schema: "yt-release-package/1", playlists: ["PLaaaa"] });
  assert.equal(result.pkg, null);
  assert.deepEqual(result.problems, [{ code: "field_invalid", params: { field: "playlists" } }]);
});

test("AC-PP-05: the upload row freezes the playlists; a change of them is a packaging change", () => {
  const settings = { channelTags: [] };
  const place = { manifestPath: "04 Videos/V70/V70_release.json", folder: "04 Videos/V70" };
  const before = approvedPackageOf(parse({ playlists: ["PLaaaa"] }).pkg!, place, settings);
  assert.deepEqual(before.playlists, ["PLaaaa"]);
  const none = approvedPackageOf(parse({}).pkg!, place, settings);
  assert.equal("playlists" in none, false, "a package without playlists freezes no list (rows read exactly as before)");
  const after = approvedPackageOf(parse({ playlists: ["PLaaaa", "PLbbbb"] }).pkg!, place, settings);
  assert.deepEqual(changedPackageFields(before, after), ["playlists"]);
  assert.deepEqual(changedPackageFields(before, before), []);
});

test("AC-PP-06: the quota budget adds 53 units per package playlist (ownership 1, membership 1, insert 50, read-back 1)", () => {
  // The pinned values stay: 95 without anything, 201 with the settings playlist and a deferred date.
  assert.equal(estimateUploadUnits({ playlist: false, deferredPublishAt: false }), 95);
  assert.equal(estimateUploadUnits({ playlist: true, deferredPublishAt: true }), 201);
  assert.equal(estimateUploadUnits({ playlist: true, deferredPublishAt: true, packagePlaylists: 2 }), 201 + 106);
  assert.equal(estimateUploadUnits({ playlist: false, deferredPublishAt: false, packagePlaylists: 0 }), 95);
});
