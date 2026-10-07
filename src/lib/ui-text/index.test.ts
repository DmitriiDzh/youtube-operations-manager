import assert from "node:assert/strict";
import test from "node:test";
import { formatMessage, formatNumber, languageFromAcceptLanguage, resolveUiLanguage, translate, uiMessageText, createTranslator } from "./index";

// BL-152 (docs/roadmap/plans/UI_LANGUAGE_PLAN.md; owner, Telegram 2026-10-08, msg 2032). Expected values come from the
// owner's decisions, RFC 9110 §12.5.4 (Accept-Language) and the CLDR plural rules, not from running the code.

test("Q4: no choice → the system language, the first supported one by the header's own preference (q-values)", () => {
  assert.equal(languageFromAcceptLanguage("ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"), "ru");
  assert.equal(languageFromAcceptLanguage("en-GB,en;q=0.9,ru;q=0.8"), "en");
  // Order by weight, not by position.
  assert.equal(languageFromAcceptLanguage("en;q=0.5, ru;q=0.9"), "ru");
  // An unsupported first choice is skipped for the next supported one.
  assert.equal(languageFromAcceptLanguage("fi-FI,fi;q=0.9,ru;q=0.5"), "ru");
  // q=0 means "not acceptable".
  assert.equal(languageFromAcceptLanguage("ru;q=0, en;q=0.1"), "en");
  assert.equal(languageFromAcceptLanguage("RU"), "ru");
});

test("Q4: a system language we do not have falls back to English", () => {
  assert.deepEqual(resolveUiLanguage({ cookie: undefined, acceptLanguage: "fi-FI,de;q=0.8" }), { language: "en", source: "system", systemLanguage: "en" });
  assert.deepEqual(resolveUiLanguage({ cookie: undefined, acceptLanguage: null }), { language: "en", source: "system", systemLanguage: "en" });
  assert.equal(languageFromAcceptLanguage("*"), null);
});

test("Q1: a chosen language wins over the system language; an unknown stored value is ignored", () => {
  assert.deepEqual(resolveUiLanguage({ cookie: "en", acceptLanguage: "ru-RU" }), { language: "en", source: "chosen", systemLanguage: "ru" });
  assert.deepEqual(resolveUiLanguage({ cookie: "ru", acceptLanguage: "en-US" }), { language: "ru", source: "chosen", systemLanguage: "en" });
  assert.deepEqual(resolveUiLanguage({ cookie: "xx", acceptLanguage: "ru" }), { language: "ru", source: "system", systemLanguage: "ru" });
});

test("parameters are filled; a missing one stays visible instead of disappearing", () => {
  assert.equal(formatMessage("en", "Error {status}", { status: 404 }), "Error 404");
  assert.equal(formatMessage("en", "From {a} to {b}", { a: "x" }), "From x to {b}");
  assert.equal(formatMessage("en", "No placeholders"), "No placeholders");
});

test("plurals follow each language's own rules (CLDR): Russian one / few / many", () => {
  const ru = "{count, plural, one {# день} few {# дня} many {# дней} other {# дня}}";
  assert.equal(formatMessage("ru", ru, { count: 1 }), "1 день");
  assert.equal(formatMessage("ru", ru, { count: 3 }), "3 дня");
  assert.equal(formatMessage("ru", ru, { count: 5 }), "5 дней");
  assert.equal(formatMessage("ru", ru, { count: 11 }), "11 дней");
  assert.equal(formatMessage("ru", ru, { count: 21 }), "21 день");
  assert.equal(formatMessage("ru", ru, { count: 22 }), "22 дня");
  const en = "{count, plural, one {# video} other {# videos}}";
  assert.equal(formatMessage("en", en, { count: 1 }), "1 video");
  assert.equal(formatMessage("en", en, { count: 0 }), "0 videos");
  assert.equal(formatMessage("en", "{count, plural, =0 {none} one {# item} other {# items}}", { count: 0 }), "none");
  // Other parameters inside a plural form are filled too.
  assert.equal(formatMessage("en", "{n, plural, one {# file in {dir}} other {# files in {dir}}}", { n: 2, dir: "a" }), "2 files in a");
});

test("numbers use the interface language's marks, never the browser's own locale", () => {
  assert.equal(formatNumber("en", 1234567.5), "1,234,567.5");
  // Russian groups with a no-break space and uses a decimal comma.
  assert.equal(formatNumber("ru", 1234567.5), "1 234 567,5");
  assert.equal(formatMessage("ru", "{n} ед.", { n: 12345 }), "12 345 ед.");
});

test("translate falls back to English for a key a locale lacks at runtime, and messages from data pass through", () => {
  assert.equal(translate("en", "nav.home"), "Home");
  assert.equal(translate("ru", "nav.home"), "Главная");
  const t = createTranslator("ru");
  assert.equal(uiMessageText(t, { key: "common.save" }), "Сохранить");
  assert.equal(uiMessageText(t, { text: "token revoked" }), "token revoked");
});
