"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";

type Signal = {
  linkId: string;
  project: string;
  article: string;
  daily: { date: string; views: number }[];
  last30DaysViews: number | null;
  previous30DaysViews: number | null;
};

/**
 * Phase 13 slice 13.8 (docs/roadmap/plans/PHASE_13_PLAN.md) -- an interest signal from outside
 * YouTube for one Research topic: daily page views of the Wikipedia articles linked to it. Its own
 * component and feature module, so the topics panel works the same whether or not it loads.
 */
export function TopicWikipediaSignals({ topicId }: { topicId: string }) {
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [article, setArticle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/market-intelligence/topics/${encodeURIComponent(topicId)}/wikipedia`;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(base);
      if (!res.ok) return;
      setSignals(((await res.json()) as { signals: Signal[] }).signals);
    } catch {
      // Non-fatal: the section just stays empty.
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function link() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ article }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message ?? `Error ${res.status}`);
        return;
      }
      setArticle("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function unlink(linkId: string) {
    setBusy(true);
    try {
      await fetch(`${base}/${encodeURIComponent(linkId)}`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const change = (s: Signal) => {
    if (s.last30DaysViews === null || s.previous30DaysViews === null || s.previous30DaysViews === 0) return null;
    return ((s.last30DaysViews - s.previous30DaysViews) / s.previous30DaysViews) * 100;
  };

  return (
    <div className="space-y-2 border-t border-zinc-800 pt-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
        Wikipedia interest
        <InfoTooltip>
          Daily page views of Wikipedia articles you link to this topic -- a signal of interest from outside YouTube.
          Free (Wikimedia), refreshed every few hours. Turn it off under Settings → API → Wikipedia reads.
        </InfoTooltip>
      </div>
      {signals?.map((s) => {
        const pct = change(s);
        return (
          <div key={s.linkId} className="flex items-center justify-between gap-2 text-xs text-zinc-300">
            <span>
              {s.project.replace(".wikipedia", "")}: {s.article.replace(/_/g, " ")} &middot; last 30 days:{" "}
              {s.last30DaysViews === null ? "no data yet" : s.last30DaysViews.toLocaleString()}
              {pct !== null && (
                <span className={pct >= 0 ? "text-emerald-400" : "text-red-400"}>
                  {" "}
                  ({pct >= 0 ? "+" : ""}
                  {pct.toFixed(0)}% vs previous 30)
                </span>
              )}
            </span>
            <button
              disabled={busy}
              onClick={() => void unlink(s.linkId)}
              className="rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:border-red-700 hover:text-red-400 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className="flex gap-2">
        <input
          value={article}
          onChange={(e) => setArticle(e.target.value)}
          placeholder="Wikipedia article title or URL, e.g. Ambient music"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
        />
        <button
          disabled={busy || article.trim().length === 0}
          onClick={() => void link()}
          className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          Link
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
