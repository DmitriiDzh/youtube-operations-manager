import { sameLanguage } from "@/lib/shared-language-baseline";
import {
  validateLocalizationSet,
  type LocalizationRefusal,
  type LocalizationSet,
  type LocalizationSetLimits,
  type LocalizationSetValidation,
} from "@/lib/shared-localization-set";

// ---------------------------------------------------------------------------
// BL-210 (docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md, ADR 0047): a channel's own title/description translations -- the
// set's rules and the preview of an apply. Pure, no server code: the MCP tools, the routes, the service and the Web UI card use
// the same functions. Nothing here calls YouTube.
// ---------------------------------------------------------------------------

export type ChannelLocalizationSet = LocalizationSet;
export type ChannelLocalizationRefusal = LocalizationRefusal;

/** One channel's set: at most this many languages (the same bound as a stream's set). */
export const CHANNEL_LOCALIZATIONS_MAX_LANGUAGES = 50;

/**
 * The documented bounds of the fields a channel translation translates (developers.google.com/youtube/v3/docs/channels):
 * `brandingSettings.channel.title` "maximum length of 30 characters"; `snippet.description` "maximum length of 1000 characters".
 * The reference states no bound for `localizations.(key).*` itself (plan "API facts", deviation 3).
 */
export const CHANNEL_TITLE_MAX_CHARACTERS = 30;
export const CHANNEL_DESCRIPTION_MAX_CHARACTERS = 1000;

export const CHANNEL_LOCALIZATION_LIMITS: LocalizationSetLimits = {
  titleMaxCharacters: CHANNEL_TITLE_MAX_CHARACTERS,
  description: { max: CHANNEL_DESCRIPTION_MAX_CHARACTERS, unit: "characters" },
  maxLanguages: CHANNEL_LOCALIZATIONS_MAX_LANGUAGES,
};

/** `channels.update`: "A call to this method has a quota cost of 50 units"; `channels.list`: 1 unit. */
export const CHANNEL_UPDATE_UNITS = 50;
export const CHANNEL_LIST_UNITS = 1;

/** The whole set, or every reason it is refused (one bad language refuses it all). `baselineLanguage`: the channel's baseline. */
export function validateChannelLocalizations(input: unknown, options: { baselineLanguage: string | null }): LocalizationSetValidation {
  return validateLocalizationSet(input, { baselineLanguage: options.baselineLanguage, limits: CHANNEL_LOCALIZATION_LIMITS, ownText: "the channel's own title and description" });
}

export type StoredChannelLocalizationSet = { ok: true; set: ChannelLocalizationSet | null } | { ok: false; problem: string };

/** Reads the stored column: null = none saved. A stored value that fails the rules is reported, never guessed (fail closed). */
export function readStoredChannelLocalizations(json: string | null | undefined): StoredChannelLocalizationSet {
  if (json === null || json === undefined) return { ok: true, set: null };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, problem: "the saved translations are not valid JSON" };
  }
  const result = validateChannelLocalizations(raw, { baselineLanguage: null });
  if (!result.ok) return { ok: false, problem: `the saved translations are invalid: ${result.message}` };
  return { ok: true, set: Object.keys(result.set).length > 0 ? result.set : null };
}

/** What the channel looks like on YouTube, as far as the translations go (the read gateway's context, narrowed). */
export type LiveChannelLocalizations = {
  snippet: { title: string; description: string; defaultLanguage: string | null };
  brandingChannel: Record<string, unknown>;
  localizations: Record<string, { title: string; description: string }>;
};

/** The existing key for a language in any letter case (the merge's own `localeKeyFor` rule; that module imports server code). */
function keyFor(localizations: Record<string, unknown>, language: string): string | null {
  return Object.keys(localizations).find((key) => sameLanguage(key, language)) ?? null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value : null);

/**
 * The channel's default language: `brandingSettings.channel.defaultLanguage` (the one `channels.update` lets a request set, and the
 * one localizations require). Owner decision (msg 3350): this app never sets it -- not set there means nothing is written, even when
 * `snippet.defaultLanguage` has a value. `mismatch`: both are set and disagree.
 */
