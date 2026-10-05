import type { ParsedReportingCsv } from "@/lib/youtube-read-gateway";
import { DomainError, REACH_BASIC_COLUMNS, type ReachRow } from "./contracts";

function malformed(message: string, details?: unknown): DomainError {
  return new DomainError({ code: "reporting_report_malformed", message, details });
}

/** `YYYYMMDD` (what the Reporting API's `date` dimension uses) or `YYYY-MM-DD` -> `YYYY-MM-DD`; a real calendar date only. */
export function normalizeReportDate(raw: string): string | null {
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const match = compact ?? dashed;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Maps a parsed `channel_reach_basic_a1` file to rows. Fails the WHOLE file (rather than importing part of
 * it) on anything that would silently corrupt data: a missing documented column, a row naming a different
 * channel than the one this report was fetched for (identity check), an unreadable date/number, or two rows
 * for the same video and day.
 */
export function mapReachBasicRows(parsed: ParsedReportingCsv, expectedChannelId: string): ReachRow[] {
  const missing = Object.values(REACH_BASIC_COLUMNS).filter((column) => !parsed.columns.includes(column));
  if (missing.length > 0) {
    throw malformed(`Reach report is missing expected column(s): ${missing.join(", ")}.`, { columns: parsed.columns });
  }

  const seen = new Set<string>();
  return parsed.rows.map((row, index) => {
    const line = index + 2;
    const channelId = row[REACH_BASIC_COLUMNS.channelId];
    if (channelId !== expectedChannelId) {
      throw malformed(`Reach report row ${line} belongs to channel "${channelId}", expected "${expectedChannelId}".`);
    }

    const date = normalizeReportDate(row[REACH_BASIC_COLUMNS.date]);
    if (!date) throw malformed(`Reach report row ${line} has an unreadable date "${row[REACH_BASIC_COLUMNS.date]}".`);

    const videoId = row[REACH_BASIC_COLUMNS.videoId].trim();
    if (!videoId) throw malformed(`Reach report row ${line} has an empty video_id.`);

    const rawImpressions = row[REACH_BASIC_COLUMNS.impressions].trim();
    const impressions = Number(rawImpressions);
    if (rawImpressions === "" || !Number.isInteger(impressions) || impressions < 0) {
      throw malformed(`Reach report row ${line} has an invalid impressions value "${rawImpressions}".`);
    }

    const rawCtr = row[REACH_BASIC_COLUMNS.ctr].trim();
    let ctr: number | null = null;
    if (rawCtr !== "") {
      ctr = Number(rawCtr);
      if (!Number.isFinite(ctr) || ctr < 0) {
        throw malformed(`Reach report row ${line} has an invalid CTR value "${rawCtr}".`);
      }
    }

    const key = `${date}\u0000${videoId}`;
    if (seen.has(key)) throw malformed(`Reach report has more than one row for video ${videoId} on ${date}.`);
    seen.add(key);

    return { date, videoId, impressions, ctr };
  });
}
