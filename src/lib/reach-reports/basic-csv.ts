import type { ParsedReportingCsv } from "@/lib/youtube-read-gateway";
import {
  BASIC_COLUMNS,
  BASIC_REQUIRED_COLUMNS,
  DomainError,
  TRAFFIC_SOURCE_COLUMNS,
  TRAFFIC_SOURCE_REQUIRED_COLUMNS,
  type BasicDailyRow,
  type BasicMetricName,
  type TrafficSourceDailyRow,
  type TrafficSourceMetricName,
} from "./contracts";
import { normalizeReportDate } from "./reach-csv";

function malformed(message: string, details?: unknown): DomainError {
  return new DomainError({ code: "reporting_report_malformed", message, details });
}

function assertColumns(parsed: ParsedReportingCsv, required: readonly string[], label: string) {
  const missing = required.filter((column) => !parsed.columns.includes(column));
  if (missing.length > 0) {
    throw malformed(`${label} report is missing expected column(s): ${missing.join(", ")}.`, { columns: parsed.columns });
  }
}

/**
 * The row's own identity. Google leaves `channel_id` (and `video_id`) empty for a deleted resource and keeps the row so totals stay
 * right; any OTHER channel's id fails the whole file, as for Reach.
 */
function rowKeyParts(row: Record<string, string>, line: number, expectedChannelId: string, label: string) {
  const channelId = (row.channel_id ?? "").trim();
  if (channelId !== "" && channelId !== expectedChannelId) {
    throw malformed(`${label} report row ${line} belongs to channel "${channelId}", expected "${expectedChannelId}".`);
  }
  const date = normalizeReportDate((row.date ?? "").trim());
  if (!date) throw malformed(`${label} report row ${line} has an unreadable date "${row.date}".`);
  return { date, videoId: (row.video_id ?? "").trim() };
}

/** An empty cell carries no value (the channel-level row has only the subscriber counts); anything else must be a number >= 0. */
function metricValue(row: Record<string, string>, column: string, line: number, label: string): number | null {
  if (!(column in row)) return null;
  const raw = row[column].trim();
  if (raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw malformed(`${label} report row ${line} has an invalid ${column} value "${raw}".`);
  return value;
}

/** Sums of decimal minutes drift in the last bits; six decimals is far below anything a report shows. */
function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function addInto<K extends string>(target: Record<K, number | null>, metric: K, value: number | null) {
  if (value === null) return;
  target[metric] = rounded((target[metric] ?? 0) + value);
}

const BASIC_METRICS = Object.keys(BASIC_COLUMNS).filter(
  (key) => key !== "date" && key !== "channelId" && key !== "videoId"
) as BasicMetricName[];

/**
 * Maps a parsed `channel_basic_a3` file to one row per video and day: every metric summed over the file's rows (country,
 * subscribed status, live or on demand), anonymised rows (`ZZ`, an empty `video_id`) included. Never averages: the average view
 * duration is derived from the sums when it is read. Fails the whole file on a missing required column, another channel's row, an
 * unreadable date or a value that is not a number >= 0.
 */
export function mapBasicRows(parsed: ParsedReportingCsv, expectedChannelId: string): BasicDailyRow[] {
  assertColumns(parsed, BASIC_REQUIRED_COLUMNS, "Basic");
  const groups = new Map<string, BasicDailyRow>();
  parsed.rows.forEach((row, index) => {
    const line = index + 2;
    const { date, videoId } = rowKeyParts(row, line, expectedChannelId, "Basic");
    const key = `${date}\u0000${videoId}`;
    let group = groups.get(key);
    if (!group) {
      group = { date, videoId, ...(Object.fromEntries(BASIC_METRICS.map((metric) => [metric, null])) as Record<BasicMetricName, null>) };
      groups.set(key, group);
    }
    for (const metric of BASIC_METRICS) addInto(group, metric, metricValue(row, BASIC_COLUMNS[metric], line, "Basic"));
  });
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date) || a.videoId.localeCompare(b.videoId));
}

const TRAFFIC_METRICS: TrafficSourceMetricName[] = ["views", "engagedViews", "watchTimeMinutes"];

/**
 * Maps a parsed `channel_traffic_source_a3` file to one row per video, day and traffic source code, summed over the other
 * dimensions and every `traffic_source_detail` (the below-threshold remainder included). A code Google adds later is kept as it
 * is; a code that is not a whole number >= 0 fails the file, like the other checks in `mapBasicRows`.
 */
export function mapTrafficSourceRows(parsed: ParsedReportingCsv, expectedChannelId: string): TrafficSourceDailyRow[] {
  assertColumns(parsed, TRAFFIC_SOURCE_REQUIRED_COLUMNS, "Traffic source");
  const groups = new Map<string, TrafficSourceDailyRow>();
  parsed.rows.forEach((row, index) => {
    const line = index + 2;
    const { date, videoId } = rowKeyParts(row, line, expectedChannelId, "Traffic source");
    const rawType = (row[TRAFFIC_SOURCE_COLUMNS.trafficSourceType] ?? "").trim();
    if (!/^\d+$/.test(rawType)) throw malformed(`Traffic source report row ${line} has an invalid traffic_source_type "${rawType}".`);
    const trafficSourceType = Number(rawType);
    const key = `${date}\u0000${videoId}\u0000${trafficSourceType}`;
    let group = groups.get(key);
    if (!group) {
      group = { date, videoId, trafficSourceType, views: null, engagedViews: null, watchTimeMinutes: null };
      groups.set(key, group);
    }
    for (const metric of TRAFFIC_METRICS) addInto(group, metric, metricValue(row, TRAFFIC_SOURCE_COLUMNS[metric], line, "Traffic source"));
  });
  return [...groups.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.videoId.localeCompare(b.videoId) || a.trafficSourceType - b.trafficSourceType
  );
}
