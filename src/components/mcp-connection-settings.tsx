"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";

type Settings = {
  mcpConnectionEnabled: boolean;
  gatewayTraffic?: GatewayTrafficWindowView[];
};

/**
 * Since docs/decisions/0013-in-app-http-mcp-transport.md this toggle gates the app's OWN MCP endpoint
 * (`POST /api/mcp`): an agent connects to it by URL + channel token and is told explicitly (403) while
 * the switch is off. It applies to the very next request -- no client restart needed.
 *
 * Split out of `LiveWritesSettings` (owner instruction, 2026-09-23: 4 Settings sub-tabs, this
 * toggle moved to the "AI Agent" one -- `/api/settings` already applies only the fields present
 * in a POST body, so this component fetches/saves independently of `LiveWritesSettings` without
 * either stepping on the other's field). "MCP connection" (renamed and inverted from the earlier
 * "MCP restricted mode", 2026-09-21) is the single gate for whether an MCP client (Codex, Claude,
 * etc.) sees ANY tool at all -- off by default, and unlike Live writes it persists across
 * sessions once turned on (a one-time setup step, not reset every boot).
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
    if (ownSettingsUnavailable(data, ["mcpConnectionEnabled"])) return;
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
            Off by default. While off, the app&apos;s MCP endpoint refuses every agent request with a clear
            error. Turning this on is the master switch only: an agent also needs its channel&apos;s agent token
            (Settings &rarr; Channels), sent as a Bearer token. With a valid token it sees only that
            channel&apos;s tools and data. The separate Live writes toggle, under API, still gates any real
            YouTube write. Unlike Live writes, this persists across restarts. Changes apply to the very next
            request, with no client restart.
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

      <AgentConnectionGuide />

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
          description="Any MCP client (Codex, Claude, etc.) that presents a valid channel agent token will see that channel's full tool set -- including apply and playlist_* write-capable tools, not just read/propose/create ones. This applies immediately. It does not by itself send anything to YouTube -- the separate Live writes toggle (under API) still gates any real write. Turn it back off any time; unlike Live writes, this stays on across restarts until you turn it off yourself."
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

/**
 * How to point an agent at this app. Only the endpoint URL and the connection commands -- never a
 * token (it is shown once, in Settings -> Channels) and never operating instructions for an agent
 * (AGENTS.md section B). The host is always the loopback address the server binds to.
 */
function AgentConnectionGuide() {
  // The port the operator actually opened this page on (server render falls back to the launchers' 3000).
  const url = useSyncExternalStore(
    () => () => {},
    () => `http://127.0.0.1:${window.location.port || "3000"}/api/mcp`,
    () => "http://127.0.0.1:3000/api/mcp"
  );
  const [copied, setCopied] = useState<string | null>(null);

  const snippets = [
    {
      id: "codex",
      title: "Codex",
      text: `codex mcp add ytom-<channel> --url ${url} --bearer-token-env-var YTOM_TOKEN_<CHANNEL>`,
      note: "One entry and one environment variable per channel (a single shared variable would hand every Codex the same channel). Prefer a project-level .codex/config.toml inside the channel's own folder, with the variable set only for that agent's launch.",
    },
    {
      id: "claude",
      title: "Claude Code",
      text: `claude mcp add --transport http ytom ${url} --header "Authorization: Bearer <this channel's agent token>"`,
      note: null,
    },
  ];

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div>
        <h4 className="text-sm font-medium text-zinc-200">Connect an agent</h4>
        <p className="mt-1 text-xs text-zinc-500">
          The app serves MCP itself while it is running, on this computer only. An agent needs just this URL and
          its channel&apos;s agent token (Settings &rarr; Channels) &mdash; no path to the project.
        </p>
        <code className="mt-2 block break-all rounded bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-200">{url}</code>
      </div>
      {snippets.map((snippet) => (
        <div key={snippet.id} className="space-y-1">
          <div className="flex items-center justify-between text-xs text-zinc-400">
            <span>{snippet.title}</span>
            <button onClick={() => copy(snippet.id, snippet.text)} className="text-zinc-400 hover:text-zinc-200">
              {copied === snippet.id ? "Copied" : "Copy"}
            </button>
          </div>
          <code className="block break-all rounded bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300">{snippet.text}</code>
          {snippet.note && <p className="text-xs text-zinc-500">{snippet.note}</p>}
        </div>
      ))}
    </div>
  );
}
