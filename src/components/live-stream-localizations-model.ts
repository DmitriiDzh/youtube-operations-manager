// BL-207 stage 5 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2): the «Переводы» card's pure logic -- rows ↔ the stored set,
// which languages each row may pick, and the refusals per row. The rules are the server's own validator (the pure file
// `live-streams/localizations.ts`), so the card shows exactly what the server would refuse.
import { sameLanguage } from "@/lib/shared-language-baseline";
import { SUPPORTED_YOUTUBE_LANGUAGES } from "@/lib/youtube-supported-languages";
import type { UiTextKey } from "@/lib/ui-text";
import type { LocalizationSetValidation } from "@/lib/shared-localization-set";
import { normalizeDescription, validateLiveLocalizations, type LiveLocalizationRefusal, type LiveLocalizationSet, type LiveLocalizationsWarning } from "@/lib/live-streams/localizations";

/** The card's text for each warning the server gives (every code has one: the type requires it). `{language}`: the warning's. */
export const WARNING_KEYS: Record<LiveLocalizationsWarning["code"], UiTextKey> = {
  video_settings_not_saved: "live.translations.warning.videoSettingsNotSaved",
  video_settings_invalid: "live.translations.warning.videoSettingsInvalid",
  baseline_language_in_set: "live.translations.warning.baselineLanguageInSet",
  no_baseline: "live.translations.warning.noBaseline",
};

export type TranslationRow = { id: string; language: string; title: string; description: string };

/** A row's refusal: the server's reasons, plus `language_missing` for a row whose language is not chosen yet. */
export type RowRefusal = { reason: LiveLocalizationRefusal["reason"] | "language_missing"; hint?: string };

export function rowsOf(set: LiveLocalizationSet | null, newId: () => string): TranslationRow[] {
  return Object.entries(set ?? {}).map(([language, entry]) => ({ id: newId(), language, title: entry.title, description: entry.description }));
}

/** The set the rows describe (rows without a language are left out; they are refused on their own). */
export function setOf(rows: readonly TranslationRow[]): Record<string, { title: string; description: string }> {
  const set: Record<string, { title: string; description: string }> = {};
  for (const row of rows) if (row.language) set[row.language] = { title: row.title, description: row.description };
  return set;
}

/**
 * Whether the rows say the same as the saved set (order and the row ids do not matter). Compared as the server stores them: the
 * title trimmed, the description with CRLF made LF -- so a just-saved card is clean and takes the server's (or MCP's) updates.
 */
export function sameAsSaved(rows: readonly TranslationRow[], saved: LiveLocalizationSet | null): boolean {
  if (rows.some((row) => !row.language)) return false;
  const a = setOf(rows);
  const b = saved ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => b[key] !== undefined && b[key].title.trim() === a[key].title.trim() && normalizeDescription(b[key].description) === normalizeDescription(a[key].description)
  );
}

/**
 * The languages a row may choose: every supported YouTube code except the channel's baseline (its text is the stream's own title
 * and description) and the languages other rows already use. The row's own language stays listed.
 */
export function languageChoices(rows: readonly TranslationRow[], rowId: string, baselineLanguage: string | null): Array<{ code: string; name: string }> {
  const used = new Set(rows.filter((row) => row.id !== rowId && row.language).map((row) => row.language));
  return SUPPORTED_YOUTUBE_LANGUAGES.filter((lang) => !used.has(lang.code) && !sameLanguage(lang.code, baselineLanguage)).map((lang) => ({ code: lang.code, name: lang.name }));
}

/**
 * The refusals of each row by the server's rules (rows are keyed by id), and the problem with the set as a whole. BL-210: the channel
 * translations card passes its own validator (the channel's limits); the stream card keeps the default.
 */
export function checkRows(
  rows: readonly TranslationRow[],
  baselineLanguage: string | null,
  validate: (input: unknown, options: { baselineLanguage: string | null }) => LocalizationSetValidation = validateLiveLocalizations
): { byRow: Map<string, RowRefusal[]>; tooMany: boolean } {
  const byRow = new Map<string, RowRefusal[]>();
  for (const row of rows) if (!row.language) byRow.set(row.id, [{ reason: "language_missing" }]);
  const result = validate(setOf(rows), { baselineLanguage });
  if (result.ok) return { byRow, tooMany: false };
  if (result.problem === "too_many_languages") return { byRow, tooMany: true };
  return { byRow: mergeRefusals(byRow, rows, result.refused), tooMany: false };
}

/** The server's `details.refused` placed on the rows of their languages. */
export function refusalsByRow(rows: readonly TranslationRow[], refused: readonly LiveLocalizationRefusal[]): Map<string, RowRefusal[]> {
  return mergeRefusals(new Map(), rows, refused);
}

function mergeRefusals(byRow: Map<string, RowRefusal[]>, rows: readonly TranslationRow[], refused: readonly LiveLocalizationRefusal[]): Map<string, RowRefusal[]> {
  for (const refusal of refused) {
    const row = rows.find((r) => r.language === refusal.language);
    if (!row) continue;
    byRow.set(row.id, [...(byRow.get(row.id) ?? []), { reason: refusal.reason, ...(refusal.hint ? { hint: refusal.hint } : {}) }]);
  }
  return byRow;
}
