import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanAnswers, PlanReviewField } from "@/lib/generation-plans/contracts";
import type { UiLanguage } from "@/lib/ui-text";
import { answersToSend, formSectionsFor, genreOf, genreTintStyle, missingRequired, planGenres, reasonRowsFor, reviewFormsOfShared, safeGenreColor, savedAnswersOf, toggleAnswer, withSavedAnswers, type ReviewFormsView } from "./genre-review-model";
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

test("FO-REQ-0043 §B item 4: a rated attempt opens with its saved answers; editing them changes what a replacing verdict sends", () => {
  const saved = { "g.no_vocals": true, "rj.instruments": false, "rj.tempo": "right" };
  const rated = { verdict: { answers: saved } };
  const fresh: { reasons: string[]; rating: number | null; answers?: PlanAnswers } = { reasons: [], rating: null };
  const opened = withSavedAnswers(fresh, savedAnswersOf(rated));
  assert.deepEqual(opened, { reasons: [], rating: null, answers: { "g.no_vocals": true, "rj.instruments": false, "rj.tempo": "right" } });
  assert.notEqual(opened.answers, saved, "a copy: editing never changes the stored verdict on screen");
  // Only the form is prefilled: the rating and chips start fresh as before.
  assert.equal(opened.rating, null);
  assert.deepEqual(opened.reasons, []);
  // The owner changes the tempo; a replacing verdict sends the edited answers.
  const edited = toggleAnswer(opened.answers, "rj.tempo", "faster");
  const all = [...GENERAL, ...GENRE_FIELDS];
  assert.deepEqual(answersToSend(all, edited), { "g.no_vocals": true, "rj.instruments": false, "rj.tempo": "faster" });
  // A draft that already holds answers (kept while moving between attempts) keeps them.
  assert.deepEqual(withSavedAnswers({ answers: { "g.no_vocals": false } }, savedAnswersOf(rated)), { answers: { "g.no_vocals": false } });
  // Nothing to prefill: no verdict, a verdict without answers, a re-check.
  assert.equal(savedAnswersOf({ verdict: null }), undefined);
  assert.equal(savedAnswersOf({ verdict: {} }), undefined);
  assert.equal(savedAnswersOf({ verdict: { answers: {} } }), undefined);
  assert.equal(savedAnswersOf({ ...rated, recheck: { recheckId: "q1" } }), undefined);
  assert.equal(savedAnswersOf(null), undefined);
});

// -- independent review of BL-229 ---------------------------------------------------------------------------------------------

test("review 1: a verdict sent from here to another computer's plan keeps its answers in the 'sent, waiting' verdict (track and re-check)", async () => {
  const { peerQueue, peerRecheckEntries } = await import("./plan-review-screen");
  const answers = { "g.no_vocals": true, "rj.tempo": "right" };
  const entry = { itemKey: "014/V01", groupId: "014", attemptRef: "job:1", jobId: null, seed: null, params: {}, stages: [], verdict: null, playable: true };
  const recheck = { recheckId: "q1", itemKey: "014/V01", attemptRef: "job:1", kind: "question", title: "голос?", note: "is there a voice", auditionFile: null, markers: [], checks: [], metrics: {}, previousVerdict: null, openedAt: "2026-10-27T12:00:00.000Z", extraStage: null };
  const data = {
    devices: [{ deviceId: "mac-1", hostname: "MAC", plans: [{ planId: "music-014", review: [entry], items: [{ itemKey: "014/V01", groupId: "014" }], rechecks: [recheck] }] }],
    outgoing: [
      { planId: "music-014", ownerDeviceId: "mac-1", itemKey: "014/V01", attemptRef: "job:1", result: "accepted", rating: null, at: "2026-10-27T12:10:00.000Z", answers },
      { planId: "music-014", ownerDeviceId: "mac-1", itemKey: "014/V01", attemptRef: "job:1", result: "accepted", rating: null, at: "2026-10-27T12:11:00.000Z", recheckId: "q1", answers },
    ],
  } as unknown as Parameters<typeof peerQueue>[0];
  const source = { deviceId: "mac-1", hostname: "MAC" };
  const [track] = peerQueue(data, source, "music-014");
  assert.deepEqual([track.verdict?.note, track.verdict?.answers], ["sent, waiting for MAC", { "g.no_vocals": true, "rj.tempo": "right" }]);
  assert.deepEqual(savedAnswersOf(track), { "g.no_vocals": true, "rj.tempo": "right" }, "the form opens with them");
  const [sent] = peerRecheckEntries(data, source, "music-014");
  assert.deepEqual(sent.verdict?.answers, { "g.no_vocals": true, "rj.tempo": "right" });
  // Without answers there is no answers key (unchanged for every other plan).
  const plain = { ...data, outgoing: [{ ...data.outgoing[0], answers: undefined }] } as unknown as Parameters<typeof peerQueue>[0];
  assert.equal("answers" in (peerQueue(plain, source, "music-014")[0].verdict ?? {}), false);
});

test("review 2: every draft reset on a rated attempt restores its saved answers; a kept draft with its own answers wins", async () => {
  const { draftOpenedFor, keepDraft } = await import("./plan-review-screen");
  const rated = { itemKey: "014/V01", attemptRef: "job:1", verdict: { at: "2026-10-27T12:00:00.000Z", answers: { "g.no_vocals": true } } };
  const kept = new Map();
  // A fresh draft (filter or wave change, the same index again): the saved answers, nothing else.
  assert.deepEqual(draftOpenedFor(kept, rated), { reasons: [], rating: null, note: "", marks: [], openMark: null, pending: null, answers: { "g.no_vocals": true } });
  // A kept draft written against this verdict with its own answers keeps them; one without answers gets the saved ones.
  const own = { reasons: ["x"], rating: 4, note: "", marks: [], openMark: null, pending: null, answers: { "g.no_vocals": false } };
  keepDraft(kept, rated, own);
  assert.deepEqual(draftOpenedFor(kept, rated), own);
  const noAnswers = { ...own, answers: undefined };
  keepDraft(kept, rated, noAnswers);
  assert.deepEqual(draftOpenedFor(kept, rated), { ...own, answers: { "g.no_vocals": true } });
  // An attempt without a verdict, and no attempt: a fresh empty draft.
  assert.deepEqual(draftOpenedFor(new Map(), { itemKey: "014/V02", attemptRef: "job:2", verdict: null }).answers, undefined);
  assert.deepEqual(draftOpenedFor(new Map(), undefined).answers, undefined);
});

test("review 6: each answer refusal code has its own text in English and Russian", async () => {
  const { PLAN_ANSWER_ERROR_CODES } = await import("@/lib/generation-plans/contracts");
  const { DICTIONARIES } = await import("@/lib/ui-text");
  for (const code of PLAN_ANSWER_ERROR_CODES) {
    for (const language of ["en", "ru"] as const) {
      const text = (DICTIONARIES[language] as Record<string, string>)[`errors.${code}`];
      assert.equal(typeof text === "string" && text.length > 0, true, `${language} errors.${code}`);
    }
  }
  assert.equal(PLAN_ANSWER_ERROR_CODES.length, 5);
});
