"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";

type WorkspaceListEntry = { channelId: string; path: string | null; updatedAt: string | null };

/**
 * Phase 11 (`docs/roadmap/plans/PHASE_11_PLAN.md`) -- the per-channel "production workspace" path
 * field, rendered inside each row of `channel-connections-settings.tsx`. Self-contained on
 * purpose (`AGENTS.md` §M): it owns its own fetch/save against `/api/channel-workspaces` and is
 * wrapped in its own error boundary by the caller, so a failure here never breaks the rest of the
 * Channels card (listing, Activate, Disconnect). Plain controlled text input, no native dialogs.
 */
export function ChannelWorkspaceField({ channelId }: { channelId: string }) {
  const [savedPath, setSavedPath] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channel-workspaces");
      if (!res.ok) {
        setError("Could not load the workspace path.");
        return;
      }
      const data = (await res.json()) as { workspaces: WorkspaceListEntry[] };
      const current = data.workspaces.find((entry) => entry.channelId === channelId)?.path ?? null;
      setSavedPath(current);
      setDraft(current ?? "");
    } catch {
      setError("Could not load the workspace path.");
    }
  }, [channelId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(nextPath: string | null) {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/channel-workspaces", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId, path: nextPath }),
      });
      const data = (await res.json()) as {
        workspace?: { configured: boolean; path?: string };
        message?: string;
      };
      if (!res.ok || !data.workspace) {
        setError(data.message ?? "Failed to save");
        return;
      }
      const stored = data.workspace.configured ? (data.workspace.path ?? null) : null;
      setSavedPath(stored);
      setDraft(stored ?? "");
      setNotice(stored ? "Saved." : "Cleared.");
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const trimmed = draft.trim();
  const dirty = savedPath !== undefined && trimmed !== (savedPath ?? "");

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            Production workspace folder (this device)
            <InfoTooltip>
              An absolute path to this channel&apos;s production folder on this computer. It is stored
              only on this device and never synced or handed off. A connected agent working on this
              channel (while it is the active channel) can read this path back. This app never
              opens, lists or changes anything inside the folder. The folder must exist and must not
              be inside this app&apos;s own data directory. Leave empty and save to clear.
            </InfoTooltip>
          </span>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={savedPath === undefined}
            placeholder="/absolute/path/to/channel-workspace"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
          />
        </label>
        <button
          onClick={() => save(trimmed === "" ? null : trimmed)}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {savedPath && (
          <button
            onClick={() => save(null)}
            disabled={saving}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-zinc-500 disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
      {notice && <p className="text-xs text-green-500">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
