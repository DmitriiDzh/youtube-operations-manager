// BL-117 slice 2 (docs/roadmap/plans/QUOTA_HISTORY_AND_GUARD_PLAN.md) -- the pre-flight quota guard. Pure facts and verdicts;
// no I/O here.

/**
 * Quota units one batch row costs, derived from the actual call sequence (docs/TECHNICAL_DEBT.md / write-executor):
 * a fresh `videos.list` before the write (1) + `videos.update` (50) + the read-back verification `videos.list` (1),
 * from Google's official table (`src/lib/youtube-quota/costs.ts`). Retries and the odd extra call are covered by
 * `QUOTA_SAFETY_MARGIN_UNITS`, not by inflating this number.
 */
export const UNITS_PER_WRITTEN_VIDEO = 1 + 50 + 1;
/** Units always held back from "remaining" (retries, Monitoring rounding, calls from another device in the last minutes). */
export const QUOTA_SAFETY_MARGIN_UNITS = 100;
/** Cloud Monitoring reflects usage with about a minute of delay: calls this device made in the last 2 minutes may not be in `used` yet. */
export const MONITORING_LAG_SECONDS = 120;
/** Background reads stop when less than this share of the limit is left (owner decision 2026-10-03, configurable, default 20%). */
export const DEFAULT_QUOTA_RESERVE_PERCENT = 20;
export const MIN_QUOTA_RESERVE_PERCENT = 0;
export const MAX_QUOTA_RESERVE_PERCENT = 90;

export type QuotaSnapshot =
  | { known: false; cloudConnected: boolean }
  | {
      known: true;
      limit: number;
      /** Google's usage since the last reset (`usedLast24h` in the cloud-quotas contract). */
      used: number;
      /** Units this device logged in the last `MONITORING_LAG_SECONDS`: not yet visible in `used`. */
      recentLocalUnits: number;
      resetsAt: string | null;
    };

export type GuardVerdict =
  | { decision: "allow"; estimatedUnits: number; remainingUnits: number; fitVideos: number }
  | { decision: "insufficient"; estimatedUnits: number; remainingUnits: number; fitVideos: number; resetsAt: string | null }
  | { decision: "unknown"; estimatedUnits: number; cloudConnected: boolean };
