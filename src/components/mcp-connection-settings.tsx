"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";

type Settings = {
  mcpConnectionEnabled: boolean;
  gatewayTraffic?: GatewayTrafficWindowView[];
};

/**
 * Split out of `LiveWritesSettings` (owner instruction, 2026-09-23: 4 Settings sub-tabs, this
 * toggle moved to the "AI Agent" one -- `/api/settings` already applies only the fields present
 * in a POST body, so this component fetches/saves independently of `LiveWritesSettings` without
 * either stepping on the other's field). "MCP connection" (renamed and inverted from the earlier
 * "MCP restricted mode", 2026-09-21) is the single gate for whether an MCP client (Codex, Claude,
 * etc.) sees ANY tool at all -- off by default, and unlike Live writes it persists across
 * sessions once turned on (a one-time setup step, not reset every boot). It only takes effect the
 * next time an MCP client spawns/reconnects the server process, not for an already-open
 * connection (stated plainly below, not hidden).
 */
export function McpConnectionSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

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
        body: JSON.stringify({ mcpConnectionEnabled: next.mcpConnectionEnabled }),
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

  const dirty = settings && draft.mcpConnectionEnabled !== settings.mcpConnectionEnabled;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          MCP connection
          <InfoTooltip>
            Off by default. While off, an MCP client (e.g. Codex, Claude) sees NO tools at all --
            not registered at all, not merely rejected at call time. Turning this on registers
            the full tool set (read/propose/create plus write-capable tools like playlists/apply
            -- the separate Live writes toggle, under API, still gates any real YouTube write).
            Unlike Live writes, this persists across sessions once enabled -- a one-time setup
            step, not reset every restart. Known limitation: this takes effect the next time an
            MCP client spawns or reconnects the server process, not instantly for a connection
            that is already open.
          </InfoTooltip>
        </h3>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch
            label="Enable MCP / agent connection"
            checked={draft.mcpConnectionEnabled}
            onChange={(checked) => {
              if (checked) {
                setConfirming(true);
              } else {
                setDraft({ ...draft, mcpConnectionEnabled: false });
              }
            }}
          />
          <span className="text-sm text-zinc-300">Enable MCP / agent connection</span>
        </div>
      </div>

      <GatewayTrafficStats size="lg" window={settings?.gatewayTraffic?.find((c) => c.category === "mcp_tool_calls")} />

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

      {confirming && (
        <ConfirmDialog
          title="Allow an MCP client / agent to connect?"
          description="Any MCP client (Codex, Claude, etc.) that spawns or reconnects to the server after this is saved will see the full tool set -- including apply and playlist_* write-capable tools, not just read/propose/create ones. This does not by itself send anything to YouTube -- the separate Live writes toggle (under API) still gates any real write. Turn it back off any time; unlike Live writes, this stays on across restarts until you turn it off yourself."
          confirmLabel="Enable"
          confirmVariant="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            setDraft({ ...draft, mcpConnectionEnabled: true });
          }}
        />
      )}
    </div>
  );
}
