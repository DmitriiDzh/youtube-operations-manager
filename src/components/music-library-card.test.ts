import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MusicBatchRow, MusicLibraryView } from "@/lib/music-library/contracts";
import type { UiLanguage } from "@/lib/ui-text";
import { MusicBatchTable, MusicLibraryAge, MusicLibraryBody, type MusicLibraryLoad } from "./music-library-card";
import { UiTextProvider } from "./ui-text-provider";

// BL-229 part A (MUSIC_LIBRARY_PLAN.md §4): what the owner reads on the card, in Russian, with the texts the plan names --
// AC-ML-01 hours, AC-ML-02 «заготовка», AC-ML-03 «Без жанра: 2 трека», AC-ML-04 24/30 (80 %) and «—», AC-ML-06 the empty states.

function html(node: ReactNode, language: UiLanguage = "ru"): string {
  const providerProps = { language, source: "chosen" as const, systemLanguage: language, children: node };
  return renderToStaticMarkup(createElement(UiTextProvider, providerProps));
}
const body = (load: MusicLibraryLoad, language?: UiLanguage) => html(createElement(MusicLibraryBody, { load }), language);

const batch = (overrides: Partial<MusicBatchRow>): MusicBatchRow => ({ batch: "001", playlist: null, briefVersion: null, tracks: 30, date: null, source: null, reviewed: null, accepted: null, acceptancePercent: null, ...overrides });

function view(overrides: Partial<MusicLibraryView> = {}): MusicLibraryView {
  return {
    generatedAt: "2026-10-27T10:00:00.000Z",
    ageMinutes: 120,
    stale: false,
    genres: [
      { id: "rural-japan-control", title: "Sounds of Rural Japan", label: "Control", color: "#4f9d69", playlist: "PLW3cmFOp7WbA", status: "active", batches: 13, tracks: 390, hours: 19.5, neverUsedHours: 10, daysLeft: 41, batchRows: [] },
      { id: "sleep-rain", title: "Sleep Rain", label: "Rain", color: null, playlist: null, status: "stub", batches: 1, tracks: 30, hours: 1.5, neverUsedHours: 1.5, daysLeft: null, batchRows: [] },
    ],
    withoutGenre: null,
    ...overrides,
  };
}

test("AC-ML-01/02: a genre row shows its figures with one decimal; a stub shows «заготовка»; no forecast shows «—»", () => {
  const out = body({ state: "done", result: { status: "ok", view: view() } });
  assert.match(out, /Sounds of Rural Japan/);
  assert.match(out, /PLW3cmFOp7WbA/);
  assert.match(out, /19,5 ч/);
  assert.match(out, /10,0 ч/);
  assert.match(out, /41 день/);
  assert.match(out, /активный/);
  assert.match(out, /заготовка/);
  assert.match(out, /Rain/);
  assert.doesNotMatch(out, /Без жанра/);
  const en = body({ state: "done", result: { status: "ok", view: view() } }, "en");
  assert.match(en, /19\.5 h/);
  assert.match(en, /10\.0 h/);
  assert.match(en, /41 days/);
});

test("AC-ML-03: 2 tracks without a genre show the highlighted «Без жанра: 2 трека» row", () => {
  const out = body({ state: "done", result: { status: "ok", view: view({ withoutGenre: { tracks: 2, batchRows: [batch({ batch: "015", tracks: 2 })] } }) } });
  assert.match(out, /Без жанра: 2 трека/);
  assert.match(out, /015/);
});

test("AC-ML-04: 24 of 30 reviewed reads 24/30 (80 %); none reviewed reads «—», never 0 %", () => {
  const out = html(createElement(MusicBatchTable, { rows: [batch({ batch: "001", reviewed: 30, accepted: 24, acceptancePercent: 80 }), batch({ batch: "002", reviewed: 0, accepted: 0, acceptancePercent: null })] }));
  assert.match(out, /24\/30 \(80 %\)/);
  assert.doesNotMatch(out, /\(0 %\)/);
  // Row 001: playlist, brief, date, source unknown (4 dashes); row 002: the same 4 plus its acceptance (5) = 9.
  assert.equal((out.match(/—/g) ?? []).length, 9);
  assert.doesNotMatch(out, /\/0/);
});

test("AC-ML-06: each empty state has its own text and shows no rows", () => {
  const cases: Array<[MusicLibraryLoad, RegExp]> = [
    [{ state: "done", result: { status: "no_workspace" } }, /Папка канала не задана на этом компьютере/],
    [{ state: "done", result: { status: "no_file" } }, /Фабрика ещё не прислала сводку/],
    [{ state: "done", result: { status: "unreadable", reason: "genres: Invalid input" } }, /Сводку не прочитать: genres: Invalid input/],
    [{ state: "done", result: { status: "workspace_unavailable", reason: "path does not exist" } }, /Папку канала не открыть на этом компьютере: path does not exist/],
  ];
  for (const [load, text] of cases) {
    const out = body(load);
    assert.match(out, text);
    assert.doesNotMatch(out, /<table/);
  }
});

test("AC-ML-05: the stale mark shows only when the view is stale; the age reads in minutes, hours or days", () => {
  const stale = html(createElement(MusicLibraryAge, { view: { generatedAt: "x", ageMinutes: 25 * 60, stale: true } }));
  assert.match(stale, /Сводка 25 часов назад/);
  assert.match(stale, /Устарела: старше 24 часов/);
  const fresh = html(createElement(MusicLibraryAge, { view: { generatedAt: "x", ageMinutes: 23 * 60, stale: false } }));
  assert.match(fresh, /Сводка 23 часа назад/);
  assert.doesNotMatch(fresh, /Устарела/);
  assert.match(html(createElement(MusicLibraryAge, { view: { generatedAt: "x", ageMinutes: 5, stale: false } })), /Сводка 5 минут назад/);
  assert.match(html(createElement(MusicLibraryAge, { view: { generatedAt: "x", ageMinutes: 3 * 24 * 60, stale: true } })), /Сводка 3 дня назад/);
});
