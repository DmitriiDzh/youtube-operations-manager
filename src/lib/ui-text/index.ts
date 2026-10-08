// BL-152 (docs/roadmap/plans/UI_LANGUAGE_PLAN.md): the interface language. Every text the Web UI shows is a key in
// `locales/en.ts` (the source) with a translation in every other locale file; components never hold display text of
// their own. MCP, API bodies and CLI output stay English -- they are read by agents and scripts (AGENTS.md §B).
//
// A flat, pure module like `shared-formatting` (no I/O, no adapters), so it is not split into the §6.2 five-piece
// layering. Not to be confused with `localization`/`ai-localization`, which translate VIDEO titles and descriptions.

import { en, type UiTextKey } from "./locales/en";
import { ru } from "./locales/ru";

export type { UiTextKey };

/** Every interface language, in the order the selector lists them. A new language = one locale file + one entry here. */
export const UI_LANGUAGES = [
  { code: "en", nativeName: "English", numberLocale: "en-US" },
  { code: "ru", nativeName: "Русский", numberLocale: "ru-RU" },
] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number]["code"];

/** Used when neither a chosen language nor a supported system language is available (owner, msg 2032, Q4). */
export const FALLBACK_UI_LANGUAGE: UiLanguage = "en";

/**
 * The person's choice, per browser on this computer (owner, msg 2032, Q1). A cookie, not `app_settings`: the root layout
 * renders every page -- the startup recovery page included, which must work while the database cannot open -- and a
 * cookie is read without the database.
 */
export const UI_LANGUAGE_COOKIE = "ui_language";

export const DICTIONARIES: Record<UiLanguage, Record<UiTextKey, string>> = { en, ru };

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && UI_LANGUAGES.some((l) => l.code === value);
}

/**
 * The first supported language in an `Accept-Language` header, by the header's own preference order (q-values), matched
 * on the primary subtag ("ru-RU" → "ru"). The browser runs on the same computer and follows the system language.
 */
export function languageFromAcceptLanguage(header: string | null | undefined): UiLanguage | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { primary: tag.trim().toLowerCase().split("-")[0], weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.primary && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) if (isUiLanguage(entry.primary)) return entry.primary;
  return null;
}

export type UiLanguageSource = "chosen" | "system";

export type ResolvedUiLanguage = {
  language: UiLanguage;
  source: UiLanguageSource;
  /** What "System" would give -- shown next to that choice in the selector even while another language is chosen. */
  systemLanguage: UiLanguage;
};

/** A chosen language wins; otherwise the system language; otherwise English (owner, msg 2032, Q4). */
export function resolveUiLanguage(input: { cookie: string | null | undefined; acceptLanguage: string | null | undefined }): ResolvedUiLanguage {
  const systemLanguage = languageFromAcceptLanguage(input.acceptLanguage) ?? FALLBACK_UI_LANGUAGE;
  if (isUiLanguage(input.cookie)) return { language: input.cookie, source: "chosen", systemLanguage };
  return { language: systemLanguage, source: "system", systemLanguage };
}

export type UiTextParams = Record<string, string | number>;

export function numberLocale(language: UiLanguage): string {
  return UI_LANGUAGES.find((l) => l.code === language)?.numberLocale ?? "en-US";
}

/**
 * Fills a message: `{name}` takes a parameter; `{count, plural, one {# video} few {# видео} other {# videos}}` picks the
 * form by `Intl.PluralRules` for the language (Russian has one/few/many), `#` being the number. `=0 {…}` matches an exact
 * value first. A missing parameter stays visible as `{name}` rather than silently disappearing.
 */
export function formatMessage(language: UiLanguage, message: string, params: UiTextParams = {}): string {
  let out = "";
  let i = 0;
  while (i < message.length) {
    const open = message.indexOf("{", i);
    if (open === -1) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const close = matchingBrace(message, open);
    if (close === -1) {
      out += message.slice(open);
      break;
    }
    out += formatPlaceholder(language, message.slice(open + 1, close), params);
    i = close + 1;
  }
  return out;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let j = open; j < text.length; j += 1) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}") {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

