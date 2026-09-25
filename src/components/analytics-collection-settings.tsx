"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { isValidIanaTimezone, isValidLocalTimeOfDay } from "@/lib/analytics/staleness";

// `Intl.supportedValuesOf` (ES2022) -- the real, canonical IANA timezone database this runtime
// ships, not a hand-maintained list that could drift from it. Backing a <datalist> rather than a
// plain <select> per the owner's own request (2026-09-25): "лучше сделать выбор из списка, в
// который можно вводить, чтобы сузить список" -- typing still narrows the list, but an exact,
// valid IANA name can also still be typed directly (the server-side `isValidIanaTimezone` check
// below is the actual source of truth either way, this list is discoverability only).
const IANA_TIMEZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

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
export function AnalyticsCollectionSettings() {
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

  const timeValid = isValidLocalTimeOfDay(draft.analyticsSyncLocalTime);
  const timezoneValid = isValidIanaTimezone(draft.analyticsSyncTimezone);

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          Analytics auto-collection
          <InfoTooltip>
            Once a day, on entering the dashboard, this app checks whether analytics were already
            collected today after the time below and collects them if not. This does not run on a
            background schedule &mdash; it only checks when you actually open the dashboard.
          </InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Collection time (local, 24h)
          <input
            type="text"
            inputMode="numeric"
            placeholder="HH:MM"
            value={draft.analyticsSyncLocalTime}
            onChange={(e) => setDraft({ ...draft, analyticsSyncLocalTime: e.target.value })}
            // A plain text input, not `type="time"` -- the native time widget renders its value
            // using the browser/OS locale's own separator (e.g. "12.05" under a Finnish locale),
            // which the owner explicitly flagged as confusing (2026-09-25: "время должно
            // отображать как 12:05, а не точка"). A controlled text field always shows exactly
            // what's stored (`HH:MM`, the same format `isValidLocalTimeOfDay` validates below and
            // the server itself expects), independent of the viewer's locale.
            className={`w-24 rounded-lg border bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 ${
              timeValid ? "border-zinc-700" : "border-red-700"
            }`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Timezone (IANA name)
          <input
            type="text"
            list="analytics-sync-iana-timezones"
            value={draft.analyticsSyncTimezone}
            onChange={(e) => setDraft({ ...draft, analyticsSyncTimezone: e.target.value })}
            placeholder="e.g. America/New_York"
            className={`min-w-56 rounded-lg border bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 ${
              timezoneValid ? "border-zinc-700" : "border-red-700"
            }`}
          />
          {/* Typing still narrows this list (native <datalist> behavior) while an exact IANA name
              can also be typed directly -- narrows the free-text error surface the owner flagged
              (2026-09-25: "свободный ввод... это место для потенциальной ошибки") without losing
              the ability to enter any zone this runtime actually supports. */}
          <datalist id="analytics-sync-iana-timezones">
            {IANA_TIMEZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </label>
        <button
          onClick={handleSave}
          disabled={saving || !dirty || !timeValid || !timezoneValid}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {(!timeValid || !timezoneValid) && (
        <p className="text-xs text-red-400">
          {!timeValid && "Time must be HH:MM, 24h. "}
          {!timezoneValid && "Timezone must be a valid IANA name (e.g. Europe/Helsinki)."}
        </p>
      )}
      {savedNotice && <p className="text-sm font-medium text-green-500">{savedNotice}</p>}
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
