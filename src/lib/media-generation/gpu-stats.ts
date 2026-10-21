import type { z } from "zod";
import { gpuStatsInputSchema } from "./schemas";
import { parseGpuSkipped, type StoredSessionRow } from "./sessions";
import { DomainError, parseWithSchema, type MediaGpuPlan, type MediaSettings } from "./contracts";
import { GPU_AVAILABILITY_NONE, GPU_AVAILABILITY_OVERALL, GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS, withImpliedNone } from "./gpu-availability";
import { orderedGpuCandidateIds } from "./gpu-plan";
import { orderCudaMinimums } from "./cuda-host";

const GPU_AVAILABILITY_UNKNOWN = "UNKNOWN";

/**
 * BL-206 (FO-REQ-0033, docs/roadmap/plans/GPU_STATS_PLAN.md §2.B/§2.C): a session's GPU wait, derived from its row (no table of its
 * own), and the statistics `factory_media_get_gpu_stats` builds from those records and the stored availability snapshots. Pure.
 */

/**
 * ready = ComfyUI answered (readyAt set); failed = the session ended `failed` before that; stopped = it ended otherwise before
 * that (a stop, a reject, an app restart); open = it has not ended yet.
 */
export type GpuWaitOutcome = "ready" | "failed" | "stopped" | "open";

export type GpuWaitRecord = {
  sessionId: string;
  requestedBy: string;
  status: string;
  outcome: GpuWaitOutcome;
  /** The GPU list the session tried: its own plan's, else the Settings' GPU and fallback list (as they are now); null = its stored plan is unreadable. */
  candidates: string[] | null;
  datacenterId: string | null;
  firstApprovedAt: string | null;
  /** True for a session from before schema v100: its first approval is its earliest capacity attempt. */
  waitApproximate: boolean;
  readyAt: string | null;
  /** readyAt − first approval, in minutes (two decimals); null unless ready. */
  waitMinutes: number | null;
  /** The GPU the session got (null unless ready). */
  gpuTypeId: string | null;
  capacityAttempts: number;
  /** BL-208: `kind` (stock | config) on records stored from 1.28.0 on; older records have none. */
  skipped: Array<{ gpuTypeId: string; reason: string; kind?: "stock" | "config" }> | null;
  /** For a failed session: the code its error starts with (`media_no_capacity`), else its first words as a code. */
  failureReason: string | null;
  usdCharged: number | null;
};

/**
 * The code a failed session's error starts with -- `media_no_capacity: …` → `media_no_capacity` -- or `other` when it does not start
 * with one (free text such as `pod creation failed (HTTP 500 …)` would split the buckets otherwise).
 */
export function failureReasonOf(error: string | null): string {
  const code = error ? /^[a-z][a-z0-9_]+(?=:)/.exec(error) : null;
  return code ? code[0] : "other";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The session's stored GPU plan; `invalid` when it cannot be read (that record then has no candidate list, the call goes on). */
function readGpuPlan(json: string | null | undefined): MediaGpuPlan | null | "invalid" {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as { candidates?: unknown };
    if (!parsed || !Array.isArray(parsed.candidates) || !parsed.candidates.every((id) => typeof id === "string")) return "invalid";
    return parsed as MediaGpuPlan;
  } catch {
    return "invalid";
  }
}

/** The Settings' part of the candidate list (`orderedGpuCandidateIds` without a plan). */
export type GpuCandidateSettings = Pick<MediaSettings, "gpuTypeId" | "gpuFallbackIds">;
/** BL-208: what the stats read from the Settings -- the candidate list and the default CUDA minimum of the availability read. */
export type GpuStatsSettings = GpuCandidateSettings & Pick<MediaSettings, "minCudaVersion">;

