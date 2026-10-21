import { sameLanguage } from "@/lib/shared-language-baseline";
import { isSupportedYoutubeLanguageCode, suggestYoutubeLanguageCode } from "@/lib/youtube-supported-languages";
import { hasAngleBrackets } from "@/lib/youtube-video-fields";

// ---------------------------------------------------------------------------
// The validator of a stored per-language title/description set -- one rule for every writer that keeps such a set locally before
// sending it to YouTube: a live stream's translations (BL-207, `live-streams/localizations.ts`, ADR 0045) and a channel's own
// translations (BL-210, `channel-localizations`, ADR 0047). Moved from `live-streams/localizations.ts` (which keeps
// `validateLiveLocalizations` as a thin wrapper with the video limits, behaviour unchanged) so the second feature module does not
// reach into the first (AGENTS.md §M). The limits differ per resource, so they are passed in. Pure, no server code: the Web UI
// imports it too.
// ---------------------------------------------------------------------------

export type LocalizationEntry = { title: string; description: string };
/** Language code (an exact supported YouTube code) → its title and description. */
export type LocalizationSet = Record<string, LocalizationEntry>;

export type LocalizationSetLimits = {
  titleMaxCharacters: number;
  /** The description bound and how it is counted: UTF-8 bytes (a video's description) or characters (a channel's). */
  description: { max: number; unit: "bytes" | "characters" };
  maxLanguages: number;
};

export type LocalizationRefusalReason =
  | "not_an_entry"
  | "unsupported_language"
  | "baseline_language"
  | "title_empty"
  | "title_too_long"
  | "title_angle_brackets"
  | "description_empty"
  | "description_too_long"
  | "description_angle_brackets";

export type LocalizationRefusal = { language: string; reason: LocalizationRefusalReason; message: string; hint?: string };

export type LocalizationSetValidation =
  | { ok: true; set: LocalizationSet }
  /** `problem`: why the set as a whole is refused; `refused`: every refused language with its reason. Nothing is stored. */
  | { ok: false; problem: "not_an_object" | "too_many_languages" | "invalid_languages"; message: string; refused: LocalizationRefusal[] };

export type LocalizationSetOptions = {
  /** The channel's baseline title/description language (null = none set): never a translation. */
  baselineLanguage: string | null;
  limits: LocalizationSetLimits;
  /** What the baseline language's text is, for its refusal message (e.g. "the stream's own title and description"). */
  ownText: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A description as stored: CRLF line breaks become LF (a pasted Windows text; YouTube keeps LF). */
export function normalizeDescription(description: string): string {
  return description.replace(/\r\n/g, "\n");
}

/** A description's length in the limit's own unit (as stored: CRLF made LF). */
export function descriptionLength(description: string, unit: LocalizationSetLimits["description"]["unit"]): number {
  const normalized = normalizeDescription(description);
  return unit === "bytes" ? new TextEncoder().encode(normalized).length : [...normalized].length;
}

function entryRefusals(language: string, value: unknown, options: LocalizationSetOptions): LocalizationRefusal[] {
  const { limits } = options;
  const refusals: LocalizationRefusal[] = [];
  if (!isSupportedYoutubeLanguageCode(language)) {
    const hint = suggestYoutubeLanguageCode(language);
    refusals.push({
      language,
      reason: "unsupported_language",
      message: hint ? `"${language}" is not a YouTube language code -- did you mean "${hint}"?` : `"${language}" is not a language YouTube supports`,
      ...(hint ? { hint } : {}),
    });
  } else if (sameLanguage(language, options.baselineLanguage)) {
    refusals.push({ language, reason: "baseline_language", message: `"${language}" is the channel's base language: its text is ${options.ownText}` });
  }

  const keys = isPlainObject(value) ? Object.keys(value).sort().join(",") : null;
  if (!isPlainObject(value) || keys !== "description,title" || typeof value.title !== "string" || typeof value.description !== "string") {
    refusals.push({ language, reason: "not_an_entry", message: "Each language needs exactly a title and a description (text)" });
    return refusals;
  }

  const title = value.title.trim();
  const titleLength = [...title].length;
  if (titleLength === 0) refusals.push({ language, reason: "title_empty", message: "The title is empty" });
  else if (titleLength > limits.titleMaxCharacters) refusals.push({ language, reason: "title_too_long", message: `The title has ${titleLength} characters; YouTube allows ${limits.titleMaxCharacters}` });
  if (hasAngleBrackets(value.title)) refusals.push({ language, reason: "title_angle_brackets", message: "The title may not contain < or >" });

  // Owner, Telegram msg 3287: a translation needs its description too (empty after trimming is refused). Counted as stored: with
  // CRLF line breaks made LF.
  const description = normalizeDescription(value.description);
  const length = descriptionLength(description, limits.description.unit);
  if (description.trim().length === 0) refusals.push({ language, reason: "description_empty", message: "The description is empty" });
  else if (length > limits.description.max) {
    refusals.push({ language, reason: "description_too_long", message: `The description has ${length} ${limits.description.unit}; YouTube allows ${limits.description.max}` });
  }
  if (hasAngleBrackets(value.description)) refusals.push({ language, reason: "description_angle_brackets", message: "The description may not contain < or >" });
  return refusals;
}

/**
 * The whole set, or every reason it is refused (one bad language refuses it all: nothing is half-saved). The title is kept trimmed
 * (as YouTube stores it); the description as given, with CRLF line breaks made LF.
 */
export function validateLocalizationSet(input: unknown, options: LocalizationSetOptions): LocalizationSetValidation {
  if (!isPlainObject(input)) {
    return { ok: false, problem: "not_an_object", message: "The translations must be an object: language code → { title, description }", refused: [] };
  }
  const languages = Object.keys(input);
  if (languages.length > options.limits.maxLanguages) {
    return { ok: false, problem: "too_many_languages", message: `${languages.length} languages; at most ${options.limits.maxLanguages}`, refused: [] };
  }
  const refused = languages.flatMap((language) => entryRefusals(language, input[language], options));
  if (refused.length > 0) {
    return { ok: false, problem: "invalid_languages", message: `Refused: ${refused.map((r) => `${r.language} (${r.message})`).join("; ")}`, refused };
  }
  const set: LocalizationSet = {};
  for (const language of languages) {
    const value = input[language] as LocalizationEntry;
    set[language] = { title: value.title.trim(), description: normalizeDescription(value.description) };
  }
  return { ok: true, set };
}
