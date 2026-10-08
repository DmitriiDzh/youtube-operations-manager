"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  apiErrorText,
  createTranslator,
  formatNumber,
  type Translate,
  type UiLanguage,
  type UiLanguageSource,
} from "@/lib/ui-text";

// BL-152: the interface language for every client component. The root layout resolves it on the server (cookie, else
// the browser's language) and passes it in, so the first paint is already in that language. A language change sets the
// cookie and calls `router.refresh()`; the root layout re-renders and this provider gets the new `language` prop.

type UiTextContextValue = {
  language: UiLanguage;
  source: UiLanguageSource;
  systemLanguage: UiLanguage;
  t: Translate;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** A failed API answer's text in the interface language (see `apiErrorText`). */
  errorText: (body: unknown, fallback: string) => string;
};

const UiTextContext = createContext<UiTextContextValue | null>(null);

export function UiTextProvider(props: { language: UiLanguage; source: UiLanguageSource; systemLanguage: UiLanguage; children: ReactNode }) {
  const { language, source, systemLanguage } = props;
  const value = useMemo<UiTextContextValue>(
    () => ({
      language,
      source,
      systemLanguage,
      t: createTranslator(language),
      formatNumber: (n, options) => formatNumber(language, n, options),
      errorText: (body, fallback) => apiErrorText(language, body, fallback),
    }),
    [language, source, systemLanguage],
  );
  return <UiTextContext.Provider value={value}>{props.children}</UiTextContext.Provider>;
}

/** The language, its source, `t` and `formatNumber`. Outside a provider (a test render) it is English. */
export function useUiText(): UiTextContextValue {
  return useContext(UiTextContext) ?? FALLBACK;
}

/** `const t = useT(); t("nav.home")` */
export function useT(): Translate {
  return useUiText().t;
}

const FALLBACK: UiTextContextValue = {
  language: "en",
  source: "system",
  systemLanguage: "en",
  t: createTranslator("en"),
  formatNumber: (n, options) => formatNumber("en", n, options),
  errorText: (body, fallback) => apiErrorText("en", body, fallback),
};
