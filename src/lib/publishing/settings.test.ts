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
