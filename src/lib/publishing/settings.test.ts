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
  // The package's tags first, then the channel's that are not there yet (case-insensitive).
  assert.deepEqual(uploadTags(["cuban jazz", "Piano"], ["piano", "tropical jazz"]), ["cuban jazz", "Piano", "tropical jazz"]);
  assert.deepEqual(uploadTags([], []), []);
});
