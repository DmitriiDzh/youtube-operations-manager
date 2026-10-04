"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { estimateCollectionUnits } from "@/lib/market-intelligence/collection-depth";
import { parseDateDraft, parseDepthDraft } from "./market-collection-depth-fields";

type Defaults = {
  maxVideosPerChannel: number | null;
  publishedAfter: string | null;
  effectiveMaxVideosPerChannel: number;
  estimatedFirstCollectionUnits: number;
  estimatedFirstCollectionWorstCaseUnits: number;
};

/**
 * Settings-tab card (operator request 2026-10-04): how many of a watchlisted competitor's newest uploads are collected, and an optional
 * earliest publish date. These are the defaults; each watchlist entry can override them. Left blank = today's behaviour (50 videos,
 * no date, one page). The cost lines are computed before anything runs.
 */
export function MarketIntelligenceCollectionDepthSettings() {
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [draftMax, setDraftMax] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const apply = useCallback((data: Defaults) => {
    setDefaults(data);
    setDraftMax(data.maxVideosPerChannel === null ? "" : String(data.maxVideosPerChannel));
    setDraftDate(data.publishedAfter ?? "");
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/market-intelligence/collection-depth");
      if (!res.ok) {
        setLoadError("Failed to load collection depth.");
        return;
      }
      setLoadError(null);
      apply((await res.json()) as Defaults);
    } catch {
      setLoadError("Failed to load collection depth.");
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const parsedMax = parseDepthDraft(draftMax);
  const parsedDate = parseDateDraft(draftDate);
  const validationMessage = !parsedMax.ok ? parsedMax.message : !parsedDate.ok ? parsedDate.message : null;
  const dirty =
    defaults !== null &&
    parsedMax.ok &&
    parsedDate.ok &&
    (parsedMax.value !== defaults.maxVideosPerChannel || parsedDate.value !== defaults.publishedAfter);

  async function handleSave() {
    if (!parsedMax.ok || !parsedDate.ok) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/market-intelligence/collection-depth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxVideosPerChannel: parsedMax.value, publishedAfter: parsedDate.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save");
        return;
      }
      apply(data as Defaults);
      setSavedNotice("Saved.");
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!defaults) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        {loadError ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-red-400">{loadError}</p>
            <button onClick={() => void load()} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
              Retry
            </button>
          </div>
        ) : (
          <LoadingIndicator className="text-sm text-zinc-400" />
        )}
      </div>
    );
  }

  const shownMax = parsedMax.ok ? (parsedMax.value ?? 50) : null;
  const estimate = shownMax === null ? null : estimateCollectionUnits(shownMax);

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
        Competitor collection depth
        <InfoTooltip>
          How many of each watchlisted competitor&rsquo;s newest uploads are collected, and the earliest publish date to go back to. The first
          collection walks the channel&rsquo;s uploads page by page (50 videos per page, 1 unit each) until the limit or the date; later
          collections only read what is new (usually 2&ndash;3 units per channel). A backfill that does not fit today&rsquo;s daily quota
          continues on the next days, where it stopped. Each watchlist entry can override these defaults. Left blank = 50 videos, no date.
          Per YouTube API policy, other channels&rsquo; statistics are kept for 30 days.
        </InfoTooltip>
      </h3>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-zinc-400">Videos per channel (1&ndash;2000)</span>
          <input
            type="text"
            inputMode="numeric"
            value={draftMax}
            placeholder="50"
            onChange={(e) => setDraftMax(e.target.value)}
            disabled={saving}
            className="mt-1 block w-28 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
          />
        </label>
        <label className="block">
          <span className="text-xs text-zinc-400">Earliest publish date (YYYY-MM-DD)</span>
          <input
            type="text"
            value={draftDate}
            placeholder="no limit"
            onChange={(e) => setDraftDate(e.target.value)}
            disabled={saving}
            className="mt-1 block w-40 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
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

      {validationMessage && <p className="text-xs text-amber-400">{validationMessage}</p>}
      {estimate && (
        <p className="text-xs text-zinc-400">
          First collection of a channel &asymp; {estimate.firstCollection} units (up to {estimate.firstCollectionWorstCase} if batch statistics are unavailable);
          later collections &asymp; {estimate.steadyState} units per channel.
        </p>
      )}
      {savedNotice && <p className="text-sm font-medium text-green-500">{savedNotice}</p>}
      {error && <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">{error}</div>}
    </div>
  );
}
