"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { CloudQuotaProgress, type ServiceQuotaStatusView } from "./cloud-quota-progress";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { SettingsSectionRow } from "./settings-section-row";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";

type Settings = {
  liveWritesEnabled: boolean;
  gatewayTraffic?: GatewayTrafficWindowView[];
  cloudQuotaStatus?: { dataApi: ServiceQuotaStatusView; tokenRefreshFailed?: boolean };
};

/**
 * "Live writes" is the Gate B toggle (docs/TECHNICAL_DEBT.md RISK-09) -- off by default every
 * session (the web server resets it to false when it starts and when it shuts down,
 * `src/instrumentation.ts`), and turning it on here is layer 1 of the two-layer live-write barrier,
 * never the write itself. The "MCP connection" toggle used to live in this same component --
 * split out into `McpConnectionSettings` 2026-09-23 when Settings gained sub-tabs (owner
 * instruction: 4 categories, MCP connection moved to "AI Agent"). `/api/settings` already applies
 * only the fields present in a POST body, so the two components fetch/save independently without
 * stepping on each other.
 */
export function LiveWritesSettings() {
  const t = useT();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [confirmingLiveWrites, setConfirmingLiveWrites] = useState(false);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as Settings;
    if (ownSettingsUnavailable(data, ["liveWritesEnabled"])) return;
    setSettings(data);
    setDraft(data);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function save(next: Settings) {
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveWritesEnabled: next.liveWritesEnabled }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? t("common.errorStatus", { status: String(res.status) }));
        return;
      }
      setSettings(data);
      setDraft(data);
      setSavedNotice(t("common.saved"));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!draft) return null;

  const dirty = settings && draft.liveWritesEnabled !== settings.liveWritesEnabled;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <SettingsSectionRow
        left={
          <div>
            <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
              {t("settingsCard.liveWrites")}
              <InfoTooltip>{t("settingsCards.liveWrites.info")}</InfoTooltip>
            </h3>
            <div className="mt-2 flex items-center gap-2">
              <ToggleSwitch
                label={t("settingsCards.liveWrites.toggle")}
                checked={draft.liveWritesEnabled}
                onChange={(checked) => {
                  if (checked) {
                    setConfirmingLiveWrites(true);
                  } else {
                    setDraft({ ...draft, liveWritesEnabled: false });
                  }
                }}
              />
              <span className="text-sm text-zinc-300">{t("settingsCards.liveWrites.toggle")}</span>
            </div>
          </div>
        }
        right={
          <>
            <GatewayTrafficStats
              size="lg"
              window={settings?.gatewayTraffic?.find((c) => c.category === "live_writes")}
            />
            {/* Shared with Data API reads elsewhere -- same underlying Google service, owner
                instruction 2026-09-22: "Можем пока что отображать на Live write и на Data reads
                один и тот же счетчик". */}
            <CloudQuotaProgress size="lg" tokenRefreshFailed={settings?.cloudQuotaStatus?.tokenRefreshFailed} status={settings?.cloudQuotaStatus?.dataApi} historyService="data" />
          </>
        }
      />

      {error && <p className="text-xs text-red-400">{error}</p>}
      {savedNotice && !dirty && <p className="text-xs text-emerald-400">{savedNotice}</p>}

      <div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
        <button
          onClick={() => save(draft)}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("settingsCards.saveApply")}
        </button>
        {dirty && (
          <button onClick={() => setDraft(settings)} className="text-xs text-zinc-500 hover:text-zinc-300">
            {t("settingsCards.discardChanges")}
          </button>
        )}
      </div>

      {confirmingLiveWrites && (
        <ConfirmDialog
          title={t("settingsCards.liveWrites.confirmTitle")}
          description={t("settingsCards.liveWrites.confirmBody")}
          confirmLabel={t("settingsCards.enable")}
          confirmVariant="danger"
          onCancel={() => setConfirmingLiveWrites(false)}
          onConfirm={() => {
            setConfirmingLiveWrites(false);
            setDraft({ ...draft, liveWritesEnabled: true });
          }}
        />
      )}
    </div>
  );
}
