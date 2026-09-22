"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudQuotaProgress, type ServiceQuotaStatusView } from "./cloud-quota-progress";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { ToggleSwitch } from "./toggle-switch";

type Settings = {
  dataApiReadsEnabled: boolean;
  analyticsReadsEnabled: boolean;
  gatewayTraffic?: GatewayTrafficWindowView[];
  cloudQuotaStatus?: { dataApi: ServiceQuotaStatusView; analytics: ServiceQuotaStatusView };
};

/**
 * Settings-tab toggles for the two `src/lib/youtube-read-gateway/` children (owner instruction,
 * 2026-09-22, Telegram: "выведи такие же тумблеры в настройки по запросам API (теперь входящим).
 * Делаем отдельный тумблер на каждый модуль / шлюз API чтения"), `docs/decisions/0007-youtube-
 * read-gateway.md`. Unlike `LiveWritesSettings`' toggles, both default to **enabled** and persist
 * across restarts (see `src/lib/db.ts`'s `getDataApiReadsEnabled` for the full rationale) -- no
 * confirmation dialog on turning one on, since neither direction here grants a new capability the
 * way Live writes/MCP connection do; it is a pure pause/resume of outbound reads.
 *
 * Disabling a category also fails any write path that depends on that category's reads (Batches'
 * write-client construction, `write-context`'s pre-write identity check) -- intentional, stated
 * in the toggle's own description below rather than left as a surprise.
 */
export function ReadGatewaySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as Settings;
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
        body: JSON.stringify(next),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setSettings(data);
      setDraft(data);
      setSavedNotice("Saved.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!draft) return null;

  const dirty =
    settings &&
    (draft.dataApiReadsEnabled !== settings.dataApiReadsEnabled ||
      draft.analyticsReadsEnabled !== settings.analyticsReadsEnabled);

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Data API reads</h3>
        <p className="mt-1 text-xs text-zinc-500">
          On by default. Governs every real call to the YouTube Data API v3 (channel sync, video
          listing, playlists). Turning this off also fails any write path that depends on a read
          first (Batches, the pre-write channel identity check) -- Live writes above still
          separately governs whether a write is otherwise allowed.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch
            label="Enable Data API reads"
            checked={draft.dataApiReadsEnabled}
            onChange={(checked) => setDraft({ ...draft, dataApiReadsEnabled: checked })}
          />
          <span className="text-sm text-zinc-300">Enable Data API reads</span>
        </div>
        <GatewayTrafficStats
          window={settings?.gatewayTraffic?.find((c) => c.category === "data_api_reads")}
        />
        <CloudQuotaProgress status={settings?.cloudQuotaStatus?.dataApi} />
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-100">Analytics reads</h3>
        <p className="mt-1 text-xs text-zinc-500">
          On by default. Governs every real call to the YouTube Analytics API (the Analytics
          tab&apos;s manual and automatic collection).
        </p>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch
            label="Enable Analytics reads"
            checked={draft.analyticsReadsEnabled}
            onChange={(checked) => setDraft({ ...draft, analyticsReadsEnabled: checked })}
          />
          <span className="text-sm text-zinc-300">Enable Analytics reads</span>
        </div>
        <GatewayTrafficStats
          window={settings?.gatewayTraffic?.find((c) => c.category === "analytics_reads")}
        />
        <CloudQuotaProgress status={settings?.cloudQuotaStatus?.analytics} />
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {savedNotice && !dirty && <p className="text-xs text-emerald-400">{savedNotice}</p>}

      <div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
        <button
          onClick={() => save(draft)}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save / Apply"}
        </button>
        {dirty && (
          <button onClick={() => setDraft(settings)} className="text-xs text-zinc-500 hover:text-zinc-300">
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}
