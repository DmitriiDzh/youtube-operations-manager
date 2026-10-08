"use client";

import { errorText } from "@/lib/ui-text";
import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

/**
 * "Automatic device sync" (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.7). On by default and
 * persistent. Same fetch/save shape as `operator-cli-settings.tsx` (`/api/settings` applies only
 * the fields present in a POST body).
 */
export function DeviceAutoSyncSettings() {
  const t = useT();
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as { deviceAutoSyncEnabled: boolean };
    if (ownSettingsUnavailable(data, ["deviceAutoSyncEnabled"])) return;
    setSaved(data.deviceAutoSyncEnabled);
    setDraft(data.deviceAutoSyncEnabled);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function save() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceAutoSyncEnabled: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("common.errorStatus", { status: String(res.status) })));
        return;
      }
      setSaved(data.deviceAutoSyncEnabled);
      setDraft(data.deviceAutoSyncEnabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (draft === null) return null;
  const dirty = draft !== saved;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("settingsCard.autoDeviceSync")}
          <InfoTooltip>{t("settingsCards.autoSync.info")}</InfoTooltip>
        </h3>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch label={t("settingsCards.autoSync.toggle")} checked={draft} onChange={setDraft} />
          <span className="text-sm text-zinc-300">{t("settingsCards.autoSync.toggle")}</span>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("settingsCards.saveApply")}
        </button>
        {dirty && (
          <button onClick={() => setDraft(saved)} className="text-xs text-zinc-500 hover:text-zinc-300">
            {t("settingsCards.discardChanges")}
          </button>
        )}
      </div>
    </div>
  );
}
