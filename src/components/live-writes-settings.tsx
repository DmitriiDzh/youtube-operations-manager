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
  mcpConnectionEnabled: boolean;
  gatewayTraffic?: GatewayTrafficWindowView[];
  cloudQuotaStatus?: { dataApi: ServiceQuotaStatusView };
};

/**
 * Settings-tab toggles (owner instruction, 2026-09-21): "Live writes" is the Gate B toggle
 * (docs/TECHNICAL_DEBT.md RISK-09) -- off by default every session (the server forces it back
 * to false on every process boot, `src/lib/db.ts`'s `initializeDatabase`), and turning it on
 * here is layer 1 of the two-layer live-write barrier, never the write itself. "MCP connection"
 * (renamed and inverted from the earlier "MCP restricted mode", same day) is the single gate for
 * whether an MCP client (Codex, Claude, etc.) sees ANY tool at all -- off by default, and unlike
 * Live writes it persists across sessions once turned on (a one-time setup step, not reset every
 * boot). It only takes effect the next time an MCP client spawns/reconnects the server process,
 * not for an already-open connection (stated plainly below, not hidden).
 */
export function LiveWritesSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [confirmingLiveWrites, setConfirmingLiveWrites] = useState(false);
  const [confirmingMcpConnection, setConfirmingMcpConnection] = useState(false);

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

  const dirty = settings && (draft.liveWritesEnabled !== settings.liveWritesEnabled || draft.mcpConnectionEnabled !== settings.mcpConnectionEnabled);

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
            {/* Shared with Data API reads below -- same underlying Google service, owner
                instruction 2026-09-22: "Можем пока что отображать на Live write и на Data reads
                один и тот же счетчик". */}
            <CloudQuotaProgress size="lg" status={settings?.cloudQuotaStatus?.dataApi} />
          </>
        }
      />

      <div className="border-t border-zinc-800 pt-4">
        <SettingsSectionRow
          left={
            <div>
              <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
                MCP connection
                <InfoTooltip>
                  Off by default. While off, an MCP client (e.g. Codex, Claude) sees NO tools at
                  all -- not registered at all, not merely rejected at call time. Turning this on
                  registers the full tool set (read/propose/create plus write-capable tools like
                  playlists/apply -- Live writes above still separately gates any real YouTube
                  write). Unlike Live writes, this persists across sessions once enabled -- a
                  one-time setup step, not reset every restart. Known limitation: this takes
                  effect the next time an MCP client spawns or reconnects the server process, not
                  instantly for a connection that is already open.
                </InfoTooltip>
              </h3>
              <div className="mt-2 flex items-center gap-2">
                <ToggleSwitch
                  label="Enable MCP / agent connection"
                  checked={draft.mcpConnectionEnabled}
                  onChange={(checked) => {
                    if (checked) {
                      setConfirmingMcpConnection(true);
                    } else {
                      setDraft({ ...draft, mcpConnectionEnabled: false });
                    }
                  }}
                />
                <span className="text-sm text-zinc-300">Enable MCP / agent connection</span>
              </div>
            </div>
          }
          right={
            <GatewayTrafficStats
              size="lg"
              window={settings?.gatewayTraffic?.find((c) => c.category === "mcp_tool_calls")}
            />
          }
        />
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

      {confirmingMcpConnection && (
        <ConfirmDialog
          title="Allow an MCP client / agent to connect?"
          description="Any MCP client (Codex, Claude, etc.) that spawns or reconnects to the server after this is saved will see the full tool set -- including apply and playlist_* write-capable tools, not just read/propose/create ones. This does not by itself send anything to YouTube -- the separate Live writes toggle above still gates any real write. Turn it back off any time; unlike Live writes, this stays on across restarts until you turn it off yourself."
          confirmLabel="Enable"
          confirmVariant="danger"
          onCancel={() => setConfirmingMcpConnection(false)}
          onConfirm={() => {
            setConfirmingMcpConnection(false);
            setDraft({ ...draft, mcpConnectionEnabled: true });
          }}
        />
      )}
    </div>
  );
}
