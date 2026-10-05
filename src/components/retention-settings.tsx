"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";

type Settings = { draftRetentionDays: number; writeLogRetentionDays: number };

const MIN_DRAFT_DAYS = 1;
const MIN_LOG_DAYS = 7;
const MAX_DAYS = 3650;

function parseDays(draft: string, min: number): number | null {
  if (!/^\d{1,4}$/.test(draft.trim())) return null;
  const value = Number(draft.trim());
  return value >= min && value <= MAX_DAYS ? value : null;
}

/** BL-125: how long finished work is kept. Controlled text fields (not native number widgets), so the stored digits show the same in every locale. */
export function RetentionSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draftDays, setDraftDays] = useState("7");
  const [logDays, setLogDays] = useState("30");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) {
        setLoadError("Failed to load settings.");
        return;
      }
      const data = (await res.json()) as Settings;
      if (ownSettingsUnavailable(data, ["draftRetentionDays", "writeLogRetentionDays"])) {
        setLoadError("Failed to load settings.");
        return;
      }
      setLoadError(null);
      setSettings(data);
      setDraftDays(String(data.draftRetentionDays));
      setLogDays(String(data.writeLogRetentionDays));
    } catch {
      setLoadError("Failed to load settings.");
    }
  }, []);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const parsedDraft = parseDays(draftDays, MIN_DRAFT_DAYS);
  const parsedLog = parseDays(logDays, MIN_LOG_DAYS);
  const valid = parsedDraft !== null && parsedLog !== null;
  const dirty =
    settings !== null &&
    valid &&
    (parsedDraft !== settings.draftRetentionDays || parsedLog !== settings.writeLogRetentionDays);

  async function handleSave() {
    if (!valid) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftRetentionDays: parsedDraft, writeLogRetentionDays: parsedLog }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save");
        return;
      }
      setSettings(data);
      setDraftDays(String(data.draftRetentionDays));
      setLogDays(String(data.writeLogRetentionDays));
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
        {loadError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{loadError}</p>
            <button onClick={() => void fetchSettings()} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
              Retry
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        Keeping finished work
        <InfoTooltip>
          Settled drafts are deleted after the first period: rejected change sets, and approved ones whose changes were written to
          YouTube and verified. The write log (batches, per-video results, audit events) of a fully successful batch is deleted after
          the second period. Change sets still in review, and anything that failed, conflicted or was cancelled, are never deleted
          automatically.
        </InfoTooltip>
      </h3>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={draftDays}
          onChange={(e) => setDraftDays(e.target.value)}
          disabled={saving}
          aria-label="Days to keep settled drafts"
          className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-sm text-zinc-400">days to keep settled drafts (at least 1)</span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={logDays}
          onChange={(e) => setLogDays(e.target.value)}
          disabled={saving}
          aria-label="Days to keep the write log"
          className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-sm text-zinc-400">days to keep the write log (at least 7)</span>
        <button
          onClick={() => void handleSave()}
          disabled={saving || !dirty}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
      {!valid && <p className="text-xs text-red-400">Drafts: a whole number of days, at least 1. Write log: at least 7.</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {savedNotice && !dirty && <p className="text-xs text-emerald-400">{savedNotice}</p>}
    </div>
  );
}
