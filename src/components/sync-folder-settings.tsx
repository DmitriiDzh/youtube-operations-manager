"use client";

import { useCallback, useEffect, useState } from "react";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message ?? `Request to ${url} failed (${res.status})`);
  }
  return data as T;
}

/**
 * The Syncthing shared-folder path -- moved here from `DeviceHandoffPanel` (owner instruction,
 * 2026-09-23: "давай в настройках сделаем 4 категории закладок... Sync (сюда все настройки типа
 * путей до папок переезжают)"). This is the one piece of `device-handoff`/`snapshot`'s own config
 * that is genuinely a *setting* rather than an *action* -- the Merge tab keeps every actual sync
 * action (Sync now, snapshot export/import, conflict resolution), this owns only where the shared
 * folder lives. Saving here no longer re-fetches the Merge tab's snapshot list directly (that tab
 * re-fetches on its own mount, same as every other tab in this app already does).
 */
export function SyncFolderSettings() {
  const [syncthingRootPath, setSyncthingRootPath] = useState("");
  const [saved, setSyncthingRootPathSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJson<{ syncthingRootPath: string | null }>("/api/device-handoff/bootstrap-config");
      setSyncthingRootPath(data.syncthingRootPath ?? "");
      setSyncthingRootPathSaved(data.syncthingRootPath ?? "");
    } catch {
      // non-fatal -- first-run config may not exist yet
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave() {
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    try {
      await fetchJson("/api/device-handoff/bootstrap-config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ syncthingRootPath: syncthingRootPath || null }),
      });
      setSyncthingRootPathSaved(syncthingRootPath);
      setSavedNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save folder");
    } finally {
      setBusy(false);
    }
  }

  const dirty = syncthingRootPath !== saved;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="text-base font-semibold text-zinc-100">Syncthing folder</h3>
      <p className="text-sm text-zinc-400">
        The local directory Syncthing shares with the other device. Snapshots, change drafts,
        editorial profiles, and AI connections all sync through this folder. Leave empty to work
        local-only (nothing leaves this device).
      </p>
      <div className="flex gap-2">
        <input
          value={syncthingRootPath}
          onChange={(e) => setSyncthingRootPath(e.target.value)}
          placeholder="e.g. D:\Sync\yt-ops-manager"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100"
        />
        <button
          onClick={handleSave}
          disabled={busy || !dirty}
          className="rounded-md border border-zinc-700 px-3 py-2 text-sm font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {savedNotice && !dirty && <p className="text-xs text-emerald-400">{savedNotice}</p>}
    </div>
  );
}