function formatPlaceholder(language: UiLanguage, body: string, params: UiTextParams): string {
  const firstComma = body.indexOf(",");
  if (firstComma === -1) {
    const name = body.trim();
    const value = params[name];
    if (value === undefined) return `{${name}}`;
    return typeof value === "number" ? formatNumber(language, value) : value;
  }
  const name = body.slice(0, firstComma).trim();
  const rest = body.slice(firstComma + 1);
  const secondComma = rest.indexOf(",");
  if (secondComma === -1 || rest.slice(0, secondComma).trim() !== "plural") return `{${body}}`;
  const value = params[name];
  if (typeof value !== "number") return `{${name}}`;
  const forms = parsePluralForms(rest.slice(secondComma + 1));
  const form = forms.get(`=${value}`) ?? forms.get(new Intl.PluralRules(numberLocale(language)).select(value)) ?? forms.get("other");
  if (form === undefined) return `{${name}}`;
  return formatMessage(language, form.replaceAll("#", formatNumber(language, value)), params);
}

function parsePluralForms(text: string): Map<string, string> {
  const forms = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const selector = text.slice(i, open).trim();
    const close = matchingBrace(text, open);
    if (close === -1 || !selector) break;
    forms.set(selector, text.slice(open + 1, close));
    i = close + 1;
  }
  return forms;
}

/** A number in the language's grouping and decimal marks (en "1,234.5", ru "1 234,5"), never the browser's own locale. */
export function formatNumber(language: UiLanguage, value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(numberLocale(language), options).format(value);
}

export function translate(language: UiLanguage, key: UiTextKey, params?: UiTextParams): string {
  const message = DICTIONARIES[language][key] ?? en[key] ?? key;
  return formatMessage(language, message, params);
}

export type Translate = (key: UiTextKey, params?: UiTextParams) => string;

export function createTranslator(language: UiLanguage): Translate {
  return (key, params) => translate(language, key, params);
}

/** For a text that comes from data (e.g. a server error code), not a literal key: is it a known key? */
export function isUiTextKey(value: string): value is UiTextKey {
  return Object.prototype.hasOwnProperty.call(en, value);
}

/**
 * A text a pure (non-React) module hands to the UI: a key to translate, or a text that came from outside as-is (a server
 * message, a name). Lets `.ts` helpers return display text without holding English themselves.
 */
export type UiMessage = { key: UiTextKey; params?: UiTextParams } | { text: string };

export function uiMessageText(t: Translate, message: UiMessage): string {
  return "key" in message ? t(message.key, message.params) : message.text;
}

/**
 * BL-152 slice 4: a failed API answer in the interface language. Routes answer `{ error: <code>, message: <English text> }`
 * (`DomainError`), or `{ error: <text> }`. In English the server's own message is shown exactly as before
 * (`message ?? error ?? fallback`). In another language a known code is shown in words (`errors.<code>`), with the
 * server's message kept as the detail; an unknown code falls back to the server's text. MCP and API bodies stay English
 * for agents and scripts (AGENTS.md §B) -- only the UI translates.
 */
export function apiErrorText(language: UiLanguage, body: unknown, fallback: string): string {
  const b = typeof body === "object" && body !== null ? (body as { error?: unknown; message?: unknown }) : {};
  const code = typeof b.error === "string" ? b.error : undefined;
  const message = typeof b.message === "string" && b.message.trim() ? b.message : undefined;
  const serverText = message ?? code ?? fallback;
  if (language === "en" || code === undefined) return serverText;
  const key = `errors.${code}`;
  if (!isUiTextKey(key)) return serverText;
  const text = translate(language, key);
  return message ? translate(language, "common.errorDetail", { text, detail: message }) : text;
}
