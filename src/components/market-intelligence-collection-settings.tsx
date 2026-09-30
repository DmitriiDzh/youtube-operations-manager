"use client";

import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";

type Settings = {
  marketIntelligenceDailyQuotaBudgetUnits: number | null;
};

// A coarse upper bound for the slider's own drag range -- the paired number input still accepts
// any non-negative integer beyond this, typed directly (mirrors this app's own
// `settings-input-widget-conventions` precedent: the slider is a convenience, never the only way
// to reach an exact value).
const SLIDER_MAX_UNITS = 500;

/**
 * Settings-tab section for Phase 9 slice 9B's repeatable competitor refresh
 * (docs/roadmap/plans/PHASE_9_SLICE_9B_PLAN.md §4/§6, owner decision 2026-09-26: "пользователь сам
 * в настройках мог это выставить... от того числа строить логику" -- a plain operator-set number,
 * no hardcoded default). `0`/unset means auto-collection is OFF -- there is no separate boolean
 * toggle here, the slider's own value at zero already means that (matches
 * `analytics-collection-settings.tsx`'s own sibling pattern of one focused card per repeatable
 * background collection feature).
 */
export function MarketIntelligenceCollectionSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draftUnits, setDraftUnits] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Found by independent review: without try/catch and an error branch, a failed/non-ok fetch
  // (network blip, expired session) left this card stuck on "Loading..." forever, with no way for
  // the operator to retry short of a full page reload.
  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) {
        setLoadError("Failed to load settings.");
        return;
      }
      const data = (await res.json()) as Settings;
      if (ownSettingsUnavailable(data, ["marketIntelligenceDailyQuotaBudgetUnits"])) {
        setLoadError("Failed to load settings.");
        return;
      }
      setLoadError(null);
      setSettings(data);
      setDraftUnits(data.marketIntelligenceDailyQuotaBudgetUnits ?? 0);
    } catch {
      setLoadError("Failed to load settings.");
    }
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
        body: JSON.stringify({ marketIntelligenceDailyQuotaBudgetUnits: draftUnits }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save");
        return;
      }
      setSettings(data);
      setDraftUnits(data.marketIntelligenceDailyQuotaBudgetUnits ?? 0);
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
            <button
              onClick={() => void fetchSettings()}
              className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">Loading...</p>
        )}
      </div>
    );
  }

  const dirty = draftUnits !== (settings.marketIntelligenceDailyQuotaBudgetUnits ?? 0);
  const isOff = draftUnits <= 0;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          Market intelligence daily quota
          <InfoTooltip>
            One shared daily YouTube API unit budget for both features on the Research tab: (1)
            automatic competitor auto-refresh &mdash; once per running dashboard session, this app
            checks every watchlisted competitor channel that hasn&rsquo;t been refreshed in the last
            24h and refreshes as many as the budget allows (up to 3 units per channel, only ever
            spent in full, never partially); and (2) manual channel discovery &mdash; each search
            you run on the Research tab costs 100 units. Set to 0 to turn both off. This budget
            resets at UTC midnight, independent of the Cloud quota numbers shown elsewhere.
          </InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* Disabled while saving (found by independent review): otherwise an edit made while a
            previous save is still in flight gets silently clobbered the moment that request's own
            server echo resolves and overwrites draftUnits. */}
        <input
          type="range"
          min={0}
          max={SLIDER_MAX_UNITS}
          step={1}
          value={Math.min(draftUnits, SLIDER_MAX_UNITS)}
          onChange={(e) => setDraftUnits(Number(e.target.value))}
          disabled={saving}
          className="w-64 accent-red-600 disabled:opacity-50"
        />
        <input
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={draftUnits}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            setDraftUnits(Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0);
          }}
          disabled={saving}
          className="w-24 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
        />
        <span className="text-xs text-zinc-400">units/day</span>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>

      {isOff && <p className="text-xs text-zinc-500">Auto-refresh and discovery are both off.</p>}
      {savedNotice && <p className="text-sm font-medium text-green-500">{savedNotice}</p>}
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
