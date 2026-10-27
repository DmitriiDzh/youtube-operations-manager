import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanReviewField } from "@/lib/generation-plans/contracts";
import type { UiLanguage } from "@/lib/ui-text";
import { answersToSend, formSectionsFor, genreOf, genreTintStyle, missingRequired, planGenres, reasonRowsFor, reviewFormsOfShared, safeGenreColor, toggleAnswer, type ReviewFormsView } from "./genre-review-model";
import { GenreHeader, REVIEW_REASONS, ReviewFormSection } from "./plan-review-screen";
import { UiTextProvider } from "./ui-text-provider";
import { reasonChipsFor } from "./visual-review-model";

// BL-229 part B, AC-MR-09/10 (MUSIC_LIBRARY_PLAN.md §4.2): the review screen's rules for a wave with a genre, worked out by hand.

const GENRE = { id: "rural-japan-control", title: "Sounds of Rural Japan", color: "#4F9D69", icon: "🌾" };
const GENERAL: PlanReviewField[] = [
  { id: "g.no_vocals", type: "yes_no", question: "Нет вокала и голосов?", required: true },
  { id: "g.background", type: "scale_1_10", question: "Годится как спокойный фон" },
];
const GENRE_FIELDS: PlanReviewField[] = [
  { id: "rj.instruments", type: "yes_no", question: "Слышно японские инструменты?", required: true },
  { id: "rj.tempo", type: "choice", question: "Темп", options: ["slower", "right", "faster"] },
];
const FORMS: ReviewFormsView = { plan: GENERAL, groups: { "014": { genre: GENRE, fields: GENRE_FIELDS } } };
const LISTS = { plan: ["голос / вокал", "щелчок / провал"], groups: { "014": ["барабаны / бит"], "016": ["свой список"] } };

test("AC-MR-09: a genre wave shows two rows -- general (the plan's) then the genre's; any other wave is exactly reasonChipsFor", () => {
  assert.deepEqual(reasonRowsFor("audio", "014", LISTS, REVIEW_REASONS, FORMS), { kind: "genre", general: { source: "custom", values: ["голос / вокал", "щелчок / провал"] }, genre: ["барабаны / бит"] });
  // Wave 015 (no genre, no list of its own): one row, the plan's list -- the same as before BL-229.
  assert.deepEqual(reasonRowsFor("audio", "015", LISTS, REVIEW_REASONS, FORMS), { kind: "single", chips: { source: "custom", values: ["голос / вокал", "щелчок / провал"] } });
  assert.deepEqual(reasonRowsFor("audio", "015", LISTS, REVIEW_REASONS, FORMS), { kind: "single", chips: reasonChipsFor("audio", "015", LISTS, REVIEW_REASONS) });
  // Wave 016 has its own list and no genre: it still REPLACES the plan's list (today's rule).
  assert.deepEqual(reasonRowsFor("audio", "016", LISTS, REVIEW_REASONS, FORMS), { kind: "single", chips: { source: "custom", values: ["свой список"] } });
  // A genre wave on a plan without chips: the general row is the media kind's defaults (music's ten); no wave list = no genre row.
  const bare = reasonRowsFor("audio", "014", { plan: null, groups: {} }, REVIEW_REASONS, FORMS);
  assert.deepEqual(bare, { kind: "genre", general: { source: "audio", values: REVIEW_REASONS }, genre: [] });
  const image = reasonRowsFor("image", "014", { plan: null, groups: {} }, REVIEW_REASONS, FORMS);
  assert.equal(image.kind === "genre" ? image.general.source : null, "image");
});

