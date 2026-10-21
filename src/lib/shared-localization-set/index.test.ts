import assert from "node:assert/strict";
import test from "node:test";
import { descriptionLength, validateLocalizationSet, type LocalizationSetLimits } from "./index";

// BL-210 (docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md, "API facts"): the shared set validator with a channel's limits --
// 30 characters for a title (brandingSettings.channel.title), 1000 CHARACTERS for a description (channels resource). The video
// limits (100 characters / 5000 bytes) stay covered by `live-streams/localizations.test.ts`. Expected values by hand.

const channelLimits: LocalizationSetLimits = { titleMaxCharacters: 30, description: { max: 1000, unit: "characters" }, maxLanguages: 50 };
const options = { baselineLanguage: "en", limits: channelLimits, ownText: "the channel's own title and description" };

test("a description is counted in the limit's own unit: characters vs UTF-8 bytes", () => {
  // "ж" is 1 character and 2 bytes; CRLF counts as one LF.
  assert.equal(descriptionLength("жж\r\n", "characters"), 3);
  assert.equal(descriptionLength("жж\r\n", "bytes"), 5);
});

test("channel limits: a 30-character title and a 1000-character description pass; 31 and 1001 are refused", () => {
  const ok = validateLocalizationSet({ de: { title: "a".repeat(30), description: "ж".repeat(1000) } }, options);
  assert.equal(ok.ok, true);

  const bad = validateLocalizationSet({ de: { title: "a".repeat(31), description: "ж".repeat(1001) } }, options);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.deepEqual(
    bad.refused.map((r) => r.reason),
    ["title_too_long", "description_too_long"]
  );
  assert.equal(bad.refused[1].message, "The description has 1001 characters; YouTube allows 1000");
});

test("the baseline language's refusal names the text it would replace", () => {
  const bad = validateLocalizationSet({ en: { title: "T", description: "D" } }, options);
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.deepEqual(bad.refused, [{ language: "en", reason: "baseline_language", message: "\"en\" is the channel's base language: its text is the channel's own title and description" }]);
});

test("more languages than the limit refuse the whole set", () => {
  const input = Object.fromEntries(["de", "fr", "es"].map((l) => [l, { title: "T", description: "D" }]));
  const result = validateLocalizationSet(input, { ...options, limits: { ...channelLimits, maxLanguages: 2 } });
  assert.deepEqual(result, { ok: false, problem: "too_many_languages", message: "3 languages; at most 2", refused: [] });
});
