"use client";

import { createContext, Fragment, useContext, useMemo, useState, type ReactNode } from "react";
import {
  createTranslator,
  formatNumber,
  translate,
  type Translate,
  type UiLanguage,
  type UiTextKey,
  type UiTextParams,
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
};

const UiTextContext = createContext<UiTextContextValue | null>(null);

/** One translator whose language can change underneath it (see the provider). Exported for its test. */
export class LiveLanguage {
  private language: UiLanguage;
  readonly t: Translate;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;

  constructor(language: UiLanguage) {
    this.language = language;
    const t = ((key: UiTextKey, params?: UiTextParams) => translate(this.language, key, params)) as Translate;
    Object.defineProperty(t, "language", { get: () => this.language });
    this.t = t;
    this.formatNumber = (value, options) => formatNumber(this.language, value, options);
  }

  set(language: UiLanguage) {
    this.language = language;
  }
}

export function UiTextProvider(props: { language: UiLanguage; source: UiLanguageSource; systemLanguage: UiLanguage; children: ReactNode }) {
  const { language, source, systemLanguage } = props;
  // Review round 4: `t` and `formatNumber` keep ONE identity for the provider's lifetime and read the current language
  // when called. Components list `t` in their fetch callbacks' dependencies; if `t` changed with the language, switching
  // it (Settings → General) would refetch every mounted panel and overwrite unsaved form drafts, which `router.refresh()`
  // otherwise keeps. Consumers still re-render on a change -- the context value below changes with `language` -- and then
  // every `t(...)` call returns the new language. Updating it during render is safe: the value is derived only from props,
  // so a discarded render cannot leave it wrong for the committed tree.
  const [live] = useState(() => new LiveLanguage(language));
  live.set(language);
  const value = useMemo<UiTextContextValue>(
    () => ({ language, source, systemLanguage, t: live.t, formatNumber: live.formatNumber }),
    [language, source, systemLanguage, live],
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
};

const SLOT = "\u0000";

/**
 * BL-152: one translated sentence with React elements inside it (a highlighted number, a reset time): each slot name is a
 * placeholder in the key's text, so the sentence stays whole and each language places the element where its grammar wants.
 */
export function translateWithSlots(t: Translate, key: UiTextKey, params: UiTextParams, slots: Record<string, ReactNode>): ReactNode[] {
  const markers = Object.fromEntries(Object.keys(slots).map((name) => [name, `${SLOT}${name}${SLOT}`]));
  return t(key, { ...params, ...markers })
    .split(SLOT)
    .map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{slots[part]}</Fragment> : part));
}
