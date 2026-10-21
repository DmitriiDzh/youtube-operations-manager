import { sameLanguage } from "@/lib/shared-language-baseline";
import { isSupportedYoutubeLanguageCode, suggestYoutubeLanguageCode } from "@/lib/youtube-supported-languages";
import { DESCRIPTION_MAX_BYTES, hasAngleBrackets, TITLE_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import { DomainError } from "./contracts";
import type { LiveStreamsDependencies } from "./services";
import type { StoredVideoSettings } from "./video-settings";

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

/** A description as stored: CRLF line breaks become LF (a pasted Windows text; YouTube keeps LF). */
export function normalizeDescription(description: string): string {
  return description.replace(/\r\n/g, "\n");
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

  // Owner, Telegram msg 3287: a translation needs its description too (1–5000 bytes; empty after trimming is refused). Counted
  // as stored: with CRLF line breaks made LF.
  const description = normalizeDescription(value.description);
  const bytes = new TextEncoder().encode(description).length;
  if (description.trim().length === 0) refusals.push({ language, reason: "description_empty", message: "The description is empty" });
  else if (bytes > DESCRIPTION_MAX_BYTES) refusals.push({ language, reason: "description_too_long", message: `The description has ${bytes} bytes; YouTube allows ${DESCRIPTION_MAX_BYTES}` });
  if (hasAngleBrackets(value.description)) refusals.push({ language, reason: "description_angle_brackets", message: "The description may not contain < or >" });
  return refusals;
}

/**
 * The whole set, or every reason it is refused (one bad language refuses it all: nothing is half-saved). The title is kept trimmed
 * (as YouTube stores it); the description as given, with CRLF line breaks made LF. `baselineLanguage` is the channel's baseline (null = none set).
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
    set[language] = { title: value.title.trim(), description: normalizeDescription(value.description) };
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

/**
 * Why a saved set may not reach YouTube (a warning, never a refusal -- owner msg 3287): the translations step runs only when the
 * stream's video settings are saved (`applyVideoSettings` is skipped otherwise), and only as their part; a set holding the
 * channel's current base language fails on every broadcast (the video's own language is never a translation); without a base
 * language the broadcast's video gets no default language, and a video without one gets no translations.
 */
export type LiveLocalizationsWarning = {
  code: "video_settings_not_saved" | "video_settings_invalid" | "baseline_language_in_set" | "no_baseline";
  message: string;
  /** `baseline_language_in_set`: the set's language that is the channel's base language now. */
  language?: string;
};

/** The last `localizations` step of an application (Start, a segment, «Применить снова»); `error` is the owner's text. */
export type LiveLocalizationsLastStep = { at: string; broadcastId: string | null; ok: boolean; skipped?: string; error?: string };

export type LiveLocalizationsView = {
  /** The saved set (null = none, or unreadable: see `problem`). */
  localizations: LiveLocalizationSet | null;
  problem: string | null;
  warnings: LiveLocalizationsWarning[];
  lastStep: LiveLocalizationsLastStep | null;
};

export type StreamLocalizationsDependencies = {
  store: Pick<LiveStreamsDependencies["store"], "getStream" | "updateStream" | "insertEvent">;
  /** The channel's baseline title/description language (null = none set). */
  channelLanguage(channelId: string): Promise<string | null>;
  /** Reads the row's stored video settings (`video-settings.ts`), injected so this file stays importable by the page. */
  readVideoSettings(json: string | null | undefined): StoredVideoSettings;
  /** The stream's last `video_settings_applied` summary (null = none). */
  lastApplied(channelId: string): Promise<{ at: Date; detailJson: string } | null>;
  clock: () => Date;
  newId: () => string;
};

/** The warnings for a saved set, from the row's video settings and the channel's base language now (none without a set). */
export function localizationsWarnings(set: LiveLocalizationSet | null, videoSettings: StoredVideoSettings, baselineLanguage: string | null): LiveLocalizationsWarning[] {
  if (!set || Object.keys(set).length === 0) return [];
  const warnings: LiveLocalizationsWarning[] = [];
  if (!videoSettings.ok) {
    warnings.push({ code: "video_settings_invalid", message: "The stream's saved video settings are unreadable, so nothing is applied after Start -- the translations are not written until they are saved again" });
  } else if (videoSettings.settings === null) {
    warnings.push({ code: "video_settings_not_saved", message: "The stream's video settings are not saved, so nothing is applied after Start -- the translations are written only as part of the video settings: save them" });
  }
  if (baselineLanguage === null || baselineLanguage.trim().length === 0) {
    warnings.push({ code: "no_baseline", message: "The channel has no base language, so the broadcast's video gets no default language and the translations are not written: set the channel's base language" });
  } else {
    const own = Object.keys(set).find((language) => sameLanguage(language, baselineLanguage));
    if (own) {
      warnings.push({
        code: "baseline_language_in_set",
        message: `The translations hold "${own}", now the channel's base language: the translations step fails on every broadcast until it is removed`,
        language: own,
      });
    }
  }
  return warnings;
}

/** The `localizations` step of an application summary, if it ran one. */
export function lastLocalizationsStep(applied: { at: Date; detailJson: string } | null): LiveLocalizationsLastStep | null {
  if (!applied) return null;
  let detail: { broadcastId?: unknown; steps?: unknown };
  try {
    detail = JSON.parse(applied.detailJson) as typeof detail;
  } catch {
    return null;
  }
  const step = Array.isArray(detail.steps) ? (detail.steps as Array<Record<string, unknown>>).find((s) => s?.step === "localizations") : undefined;
  if (!step) return null;
  return {
    at: applied.at.toISOString(),
    broadcastId: typeof detail.broadcastId === "string" ? detail.broadcastId : null,
    ok: step.ok === true,
    ...(typeof step.skipped === "string" ? { skipped: step.skipped } : {}),
    ...(typeof step.error === "string" ? { error: step.error } : {}),
  };
}

export function createStreamLocalizations(deps: StreamLocalizationsDependencies) {
  async function warningsFor(channelId: string, set: LiveLocalizationSet | null): Promise<LiveLocalizationsWarning[]> {
    if (!set || Object.keys(set).length === 0) return [];
    return localizationsWarnings(set, deps.readVideoSettings((await deps.store.getStream(channelId))?.videoSettingsJson), await deps.channelLanguage(channelId));
  }

  const service = {
    /** The saved set (null = none) or the problem with it. */
    async get(channelId: string): Promise<StoredLocalizations> {
      return readStoredLocalizations((await deps.store.getStream(channelId))?.localizationsJson);
    },

    /** What the page, the route and the Operator see: the set, its warnings and the last step's result. */
    async view(channelId: string): Promise<LiveLocalizationsView> {
      const row = await deps.store.getStream(channelId);
      const stored = readStoredLocalizations(row?.localizationsJson);
      const set = stored.ok ? stored.set : null;
      return {
        localizations: set,
        problem: stored.ok ? null : stored.problem,
        warnings: await warningsFor(channelId, set),
        lastStep: lastLocalizationsStep(await deps.lastApplied(channelId)),
      };
    },

    /** `set`, plus the warnings the saved set has now (MCP and route answer). */
    async save(channelId: string, input: unknown, by: "owner" | "factory" = "owner"): Promise<{ localizations: LiveLocalizationSet; warnings: LiveLocalizationsWarning[] }> {
      const localizations = await service.set(channelId, input, by);
      return { localizations, warnings: await warningsFor(channelId, localizations) };
    },

    /**
     * Local only. The set replaces the saved one; an empty set clears it. The channel must have a stream on this computer. Any
     * refused language refuses the whole call (`validation_failed`, `details.refused`) and nothing is stored.
     */
    async set(channelId: string, input: unknown, by: "owner" | "factory" = "owner"): Promise<LiveLocalizationSet> {
      const result = validateLiveLocalizations(input, { baselineLanguage: await deps.channelLanguage(channelId) });
      if (!result.ok) {
        throw new DomainError({ code: "validation_failed", message: result.message, details: { channelId, problem: result.problem, refused: result.refused } });
      }
      const now = deps.clock();
      const languages = Object.keys(result.set);
      const localizationsJson = languages.length > 0 ? JSON.stringify(result.set) : null;
      if (!(await deps.store.updateStream(channelId, { localizationsJson, updatedAt: now }))) {
        throw new DomainError({ code: "live_stream_not_found", message: "This channel has no live stream on this computer", details: { channelId } });
      }
      await deps.store.insertEvent({ id: deps.newId(), channelId, at: now, kind: "localizations_saved", detailJson: JSON.stringify({ languages, by }) });
      return result.set;
    },
  };
  return service;
}

/** The Operator's status entry (Factory API 1.27.0): codes only -- never the owner's error text (ADR 0036's status rule). */
export type LiveLocalizationsStatusEntry = {
  channelId: string;
  localizations: LiveLocalizationSet | null;
  problem: "invalid_stored" | null;
  warnings: Array<LiveLocalizationsWarning["code"]>;
  lastStep: { at: string; broadcastId: string | null; ok: boolean; skipped?: string; failure?: "read_back_mismatch" | "failed" } | null;
};

export function localizationsStatusEntry(channelId: string, view: LiveLocalizationsView): LiveLocalizationsStatusEntry {
  const step = view.lastStep;
  return {
    channelId,
    localizations: view.localizations,
    problem: view.problem === null ? null : "invalid_stored",
    warnings: view.warnings.map((w) => w.code),
    lastStep: step
      ? {
          at: step.at,
          broadcastId: step.broadcastId,
          ok: step.ok,
          ...(step.skipped ? { skipped: step.skipped } : {}),
          ...(!step.ok ? { failure: step.error?.startsWith("YouTube reads back something else") ? ("read_back_mismatch" as const) : ("failed" as const) } : {}),
        }
      : null,
  };
}
