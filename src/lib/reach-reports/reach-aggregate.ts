import { TOP_VIDEOS_LIMIT, type ReachDailyPoint, type ReachVideoPoint } from "./contracts";

type Row = { date: string; videoId: string; impressions: number; ctr: number | null };

/**
 * Click-through rate is a ratio, so it can never be summed or averaged across rows. The combined value is
 * impressions-weighted: total clicks / total impressions, where clicks = ctr x impressions. A row with no CTR
 * contributes to neither the numerator nor the denominator (its clicks are unknown, not zero); if no row has
 * a CTR the result is `null`, never 0.
 */
export function weightedCtr(rows: ReadonlyArray<{ impressions: number; ctr: number | null }>): number | null {
  let clicks = 0;
  let impressions = 0;
  for (const row of rows) {
    if (row.ctr === null) continue;
    clicks += row.ctr * row.impressions;
    impressions += row.impressions;
  }
  return impressions > 0 ? clicks / impressions : null;
}

function sumImpressions(rows: ReadonlyArray<{ impressions: number }>): number {
  return rows.reduce((total, row) => total + row.impressions, 0);
}

export function aggregateReach(rows: readonly Row[]): {
  daily: ReachDailyPoint[];
  videos: ReachVideoPoint[];
  totals: { impressions: number; ctr: number | null };
} {
  const byDate = new Map<string, Row[]>();
  const byVideo = new Map<string, Row[]>();
  for (const row of rows) {
    byDate.set(row.date, [...(byDate.get(row.date) ?? []), row]);
    byVideo.set(row.videoId, [...(byVideo.get(row.videoId) ?? []), row]);
  }

  const daily = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, group]) => ({ date, impressions: sumImpressions(group), ctr: weightedCtr(group) }));

  const videos = [...byVideo.entries()]
    .map(([videoId, group]) => ({ videoId, impressions: sumImpressions(group), ctr: weightedCtr(group) }))
    .sort((a, b) => b.impressions - a.impressions || a.videoId.localeCompare(b.videoId))
    .slice(0, TOP_VIDEOS_LIMIT);

  return { daily, videos, totals: { impressions: sumImpressions(rows), ctr: weightedCtr(rows) } };
}
