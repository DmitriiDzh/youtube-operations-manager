"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";

type WorkspaceSettings = {
  operationsWorkspacePath: string | null;
};

/**
 * Settings-tab section for Phase 7 slice I (owner spec §3/§30, `docs/AGENT_OPERATIONS_INTERFACE.md`
 * §4i, project owner clarification via Telegram 2026-09-24). Stores an absolute path to a folder
 * OUTSIDE this repository holding Codex's own operating/editorial instructions -- this application
 * never generates or stores that content itself (`AGENTS.md` §B), it only records where it is and
 * surfaces it to the connected agent via the read-only `agent_list_operations_files`/
 * `agent_get_operations_file` MCP tools/CLI commands. This is the ONLY way to set this path -- no
 * agent-callable MCP tool or CLI command can (owner spec §17's `local_path` self-authorization
 * concern applies here too). Validated server-side (`/api/settings`) before being saved: must be an
 * absolute, existing directory that does not overlap this application's own app-data directory.
 */
export function OperationsWorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as WorkspaceSettings;
    setSettings(data);
    setDraft(data.operationsWorkspacePath ?? "");
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationsWorkspacePath: draft.trim() === "" ? null : draft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save");
        return;
      }
      setSettings(data);
      setDraft(data.operationsWorkspacePath ?? "");
      setSavedNotice("Saved.");
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  const dirty = draft.trim() !== (settings.operationsWorkspacePath ?? "");

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          Codex operations workspace
          <InfoTooltip>
            An absolute path to a folder OUTSIDE this repository holding Codex&apos;s own operating
            instructions. This app never creates or edits anything in that folder -- it only reads
            .md/.txt/.json/.yaml/.yml files from it (never dotfiles) and lets the connected agent
            list/read them. Leave empty to disable. The folder must not be inside this app&apos;s own
            data directory.
          </InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 min-w-64 flex-col gap-1 text-xs text-zinc-400">
          Workspace folder path
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="/absolute/path/to/operations-workspace"
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {savedNotice && <p className="text-sm font-medium text-green-500">{savedNotice}</p>}
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
