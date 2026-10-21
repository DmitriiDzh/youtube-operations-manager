import { sameLanguage } from "@/lib/shared-language-baseline";
import { isSupportedYoutubeLanguageCode, suggestYoutubeLanguageCode } from "@/lib/youtube-supported-languages";
import { DESCRIPTION_MAX_BYTES, hasAngleBrackets, TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import { DomainError } from "./contracts";
import type { LiveStreamsDependencies } from "./services";

// ---------------------------------------------------------------------------
// BL-207 stage 2 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2, ADR 0045): the stream's translations of its title and
// description -- one set per stream, given to every broadcast and segment after Start. Stored on this computer
// (`live_streams.localizations_json`, schema v101, device-local like the row). Local only: nothing here writes to YouTube; the
// write is the `localizations` step of `video-apply.ts`. The validator is pure (no server code) so the MCP tool, the route, the
// store and the page apply the same rules.
// ---------------------------------------------------------------------------

export type LiveLocalization = { title: string; description: string };
/** Language code (an exact supported YouTube code) → its title and description. */
export type LiveLocalizationSet = Record<string, LiveLocalization>;

/** One stream's set: at most this many languages. */
export const LIVE_LOCALIZATIONS_MAX_LANGUAGES = 50;

export type LiveLocalizationRefusalReason =
  | "not_an_entry"
  | "unsupported_language"
  | "baseline_language"
  | "title_empty"
  | "title_too_long"
  | "title_angle_brackets"
  | "description_empty"
  | "description_too_long"
  | "description_angle_brackets";

export type LiveLocalizationRefusal = { language: string; reason: LiveLocalizationRefusalReason; message: string; hint?: string };

export type LiveLocalizationsValidation =
  | { ok: true; set: LiveLocalizationSet }
  /** `problem`: why the set as a whole is refused; `refused`: every refused language with its reason. Nothing is stored. */
  | { ok: false; problem: "not_an_object" | "too_many_languages" | "invalid_languages"; message: string; refused: LiveLocalizationRefusal[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryRefusals(language: string, value: unknown, baselineLanguage: string | null): LiveLocalizationRefusal[] {
  const refusals: LiveLocalizationRefusal[] = [];
  if (!isSupportedYoutubeLanguageCode(language)) {
    const hint = suggestYoutubeLanguageCode(language);
    refusals.push({
      language,
      reason: "unsupported_language",
      message: hint ? `"${language}" is not a YouTube language code -- did you mean "${hint}"?` : `"${language}" is not a language YouTube supports`,
      ...(hint ? { hint } : {}),
    });
  } else if (sameLanguage(language, baselineLanguage)) {
    refusals.push({ language, reason: "baseline_language", message: `"${language}" is the channel's base language: its text is the stream's own title and description` });
  }

  const keys = isPlainObject(value) ? Object.keys(value).sort().join(",") : null;
  if (!isPlainObject(value) || keys !== "description,title" || typeof value.title !== "string" || typeof value.description !== "string") {
    refusals.push({ language, reason: "not_an_entry", message: "Each language needs exactly a title and a description (text)" });
    return refusals;
  }

  const title = value.title.trim();
  const titleLength = [...title].length;
  if (titleLength === 0) refusals.push({ language, reason: "title_empty", message: "The title is empty" });
  else if (titleLength > TITLE_MAX_CHARACTERS) refusals.push({ language, reason: "title_too_long", message: `The title has ${titleLength} characters; YouTube allows ${TITLE_MAX_CHARACTERS}` });
  if (hasAngleBrackets(value.title)) refusals.push({ language, reason: "title_angle_brackets", message: "The title may not contain < or >" });

  // Owner, Telegram msg 3287: a translation needs its description too (1–5000 bytes; empty after trimming is refused).
  const bytes = new TextEncoder().encode(value.description).length;
  if (value.description.trim().length === 0) refusals.push({ language, reason: "description_empty", message: "The description is empty" });
  else if (bytes > DESCRIPTION_MAX_BYTES) refusals.push({ language, reason: "description_too_long", message: `The description has ${bytes} bytes; YouTube allows ${DESCRIPTION_MAX_BYTES}` });
  if (hasAngleBrackets(value.description)) refusals.push({ language, reason: "description_angle_brackets", message: "The description may not contain < or >" });
  return refusals;
}

/**
 * The whole set, or every reason it is refused (one bad language refuses it all: nothing is half-saved). The title is kept trimmed
 * (as YouTube stores it); the description exactly as given. `baselineLanguage` is the channel's baseline (null = none set).
 */
export function validateLiveLocalizations(input: unknown, options: { baselineLanguage: string | null }): LiveLocalizationsValidation {
  if (!isPlainObject(input)) {
    return { ok: false, problem: "not_an_object", message: "The translations must be an object: language code → { title, description }", refused: [] };
  }
  const languages = Object.keys(input);
  if (languages.length > LIVE_LOCALIZATIONS_MAX_LANGUAGES) {
    return { ok: false, problem: "too_many_languages", message: `${languages.length} languages; at most ${LIVE_LOCALIZATIONS_MAX_LANGUAGES}`, refused: [] };
  }
  const refused = languages.flatMap((language) => entryRefusals(language, input[language], options.baselineLanguage));
  if (refused.length > 0) {
    return { ok: false, problem: "invalid_languages", message: `Refused: ${refused.map((r) => `${r.language} (${r.message})`).join("; ")}`, refused };
  }
  const set: LiveLocalizationSet = {};
  for (const language of languages) {
    const value = input[language] as LiveLocalization;
    set[language] = { title: value.title.trim(), description: value.description };
  }
  return { ok: true, set };
}

export type StoredLocalizations = { ok: true; set: LiveLocalizationSet | null } | { ok: false; problem: string };

/**
 * Reads the v101 column: null = none saved. A stored value that does not pass the shape and field rules is reported, never
 * guessed (fail closed). The baseline is not checked here: the write step compares the set with the video's own fresh language.
 */
export function readStoredLocalizations(json: string | null | undefined): StoredLocalizations {
  if (json === null || json === undefined) return { ok: true, set: null };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, problem: "the saved translations are not valid JSON" };
  }
  const result = validateLiveLocalizations(raw, { baselineLanguage: null });
  if (!result.ok) return { ok: false, problem: `the saved translations are invalid: ${result.message}` };
  return { ok: true, set: Object.keys(result.set).length > 0 ? result.set : null };
}

export type StreamLocalizationsDependencies = {
  store: Pick<LiveStreamsDependencies["store"], "getStream" | "updateStream" | "insertEvent">;
  /** The channel's baseline title/description language (null = none set). */
  channelLanguage(channelId: string): Promise<string | null>;
  clock: () => Date;
  newId: () => string;
};

export function createStreamLocalizations(deps: StreamLocalizationsDependencies) {
  return {
    /** The saved set (null = none) or the problem with it. */
    async get(channelId: string): Promise<StoredLocalizations> {
      return readStoredLocalizations((await deps.store.getStream(channelId))?.localizationsJson);
    },

    /**
     * Local only. The set replaces the saved one; an empty set clears it. The channel must have a stream on this computer. Any
     * refused language refuses the whole call (`validation_failed`, `details.refused`) and nothing is stored.
     */
    async set(channelId: string, input: unknown): Promise<LiveLocalizationSet> {
      const result = validateLiveLocalizations(input, { baselineLanguage: await deps.channelLanguage(channelId) });
      if (!result.ok) {
        throw new DomainError({ code: "validation_failed", message: result.message, details: { channelId, problem: result.problem, refused: result.refused } });
      }
      const now = deps.clock();
      const languages = Object.keys(result.set);
      const localizationsJson = languages.length > 0 ? JSON.stringify(result.set) : null;
      if (!(await deps.store.updateStream(channelId, { localizationsJson, updatedAt: now }))) {
        throw new DomainError({ code: "not_found", message: "This channel has no live stream on this computer", details: { channelId } });
      }
      await deps.store.insertEvent({ id: deps.newId(), channelId, at: now, kind: "localizations_saved", detailJson: JSON.stringify({ languages }) });
      return result.set;
    },
  };
}
