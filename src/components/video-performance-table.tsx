"use client";

import { formatCtr, formatImpressions } from "@/lib/reach-reports/reach-format";
import { formatWatchTimeHours } from "@/lib/analytics/period";
import type { ReachSummary } from "./use-reach-summary";
import type { TopVideoRow } from "./use-top-videos";
import { LoadingIndicator } from "./operation-progress";

/**
 * BL-120 -- one row per video with what the owner looks at together: views and watch time (stored Analytics data) next to thumbnail impressions
 * and CTR (stored Reach data). A video without a Reach row in the period shows a dash, never zero. Reach lists only the top videos by
 * impressions, so a quieter video may show a dash even though it has some.
 */
export function VideoPerformanceTable({
  rows,
  reach,
  loading,
  onSelectVideo,
}: {
  rows: TopVideoRow[];
  reach: ReachSummary | null;
  loading: boolean;
  onSelectVideo?: (videoId: string) => void;
}) {
  const reachByVideo = new Map((reach?.videos ?? []).map((video) => [video.videoId, video]));
  const reachReady = reach?.state === "ready";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h4 className="mb-3 text-sm font-medium text-zinc-300">Top videos, this period</h4>
      {loading ? (
        <LoadingIndicator className="text-sm text-zinc-500" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No collected data for this period yet — use &ldquo;Collect now&rdquo; to fetch it.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="py-1 font-medium">Video</th>
                <th className="py-1 text-right font-medium">Views</th>
                <th className="py-1 text-right font-medium">Watch time (h)</th>
                <th className="py-1 text-right font-medium">Impressions</th>
                <th className="py-1 text-right font-medium">CTR</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const r = reachByVideo.get(row.videoId);
                return (
                  <tr
                    key={row.videoId}
                    className={`border-t border-zinc-800 text-zinc-300 ${onSelectVideo ? "cursor-pointer hover:bg-zinc-800/40" : ""}`}
                    onClick={onSelectVideo ? () => onSelectVideo(row.videoId) : undefined}
                  >
                    <td className="py-1.5">
                      <div className="flex items-center gap-3">
                        {row.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={row.thumbnail} alt="" className="h-9 w-16 shrink-0 rounded object-cover" />
                        ) : (
                          <div className="h-9 w-16 shrink-0 rounded bg-zinc-800" />
                        )}
                        <span className="min-w-0 max-w-[24rem] truncate" title={row.title}>
                          {row.title}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 text-right">{row.views.toLocaleString()}</td>
                    <td className="py-1.5 text-right">{formatWatchTimeHours(row.watchMinutes)}</td>
                    <td className="py-1.5 text-right">{reachReady && r ? formatImpressions(r.impressions) : "—"}</td>
                    <td className="py-1.5 text-right">{reachReady && r ? formatCtr(r.ctr) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
