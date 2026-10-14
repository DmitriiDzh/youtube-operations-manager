import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PUBLISHING_SETTINGS, effectivePublishingSettings, parsePublishingSettingsPatch } from "./settings";

// BL-182 stage 2 (FO-REQ-0023 §4 A3; owner msgs 1114, 2715, 2725/2727). Requirements:
// - defaults: published at 12:00 UTC, no playlist, Music (10), not made for kids, AI use on (G2), standard license, embeddable,
//   subscribers notified;
// - the time is a 24-hour UTC HH:MM; a playlist is an id or none; the category one of YouTube's assignable ids; the license
//   "youtube" or "creativeCommon"; the flags booleans;
// - a value this build cannot use never reaches an upload: the default applies.

test("the defaults the request and the owner set", () => {
  assert.deepEqual(DEFAULT_PUBLISHING_SETTINGS, {
    publishTimeUtc: "12:00",
    playlistId: null,
    categoryId: "10",
    madeForKids: false,
    containsSyntheticMedia: true,
    license: "youtube",
    embeddable: true,
    notifySubscribers: true,
    // Owner msgs 2751/2753: «Прямая реклама» off unless the owner turns it on; no channel tags until the owner adds some.
    paidProductPlacement: false,
    channelTags: [],
  });
  assert.deepEqual(effectivePublishingSettings({}), { settings: DEFAULT_PUBLISHING_SETTINGS, saved: [] });
});

test("saved values replace the defaults; an invalid or unknown stored value falls back to the default", () => {
  const { settings, saved } = effectivePublishingSettings({
    publishTimeUtc: "13:30",
    playlistId: "PLabc_DEF-123",
    madeForKids: "no",
    categoryId: "99",
    futureField: true,
  });
  assert.equal(settings.publishTimeUtc, "13:30");
  assert.equal(settings.playlistId, "PLabc_DEF-123");
  assert.equal(settings.madeForKids, false, "a non-boolean is not used");
  assert.equal(settings.categoryId, "10", "99 is not an assignable category");
  assert.deepEqual(saved, ["publishTimeUtc", "playlistId"]);
});

test("a save names known fields with valid values; one bad field refuses the whole save", () => {
  assert.deepEqual(parsePublishingSettingsPatch({ publishTimeUtc: "09:00", playlistId: null, license: "creativeCommon", notifySubscribers: false }), {
    ok: true,
    patch: { publishTimeUtc: "09:00", playlistId: null, license: "creativeCommon", notifySubscribers: false },
  });
  for (const body of [
    { publishTimeUtc: "9:00" },
    { publishTimeUtc: "24:00" },
    { publishTimeUtc: "12:00", categoryId: "18" },
    { license: "cc" },
    { embeddable: "true" },
    { playlistId: "" },
    { title: "x" },
    {},
    null,
    [],
  ]) {
    assert.equal(parsePublishingSettingsPatch(body).ok, false, JSON.stringify(body));
  }
});

// Owner msgs 2751/2753. YouTube's own rules (videos resource): snippet.tags is at most 500 characters, commas between tags and the
// quotes around a tag with a space counted; `paidProductPlacementDetails.hasPaidProductPlacement` is a boolean.
test("paid promotion is true/false; channel tags: a list of distinct tags, each 1-100 characters without <, > or a comma, within 500", async () => {
  const { publishingSettingProblem, uploadTags, CHANNEL_TAGS_MAX } = await import("./settings");
  assert.equal(publishingSettingProblem("paidProductPlacement", true), null);
  assert.notEqual(publishingSettingProblem("paidProductPlacement", "yes"), null);
  assert.equal(publishingSettingProblem("channelTags", []), null);
  assert.equal(publishingSettingProblem("channelTags", ["tropical jazz", "bossa nova"]), null);
  for (const bad of ["jazz", ["a,b"], ["<b>"], [" jazz"], [""], ["x".repeat(101)], ["Jazz", "jazz"], Array.from({ length: CHANNEL_TAGS_MAX + 1 }, (_, i) => `t${i}`), Array.from({ length: 6 }, (_, i) => `${i}`.repeat(90))]) {
    assert.notEqual(publishingSettingProblem("channelTags", bad), null, JSON.stringify(bad).slice(0, 60));
  }
  // Requirement changed by the owner (msg 2817, FO-MSG-0017 option «б»; was msg 2753 "added after the package's"): a package with
  // its own tags sends only those, a package with none sends the channel's common tags.
  assert.deepEqual(uploadTags(["cuban jazz", "Piano"], ["piano", "tropical jazz"]), ["cuban jazz", "Piano"]);
  assert.deepEqual(uploadTags([], ["piano", "tropical jazz"]), ["piano", "tropical jazz"]);
  assert.deepEqual(uploadTags(["jazz"], []), ["jazz"]);
  assert.deepEqual(uploadTags([], []), []);
});

// FO-MSG-0017 (owner msgs 2813/2814): the channel's tags are checked like a package's -- YouTube's 500 characters, counted as YouTube
// counts them (videos resource, snippet.tags: commas between tags count). By hand: four tags of 100 letters and one of 96 = 496 + 4
// commas = 500, accepted; one more letter = 501, refused.
test("channel tags: exactly 500 characters by YouTube's count is accepted, 501 is refused", async () => {
  const { publishingSettingProblem } = await import("./settings");
  const at500 = ["a", "b", "c", "d"].map((c) => c.repeat(100)).concat("e".repeat(96));
  assert.equal(publishingSettingProblem("channelTags", at500), null);
  assert.notEqual(publishingSettingProblem("channelTags", [...at500.slice(0, 4), "e".repeat(97)]), null);
});

// FO-MSG-0017 §2: the approval screen shows each row's tags with where they come from. By hand (YouTube's count: a tag with a space
// counts two quotes, commas count): "cuban jazz" 12 + "Piano" 5 + 1 comma = 18; "tropical jazz" alone = 15.
test("an upload's tags: the package's, or the channel's when the package has none, counted for the approval row", async () => {
  const { uploadTagsSummary } = await import("./settings");
  // Owner msg 2817: the package's own tags replace the channel's -- "cuban jazz" 12 + "Piano" 5 + 1 comma = 18.
  assert.deepEqual(uploadTagsSummary(["cuban jazz", "Piano"], ["piano", "tropical jazz"]), { tags: ["cuban jazz", "Piano"], fromPackage: 2, fromChannel: 0, characters: 18 });
  // tags: [] in the package -> the channel's tags (FO-MSG-0017 §2 rule).
  assert.deepEqual(uploadTagsSummary([], ["tropical jazz"]), { tags: ["tropical jazz"], fromPackage: 0, fromChannel: 1, characters: 15 });
  assert.deepEqual(uploadTagsSummary(["jazz"], []), { tags: ["jazz"], fromPackage: 1, fromChannel: 0, characters: 4 });
  assert.deepEqual(uploadTagsSummary([], []), { tags: [], fromPackage: 0, fromChannel: 0, characters: 0 });
});
