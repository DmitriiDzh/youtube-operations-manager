"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./confirm-dialog";

type Settings = {
  liveWritesEnabled: boolean;
  mcpRestrictedModeEnabled: boolean;
};

/**
 * Settings-tab toggles (owner instruction, 2026-09-21): "Live writes" is the Gate B toggle
 * (docs/TECHNICAL_DEBT.md RISK-09) -- off by default every session (the server forces it back
 * to false on every process boot, `src/lib/db.ts`'s `initializeDatabase`), and turning it on
 * here is layer 1 of the two-layer live-write barrier, never the write itself. "MCP restricted
 * mode" is the persisted counterpart to the `MCP_RESTRICTED_MODE` env var -- it only takes
 * effect the next time an MCP client spawns/reconnects the server process, not for an
 * already-open connection (stated plainly below, not hidden).
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

  const dirty = settings && (draft.liveWritesEnabled !== settings.liveWritesEnabled || draft.mcpRestrictedModeEnabled !== settings.mcpRestrictedModeEnabled);

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-100">Live writes</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Off by default every session. When on, a Batch you create can be a real (non-dry-run)
          one, and the Batches tab gets an actual &ldquo;Execute&rdquo; action that writes to
          YouTube. This is layer 1 of a two-layer barrier -- turning it on does not by itself send
          anything.
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={draft.liveWritesEnabled}
            onChange={(e) => {
              if (e.target.checked) {
                setConfirmingLiveWrites(true);
              } else {
                setDraft({ ...draft, liveWritesEnabled: false });
              }
            }}
          />
          Enable live writes for this session
        </label>
      </div>

      <div className="border-t border-zinc-800 pt-4">
        <h3 className="text-sm font-semibold text-zinc-100">MCP restricted mode</h3>
        <p className="mt-1 text-xs text-zinc-500">
          When on, an MCP client (e.g. Codex, Claude) only ever sees read/propose/create-class
          tools -- every write-capable tool (playlists, apply, write-channel/auth switching) is
          not registered at all, not merely rejected at call time. Known limitation: this takes
          effect the next time an MCP client spawns or reconnects the server process, not
          instantly for a connection that is already open.
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={draft.mcpRestrictedModeEnabled}
            onChange={(e) => setDraft({ ...draft, mcpRestrictedModeEnabled: e.target.checked })}
          />
          Restrict MCP to read/propose/create tools only
        </label>
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
    </div>
  );
}
