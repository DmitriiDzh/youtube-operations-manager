import { planAnswerRefused, type PlanAnswers, type PlanGenre, type PlanReviewField, type PlanReviewForm } from "./contracts";

// BL-229 part B (MUSIC_LIBRARY_PLAN.md §3, ADR 0054 amendment 1): the review forms of a plan and its waves, and the owner's
// answers checked against them. Pure: used on this computer's plans and on another computer's report alike (both carry the
// plan's `reviewForm` and each wave's `reviewForm` in the same shape).

type FormsOf = { reviewForm?: PlanReviewForm | null; groups: ReadonlyArray<{ groupId: string; reviewForm?: PlanReviewForm | null; genre?: PlanGenre | null }> };

/** A field as stored: only its known keys (anything the factory added is already stripped by the schema). */
export function normalizeField(field: PlanReviewField): PlanReviewField {
  return {
    id: field.id,
    type: field.type,
    question: field.question,
    ...(field.type === "choice" && field.options ? { options: [...field.options] } : {}),
    ...(field.required !== undefined ? { required: field.required } : {}),
  };
}

/** A form as stored; an empty form is no form (null). */
export function normalizeForm(form: PlanReviewForm | null | undefined): PlanReviewForm | null {
  if (!form || form.fields.length === 0) return null;
  return { fields: form.fields.map(normalizeField) };
}

export function normalizeGenre(genre: PlanGenre | null | undefined): PlanGenre | null {
  return genre ? { id: genre.id, title: genre.title, color: genre.color, icon: genre.icon } : null;
}

/** The questions of an attempt of `groupId`: the plan's first, then its wave's. */
export function effectiveFields(plan: FormsOf, groupId: string | null): PlanReviewField[] {
  const wave = groupId === null ? undefined : plan.groups.find((g) => g.groupId === groupId);
  return [...(plan.reviewForm?.fields ?? []), ...(wave?.reviewForm?.fields ?? [])];
}

/** Field ids used twice across the plan's form plus one wave's form (each wave is checked on its own). */
export function duplicateFieldIds(plan: FormsOf): Array<{ groupId: string | null; fieldId: string }> {
  const out: Array<{ groupId: string | null; fieldId: string }> = [];
  const planIds = (plan.reviewForm?.fields ?? []).map((f) => f.id);
  for (const id of planIds.filter((x, i) => planIds.indexOf(x) !== i)) out.push({ groupId: null, fieldId: id });
  for (const g of plan.groups) {
    const ids = (g.reviewForm?.fields ?? []).map((f) => f.id);
    for (const id of ids) if (planIds.includes(id)) out.push({ groupId: g.groupId, fieldId: id });
    for (const id of ids.filter((x, i) => ids.indexOf(x) !== i)) out.push({ groupId: g.groupId, fieldId: id });
  }
  return out;
}

/** Why one answer does not fit its field, or null when it does. */
function problemOf(field: PlanReviewField, value: unknown): "plan_answer_wrong_type" | "plan_answer_out_of_range" | "plan_answer_unknown_option" | null {
  if (field.type === "yes_no") return typeof value === "boolean" ? null : "plan_answer_wrong_type";
  if (field.type === "scale_1_10") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "plan_answer_wrong_type";
    return Number.isInteger(value) && value >= 1 && value <= 10 ? null : "plan_answer_out_of_range";
  }
  if (typeof value !== "string") return "plan_answer_wrong_type";
  return (field.options ?? []).includes(value) ? null : "plan_answer_unknown_option";
}

const EXPECTED: Record<PlanReviewField["type"], string> = { yes_no: "true or false", scale_1_10: "a whole number 1-10", choice: "one of the options" };

/**
 * The owner's answers checked against the attempt's questions: every id must be one of them with a value of its type, and every
 * required question answered (for an accept AND a reject). Returns the answers to store (in the form's order), or undefined
 * when there are none; refuses with the first problem's own code.
 */
export function checkAnswers(fields: readonly PlanReviewField[], given: Record<string, unknown> | undefined): PlanAnswers | undefined {
  const answers = given ?? {};
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [fieldId, value] of Object.entries(answers)) {
    const field = byId.get(fieldId);
    if (!field) throw planAnswerRefused("plan_answer_unknown_field", `${fieldId} is not a question of this attempt's review form`, { fieldId });
    const problem = problemOf(field, value);
    if (problem) {
      throw planAnswerRefused(problem, `${fieldId} takes ${EXPECTED[field.type]}`, { fieldId, type: field.type, ...(field.type === "choice" ? { options: field.options ?? [] } : {}) });
    }
  }
  const missing = fields.filter((f) => f.required === true && !Object.hasOwn(answers, f.id)).map((f) => f.id);
  if (missing.length > 0) throw planAnswerRefused("plan_answer_required", `Answer the required question${missing.length > 1 ? "s" : ""} ${missing.join(", ")} first`, { fieldId: missing[0], missing });
  return orderedAnswers(fields, answers);
}

/**
 * A verdict from the other computer, applied here: answers whose question no longer exists here (or whose value no longer fits
 * it) are dropped -- the verdict itself is never lost to a later change of the form.
 */
export function keepFittingAnswers(fields: readonly PlanReviewField[], given: PlanAnswers | undefined): PlanAnswers | undefined {
  if (!given) return undefined;
  const fitting = Object.fromEntries(Object.entries(given).filter(([id, value]) => {
    const field = fields.find((f) => f.id === id);
    return field !== undefined && problemOf(field, value) === null;
  }));
  return orderedAnswers(fields, fitting);
}

function orderedAnswers(fields: readonly PlanReviewField[], answers: Record<string, unknown>): PlanAnswers | undefined {
  const out: PlanAnswers = {};
  for (const f of fields) if (Object.hasOwn(answers, f.id)) out[f.id] = answers[f.id] as boolean | number | string;
  return Object.keys(out).length > 0 ? out : undefined;
}
