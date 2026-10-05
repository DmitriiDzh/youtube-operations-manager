"use client";

import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { formatFieldVelocity } from "./market-velocity-format";
import { LoadingIndicator } from "./operation-progress";

// Phase 9 slice 9H, part C (docs/roadmap/plans/PHASE_9_SLICE_9H_PART_C_PLAN.md) -- Videos tab.
// Mirrors getMarketVideosOverviewOutputSchema. A read-only, per-video aggregation across the whole
// watchlist -- no mutation actions live here.
type FieldVelocity = { value: number | null; basis: "insufficient_history" | "stale_latest" | "partial_window" | "full_window" };

type BreakoutAssessment = {
  videoId: string;
  dayOffset: number;
  videoViewCount: number | null;
  channelBaselineMedianViewCount: number | null;
  ratio: number | null;
  isBreakout: boolean;
  reason: string;
};

type VideoOverviewRow = {
  videoId: string;
  channelId: string;
  channelHandleOrUrl: string | null;
  title: string | null;
  publishedAt: string | null;
  viewCount: number | null;
  observedAt: string;
  velocity: FieldVelocity;
  breakout: BreakoutAssessment | null;
  topics: { topicId: string; name: string }[];
};


// breakout: null has exactly two real causes (plan §7) -- never one generic sentence covering
// both, and never a fabricated "not a breakout" verdict for a video this app never actually
// assessed.
function formatBreakout(breakout: BreakoutAssessment | null, publishedAt: string | null, recentVideoWindowDays: number): string {
  if (breakout === null) {
    return publishedAt === null ? "no publication date on record" : `older than the ${recentVideoWindowDays}-day recent-video window`;
  }
  if (breakout.ratio === null) return breakout.reason;
  return `${breakout.isBreakout ? "breakout" : "not a breakout"} -- ratio ${breakout.ratio.toFixed(2)} (${breakout.reason})`;
}

type Methodology = { velocityWindowDays: number; recentVideoWindowDays: number; baselineDayOffset: number };

export function MarketVideosPanel() {
  const [videos, setVideos] = useState<VideoOverviewRow[] | null>(null);
  const [methodology, setMethodology] = useState<Methodology | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVideos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/market-intelligence/videos-overview");
      if (res.ok) {
        const data: { videos: VideoOverviewRow[]; methodology: Methodology } = await res.json();
        setVideos(data.videos);
        setMethodology(data.methodology);
      } else {
        const body = await res.json().catch(() => null);
        setError(body?.message ?? "Failed to load Videos.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchVideos();
  }, [fetchVideos]);

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        Videos
        <InfoTooltip>
          Individual videos observed across the whole watchlist, from already-collected local data
          -- never a live YouTube call of its own. Views are only as fresh as this video&rsquo;s own
          last collection run (shown next to the figure) -- a video that has fallen off a channel&rsquo;s
          own ≤50-newest-uploads page simply stops being re-observed.
        </InfoTooltip>
      </h3>

      {loading && <LoadingIndicator className="text-xs text-zinc-500" />}
      {!loading && error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && videos && videos.length === 0 && (
        <p className="text-xs text-zinc-500">No videos observed yet -- add a channel to the watchlist below and collect a snapshot.</p>
      )}

      {!loading && videos && videos.length > 0 && methodology && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="pb-1 pr-3 font-medium">Title</th>
                <th className="pb-1 pr-3 font-medium">Channel</th>
                <th className="pb-1 pr-3 font-medium">Published</th>
                <th className="pb-1 pr-3 font-medium">Views (as of)</th>
                <th className="pb-1 pr-3 font-medium">Velocity</th>
                <th className="pb-1 pr-3 font-medium">Relative performance</th>
                <th className="pb-1 font-medium">Topic/format</th>
              </tr>
            </thead>
            <tbody>
              {videos.map((v) => (
                <tr key={v.videoId} className="border-t border-zinc-800 align-top">
                  <td className="py-1 pr-3 text-zinc-200">
                    {v.title === null ? <span className="italic text-zinc-500">Title not captured</span> : v.title}
                  </td>
                  <td className="py-1 pr-3 text-zinc-400">{v.channelHandleOrUrl ?? v.channelId}</td>
                  <td className="py-1 pr-3 text-zinc-400">{v.publishedAt ? formatDisplayDateTime(v.publishedAt) : "—"}</td>
                  <td className="py-1 pr-3 text-zinc-400">
                    {v.viewCount ?? "—"} <span className="text-zinc-600">(as of {formatDisplayDateTime(v.observedAt)})</span>
                  </td>
                  <td className="py-1 pr-3 text-zinc-400">{formatFieldVelocity(v.velocity, "views", methodology.velocityWindowDays)}</td>
                  <td className={`py-1 pr-3 ${v.breakout?.isBreakout ? "text-emerald-400" : "text-zinc-400"}`}>
                    {formatBreakout(v.breakout, v.publishedAt, methodology.recentVideoWindowDays)}
                  </td>
                  <td className="py-1 text-zinc-400">
                    {v.topics.length === 0 ? "No topic assigned" : v.topics.map((t) => t.name).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
