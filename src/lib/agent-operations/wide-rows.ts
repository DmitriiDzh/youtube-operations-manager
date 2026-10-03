/**
 * Long -> wide layout for per-video metric rows: one row per video per day, one column per metric. A metric with no stored row for that day
 * is `null` (the Analytics API omits zero-activity days, so absence is not zero -- never zero-filled). Columns follow `metricNames` order;
 * rows are ordered by videoId, then date. A row whose metric is not in `metricNames` is ignored (it was not asked for).
 */
export function toWideMetricRows(
  rows: ReadonlyArray<{ videoId: string; metricDate: string; metricName: string; metricValue: number }>,
  metricNames: readonly string[]
): Array<Record<string, string | number | null>> {
  const wanted = new Set(metricNames);
  const byKey = new Map<string, Record<string, string | number | null>>();
  for (const row of rows) {
    if (!wanted.has(row.metricName)) continue;
    const key = `${row.videoId}\u0000${row.metricDate}`;
    let wide = byKey.get(key);
    if (!wide) {
      wide = { videoId: row.videoId, metricDate: row.metricDate };
      for (const name of metricNames) wide[name] = null;
      byKey.set(key, wide);
    }
    wide[row.metricName] = row.metricValue;
  }
  return [...byKey.values()].sort(
    (a, b) => String(a.videoId).localeCompare(String(b.videoId)) || String(a.metricDate).localeCompare(String(b.metricDate))
  );
}
