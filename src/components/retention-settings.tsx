"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

type Settings = { draftRetentionDays: number; writeLogRetentionDays: number };

const MIN_DRAFT_DAYS = 1;
const MIN_LOG_DAYS = 7;
const MAX_DAYS = 3650;

function parseDays(draft: string, min: number): number | null {
  if (!/^\d{1,4}$/.test(draft.trim())) return null;
  const value = Number(draft.trim());
  return value >= min && value <= MAX_DAYS ? value : null;
}

/** BL-125: how long finished work is kept. Controlled text fields (not native number widgets), so the stored digits show the same in every locale. */
export function RetentionSettings() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draftDays, setDraftDays] = useState("7");
  const [logDays, setLogDays] = useState("30");
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
      if (ownSettingsUnavailable(data, ["draftRetentionDays", "writeLogRetentionDays"])) {
        setLoadError(t("settings.loadFailed"));
        return;
      }
      setLoadError(null);
      setSettings(data);
      setDraftDays(String(data.draftRetentionDays));
      setLogDays(String(data.writeLogRetentionDays));
    } catch {
      setLoadError(t("settings.loadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const parsedDraft = parseDays(draftDays, MIN_DRAFT_DAYS);
  const parsedLog = parseDays(logDays, MIN_LOG_DAYS);
  const valid = parsedDraft !== null && parsedLog !== null;
  const dirty =
    settings !== null &&
    valid &&
    (parsedDraft !== settings.draftRetentionDays || parsedLog !== settings.writeLogRetentionDays);

  async function handleSave() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRetentionDays: parsedDraft, writeLogRetentionDays: parsedLog }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? t("settings.saveFailed"));
        return;
      }
      setSettings(data);
      setDraftDays(String(data.draftRetentionDays));
      setLogDays(String(data.writeLogRetentionDays));
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
        {t("retention.title")}
        <InfoTooltip>{t("retention.info")}</InfoTooltip>
      </h3>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={draftDays}
          onChange={(e) => setDraftDays(e.target.value)}
          disabled={saving}
          aria-label={t("retention.draftsAria")}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-sm text-zinc-400">{t("retention.draftsLabel")}</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={logDays}
          onChange={(e) => setLogDays(e.target.value)}
          disabled={saving}
          aria-label={t("retention.logAria")}
          className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-sm text-zinc-400">{t("retention.logLabel")}</span>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>
      {!valid && <p className="text-xs text-red-400">{t("retention.invalid")}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {savedNotice && !dirty && <p className="text-xs text-emerald-400">{savedNotice}</p>}
    </div>
  );
}