export function buildGpuWaitRecord(row: StoredSessionRow, settings: GpuCandidateSettings): GpuWaitRecord {
  const plan = readGpuPlan(row.gpuPlanJson);
  // The same ordered, de-duplicated list a start tries (gpu-plan.ts), from the session's plan, else the Settings as they are now.
  const candidates = plan === "invalid" ? null : orderedGpuCandidateIds(plan, settings);
  const first = row.firstApprovedAt ?? null;
  const outcome: GpuWaitOutcome = row.readyAt ? "ready" : row.status === "failed" ? "failed" : ["done", "rejected", "interrupted"].includes(row.status) ? "stopped" : "open";
  return {
    sessionId: row.id,
    requestedBy: row.requestedBy,
    status: row.status,
    outcome,
    candidates,
    datacenterId: row.datacenterId,
    firstApprovedAt: first ? first.toISOString() : null,
    waitApproximate: row.firstApprovedApproximate === true,
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    waitMinutes: outcome === "ready" && first && row.readyAt ? round2((row.readyAt.getTime() - first.getTime()) / 60_000) : null,
    gpuTypeId: outcome === "ready" ? row.gpuTypeId : null,
    capacityAttempts: row.capacityAttempts ?? 0,
    skipped: parseGpuSkipped(row.gpuSkippedJson ?? null),
    failureReason: outcome === "failed" ? failureReasonOf(row.error) : null,
    usdCharged: row.usdCharged,
  };
}

// -- §2.C: factory_media_get_gpu_stats --------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** The default window (the last 7 days) and the longest one (the log's retention). */
export const GPU_STATS_DEFAULT_DAYS = 7;
export const GPU_STATS_MAX_DAYS = 90;
/** At most this many sessions are listed with `includeSessions` (newest first); the counts always cover all of them. */
export const GPU_STATS_SESSION_LIST_LIMIT = 500;

export { gpuStatsInputSchema };
export type GpuStatsInput = z.infer<typeof gpuStatsInputSchema>;

/** Counts of one GPU availability key in one UTC hour (0-23) of one ISO weekday (1-7). */
export type GpuStatsCell = { hour: number; weekday: number; count: number };

export type GpuStatsStore = {
  /**
   * Under the time range: the snapshots per hour/weekday (snapshots table); per GPU (and `gpuTypeIds`) the snapshots with a row of
   * it; the stored rows per GPU, datacenter and level (and `gpuTypeIds` / `dataCenterIds`; the overall `*` rows only when no
   * datacenter is named or `*` is).
   */
  availabilityCells(filter: { since: Date; until: Date; gpuTypeIds?: string[]; dataCenterIds?: string[]; /** BL-208: one CUDA minimum ('' = none). */ minCudaVersion?: string }): Promise<{
    snapshots: GpuStatsCell[];
    gpus: Array<GpuStatsCell & { gpuTypeId: string }>;
    rows: Array<GpuStatsCell & { gpuTypeId: string; dataCenterId: string; stock: string | null }>;
  }>;
  /** Sessions whose first approval is in the range, newest first. */
  sessionsFirstApprovedBetween(since: Date, until: Date): Promise<StoredSessionRow[]>;
  /** BL-208: the CUDA minimums ('' = none) with an availability snapshot in the range. */
  availabilityMinimums?(range: { since: Date; until: Date }): Promise<string[]>;
};

