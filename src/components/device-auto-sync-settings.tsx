"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { ToggleSwitch } from "./toggle-switch";

/**
 * "Automatic device sync" (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.7). On by default and
 * persistent. Same fetch/save shape as `operator-cli-settings.tsx` (`/api/settings` applies only
 * the fields present in a POST body).
 */
export function DeviceAutoSyncSettings() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as { deviceAutoSyncEnabled: boolean };
    if (ownSettingsUnavailable(data, ["deviceAutoSyncEnabled"])) return;
    setSaved(data.deviceAutoSyncEnabled);
    setDraft(data.deviceAutoSyncEnabled);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function save() {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceAutoSyncEnabled: draft }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? `Error ${res.status}`);
        return;
      }
      setSaved(data.deviceAutoSyncEnabled);
      setDraft(data.deviceAutoSyncEnabled);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (draft === null) return null;
  const dirty = draft !== saved;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Automatic device sync
          <InfoTooltip>
            While the app is running, it publishes this computer&apos;s changes to the sync folder about once a minute
            and loads the other computer&apos;s newer data by itself, as long as this computer has no unpublished
            changes of its own. Covered: Batches history and audit, Research, Decisions, and market-record
            assignments. Drafts (Change Sets, profiles, AI connections) sync separately and are not affected by this switch. If both computers changed data, nothing is overwritten: the bell in
            the header asks you which computer&apos;s data to keep. The manual export/import in the Merge tab still works.
          </InfoTooltip>
        </h3>
        <div className="mt-2 flex items-center gap-2">
          <ToggleSwitch label="Sync automatically between computers" checked={draft} onChange={setDraft} />
          <span className="text-sm text-zinc-300">Sync automatically between computers</span>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save / Apply"}
        </button>
        {dirty && (
          <button onClick={() => setDraft(saved)} className="text-xs text-zinc-500 hover:text-zinc-300">
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}