export function channelDefaultLanguage(live: LiveChannelLocalizations): { language: string | null; mismatch: boolean } {
  const branding = text(live.brandingChannel.defaultLanguage);
  const snippet = text(live.snippet.defaultLanguage);
  return { language: branding, mismatch: branding !== null && snippet !== null && !sameLanguage(branding, snippet) };
}

/** The channel's own-language entry in its translations, if YouTube lists one (null = none). */
export function ownLanguageEntry(live: LiveChannelLocalizations, ownLanguage: string): { key: string; sameAsBase: boolean } | null {
  const key = keyFor(live.localizations, ownLanguage);
  if (key === null) return null;
  const entry = live.localizations[key];
  return { key, sameAsBase: entry.title === live.snippet.title && entry.description === live.snippet.description };
}

export type ChannelLocalizationLanguageStatus = "new" | "changed" | "unchanged";

export type ChannelLocalizationsPreviewProblem =
  /** `brandingSettings.channel.defaultLanguage` is not set: the owner sets it once in YouTube Studio (owner msg 3350). */
  | "default_language_not_set"
  /** The snippet and branding default languages disagree. */
  | "default_language_mismatch"
  /** YouTube lists a translation in the channel's own language whose text differs from the base name/description. */
  | "own_language_in_live"
  /** The set holds the channel's own (default) language. */
  | "own_language_in_set"
  /** Nothing is stored. */
  | "empty_set";

export type ChannelLocalizationsPreview = {
  languages: Array<{ language: string; status: ChannelLocalizationLanguageStatus }>;
  /** Languages on YouTube the set does not name (the own-language entry included): sent back exactly as they are, nothing deleted. */
  untouched: string[];
  /** The channel's default language on YouTube (`brandingSettings.channel.defaultLanguage`); null = not set (nothing is written). */
  defaultLanguage: { current: string | null };
  /** Why Apply would refuse (empty = it may run). */
  problems: ChannelLocalizationsPreviewProblem[];
  /** `channels.update` calls the apply makes (0 or 1) and their quota, plus the reads it makes at least (1 before, 2 per write). */
  quota: { writes: number; writeUnits: number; readUnits: number };
  /** The channel's own language: its text is the base name/description, never a translation of the set. */
  ownLanguage: string | null;
};

/**
 * What Apply would do with `set` on the channel as read (`live`): every language of the set new / changed / unchanged, the
 * languages it leaves as they are, the default language, the problems and the quota.
 */
export function previewChannelLocalizations(set: ChannelLocalizationSet | null, live: LiveChannelLocalizations): ChannelLocalizationsPreview {
  const problems: ChannelLocalizationsPreviewProblem[] = [];
  const current = channelDefaultLanguage(live);
  if (current.language === null) problems.push("default_language_not_set");
  if (current.mismatch) problems.push("default_language_mismatch");
  const own = current.language;
  if (own !== null && ownLanguageEntry(live, own)?.sameAsBase === false) problems.push("own_language_in_live");
  const entries = Object.entries(set ?? {});
  if (entries.length === 0) problems.push("empty_set");
  if (own !== null && entries.some(([language]) => sameLanguage(language, own))) problems.push("own_language_in_set");

  const languages = entries.map(([language, value]) => {
    const key = keyFor(live.localizations, language);
    const status: ChannelLocalizationLanguageStatus =
      key === null ? "new" : live.localizations[key].title === value.title && live.localizations[key].description === value.description ? "unchanged" : "changed";
    return { language, status };
  });
  const untouched = Object.keys(live.localizations).filter((key) => !entries.some(([language]) => sameLanguage(language, key)));

  const writes = problems.length === 0 && languages.some((l) => l.status !== "unchanged") ? 1 : 0;
  return {
    languages,
    untouched,
    defaultLanguage: { current: current.language },
    problems,
    quota: { writes, writeUnits: writes * CHANNEL_UPDATE_UNITS, readUnits: CHANNEL_LIST_UNITS * (1 + 2 * writes) },
    ownLanguage: own,
  };
}
