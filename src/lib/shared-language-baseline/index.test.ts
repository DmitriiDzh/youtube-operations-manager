import assert from "node:assert/strict";
import test from "node:test";
import { baselineValueStillHolds, currentValueIn, readAgainstBaseline, sameLanguage, type VideoLanguageView } from "./index";

// BL-178 acceptance for the shared reading of a video against its channel's language baseline (PROJECT_SPEC §14, owner
// exception 2026-10-12, msg 2665; FO-REQ-0022). Facts the expectations come from, not from the code:
// - YouTube lists the video's own default language in `localizations` too, equal to the snippet (the "mirror"; all 59 English
//   Tropico videos have `localizations.en` = the snippet);
// - with a baseline `en`, a video labelled `es` holds the original (English) in its snippet; its `localizations.es` is that
//   mirror, not a translation;
// - a row created against the mirror (baseline = the snippet text) and a row created against the aligned reading (baseline
//   "") both mean "no Spanish translation existed".

const MIRRORED_ES: VideoLanguageView = {
  defaultLanguage: "es",
  title: "Cuban Jazz Morning Coffee",
  description: "Two hours of relaxing Cuban jazz",
  localizations: {
    es: { title: "Cuban Jazz Morning Coffee", description: "Two hours of relaxing Cuban jazz" },
    "pt-BR": { title: "Jazz cubano para o cafezinho", description: "Duas horas" },
  },
};

test("sameLanguage ignores case and surrounding spaces; null never matches", () => {
  assert.equal(sameLanguage("en", "EN"), true);
  assert.equal(sameLanguage(" pt-BR", "pt-br"), true);
  assert.equal(sameLanguage("en", "es"), false);
  assert.equal(sameLanguage(null, "en"), false);
  assert.equal(sameLanguage(null, null), false);
});

test("no baseline, no own default language, or the same language: the video is read as it is", () => {
  assert.deepEqual(readAgainstBaseline(MIRRORED_ES, null), { kind: "as_is" });
  assert.deepEqual(readAgainstBaseline({ ...MIRRORED_ES, defaultLanguage: null }, "en"), { kind: "as_is" });
  assert.deepEqual(readAgainstBaseline(MIRRORED_ES, "ES"), { kind: "as_is" });
});

test("a video labelled es under baseline en is read aligned: the snippet is the en original, the es mirror is gone", () => {
  const reading = readAgainstBaseline(MIRRORED_ES, "en");
  assert.equal(reading.kind, "aligned");
  if (reading.kind !== "aligned") return;
  assert.deepEqual([reading.from, reading.to], ["es", "en"]);
  assert.deepEqual(reading.view, {
    defaultLanguage: "en",
    title: "Cuban Jazz Morning Coffee",
    description: "Two hours of relaxing Cuban jazz",
    localizations: { "pt-BR": { title: "Jazz cubano para o cafezinho", description: "Duas horas" } },
  });
  assert.equal(currentValueIn(reading.view, "es", "title"), "", "no Spanish translation exists");
  assert.equal(currentValueIn(reading.view, "en", "title"), "Cuban Jazz Morning Coffee", "the original");
  assert.equal(currentValueIn(reading.view, "pt-BR", "description"), "Duas horas");
});

test("an en mirror already present (equal to the snippet) is dropped too; one that differs is a real translation: ambiguous", () => {
  const withEnMirror = { ...MIRRORED_ES, localizations: { ...MIRRORED_ES.localizations, en: { title: MIRRORED_ES.title, description: MIRRORED_ES.description } } };
  const ok = readAgainstBaseline(withEnMirror, "en");
  assert.equal(ok.kind, "aligned");
  assert.equal(ok.kind === "aligned" && "en" in ok.view.localizations, false);

  const withRealEn = { ...MIRRORED_ES, localizations: { ...MIRRORED_ES.localizations, en: { title: "Another English title", description: "x" } } };
  assert.equal(readAgainstBaseline(withRealEn, "en").kind, "ambiguous");
});

test("an es entry that differs from the snippet cannot be told from a translation: ambiguous, never guessed", () => {
  const realEs = { ...MIRRORED_ES, localizations: { es: { title: "Jazz cubano", description: "Dos horas" } } };
  const reading = readAgainstBaseline(realEs, "en");
  assert.equal(reading.kind, "ambiguous");
  assert.match(reading.kind === "ambiguous" ? reading.reason : "", /es/);
});

test("a video labelled es with no es entry at all is aligned the same way", () => {
  const reading = readAgainstBaseline({ ...MIRRORED_ES, localizations: {} }, "en");
  assert.equal(reading.kind, "aligned");
});

test("both row shapes keep holding for the old default language; a moved snippet or a real change does not", () => {
  const reading = readAgainstBaseline(MIRRORED_ES, "en");
  // New shape: created against the aligned reading.
  assert.equal(baselineValueStillHolds(MIRRORED_ES, reading, { language: "es", field: "title", baselineValue: "" }), true);
  // Old shape (set 66cbf969): created against the mirror, i.e. the snippet text.
  assert.equal(baselineValueStillHolds(MIRRORED_ES, reading, { language: "es", field: "title", baselineValue: "Cuban Jazz Morning Coffee" }), true);
  assert.equal(baselineValueStillHolds(MIRRORED_ES, reading, { language: "es", field: "description", baselineValue: "Two hours of relaxing Cuban jazz" }), true);
  // The snippet changed since the row was made: a conflict.
  assert.equal(baselineValueStillHolds(MIRRORED_ES, reading, { language: "es", field: "title", baselineValue: "An older title" }), false);
  // Another language follows its own entry only.
  assert.equal(baselineValueStillHolds(MIRRORED_ES, reading, { language: "pt-BR", field: "title", baselineValue: "Jazz cubano para o cafezinho" }), true);
  assert.equal(baselineValueStillHolds(MIRRORED_ES, reading, { language: "pt-BR", field: "title", baselineValue: "Cuban Jazz Morning Coffee" }), false);
});

test("read as it is, a row holds only against the plain current value (the snippet for the default language)", () => {
  const plain: VideoLanguageView = { defaultLanguage: "en", title: "T", description: "D", localizations: { es: { title: "E", description: "" } } };
  const reading = readAgainstBaseline(plain, "en");
  assert.equal(baselineValueStillHolds(plain, reading, { language: "en", field: "title", baselineValue: "T" }), true);
  assert.equal(baselineValueStillHolds(plain, reading, { language: "es", field: "title", baselineValue: "E" }), true);
  assert.equal(baselineValueStillHolds(plain, reading, { language: "es", field: "title", baselineValue: "" }), false);
});
