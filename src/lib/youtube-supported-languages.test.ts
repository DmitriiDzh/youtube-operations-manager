import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedYoutubeLanguageCode, SUPPORTED_YOUTUBE_LANGUAGES } from "./youtube-supported-languages";

test("SUPPORTED_YOUTUBE_LANGUAGES is the 83 entries captured from the real i18nLanguages.list response on 2026-09-21 plus pt-BR (owner request 2026-10-04)", () => {
  assert.equal(SUPPORTED_YOUTUBE_LANGUAGES.length, 84);
  assert.equal(isSupportedYoutubeLanguageCode("pt-BR"), true);
  assert.equal(SUPPORTED_YOUTUBE_LANGUAGES.find((l) => l.code === "pt-BR")?.name, "Portuguese (Brazil)");
});

test("isSupportedYoutubeLanguageCode accepts a code present in the real captured list", () => {
  assert.equal(isSupportedYoutubeLanguageCode("es"), true);
  assert.equal(isSupportedYoutubeLanguageCode("en-GB"), true);
});

test("isSupportedYoutubeLanguageCode rejects a code absent from the list, including the documented en-US gap", () => {
  assert.equal(isSupportedYoutubeLanguageCode("en-US"), false);
  assert.equal(isSupportedYoutubeLanguageCode("not-a-real-code"), false);
});