test("AC-MR-10: the questions are the plan's then the wave's; Accept/Reject wait for every required one; a click again takes the answer back", () => {
  const sections = formSectionsFor(FORMS, "014");
  assert.deepEqual([sections.general.map((f) => f.id), sections.genre.map((f) => f.id)], [["g.no_vocals", "g.background"], ["rj.instruments", "rj.tempo"]]);
  assert.deepEqual(formSectionsFor(FORMS, "015"), { general: GENERAL, genre: [] });
  const all = [...sections.general, ...sections.genre];
  assert.deepEqual(missingRequired(all, undefined).map((f) => f.id), ["g.no_vocals", "rj.instruments"]);
  let answers = toggleAnswer(undefined, "g.no_vocals", true);
  assert.deepEqual(missingRequired(all, answers).map((f) => f.id), ["rj.instruments"]);
  answers = toggleAnswer(answers, "rj.instruments", false);
  assert.deepEqual(missingRequired(all, answers), [], "false answers a yes/no question too");
  answers = toggleAnswer(answers, "g.background", 7);
  answers = toggleAnswer(answers, "g.background", 7);
  assert.equal(Object.hasOwn(answers, "g.background"), false, "the same value again clears it");
  answers = toggleAnswer(answers, "rj.tempo", "right");
  // Only questions on screen are sent, in the form's order.
  assert.deepEqual(answersToSend(all, { ...answers, "old.removed": true }), { "g.no_vocals": true, "rj.instruments": false, "rj.tempo": "right" });
  assert.equal(answersToSend(all, {}), undefined);
});

test("AC-MR-10: the genre and its colour -- only #rrggbb tints, as a CSS variable; another computer's report gives the same forms", () => {
  assert.deepEqual(genreOf(FORMS, "014"), GENRE);
  assert.equal(genreOf(FORMS, "015"), null);
  assert.equal(genreOf(FORMS, null), null);
  assert.equal(safeGenreColor("#4F9D69"), "#4f9d69");
  for (const bad of ["green", "#4f9d6", "#4f9d69;background:red", "url(x)", null]) assert.equal(safeGenreColor(bad), null, String(bad));
  assert.deepEqual(genreTintStyle(GENRE), { "--genre-color": "#4f9d69" });
  assert.equal(genreTintStyle({ ...GENRE, color: "red" }), undefined);
  assert.equal(genreTintStyle(null), undefined);
  const shared = reviewFormsOfShared({ reviewForm: { fields: GENERAL }, groups: [{ groupId: "014", genre: GENRE, reviewForm: { fields: GENRE_FIELDS } }, { groupId: "015" }] });
  assert.deepEqual([shared.plan, { ...shared.groups }], [GENERAL, { "014": { genre: GENRE, fields: GENRE_FIELDS } }]);
  assert.deepEqual(planGenres([{ genre: GENRE }, {}, { genre: GENRE }, { genre: { ...GENRE, id: "zen", title: "Zen", icon: "🪷" } }]).map((g) => g.title), ["Sounds of Rural Japan", "Zen"]);
});

function html(node: ReactNode, language: UiLanguage = "ru"): string {
  const providerProps = { language, source: "chosen" as const, systemLanguage: language, children: node };
  return renderToStaticMarkup(createElement(UiTextProvider, providerProps));
}

test("AC-MR-10: the header reads «🌾 Sounds of Rural Japan»; a scale is 10 buttons 1-10, yes/no two, a choice one per option; required is marked", () => {
  const header = html(createElement(GenreHeader, { genre: GENRE }));
  assert.match(header, /🌾<\/span>/);
  assert.match(header, /Sounds of Rural Japan/);
  assert.match(header, /жанр этой партии/);
  const form = html(createElement(ReviewFormSection, { title: "Общие вопросы", fields: [...GENERAL, ...GENRE_FIELDS], answers: { "g.background": 7 }, onAnswer: () => undefined }));
  const buttons = [...form.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[2], m[1]]);
  assert.deepEqual(
    buttons.map(([label]) => label),
    ["Да", "Нет", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "Да", "Нет", "slower", "right", "faster"]
  );
  assert.deepEqual(buttons.filter(([, on]) => on === "true").map(([label]) => label), ["7"]);
  assert.equal((form.match(/aria-label="Обязательный вопрос"/g) ?? []).length, 2);
});
