import assert from "node:assert/strict";
import test from "node:test";
import { DICTIONARIES, UI_LANGUAGES } from "./index";
import { en, enAreas } from "./locales/en";
import { ruAreas } from "./locales/ru";

// BL-152 (owner, Telegram 2026-10-07, msg 2027): every interface text exists in every language. The compiler already
// rejects a missing or extra key in a locale file; these checks cover what types cannot see.

const placeholders = (message: string) =>
  [...message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|\})/g)].map((m) => m[1]).sort();

test("every language has every key, and no translation is empty", () => {
  const keys = Object.keys(en).sort();
  for (const { code } of UI_LANGUAGES) {
    const dictionary = DICTIONARIES[code];
    assert.deepEqual(Object.keys(dictionary).sort(), keys, code);
    for (const [key, value] of Object.entries(dictionary)) assert.ok(value.trim().length > 0, `${code}: ${key} is empty`);
  }
});

test("a translation uses exactly the parameters of the English text", () => {
  for (const { code } of UI_LANGUAGES) {
    for (const [key, source] of Object.entries(en)) {
      assert.deepEqual([...new Set(placeholders(DICTIONARIES[code][key as keyof typeof en]))], [...new Set(placeholders(source))], `${code}: ${key}`);
    }
  }
});

test("each area's keys are unique across areas (a duplicate would silently overwrite another area's text)", () => {
  const seen = new Map<string, string>();
  for (const [area, entries] of Object.entries(enAreas)) {
    for (const key of Object.keys(entries)) {
      assert.equal(seen.get(key), undefined, `${key} is in both ${seen.get(key)} and ${area}`);
      seen.set(key, area);
    }
  }
  assert.deepEqual(Object.keys(ruAreas).sort(), Object.keys(enAreas).sort());
});

test("plural forms are well-formed and always include `other`", () => {
  for (const { code } of UI_LANGUAGES) {
    for (const [key, message] of Object.entries(DICTIONARIES[code])) {
      if (!/,\s*plural\s*,/.test(message)) continue;
      assert.match(message, /\bother\s*\{/, `${code}: ${key}`);
      let depth = 0;
      for (const ch of message) {
        depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
        assert.ok(depth >= 0, `${code}: ${key} has an unbalanced brace`);
      }
      assert.equal(depth, 0, `${code}: ${key} has an unbalanced brace`);
    }
  }
});
