import assert from "node:assert/strict";
import test from "node:test";
import { checkLocalizedField, failedChecks, type LocalizedFieldInput } from "./index";

// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md §4, AC-LR-01..05; ADR 0052). Expected values worked out by hand from the
// YouTube Data API `videos` resource (title: 100 characters; description: 5000 bytes; no < or >) and FO-MSG-0025 §2.

const base = (over: Partial<LocalizedFieldInput>): LocalizedFieldInput => ({
  language: "de",
  field: "title",
  value: "Ein Titel",
  original: "A title",
  ownLanguage: "en",
  trackedLanguages: ["de", "es", "fr", "it", "ja", "ko", "zh-Hans"],
  ...over,
});

const result = (input: LocalizedFieldInput, id: string) => checkLocalizedField(input).find((check) => check.id === id)?.result;

test("AC-LR-01: the description limit is 5000 UTF-8 bytes, not characters", () => {
  // 1667 × "あ" = 5001 bytes (3 each) + "ab" = 5003 bytes, only 1669 characters.
  const over = "あ".repeat(1667) + "ab";
  assert.equal(result(base({ language: "ja", field: "description", value: over }), "description_bytes"), "fail");
  // 1666 × 3 = 4998 + "ab" = 5000 bytes exactly.
  const exact = "あ".repeat(1666) + "ab";
  assert.equal(result(base({ language: "ja", field: "description", value: exact }), "description_bytes"), "pass");
  assert.deepEqual(
    failedChecks(base({ language: "ja", field: "description", value: over })).map((check) => check.id),
    ["description_bytes"]
  );
});

test("AC-LR-02: the title limit is 100 characters counted as code points; an empty title fails", () => {
  assert.equal(result(base({ value: "x".repeat(101) }), "title_length"), "fail");
  assert.equal(result(base({ value: "x".repeat(100) }), "title_length"), "pass");
  // 100 emoji: 100 code points, 200 UTF-16 units -- valid.
  assert.equal(result(base({ value: "🍄".repeat(100) }), "title_length"), "pass");
  assert.equal(result(base({ value: "   " }), "title_length"), "fail");
});

test("angle brackets and the video's own language fail", () => {
  assert.equal(result(base({ value: "Titel <b>" }), "angle_brackets"), "fail");
  assert.equal(result(base({ field: "description", value: "a > b", original: "x" }), "angle_brackets"), "fail");
  assert.equal(result(base({ language: "EN" }), "own_language"), "fail");
  assert.equal(result(base({}), "own_language"), "pass");
});

test("AC-LR-03: ja / ko / zh must be written in their own script; other languages are not script-checked", () => {
  assert.equal(result(base({ language: "ja", value: "Mushroom hut | 3 Hours" }), "script"), "fail");
  assert.equal(result(base({ language: "ja", value: "一筆ずつ描く小屋 | 3時間" }), "script"), "pass");
  assert.equal(result(base({ language: "ko", value: "버섯 건조 오두막 | 3시간" }), "script"), "pass");
  assert.equal(result(base({ language: "ko", value: "一筆ずつ描く小屋" }), "script"), "fail");
  assert.equal(result(base({ language: "zh-Hans", value: "一笔一画画蘑菇小屋 | 3小时" }), "script"), "pass");
  assert.equal(result(base({ language: "zh-Hans", value: "Mushroom hut" }), "script"), "fail");
  // Brand and track names in Latin letters are fine while the text is mostly in its own script.
  assert.equal(result(base({ language: "ja", value: "Rural Japan Radio 🌿 日本の田舎の音楽をゆっくり聴く時間" }), "script"), "pass");
  assert.equal(checkLocalizedField(base({ language: "de" })).some((check) => check.id === "script"), false);
});

test("AC-LR-04: warnings never fail: identical text, links, hashtags, characters, an untracked language", () => {
  const warns = (input: LocalizedFieldInput) => checkLocalizedField(input).filter((check) => check.result === "warn").map((check) => check.id);
  assert.deepEqual(warns(base({ value: "A title" })), ["identical_to_original"]);
  assert.deepEqual(warns(base({ field: "description", value: "Hören https://example.com", original: "Listen" })), ["links"]);
  assert.deepEqual(warns(base({ field: "description", value: "Text www.example.com", original: "Text" })), ["links"]);
  assert.deepEqual(warns(base({ field: "description", value: "#a #b", original: "#x #y #z" })), ["hashtags"]);
  assert.deepEqual(warns(base({ value: "KaputtÃ¼ Titel" })), ["characters"]);
  assert.deepEqual(warns(base({ value: "Titel​" })), ["characters"]);
  assert.deepEqual(warns(base({ value: "Titel �" })), ["characters"]);
  assert.deepEqual(warns(base({ language: "pt-BR", value: "Um título" })), ["tracked_language"]);
  for (const input of [base({ value: "A title" }), base({ language: "pt-BR", value: "Um título" })]) {
    assert.deepEqual(failedChecks(input), []);
  }
});

test("AC-LR-05: timestamps of the original must all be kept, in order", () => {
  const original = "Tracklist\n00:00 Dawn\n05:12 Rain\n1:02:03 Night";
  const ok = "Titelliste\n00:00 Morgen\n05:12 Regen\n1:02:03 Nacht";
  const missing = "Titelliste\n00:00 Morgen\n05:12 Regen";
  const reordered = "Titelliste\n05:12 Regen\n00:00 Morgen\n1:02:03 Nacht";
  const check = (value: string) => checkLocalizedField(base({ field: "description", value, original })).find((c) => c.id === "timestamps");
  assert.equal(check(ok)?.result, "pass");
  assert.equal(check(missing)?.result, "warn");
  assert.match(check(missing)?.detail ?? "", /2 of 3/);
  assert.equal(check(reordered)?.result, "warn");
  // A description whose original has no timestamps is not timestamp-checked; a title never is.
  assert.equal(checkLocalizedField(base({ field: "description", value: "Text", original: "Plain" })).some((c) => c.id === "timestamps"), false);
  assert.equal(checkLocalizedField(base({ value: "00:00 Titel", original: "00:00 Title" })).some((c) => c.id === "timestamps"), false);
});

test("a clean translation passes every check it gets", () => {
  const checks = checkLocalizedField(base({ value: "Eine Pilz-Trockenhütte 🍄 | 3 Stunden", original: "A Mushroom-Drying Hut 🍄 | 3 Hours" }));
  assert.ok(checks.length > 0);
  assert.deepEqual(checks.filter((check) => check.result !== "pass"), []);
});
