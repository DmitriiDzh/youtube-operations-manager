"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { estimateCollectionUnits } from "@/lib/market-intelligence/collection-depth";
import { describeCompleteReason, parseDateDraft, parseDepthDraft } from "./market-collection-depth-fields";

type Progress = {
  maxVideosPerChannel: number;
  maxVideosPerChannelOverride: number | null;
  publishedAfter: string | null;
  publishedAfterOverride: string | null;
  videosStored: number;
  complete: boolean;
  completeReason: "cap" | "date" | "exhausted" | null;
  estimatedFirstCollectionUnits: number;
  estimatedFirstCollectionWorstCaseUnits: number;
};

/**
 * Per-channel collection depth (operator request 2026-10-04), shown inside an opened watchlist entry: the channel's own override of the
 * global default (blank = use the default), the estimated unit cost, and how far its collection has got (videos stored / limit, complete or not).
 */
export function MarketChannelCollectionDepth({ channelId }: { channelId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [draftMax, setDraftMax] = useState("");
  const [draftDate, setDraftDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A slower response for a previously opened channel must never overwrite the current one's values.
  const requestedChannelRef = useRef<string>(channelId);

  const apply = useCallback((data: Progress) => {
    setProgress(data);
    setDraftMax(data.maxVideosPerChannelOverride === null ? "" : String(data.maxVideosPerChannelOverride));
    setDraftDate(data.publishedAfterOverride ?? "");
  }, []);

  const load = useCallback(async () => {
    requestedChannelRef.current = channelId;
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(channelId)}/collection-depth`);
      if (requestedChannelRef.current !== channelId) return;
      if (!res.ok) {
        setLoadError("Failed to load collection depth.");
        return;
      }
      setLoadError(null);
      apply((await res.json()) as Progress);
    } catch {
      if (requestedChannelRef.current === channelId) setLoadError("Failed to load collection depth.");
    }
  }, [channelId, apply]);

  useEffect(() => {
    setProgress(null);
    setError(null);
    setSavedNotice(null);
    void load();
  }, [load]);

  const parsedMax = parseDepthDraft(draftMax);
  const parsedDate = parseDateDraft(draftDate);
  const validationMessage = !parsedMax.ok ? parsedMax.message : !parsedDate.ok ? parsedDate.message : null;
  const dirty =
    progress !== null &&
    parsedMax.ok &&
    parsedDate.ok &&
    (parsedMax.value !== progress.maxVideosPerChannelOverride || parsedDate.value !== progress.publishedAfterOverride);

  async function handleSave() {
    if (!parsedMax.ok || !parsedDate.ok) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch(`/api/market-intelligence/channels/${encodeURIComponent(channelId)}/collection-depth`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxVideosPerChannel: parsedMax.value, publishedAfter: parsedDate.value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to save");
        return;
      }
      if (requestedChannelRef.current === channelId) apply(data as Progress);
      setSavedNotice("Saved.");
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // The estimate follows the draft when it is a number; a blank draft means "the global default", which is what the saved
  // effective value already is when no override is stored.
  const draftCap = parsedMax.ok && parsedMax.value !== null ? parsedMax.value : progress?.maxVideosPerChannelOverride === null ? progress.maxVideosPerChannel : null;
  const estimate = draftCap === null ? null : estimateCollectionUnits(draftCap);

  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
        Collection depth
        <InfoTooltip>
          How many of this channel&rsquo;s newest uploads are collected, and the earliest publish date. Blank fields use the defaults from Settings
          (50 videos, no date when none is set). The first collection reads the channel&rsquo;s uploads page by page (50 videos, 1 unit per page);
          later ones only read what is new. If the daily quota does not cover a deep first collection, it continues on the next days.
        </InfoTooltip>
      </p>
      {!progress && !loadError && <LoadingIndicator className="text-xs text-zinc-500" />}
      {loadError && (
        <div className="flex items-center gap-3">
          <p className="text-xs text-red-400">{loadError}</p>
          <button onClick={() => void load()} className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800">
            Retry
          </button>
        </div>
      )}
      {progress && (
        <div className="space-y-2 text-xs text-zinc-400">
          <p>
            Stored {progress.videosStored} of {progress.maxVideosPerChannel} videos
            {progress.publishedAfter ? ` (from ${progress.publishedAfter})` : ""} &middot;{" "}
            {progress.complete
              ? `complete${describeCompleteReason(progress.completeReason) ? ` — ${describeCompleteReason(progress.completeReason)}` : ""}`
              : "not complete — continues with the next refresh"}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span>Videos per channel (blank = default)</span>
              <input
                type="text"
                inputMode="numeric"
                value={draftMax}
                placeholder={String(progress.maxVideosPerChannelOverride === null ? progress.maxVideosPerChannel : "default")}
                onChange={(e) => setDraftMax(e.target.value)}
                disabled={saving}
                className="mt-1 block w-28 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span>Earliest publish date (YYYY-MM-DD)</span>
              <input
                type="text"
                value={draftDate}
                placeholder={progress.publishedAfterOverride === null && progress.publishedAfter ? progress.publishedAfter : "default"}
                onChange={(e) => setDraftDate(e.target.value)}
                disabled={saving}
                className="mt-1 block w-40 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
              />
            </label>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
          {validationMessage && <p className="text-amber-400">{validationMessage}</p>}
          {estimate && (
            <p>
              First collection &asymp; {estimate.firstCollection} units (up to {estimate.firstCollectionWorstCase} if batch statistics are unavailable);
              later collections &asymp; {estimate.steadyState} units.
            </p>
          )}
          {savedNotice && <p className="font-medium text-green-500">{savedNotice}</p>}
          {error && <p className="text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
