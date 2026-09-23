"use client";

import { useCallback, useEffect, useState } from "react";
import { CloudQuotaProgress, type ServiceQuotaStatusView } from "./cloud-quota-progress";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { SettingsSectionRow } from "./settings-section-row";
import { ToggleSwitch } from "./toggle-switch";

type Settings = {
  liveWritesEnabled: boolean;
  gatewayTraffic?: GatewayTrafficWindowView[];
  cloudQuotaStatus?: { dataApi: ServiceQuotaStatusView };
};

/**
 * "Live writes" is the Gate B toggle (docs/TECHNICAL_DEBT.md RISK-09) -- off by default every
 * session (the server forces it back to false on every process boot, `src/lib/db.ts`'s
 * `initializeDatabase`), and turning it on here is layer 1 of the two-layer live-write barrier,
 * never the write itself. The "MCP connection" toggle used to live in this same component --
 * split out into `McpConnectionSettings` 2026-09-23 when Settings gained sub-tabs (owner
 * instruction: 4 categories, MCP connection moved to "AI Agent"). `/api/settings` already applies
 * only the fields present in a POST body, so the two components fetch/save independently without
 * stepping on each other.
 */
export function LiveWritesSettings() {
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

  const dirty = settings && draft.liveWritesEnabled !== settings.liveWritesEnabled;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <SettingsSectionRow
        left={
          <div>
            <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
              Live writes
              <InfoTooltip>
                Off by default every session. When on, a Batch you create can be a real
                (non-dry-run) one, and the Batches tab gets an actual &ldquo;Execute&rdquo; action
                that writes to YouTube. This is layer 1 of a two-layer barrier -- turning it on
                does not by itself send anything.
              </InfoTooltip>
            </h3>
            <div className="mt-2 flex items-center gap-2">
              <ToggleSwitch
                label="Enable live writes for this session"
                checked={draft.liveWritesEnabled}
                onChange={(checked) => {
                  if (checked) {
                    setConfirmingLiveWrites(true);
                  } else {
                    setDraft({ ...draft, liveWritesEnabled: false });
                  }
                }}
              />
              <span className="text-sm text-zinc-300">Enable live writes for this session</span>
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
            <CloudQuotaProgress size="lg" status={settings?.cloudQuotaStatus?.dataApi} />
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
          {saving ? "Saving..." : "Save / Apply"}
        </button>
        {dirty && (
          <button onClick={() => setDraft(settings)} className="text-xs text-zinc-500 hover:text-zinc-300">
            Discard changes
          </button>
        )}
      </div>

      {confirmingLiveWrites && (
        <ConfirmDialog
          title="Enable real YouTube writes?"
          description="A Batch you create while this is on can be a real, non-dry-run one, and the Batches tab will offer an actual Execute action. This does not send anything by itself -- but it removes the safety barrier that currently makes that impossible. Turn it back off any time; it also resets to off automatically the next time the app restarts."
          confirmLabel="Enable"
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
