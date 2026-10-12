// BL-178 (docs/PROJECT_SPEC.md §14, owner exception 2026-10-12, Telegram msg 2665; FO-REQ-0022): how a video reads against its
// channel's language baseline. Pure, no I/O. Shared by `batches` (what a write aligns and checks) and `changesets` (what a row is
// compared with), so both agree on one rule (AGENTS.md §D/§M).
//
// YouTube lists the video's own default language in `localizations` too, equal to the snippet (the "mirror"). Under a baseline
// `en`, a video labelled `es` holds the original (English) in its snippet; its `localizations.es` is that mirror, not a
// translation (owner decision 1078: a different declared language is a YouTube recognition error).

export type LocaleText = { title: string; description: string };

export type VideoLanguageView = {
  defaultLanguage: string | null;
  title: string;
  description: string;
  localizations: Record<string, LocaleText>;
};

export type BaselineReading =
  /** No baseline, no own default language (the 2026-10-02 path), or the same language: read the video as it is. */
  | { kind: "as_is" }
  /** The video's own language differs from the baseline: read as if it were the baseline, with the mirrors gone. */
  | { kind: "aligned"; from: string; to: string; view: VideoLanguageView }
  /** It differs, but an entry under the old or the new default language is not the mirror: a translation cannot be told from it. */
  | { kind: "ambiguous"; from: string; to: string; reason: string };

/** Language codes compare case-insensitively (`en` = `EN`); a missing code never matches. */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function localeKey(localizations: Record<string, LocaleText>, language: string): string | null {
  return Object.keys(localizations).find((key) => sameLanguage(key, language)) ?? null;
}

function isSnippetMirror(video: VideoLanguageView, entry: LocaleText): boolean {
  return entry.title === video.title && entry.description === video.description;
}

export function readAgainstBaseline(video: VideoLanguageView, baseline: string | null | undefined): BaselineReading {
  if (!baseline || !video.defaultLanguage || sameLanguage(video.defaultLanguage, baseline)) return { kind: "as_is" };
  const from = video.defaultLanguage;
  const to = baseline;
  const localizations: Record<string, LocaleText> = {};
  for (const [key, entry] of Object.entries(video.localizations)) {
    const isOld = sameLanguage(key, from);
    const isNew = sameLanguage(key, to);
    if (!isOld && !isNew) {
      localizations[key] = entry;
      continue;
    }
    if (!isSnippetMirror(video, entry)) {
      return {
        kind: "ambiguous",
        from,
        to,
        reason: `The video's "${key}" entry differs from its title/description, so it cannot be told from a real translation. Fix the video's language first (Languages -> Language defaults -> Fix all).`,
      };
    }
  }
  return { kind: "aligned", from, to, view: { ...video, defaultLanguage: to, localizations } };
}

/** The current value of (language, field) in a reading: the snippet for its default language, else its `localizations` entry. */
export function currentValueIn(video: VideoLanguageView, language: string, field: "title" | "description"): string {
  if (sameLanguage(language, video.defaultLanguage)) return field === "title" ? video.title : video.description;
  const key = localeKey(video.localizations, language);
  return key ? video.localizations[key][field] : "";
}

/**
 * Whether a row's baseline still matches the video (no conflict). Read aligned, a row in the old default language holds when
 * its baseline is empty (made against the aligned reading) or the snippet text (made earlier, against the mirror): both mean
 * "no translation existed". Any other row compares with the reading's current value.
 */
export function baselineValueStillHolds(
  video: VideoLanguageView,
  reading: BaselineReading,
  change: { language: string; field: "title" | "description"; baselineValue: string }
): boolean {
  const view = reading.kind === "aligned" ? reading.view : video;
  if (currentValueIn(view, change.language, change.field) === change.baselineValue) return true;
  if (reading.kind === "aligned" && sameLanguage(change.language, reading.from)) {
    return change.baselineValue === (change.field === "title" ? video.title : video.description);
  }
  return false;
}
