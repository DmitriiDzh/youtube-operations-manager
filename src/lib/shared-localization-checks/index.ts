// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §4, ADR 0052): the app's own checks of one translated title or description --
// one owner for XLSX import, `ai-localization`, the review screen and `changeset_get` (AGENTS.md §M). Pure, no I/O; the Web UI may
// import it. A `fail` makes a change invalid when it is created; a `warn` is shown, never blocking. Limits are YouTube's
// (`youtube-video-fields`): a title of 100 characters, a description of 5000 UTF-8 bytes, no < or >. Channel-template rules (block
// order, title pattern, brand phrases) are not here: they are the worker's (AGENTS.md §B) and reach the app in its report.

import { sameLanguage } from "@/lib/shared-language-baseline";
import { DESCRIPTION_MAX_BYTES, TITLE_MAX_CHARACTERS, hasAngleBrackets } from "@/lib/youtube-video-fields";

export type LocalizationCheckResult = "pass" | "warn" | "fail";
export type LocalizationCheck = { id: LocalizationCheckId; result: LocalizationCheckResult; detail: string };
export type LocalizationCheckId =
  | "title_length"
  | "description_bytes"
  | "angle_brackets"
  | "own_language"
  | "script"
  | "tracked_language"
  | "identical_to_original"
  | "timestamps"
  | "hashtags"
  | "links"
  | "characters";

export type LocalizedFieldInput = {
  language: string;
  field: "title" | "description";
  /** The proposed translated text. */
  value: string;
  /** The video's original text of the same field (its own language); "" when unknown. */
  original: string;
  /** The video's own language (null when unknown): its text is the snippet, never a translation. */
  ownLanguage: string | null;
  /** The channel's tracked languages (the Languages table's columns); empty = not known, not checked. */
  trackedLanguages: readonly string[];
};

const HIRAGANA_KATAKANA = /[぀-ヿ]/u;
const HAN = /\p{Script=Han}/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;
const TIMESTAMP = /(?<![\d:])(?:\d{1,2}:)?\d{1,2}:\d{2}(?![\d:])/g;
const HASHTAG = /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu;
const LINK = /https?:\/\/|(?<![\p{L}\p{N}])www\./iu;
// U+FFFD, the two commonest mojibake pairs (UTF-8 read as Latin-1 / Windows-1252), zero-width characters, and control characters
// other than tab and newline.
const BAD_CHARACTERS = /�|Ã[\u0080-¿]|â€|[​-‍⁠﻿]|[\u0000-\u0008\u000b-\u001f\u007f]/u;

/** Which own-script test a language gets (ja / ko / zh only); null = not script-checked. */
function ownScript(language: string): ((ch: string) => boolean) | null {
  const primary = language.toLowerCase().split("-")[0];
  if (primary === "ja") return (ch) => HIRAGANA_KATAKANA.test(ch) || HAN.test(ch);
  if (primary === "ko") return (ch) => HANGUL.test(ch);
  if (primary === "zh") return (ch) => HAN.test(ch);
  return null;
}

function timestampsOf(text: string): string[] {
  return text.match(TIMESTAMP) ?? [];
}

/** Every check this field gets, in a fixed order. */
export function checkLocalizedField(input: LocalizedFieldInput): LocalizationCheck[] {
  const checks: LocalizationCheck[] = [];
  const add = (id: LocalizationCheckId, broken: boolean, failOrWarn: "fail" | "warn", detail: string, okDetail = "") =>
    checks.push({ id, result: broken ? failOrWarn : "pass", detail: broken ? detail : okDetail });

  if (input.field === "title") {
    const length = [...input.value.trim()].length;
    add("title_length", length === 0 || length > TITLE_MAX_CHARACTERS, "fail", length === 0 ? "The title is empty" : `The title has ${length} characters; YouTube allows ${TITLE_MAX_CHARACTERS}`, `${length} of ${TITLE_MAX_CHARACTERS} characters`);
  } else {
    const bytes = new TextEncoder().encode(input.value).length;
    add("description_bytes", bytes > DESCRIPTION_MAX_BYTES, "fail", `The description has ${bytes} bytes; YouTube allows ${DESCRIPTION_MAX_BYTES}`, `${bytes} of ${DESCRIPTION_MAX_BYTES} bytes`);
  }
  add("angle_brackets", hasAngleBrackets(input.value), "fail", "YouTube refuses < and > in a title or description");
  // A warning, not a failure: an XLSX row in the video's own language legitimately edits its title/description (PROJECT_SPEC §16).
  add("own_language", input.ownLanguage !== null && sameLanguage(input.language, input.ownLanguage), "warn", `${input.language} is the video's own language: this edits the video's own title and description, it is not a translation`);

  const isOwnScript = ownScript(input.language);
  if (isOwnScript) {
    const letters = [...input.value].filter((ch) => /\p{L}/u.test(ch));
    const own = letters.filter(isOwnScript).length;
    const latin = letters.filter((ch) => LATIN.test(ch)).length;
    // Brand and track names in Latin letters are fine while the text is mostly in its own script.
    add("script", own === 0 || own * 2 < latin, "fail", `The text is not written in ${input.language}'s script (${own} of ${letters.length} letters)`);
  }

  if (input.trackedLanguages.length > 0) {
    add("tracked_language", !input.trackedLanguages.some((language) => sameLanguage(language, input.language)), "warn", `${input.language} is not one of the channel's languages`);
  }
  if (input.original.trim().length > 0) {
    add("identical_to_original", input.value.trim() === input.original.trim(), "warn", "The text is the same as the original");
  }
  if (input.field === "description") {
    const expected = timestampsOf(input.original);
    if (expected.length > 0) {
      const actual = timestampsOf(input.value);
      const kept = expected.filter((stamp) => actual.includes(stamp)).length;
      const sameOrder = actual.length === expected.length && actual.every((stamp, index) => stamp === expected[index]);
      add("timestamps", !sameOrder, "warn", kept < expected.length ? `${kept} of ${expected.length} timestamps of the original kept` : "The timestamps are not in the original's order", `${expected.length} of ${expected.length} timestamps kept`);
    }
    const originalTags = (input.original.match(HASHTAG) ?? []).length;
    const tags = (input.value.match(HASHTAG) ?? []).length;
    if (originalTags > 0 || tags > 0) {
      add("hashtags", tags !== originalTags, "warn", `${tags} hashtags; the original has ${originalTags}`);
    }
  }
  add("links", LINK.test(input.value), "warn", "The text has a link");
  add("characters", BAD_CHARACTERS.test(input.value), "warn", "The text has a broken, invisible or control character");
  return checks;
}

/** Only the failed checks -- what makes a change invalid when it is created. */
export function failedChecks(input: LocalizedFieldInput): LocalizationCheck[] {
  return checkLocalizedField(input).filter((check) => check.result === "fail");
}