/** Nearest-rank percentile: the k-th smallest value with k = ceil(p/100 × n); null for no values. */
export function nearestRank(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[Math.min(k, sorted.length) - 1];
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

export type GpuStatsWindow = { hoursUtc?: { from: number; to: number }; weekdays?: number[] };

export function inWindow(hour: number, weekday: number, window: GpuStatsWindow): boolean {
  if (window.weekdays && !window.weekdays.includes(weekday)) return false;
  if (window.hoursUtc) {
    const { from, to } = window.hoursUtc;
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }
  return true;
}

/** UTC hour and ISO weekday (1 = Monday … 7 = Sunday) of a time. */
export function hourAndWeekday(at: Date): { hour: number; weekday: number } {
  const day = at.getUTCDay();
  return { hour: at.getUTCHours(), weekday: day === 0 ? 7 : day };
}

export type GpuAvailabilityStatsEntry = {
  gpuTypeId: string;
  dataCenterId: string;
  snapshots: number;
  /** Snapshots with a stock level other than NONE (LOW / MEDIUM / HIGH). */
  inStock: number;
  inStockShare: number | null;
  /** Snapshots where RunPod listed the GPU there without a level: neither in stock nor NONE. */
  unknown: number;
  stock: Record<string, number>;
  /** Index = UTC hour 0-23. */
  byHourUtc: Array<{ snapshots: number; inStockShare: number | null }>;
  /** Index 0 = Monday … 6 = Sunday. */
  byWeekday: Array<{ snapshots: number; inStockShare: number | null }>;
};

/**
 * Per GPU × datacenter, inside the hour/weekday window: snapshots (those the GPU was read in), how many of them had stock (a level
 * other than NONE; a listing without a level is `unknown`, apart),
 * the counts per level and the same per hour and weekday. NONE is always snapshots − the stored rows of other levels, so old
 * snapshots (NONE stored) and new ones (NONE implied) count alike. A requested datacenter without any stored row still gets an
 * entry per GPU (all NONE).
 */
export function buildGpuAvailabilityStats(
  cells: Awaited<ReturnType<GpuStatsStore["availabilityCells"]>>,
  window: GpuStatsWindow,
  dataCenterIds?: string[]
): { snapshots: number; entries: GpuAvailabilityStatsEntry[] } {
  const cellKey = (hour: number, weekday: number) => hour * 8 + weekday;
  const gpuCells = new Map<string, Map<number, number>>();
  for (const c of cells.gpus) {
    if (!inWindow(c.hour, c.weekday, window)) continue;
    const m = gpuCells.get(c.gpuTypeId) ?? new Map<number, number>();
    m.set(cellKey(c.hour, c.weekday), (m.get(cellKey(c.hour, c.weekday)) ?? 0) + c.count);
    gpuCells.set(c.gpuTypeId, m);
  }
  type Acc = Map<number, Record<string, number>>;
  const keyed = new Map<string, { gpuTypeId: string; dataCenterId: string; cells: Acc }>();
  const entryFor = (gpuTypeId: string, dataCenterId: string) => {
    const key = `${gpuTypeId}\u0000${dataCenterId}`;
    const found = keyed.get(key) ?? { gpuTypeId, dataCenterId, cells: new Map() };
    keyed.set(key, found);
    return found;
  };
  for (const r of cells.rows) {
    if (!inWindow(r.hour, r.weekday, window)) continue;
    const entry = entryFor(r.gpuTypeId, r.dataCenterId);
    const levels = entry.cells.get(cellKey(r.hour, r.weekday)) ?? {};
    const level = r.stock ?? "UNKNOWN";
    levels[level] = (levels[level] ?? 0) + r.count;
    entry.cells.set(cellKey(r.hour, r.weekday), levels);
  }
  for (const dc of dataCenterIds ?? []) {
    if (dc === GPU_AVAILABILITY_OVERALL) continue;
    for (const gpuTypeId of gpuCells.keys()) entryFor(gpuTypeId, dc);
  }
  const entries: GpuAvailabilityStatsEntry[] = [];
  for (const entry of keyed.values()) {
    const denominators = gpuCells.get(entry.gpuTypeId) ?? new Map<number, number>();
    const stock: Record<string, number> = {};
    const byHour = Array.from({ length: 24 }, () => ({ snapshots: 0, inStock: 0 }));
    const byDay = Array.from({ length: 7 }, () => ({ snapshots: 0, inStock: 0 }));
    let snapshots = 0;
    let inStock = 0;
    let unknown = 0;
    for (const [key, read] of denominators) {
      const hour = Math.floor(key / 8);
      const weekday = key % 8;
      const levels = withImpliedNone(entry.cells.get(key) ?? {}, read);
      let total = 0;
      for (const [level, count] of Object.entries(levels)) {
        stock[level] = (stock[level] ?? 0) + count;
        total += count;
      }
      // In stock = a level RunPod gave (LOW / MEDIUM / HIGH); listed without a level (UNKNOWN) is counted apart (review).
      const cellUnknown = levels[GPU_AVAILABILITY_UNKNOWN] ?? 0;
      const present = total - (levels[GPU_AVAILABILITY_NONE] ?? 0) - cellUnknown;
      snapshots += total;
      inStock += present;
      unknown += cellUnknown;
      byHour[hour].snapshots += total;
      byHour[hour].inStock += present;
      byDay[weekday - 1].snapshots += total;
      byDay[weekday - 1].inStock += present;
    }
    entries.push({
      gpuTypeId: entry.gpuTypeId,
      dataCenterId: entry.dataCenterId,
      snapshots,
      inStock,
      inStockShare: share(inStock, snapshots),
      unknown,
      stock,
      byHourUtc: byHour.map((b) => ({ snapshots: b.snapshots, inStockShare: share(b.inStock, b.snapshots) })),
      byWeekday: byDay.map((b) => ({ snapshots: b.snapshots, inStockShare: share(b.inStock, b.snapshots) })),
    });
  }
  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  entries.sort((a, b) => byCode(a.gpuTypeId, b.gpuTypeId) || byCode(a.dataCenterId, b.dataCenterId));
  const snapshots = cells.snapshots.filter((c) => inWindow(c.hour, c.weekday, window)).reduce((sum, c) => sum + c.count, 0);
  return { snapshots, entries };
}

export type GpuWaitSummary = {
  count: number;
  ready: number;
  failed: number;
  stopped: number;
  open: number;
  /** failed / (ready + failed); null when none of them is decided. */
  failureRate: number | null;
  /** Nearest-rank, over the ready sessions only (a failure has no wait). */
  medianWaitMinutes: number | null;
  p90WaitMinutes: number | null;
  /** Ready sessions whose wait is approximate (before schema v100). */
  approximateWaits: number;
};

export function summarizeGpuWaits(records: GpuWaitRecord[]): GpuWaitSummary {
  const waits = records.filter((r) => r.outcome === "ready" && r.waitMinutes !== null).map((r) => r.waitMinutes as number);
  const ready = records.filter((r) => r.outcome === "ready").length;
  const failed = records.filter((r) => r.outcome === "failed").length;
  return {
    count: records.length,
    ready,
    failed,
    stopped: records.filter((r) => r.outcome === "stopped").length,
    open: records.filter((r) => r.outcome === "open").length,
    failureRate: share(failed, ready + failed),
    medianWaitMinutes: nearestRank(waits, 50),
    p90WaitMinutes: nearestRank(waits, 90),
    approximateWaits: records.filter((r) => r.outcome === "ready" && r.waitApproximate).length,
  };
}

export function buildGpuSessionStats(records: GpuWaitRecord[], includeSessions: boolean) {
  const byCandidates = new Map<string, { candidates: string[] | null; records: GpuWaitRecord[] }>();
  const byGpu = new Map<string, GpuWaitRecord[]>();
  const failures: Record<string, number> = {};
  for (const record of records) {
    const key = JSON.stringify(record.candidates);
    const group = byCandidates.get(key) ?? { candidates: record.candidates, records: [] };
    group.records.push(record);
    byCandidates.set(key, group);
    if (record.outcome === "ready" && record.gpuTypeId) byGpu.set(record.gpuTypeId, [...(byGpu.get(record.gpuTypeId) ?? []), record]);
    if (record.outcome === "failed" && record.failureReason) failures[record.failureReason] = (failures[record.failureReason] ?? 0) + 1;
  }
  return {
    ...summarizeGpuWaits(records),
    failures,
    byCandidates: [...byCandidates.values()].map((g) => ({ candidates: g.candidates, ...summarizeGpuWaits(g.records) })).sort((a, b) => b.count - a.count),
    byGpu: [...byGpu.entries()]
      .map(([gpuTypeId, list]) => {
        const summary = summarizeGpuWaits(list);
        return { gpuTypeId, ready: summary.ready, medianWaitMinutes: summary.medianWaitMinutes, p90WaitMinutes: summary.p90WaitMinutes };
      })
      .sort((a, b) => b.ready - a.ready || (a.gpuTypeId < b.gpuTypeId ? -1 : 1)),
    ...(includeSessions ? { list: records.slice(0, GPU_STATS_SESSION_LIST_LIMIT), listTruncated: records.length > GPU_STATS_SESSION_LIST_LIMIT } : {}),
  };
}

/**
 * `factory_media_get_gpu_stats` (READ): local data only -- the stored availability snapshots and this computer's sessions. Its
 * dependencies hold no RunPod client: it cannot reach RunPod, and costs nothing.
 */
export function createGpuStatsServices(deps: { store: GpuStatsStore; candidateSettings(): Promise<GpuStatsSettings>; clock: { now(): Date } }) {
  return {
    async getGpuStats(input: unknown = {}) {
      const parsed = parseWithSchema(gpuStatsInputSchema, input ?? {}, "GPU stats input");
      const to = parsed.to ? new Date(parsed.to) : deps.clock.now();
      const from = parsed.from ? new Date(parsed.from) : new Date(to.getTime() - GPU_STATS_DEFAULT_DAYS * DAY_MS);
      if (from.getTime() > to.getTime()) {
        throw new DomainError({ code: "invalid_request", message: `from (${from.toISOString()}) is after to (${to.toISOString()}).`, details: { from: from.toISOString(), to: to.toISOString() } });
      }
      if (to.getTime() - from.getTime() > GPU_STATS_MAX_DAYS * DAY_MS) {
        throw new DomainError({ code: "invalid_request", message: `The window is over ${GPU_STATS_MAX_DAYS} days (the log keeps ${GPU_STATS_MAX_DAYS}); narrow from/to.`, details: { from: from.toISOString(), to: to.toISOString(), maxDays: GPU_STATS_MAX_DAYS } });
      }
      if (parsed.hoursUtc && parsed.hoursUtc.from === parsed.hoursUtc.to) {
        throw new DomainError({ code: "invalid_request", message: "hoursUtc.from equals hoursUtc.to: an empty hour window.", details: { hoursUtc: parsed.hoursUtc } });
      }
      const window: GpuStatsWindow = { ...(parsed.hoursUtc ? { hoursUtc: parsed.hoursUtc } : {}), ...(parsed.weekdays ? { weekdays: parsed.weekdays } : {}) };
      const candidateSettings = await deps.candidateSettings();
      // BL-208 (GPU_START_FIXES_PLAN.md §F, AC-SF-10): the availability is read under ONE CUDA minimum -- the input's, else the
      // Settings' ('' = none) -- since every minimum in use is snapshotted at the same time; echoed with the minimums present.
      const minimum = parsed.minCudaVersion ?? candidateSettings.minCudaVersion ?? "";
      const cells = await deps.store.availabilityCells({
        since: from,
        until: to,
        ...(parsed.gpuTypeIds ? { gpuTypeIds: parsed.gpuTypeIds } : {}),
        ...(parsed.dataCenterIds ? { dataCenterIds: parsed.dataCenterIds } : {}),
        minCudaVersion: minimum,
      });
      const availability = buildGpuAvailabilityStats(cells, window, parsed.dataCenterIds);
      const present = deps.store.availabilityMinimums ? await deps.store.availabilityMinimums({ since: from, until: to }) : [];

      const rows = await deps.store.sessionsFirstApprovedBetween(from, to);
      const records = rows
        .filter((row) => {
          if (!row.firstApprovedAt) return false;
          const { hour, weekday } = hourAndWeekday(row.firstApprovedAt);
          return inWindow(hour, weekday, window);
        })
        .map((row) => buildGpuWaitRecord(row, candidateSettings))
        .filter((record) => !parsed.dataCenterIds || (record.datacenterId !== null && parsed.dataCenterIds.includes(record.datacenterId)))
        .filter((record) => !parsed.gpuTypeIds || (record.candidates ?? []).some((id) => parsed.gpuTypeIds!.includes(id)) || (record.gpuTypeId !== null && parsed.gpuTypeIds.includes(record.gpuTypeId)));

      return {
        from: from.toISOString(),
        to: to.toISOString(),
        hoursUtc: parsed.hoursUtc ?? null,
        weekdays: parsed.weekdays ?? null,
        intervalMinutes: GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS / 60_000,
        minCudaVersion: minimum === "" ? null : minimum,
        minCudaVersions: orderCudaMinimums(present).map((key) => (key === "" ? null : key)),
        snapshots: availability.snapshots,
        availability: availability.entries,
        sessions: buildGpuSessionStats(records, parsed.includeSessions === true),
      };
    },
  };
}
