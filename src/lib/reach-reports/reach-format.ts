/**
 * Display helpers for Reach numbers. **CTR scale is an assumption until the first real report is read
 * (BL-114):** `video_thumbnail_impressions_ctr` is treated as a RATIO (0.052 = 5.2%). If real data shows
 * the report already uses percent, this is the single place to change.
 */
export function formatCtr(ctr: number | null): string {
  if (ctr === null) return "—";
  return `${(ctr * 100).toFixed(2)}%`;
}

export function formatImpressions(value: number): string {
  return value.toLocaleString("en-US");
}
