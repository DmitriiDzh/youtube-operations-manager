import type { CSSProperties } from "react";
import type { PlanAnswers, PlanGenre, PlanMediaKind, PlanReviewField } from "@/lib/generation-plans/contracts";
import { reasonChipsFor, type ReasonChips } from "./visual-review-model";

// BL-229 part B (MUSIC_LIBRARY_PLAN.md §3, AC-MR-09/10): what the review screen shows for a wave with a genre -- its header and
// colour, two rows of chips, and the review form's questions with the answers the verdict needs. Pure, so the screen's rules
// are tested without rendering it.

/** The plan's questions and each wave's genre and questions, as the review routes return them. */
export type ReviewFormsView = { plan: PlanReviewField[]; groups: Record<string, { genre: PlanGenre | null; fields: PlanReviewField[] }> };
export const NO_REVIEW_FORMS: ReviewFormsView = { plan: [], groups: {} };

/** The forms of another computer's report (its plan's `reviewForm`, each wave's `genre` and `reviewForm`). */
export function reviewFormsOfShared(plan: { reviewForm?: { fields: PlanReviewField[] }; groups?: ReadonlyArray<{ groupId: string; genre?: PlanGenre; reviewForm?: { fields: PlanReviewField[] } }> } | undefined): ReviewFormsView {
  const groups: ReviewFormsView["groups"] = Object.create(null) as ReviewFormsView["groups"];
  for (const g of plan?.groups ?? []) if (g.genre || (g.reviewForm?.fields.length ?? 0) > 0) groups[g.groupId] = { genre: g.genre ?? null, fields: [...(g.reviewForm?.fields ?? [])] };
  return { plan: [...(plan?.reviewForm?.fields ?? [])], groups };
}

/** A colour the screen may use: only `#rrggbb` (anything else gives no tint). */
export function safeGenreColor(color: string | null | undefined): string | null {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

/** The wave's genre, or null (a wave without one, or no wave). */
export function genreOf(forms: ReviewFormsView, groupId: string | null | undefined): PlanGenre | null {
  if (!groupId || !Object.hasOwn(forms.groups, groupId)) return null;
  return forms.groups[groupId].genre ?? null;
}

/** The CSS variable the genre's tint uses (frame, verdict buttons, progress bar); none without a valid colour. */
export function genreTintStyle(genre: PlanGenre | null): CSSProperties | undefined {
  const color = safeGenreColor(genre?.color);
  return color ? ({ "--genre-color": color } as CSSProperties) : undefined;
}

/** A CSS background of `color` mixed over `base` (`transparent` = over whatever is below). */
export function tintOver(color: string, percent: number, base = "transparent"): string {
  // ui-text-ignore: a CSS value, not interface text
  return `color-mix(in srgb, ${color} ${percent}%, ${base})`;
}

export type ReasonRows = { kind: "single"; chips: ReasonChips } | { kind: "genre"; general: ReasonChips; genre: string[] };

/**
 * The chips of an attempt: for a wave with a genre, two rows -- the general ones (the plan's list, else the media kind's defaults)
 * then the genre's (the wave's list; none = no second row). Any other wave keeps `reasonChipsFor` exactly (its list replaces the
 * plan's).
 */
export function reasonRowsFor(
  media: PlanMediaKind | null | undefined,
  groupId: string | null,
  lists: { plan: readonly string[] | null; groups: Readonly<Record<string, readonly string[]>> },
  musicReasons: readonly string[],
  forms: ReviewFormsView
): ReasonRows {
  if (!genreOf(forms, groupId)) return { kind: "single", chips: reasonChipsFor(media, groupId, lists, musicReasons) };
  const general = reasonChipsFor(media, null, { plan: lists.plan, groups: {} }, musicReasons);
  const wave = groupId !== null && Object.hasOwn(lists.groups, groupId) ? [...lists.groups[groupId]] : [];
  return { kind: "genre", general, genre: wave };
}

/** The questions of an attempt: the plan's (general) first, then its wave's (the genre's). */
export function formSectionsFor(forms: ReviewFormsView, groupId: string | null): { general: PlanReviewField[]; genre: PlanReviewField[] } {
  const wave = groupId !== null && Object.hasOwn(forms.groups, groupId) ? forms.groups[groupId].fields : [];
  return { general: [...forms.plan], genre: [...wave] };
}

/** The required questions not answered yet (the verdict buttons wait for them). */
export function missingRequired(fields: readonly PlanReviewField[], answers: PlanAnswers | undefined): PlanReviewField[] {
  return fields.filter((f) => f.required === true && !Object.hasOwn(answers ?? {}, f.id));
}

/** A click on an answer button: chooses it, or -- the same one again -- takes the answer back. */
export function toggleAnswer(answers: PlanAnswers | undefined, fieldId: string, value: boolean | number | string): PlanAnswers {
  const next: PlanAnswers = { ...(answers ?? {}) };
  if (next[fieldId] === value) delete next[fieldId];
  else next[fieldId] = value;
  return next;
}

/** Only the answers to questions on screen (a question the factory removed is not sent). */
export function answersToSend(fields: readonly PlanReviewField[], answers: PlanAnswers | undefined): PlanAnswers | undefined {
  const out: PlanAnswers = {};
  for (const f of fields) if (answers && Object.hasOwn(answers, f.id)) out[f.id] = answers[f.id];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The distinct genres of a plan's waves, in wave order (the plans list's badges). */
export function planGenres(groups: ReadonlyArray<{ genre?: PlanGenre | null }> | undefined): PlanGenre[] {
  const out: PlanGenre[] = [];
  for (const g of groups ?? []) if (g.genre && !out.some((x) => x.id === g.genre!.id)) out.push(g.genre);
  return out;
}

/**
 * FO-REQ-0043 §B item 4 ("the Manager shows what is saved"): the answers an already-rated attempt opens with -- its verdict's
 * stored answers (a copy), or none for an attempt without a verdict, without answers, or a re-check (its form is not shown).
 */
export function savedAnswersOf(entry: { verdict: { answers?: PlanAnswers } | null; recheck?: unknown } | null | undefined): PlanAnswers | undefined {
  if (!entry || entry.recheck || !entry.verdict?.answers || Object.keys(entry.verdict.answers).length === 0) return undefined;
  return { ...entry.verdict.answers };
}

/** The draft an attempt opens with: its saved answers, unless the draft already holds answers of its own (a kept one). */
export function withSavedAnswers<D extends { answers?: PlanAnswers }>(draft: D, saved: PlanAnswers | undefined): D {
  if (!saved || Object.keys(draft.answers ?? {}).length > 0) return draft;
  return { ...draft, answers: { ...saved } };
}
