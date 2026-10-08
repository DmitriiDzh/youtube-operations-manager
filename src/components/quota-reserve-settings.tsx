"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

type Settings = { quotaReservePercent: number };

/** BL-117: the share of the daily YouTube quota that automatic background reads leave untouched, so writes keep headroom. */
export function QuotaReserveSettings() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("20");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) {
        setLoadError(t("settings.loadFailed"));
        return;
      }
      const data = (await res.json()) as Settings;
      if (ownSettingsUnavailable(data, ["quotaReservePercent"])) {
        setLoadError(t("settings.loadFailed"));
        return;
      }
      setLoadError(null);
      setSettings(data);
      setDraft(String(data.quotaReservePercent));
    } catch {
      setLoadError(t("settings.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  // A controlled text field (not a native number widget): it always shows exactly the stored digits, whatever the locale.
  const parsed = /^\d{1,2}$/.test(draft.trim()) ? Number(draft.trim()) : null;
  const valid = parsed !== null && parsed >= 0 && parsed <= 90;
  const dirty = settings !== null && valid && parsed !== settings.quotaReservePercent;

  async function handleSave() {
    if (!valid || parsed === null) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quotaReservePercent: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? t("settings.saveFailed"));
        return;
      }
      setSettings(data);
      setDraft(String(data.quotaReservePercent));
      setSavedNotice(t("common.saved"));
    } catch {
      setError(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{loadError}</p>
            <button onClick={() => void fetchSettings()} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
              {t("common.retry")}
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        {t("settingsCards.quotaReserve.title")}
        <InfoTooltip>{t("settingsCards.quotaReserve.info")}</InfoTooltip>
      </h3>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
          aria-label={t("settingsCards.quotaReserve.aria")}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-sm text-zinc-400">{t("settingsCards.quotaReserve.unit")}</span>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {!valid && <p className="text-xs text-red-400">{t("settingsCards.quotaReserve.invalid")}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {savedNotice && !dirty && <p className="text-xs text-emerald-400">{savedNotice}</p>}
    </div>
  );
}
