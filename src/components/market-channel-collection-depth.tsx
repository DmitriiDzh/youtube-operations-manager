"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { estimateCollectionUnits } from "@/lib/market-intelligence/collection-depth";
import { describeCompleteReason, parseDateDraft, parseDepthDraft } from "./market-collection-depth-fields";
import { useT } from "./ui-text-provider";
import { uiMessageText, errorText } from "@/lib/ui-text";

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
  const t = useT();
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
        setLoadError(t("depth.loadFailed"));
        return;
      }
      setLoadError(null);
      apply((await res.json()) as Progress);
    } catch {
      if (requestedChannelRef.current === channelId) setLoadError(t("depth.loadFailed"));
    }
  }, [channelId, apply, t]);

  useEffect(() => {
    setProgress(null);
    setError(null);
    setSavedNotice(null);
    void load();
  }, [load]);

  const parsedMax = parseDepthDraft(draftMax);
  const parsedDate = parseDateDraft(draftDate);
  const validationMessage = !parsedMax.ok ? uiMessageText(t, parsedMax.message) : !parsedDate.ok ? uiMessageText(t, parsedDate.message) : null;
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
        setError(errorText(t, data, t("depth.saveFailed"), { showErrorField: false }));
        return;
      }
      if (requestedChannelRef.current === channelId) apply(data as Progress);
      setSavedNotice(t("common.saved"));
    } catch {
      setError(t("depth.saveFailed"));
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
        {t("depth.title")}
        <InfoTooltip>{t("depth.tooltip")}</InfoTooltip>
      </p>
      {!progress && !loadError && <LoadingIndicator className="text-xs text-zinc-500" />}
      {loadError && (
        <div className="flex items-center gap-3">
          <p className="text-xs text-red-400">{loadError}</p>
          <button onClick={() => void load()} className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-200 hover:bg-zinc-800">
            {t("common.retry")}
          </button>
        </div>
      )}
      {progress && (
        <div className="space-y-2 text-xs text-zinc-400">
          <p>
            {progress.publishedAfter
              ? t("depth.storedFrom", { stored: progress.videosStored, max: progress.maxVideosPerChannel, date: progress.publishedAfter })
              : t("depth.stored", { stored: progress.videosStored, max: progress.maxVideosPerChannel })}{" "}
            &middot;{" "}
            {progress.complete
              ? describeCompleteReason(t, progress.completeReason)
                ? t("depth.completeReason", { reason: describeCompleteReason(t, progress.completeReason) })
                : t("depth.complete")
              : t("depth.notComplete")}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span>{t("depth.maxLabel")}</span>
              <input
                type="text"
                inputMode="numeric"
                value={draftMax}
                placeholder={progress.maxVideosPerChannelOverride === null ? String(progress.maxVideosPerChannel) : t("depth.placeholderDefault")}
                onChange={(e) => setDraftMax(e.target.value)}
                disabled={saving}
                className="mt-1 block w-28 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span>{t("depth.dateLabel")}</span>
              <input
                type="text"
                value={draftDate}
                placeholder={progress.publishedAfterOverride === null && progress.publishedAfter ? progress.publishedAfter : t("depth.placeholderDefault")}
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
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
          {validationMessage && <p className="text-amber-400">{validationMessage}</p>}
          {estimate && (
            <p>{t("depth.estimate", { first: estimate.firstCollection, worst: estimate.firstCollectionWorstCase, steady: estimate.steadyState })}</p>
          )}
          {savedNotice && <p className="font-medium text-green-500">{savedNotice}</p>}
          {error && <p className="text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
