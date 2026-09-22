/**
 * The hard, fixed allowlist for the Languages tab's "Add language column" feature
 * (owner instruction, Telegram 2026-09-21: "Пользователь не может добавить язык, которого не
 * будет в этом списке"). Captured from a real, live call to YouTube Data API v3's
 * `i18nLanguages.list` (part=snippet, hl=en) on 2026-09-21 -- see
 * `src/lib/youtube-read-gateway/data-api.ts`'s `listSupportedLanguages`, which produced this
 * exact list and remains the way to regenerate it
 * later if YouTube's own set changes (call it with a real authenticated client and replace the
 * array below with its output).
 *
 * Hardcoded on purpose (owner instruction: "не дергать по этому поводу API лишний раз") --
 * this is no longer fetched at runtime. The tradeoff, made knowingly and documented here: this
 * is YouTube's own list of *interface* languages (the `hl` values YouTube's UI can render in),
 * not a list YouTube publishes specifically for what `videos.update`'s `localizations` map
 * accepts. Real synced data on the "Tropico Jazz" channel proves at least one gap -- "en-US" is
 * a real, working localization language on that channel's videos, but is NOT in this list (only
 * "en", "en-GB", "en-IN" are). Any such already-real language stays visible as a column via the
 * existing `trackedLanguages ∪ real-data` union (`docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md`
 * §7.2, BL-039/E5a) regardless of this list -- only *manually typing a brand-new, not-yet-used*
 * code is affected by this hard gate.
 */
export const SUPPORTED_YOUTUBE_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "af", name: "Afrikaans" },
  { code: "am", name: "Amharic" },
  { code: "ar", name: "Arabic" },
  { code: "as", name: "Assamese" },
  { code: "az", name: "Azerbaijani" },
  { code: "be", name: "Belarusian" },
  { code: "bg", name: "Bulgarian" },
  { code: "bn", name: "Bangla" },
  { code: "bs", name: "Bosnian" },
  { code: "ca", name: "Catalan" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "en", name: "English" },
  { code: "en-GB", name: "English (United Kingdom)" },
  { code: "en-IN", name: "English (India)" },
  { code: "es", name: "Spanish" },
  { code: "es-419", name: "Spanish (Latin America)" },
  { code: "es-US", name: "Spanish (United States)" },
  { code: "et", name: "Estonian" },
  { code: "eu", name: "Basque" },
  { code: "fa", name: "Persian" },
  { code: "fi", name: "Finnish" },
  { code: "fil", name: "Filipino" },
  { code: "fr", name: "French" },
  { code: "fr-CA", name: "French (Canada)" },
  { code: "gl", name: "Galician" },
  { code: "gu", name: "Gujarati" },
  { code: "hi", name: "Hindi" },
  { code: "hr", name: "Croatian" },
  { code: "hu", name: "Hungarian" },
  { code: "hy", name: "Armenian" },
  { code: "id", name: "Indonesian" },
  { code: "is", name: "Icelandic" },
  { code: "it", name: "Italian" },
  { code: "iw", name: "Hebrew" },
  { code: "ja", name: "Japanese" },
  { code: "ka", name: "Georgian" },
  { code: "kk", name: "Kazakh" },
  { code: "km", name: "Khmer" },
  { code: "kn", name: "Kannada" },
  { code: "ko", name: "Korean" },
  { code: "ky", name: "Kyrgyz" },
  { code: "lo", name: "Lao" },
  { code: "lt", name: "Lithuanian" },
  { code: "lv", name: "Latvian" },
  { code: "mk", name: "Macedonian" },
  { code: "ml", name: "Malayalam" },
  { code: "mn", name: "Mongolian" },
  { code: "mr", name: "Marathi" },
  { code: "ms", name: "Malay" },
  { code: "my", name: "Burmese" },
  { code: "ne", name: "Nepali" },
  { code: "nl", name: "Dutch" },
  { code: "no", name: "Norwegian" },
  { code: "or", name: "Odia" },
  { code: "pa", name: "Punjabi" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "pt-PT", name: "Portuguese (Portugal)" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "si", name: "Sinhala" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "sq", name: "Albanian" },
  { code: "sr", name: "Serbian" },
  { code: "sr-Latn", name: "Serbian (Latin)" },
  { code: "sv", name: "Swedish" },
  { code: "sw", name: "Swahili" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "ur", name: "Urdu" },
  { code: "uz", name: "Uzbek" },
  { code: "vi", name: "Vietnamese" },
  { code: "zh-CN", name: "Chinese (China)" },
  { code: "zh-HK", name: "Chinese (Hong Kong)" },
  { code: "zh-TW", name: "Chinese (Taiwan)" },
  { code: "zu", name: "Zulu" },
];

const SUPPORTED_YOUTUBE_LANGUAGE_CODES = new Set(SUPPORTED_YOUTUBE_LANGUAGES.map((lang) => lang.code));

export function isSupportedYoutubeLanguageCode(code: string): boolean {
  return SUPPORTED_YOUTUBE_LANGUAGE_CODES.has(code);
}
