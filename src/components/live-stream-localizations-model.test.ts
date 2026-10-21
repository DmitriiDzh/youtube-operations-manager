import assert from "node:assert/strict";
import test from "node:test";
import { checkRows, languageChoices, refusalsByRow, rowsOf, sameAsSaved, setOf, type TranslationRow } from "./live-stream-localizations-model";

// BL-207 stage 5 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 5, AC-LL-07): the card offers supported codes minus the channel baseline and
// minus the languages other rows use, and shows the same refusals as the server. Expected values by hand from the plan.

const row = (id: string, language: string, title = "T", description = "D"): TranslationRow => ({ id, language, title, description });

test("rows ↔ set: the set the rows describe, and whether it equals the saved one", () => {
  let n = 0;
  const rows = rowsOf({ de: { title: "Dt", description: "Dd" }, fr: { title: "Ft", description: "Fd" } }, () => `r${++n}`);
  assert.deepEqual(rows, [row("r1", "de", "Dt", "Dd"), row("r2", "fr", "Ft", "Fd")]);
  assert.deepEqual(setOf([...rows, row("r3", "")]), { de: { title: "Dt", description: "Dd" }, fr: { title: "Ft", description: "Fd" } });
  assert.equal(sameAsSaved([rows[1], rows[0]], { de: { title: "Dt", description: "Dd" }, fr: { title: "Ft", description: "Fd" } }), true);
  assert.equal(sameAsSaved([rows[0]], { de: { title: "Dt", description: "Dd" }, fr: { title: "Ft", description: "Fd" } }), false);
  assert.equal(sameAsSaved([row("r1", "de", "Dt", "changed")], { de: { title: "Dt", description: "Dd" } }), false);
  assert.equal(sameAsSaved([], null), true);
  assert.equal(sameAsSaved([row("r1", "")], null), false);
});

test("language choices: no baseline (en), no language another row uses, the row's own language kept", () => {
  const rows = [row("a", "de"), row("b", "fr")];
  const forA = languageChoices(rows, "a", "en").map((l) => l.code);
  assert.equal(forA.includes("en"), false);
  assert.equal(forA.includes("fr"), false);
  assert.equal(forA.includes("de"), true);
  assert.equal(forA.includes("pt-BR"), true);
  // Without a baseline nothing is removed for it.
  assert.equal(languageChoices([], "x", null).some((l) => l.code === "en"), true);
});

test("check: the server's refusals per row, a row without a language, and more than 50 languages", () => {
  const rows = [row("a", "de", ""), row("b", "fr", "T", "é".repeat(2501)), row("c", "it", "T", "   "), row("d", ""), row("e", "es", "Jazz <live>")];
  const { byRow, tooMany } = checkRows(rows, "en");
  assert.equal(tooMany, false);
  assert.deepEqual(byRow.get("a"), [{ reason: "title_empty" }]);
  assert.deepEqual(byRow.get("b"), [{ reason: "description_too_long" }]);
  assert.deepEqual(byRow.get("c"), [{ reason: "description_empty" }]);
  assert.deepEqual(byRow.get("d"), [{ reason: "language_missing" }]);
  assert.deepEqual(byRow.get("e"), [{ reason: "title_angle_brackets" }]);
  assert.equal(checkRows([row("a", "de", "T", "é".repeat(2500))], "en").byRow.size, 0);
  // 51 rows with distinct supported codes.
  const codes = languageChoices([], "x", "en").slice(0, 51).map((l, i) => row(`r${i}`, l.code));
  assert.equal(codes.length, 51);
  assert.equal(checkRows(codes, "en").tooMany, true);
});

test("server refusals land on the rows of their languages, with the hint", () => {
  const rows = [row("a", "pt-br"), row("b", "de")];
  const byRow = refusalsByRow(rows, [{ language: "pt-br", reason: "unsupported_language", message: "m", hint: "pt-BR" }]);
  assert.deepEqual(byRow.get("a"), [{ reason: "unsupported_language", hint: "pt-BR" }]);
  assert.equal(byRow.has("b"), false);
});
