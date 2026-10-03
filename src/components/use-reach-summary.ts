import { useCallback, useEffect, useRef, useState } from "react";
import { computeDefaultPeriodRange } from "@/lib/analytics/period";

export type ReachSummary = {
  state: "no_job" | "waiting_for_first_report" | "ready";
  coverage: { firstDate: string | null; lastDate: string | null; importedFiles: number };
  daily: Array<{ date: string; impressions: number; ctr: number | null }>;
  videos: Array<{ videoId: string; impressions: number; ctr: number | null }>;
  totals: { impressions: number; ctr: number | null };
};

/**
 * BL-120 -- the stored Reach numbers (impressions, CTR) for the selected period, read from the local `reach` route. Shared by the Overview cards,
 * the per-video table and (via the same endpoint) the Content tab, so one read serves what is on screen. A failed read leaves `null`: the cards
 * then say nothing rather than showing zero.
 */
export function useReachSummary(channelId: string | null, periodDays: number) {
  const [reach, setReach] = useState<ReachSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (!channelId) return;
    const requestId = ++latest.current;
    setLoading(true);
    try {
      const { startDate, endDate } = computeDefaultPeriodRange(periodDays);
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/reach?startDate=${startDate}&endDate=${endDate}`);
      const body = res.ok ? ((await res.json()) as ReachSummary) : null;
      if (requestId === latest.current) setReach(body);
    } catch {
      if (requestId === latest.current) setReach(null);
    } finally {
      if (requestId === latest.current) setLoading(false);
    }
  }, [channelId, periodDays]);

  useEffect(() => {
    void load();
  }, [load]);

  return { reach, loading, reload: load };
}
