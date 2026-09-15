// Centralized language code -> display name mapping (docs/PROJECT_SPEC.md §13:
// "Centralize language handling ... Do not scatter language-code logic throughout UI
// components"). Deliberately not exhaustive: any code not listed here still works
// throughout the app, it just falls back to displaying the raw code (§13: "Allow
// arbitrary supported languages rather than hard-coding only five").
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  en: "English",
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  es: "Spanish",
  "es-419": "Spanish (Latin America)",
  de: "German",
  fr: "French",
  ja: "Japanese",
  ko: "Korean",
  ru: "Russian",
  it: "Italian",
  pt: "Portuguese",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "zh-Hans": "Chinese (Simplified)",
  "zh-Hant": "Chinese (Traditional)",
  nl: "Dutch",
  pl: "Polish",
  tr: "Turkish",
  ar: "Arabic",
  hi: "Hindi",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  uk: "Ukrainian",
  sv: "Swedish",
  cs: "Czech",
};

export function getLanguageDisplayName(code: string): string {
  return LANGUAGE_DISPLAY_NAMES[code] ?? code;
}
