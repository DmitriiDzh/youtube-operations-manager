"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UI_LANGUAGES, type UiLanguage, errorText } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";

// BL-152 (docs/roadmap/plans/UI_LANGUAGE_PLAN.md): Settings → General → Interface language. "System" follows the browser's
// (and so the computer's) language, falling back to English (owner, msg 2032, Q4); a chosen language is kept for this
// browser on this computer only (Q1). Each language is listed in its own name. A short fixed list, so a plain <select>.
const SYSTEM = "system";

export function UiLanguageSettings() {
  const { t, language, source, systemLanguage } = useUiText();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = source === "chosen" ? language : SYSTEM;
  const nativeName = (code: UiLanguage) => UI_LANGUAGES.find((l) => l.code === code)?.nativeName ?? code;

  async function choose(value: string) {
    if (value === current) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/ui-language", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: value === SYSTEM ? null : value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(errorText(t, data, t("settings.saveFailed")));
        return;
      }
      // The root layout reads the new cookie and re-renders the whole interface in the new language.
      router.refresh();
    } catch {
      setError(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="text-base font-medium text-zinc-100">{t("settingsCard.uiLanguage")}</h3>
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={current}
          onChange={(e) => void choose(e.target.value)}
          disabled={saving}
          aria-label={t("settingsCard.uiLanguage")}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
        >
          <option value={SYSTEM}>{t("uiLanguage.system", { language: nativeName(systemLanguage) })}</option>
          {UI_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.nativeName}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">{t("uiLanguage.thisComputer")}</span>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
