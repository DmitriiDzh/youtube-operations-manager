import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedYoutubeLanguageCode, SUPPORTED_YOUTUBE_LANGUAGES } from "./youtube-supported-languages";

test("SUPPORTED_YOUTUBE_LANGUAGES has exactly the 83 entries captured from the real i18nLanguages.list response on 2026-09-21", () => {
  assert.equal(SUPPORTED_YOUTUBE_LANGUAGES.length, 83);
});

test("isSupportedYoutubeLanguageCode accepts a code present in the real captured list", () => {
  assert.equal(isSupportedYoutubeLanguageCode("es"), true);
  assert.equal(isSupportedYoutubeLanguageCode("en-GB"), true);
});

test("isSupportedYoutubeLanguageCode rejects a code absent from the list, including the documented en-US gap", () => {
  assert.equal(isSupportedYoutubeLanguageCode("en-US"), false);
  assert.equal(isSupportedYoutubeLanguageCode("not-a-real-code"), false);
});
