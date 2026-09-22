"use client";

import { useCallback, useEffect, useState } from "react";

type SyncSettings = {
  analyticsSyncLocalTime: string;
  analyticsSyncTimezone: string;
};

/**
 * Settings-tab section for BL-059's daily auto-collection boundary
 * (docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-4). Not a boolean toggle (no ToggleSwitch
 * here) -- these are two text values, validated server-side before being saved
 * (`isValidLocalTimeOfDay`/`isValidIanaTimezone`, `/api/settings`). The timezone defaults to this
 * machine's own OS timezone the first time it's ever read, then persists -- this field lets the
 * owner override that, e.g. after moving, per their own "может меняться в зимнее/летнее время"
 * concern (which the underlying IANA-zone-aware check already handles automatically; this field
 * is only for picking the zone itself, never a manual seasonal offset).
 */
export function AnalyticsSyncSettings() {
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [draft, setDraft] = useState<SyncSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as SyncSettings;
    setSettings(data);
    setDraft(data);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save");
        return;
      }
      setSettings(data);
      setDraft(data);
      setSavedNotice("Saved.");
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !draft) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-sm text-zinc-400">Loading...</p>
      </div>
    );
  }

  const dirty =
    draft.analyticsSyncLocalTime !== settings.analyticsSyncLocalTime ||
    draft.analyticsSyncTimezone !== settings.analyticsSyncTimezone;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="text-sm font-medium text-zinc-100">Analytics auto-collection</h3>
        <p className="mt-1 text-sm text-zinc-400">
          Once a day, on entering the dashboard, this app checks whether analytics were already
          collected today after the time below and collects them if not. This does not run on a
          background schedule &mdash; it only checks when you actually open the dashboard.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Collection time (local, 24h)
          <input
            type="time"
            value={draft.analyticsSyncLocalTime}
            onChange={(e) => setDraft({ ...draft, analyticsSyncLocalTime: e.target.value })}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Timezone (IANA name)
          <input
            type="text"
            value={draft.analyticsSyncTimezone}
            onChange={(e) => setDraft({ ...draft, analyticsSyncTimezone: e.target.value })}
            placeholder="e.g. America/New_York"
            className="min-w-56 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
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
