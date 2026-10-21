import type { RunpodApiClient } from "@/lib/media-gateway";
import { GPU_AVAILABILITY_LOG_RETENTION_DAYS, isDomainError, parseWithSchema, type MediaCredentialsStatus, type MediaSettings } from "./contracts";
import { orderCudaMinimums } from "./cuda-host";
import {
  buildGpuAvailability,
  buildGpuAvailabilitySnapshotRows,
  DEFAULT_AVAILABILITY_MIN_VRAM_GB,
  GPU_AVAILABILITY_NONE,
  GPU_AVAILABILITY_OVERALL,
  GPU_AVAILABILITY_SNAPSHOT_DUE_MS,
  GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS,
  gpuAvailabilityLogInputSchema,
  summarizeGpuAvailabilityGroups,
  type GpuAvailabilityLogRow,
  type GpuAvailabilitySummaryEntry,
} from "./gpu-availability";

/**
 * BL-172 (FO-REQ-0016 B, docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md): RunPod's GPU stock stored regularly, so the Factory
 * Operator can see how often a GPU had stock in a datacenter before choosing where the media volume lives. Device-local; each
 * computer keeps its own log. BL-206 (FO-REQ-0033, GPU_STATS_PLAN.md §2.A): every 15 minutes, compactly -- one row per snapshot
 * in `media_gpu_availability_snapshots` (BL-208, v102: `media_gpu_availability_cuda_snapshots`, one per time and CUDA minimum), and
 * datacenter rows only where the stock was not NONE.
 */

/** BL-208: `minCudaVersion` -- the snapshots of one CUDA minimum ('' = read without one); the services always give it. */
export type GpuAvailabilityLogFilter = { since?: Date; until?: Date; gpuTypeId?: string; dataCenterId?: string; minCudaVersion?: string };

export type GpuAvailabilityLogStore = {
  /** BL-208: the newest snapshot of one CUDA minimum ('' = none); without one, of any. */
  latestAt(minCudaVersion?: string): Promise<Date | null>;
  /** Every row gets `at`, plus one snapshot row (per `at` and the rows' minimum); rows and snapshots older than the retention are pruned on the way. */
  insertSnapshot(at: Date, rows: GpuAvailabilityLogRow[]): Promise<void>;
  list(filter: GpuAvailabilityLogFilter & { limit: number }): Promise<Array<GpuAvailabilityLogRow & { at: Date }>>;
  /**
   * `snapshots` / `firstAt` / `lastAt`: the snapshots taken in the time range (gpu/datacenter filters do not apply); `groups`: the
   * stored rows per level under the whole filter; `gpuSnapshots`: per GPU, the snapshots in the range with a row of it.
   */
  summarize(filter: GpuAvailabilityLogFilter): Promise<{
    snapshots: number;
    firstAt: Date | null;
    lastAt: Date | null;
    groups: Array<{ gpuTypeId: string; dataCenterId: string; stock: string | null; count: number }>;
    gpuSnapshots: Array<{ gpuTypeId: string; snapshots: number }>;
  }>;
  /** BL-208: the CUDA minimums ('' = none) with a snapshot in the time range. */
  minimums?(range: { since?: Date; until?: Date }): Promise<string[]>;
};

export type GpuAvailabilitySnapshotResult =
  | { status: "taken"; at: string; rows: number }
  | { status: "skipped"; reason: "fresh" | "gateway_off" | "not_configured" | "backoff" }
  | { status: "failed"; code: string; message: string };

/**
 * One tick's outcome. BL-208 (GPU_START_FIXES_PLAN.md §F): with more than one CUDA minimum in use, `minimums` gives each one's own
 * result (null = no minimum) and the top level sums them up: taken when any was taken (rows = their sum), else failed when any
 * failed (the first failure), else skipped. With one minimum the outcome is that minimum's own result, as before.
 */
export type GpuAvailabilitySnapshotOutcome = GpuAvailabilitySnapshotResult & { minimums?: Array<{ minCudaVersion: string | null } & GpuAvailabilitySnapshotResult> };

/** BL-208: '' (the stored key for "no minimum") <-> null at the boundary. */
const minimumOut = (key: string): string | null => (key === "" ? null : key);

/** After a failed reading, the next attempt waits this long (the timer ticks more often than that). */
/** BL-206: 15 min (was 1 h), so one failed reading costs at most one 15-min snapshot (FO-REQ-0033: no gap over an hour). */
export const GPU_AVAILABILITY_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
export const GPU_AVAILABILITY_LOG_DEFAULT_LIMIT = 1000;

export function createGpuAvailabilityLogServices(deps: {
  store: GpuAvailabilityLogStore;
  base: {
    getGatewayEnabled(): Promise<boolean>;
    getCredentialsStatus(): Promise<MediaCredentialsStatus>;
    getSettings(): Promise<MediaSettings>;
    resolveRunpodClient(): Promise<RunpodApiClient>;
  };
  /** BL-208: the CUDA minimums the installed workflow templates declare (absent = none). */
  templateMinCudaVersions?: () => Promise<string[]>;
  clock: { now(): Date };
  log?: (line: string) => void;
}) {
  /** BL-208: the last failed reading per CUDA minimum ('' = none): each minimum backs off on its own. */
  const lastFailureAt = new Map<string, Date>();

  /** BL-208 (§F): the Settings' minimum plus every installed template's, without repeats, ascending; none anywhere = [''] (no filter). */
  async function minimumsInUse(settings: MediaSettings): Promise<string[]> {
    const fromTemplates = deps.templateMinCudaVersions ? await deps.templateMinCudaVersions() : [];
    const all = [settings.minCudaVersion, ...fromTemplates].filter((v): v is string => typeof v === "string" && v.length > 0);
    return all.length > 0 ? orderCudaMinimums(all) : [""];
  }

  /** BL-208: the minimum a read is under -- the input's, else the Settings' ('' = none). */
  async function readMinimum(input: string | undefined): Promise<string> {
    if (input !== undefined) return input;
    return (await deps.base.getSettings()).minCudaVersion ?? "";
  }

  return {
    /**
     * The timer's one call (every 5 minutes): for every CUDA minimum in use (BL-208: the Settings' and the installed templates'), a
     * snapshot when that minimum's newest stored one is 14 minutes old (BL-206; nominally every 15). Skips without any RunPod call
     * while the media gateway is off or RunPod is not configured, and never throws: a failed reading is logged and that minimum is
     * retried 15 minutes later, while the others go on. Per tick one datacenter-catalog read and one GPU-catalog read per due minimum,
     * Secure Cloud (network volumes exist only there).
     */
    async snapshotGpuAvailabilityIfDue(): Promise<GpuAvailabilitySnapshotOutcome> {
      // The tick's own start: a failure is dated here, not after the reads, so the retry falls on the tick 15 minutes later.
      const now = deps.clock.now();
      const results = new Map<string, GpuAvailabilitySnapshotResult>();
      let minimums: string[] = [""];
      const fail = (keys: string[], error: unknown) => {
        const code = isDomainError(error) ? error.code : "error";
        const message = error instanceof Error ? error.message : String(error);
        for (const key of keys) {
          lastFailureAt.set(key, now);
          results.set(key, { status: "failed", code, message });
        }
        const which = keys.some((k) => k !== "") ? ` for CUDA ${keys.map((k) => k || "none").join(", ")}` : "";
        deps.log?.(`[gpu-availability] the GPU availability snapshot failed (${code})${which}: ${message}`);
      };
      const outcome = (): GpuAvailabilitySnapshotOutcome => {
        const each = minimums.map((key) => ({ minCudaVersion: minimumOut(key), ...(results.get(key) ?? { status: "skipped" as const, reason: "fresh" as const }) }));
        if (each.length === 1) {
          const { minCudaVersion: _single, ...only } = each[0];
          void _single;
          return only as GpuAvailabilitySnapshotResult;
        }
        const taken = each.filter((r): r is { minCudaVersion: string | null } & Extract<GpuAvailabilitySnapshotResult, { status: "taken" }> => r.status === "taken");
        const failed = each.find((r): r is { minCudaVersion: string | null } & Extract<GpuAvailabilitySnapshotResult, { status: "failed" }> => r.status === "failed");
        const top: GpuAvailabilitySnapshotResult =
          taken.length > 0
            ? { status: "taken", at: now.toISOString(), rows: taken.reduce((sum, r) => sum + r.rows, 0) }
            : failed
              ? { status: "failed", code: failed.code, message: failed.message }
              : { status: "skipped", reason: each.every((r) => r.status === "skipped" && r.reason === "fresh") ? "fresh" : "backoff" };
        return { ...top, minimums: each };
      };
      let due: string[] = [];
      try {
        const settings = await deps.base.getSettings();
        minimums = await minimumsInUse(settings);
        for (const key of minimums) {
          const latest = await deps.store.latestAt(key);
          if (latest && now.getTime() - latest.getTime() < GPU_AVAILABILITY_SNAPSHOT_DUE_MS) {
            results.set(key, { status: "skipped", reason: "fresh" });
            continue;
          }
          const failedAt = lastFailureAt.get(key);
          if (failedAt && now.getTime() - failedAt.getTime() < GPU_AVAILABILITY_FAILURE_BACKOFF_MS) {
            results.set(key, { status: "skipped", reason: "backoff" });
            continue;
          }
          due.push(key);
        }
        if (due.length === 0) return outcome();
        if (!(await deps.base.getGatewayEnabled())) return { status: "skipped", reason: "gateway_off" };
        if (!(await deps.base.getCredentialsStatus()).configured) return { status: "skipped", reason: "not_configured" };
        const client = await deps.base.resolveRunpodClient();
        // One datacenter read for the tick; one GPU-catalog read per due minimum (each stored, or failing, on its own).
        const [dataCenters, ...gpuReads] = await Promise.all([
          client.listDataCenters(),
          ...due.map((key) =>
            client.listGpuTypes({ cloud: "SECURE", ...(key ? { minCudaVersion: key } : {}) }).then(
              (gpus) => ({ ok: true as const, gpus }),
              (error: unknown) => ({ ok: false as const, error })
            )
          ),
        ]);
        if (!dataCenters.some((dc) => dc.networkVolumeTypes.length > 0)) throw new Error("RunPod's catalog listed no datacenter with network volumes");
        for (const [index, key] of due.entries()) {
          const read = gpuReads[index];
          try {
            if (!read.ok) throw read.error;
            const availability = buildGpuAvailability({
              gpus: read.gpus,
              dataCenters,
              input: { minVramGb: DEFAULT_AVAILABILITY_MIN_VRAM_GB },
              settings: { ...settings, cloudType: "SECURE", minCudaVersion: (key || null) as MediaSettings["minCudaVersion"] },
              now,
            });
            // Either catalog coming back empty is a failure, not a snapshot: it would be stored as fresh and hide the gap.
            if (availability.gpus.length === 0) throw new Error("RunPod's catalog listed no GPU of 24 GB or more");
            if (!availability.dataCenters.some((dc) => dc.networkVolumeTypes.length > 0)) throw new Error("RunPod's catalog listed no datacenter with network volumes");
            const rows = buildGpuAvailabilitySnapshotRows(availability);
            await deps.store.insertSnapshot(now, rows);
            lastFailureAt.delete(key);
            results.set(key, { status: "taken", at: now.toISOString(), rows: rows.length });
          } catch (error) {
            fail([key], error);
          }
        }
        due = [];
        return outcome();
      } catch (error) {
        if (isDomainError(error) && error.code === "media_generation_not_configured") return { status: "skipped", reason: "not_configured" };
        if (isDomainError(error) && error.code === "media_gateway_disabled") return { status: "skipped", reason: "gateway_off" };
        fail(due.length > 0 ? due : minimums, error);
        return outcome();
      }
    },

    /** `factory_media_list_gpu_availability_log`: the stored rows newest first, or with `summary` the counts per stock level. */
    async listGpuAvailabilityLog(input: unknown = {}): Promise<
      {
        intervalHours: number;
        retentionDays: number;
        lastSnapshotAt: string | null;
        /** BL-208: the CUDA minimum this read is under (null = none) and the minimums with snapshots in the range. */
        minCudaVersion: string | null;
        minCudaVersions: Array<string | null>;
      } & (
        | { rows: Array<GpuAvailabilityLogRow & { at: string }> }
        | { summary: { snapshots: number; firstAt: string | null; lastAt: string | null; entries: GpuAvailabilitySummaryEntry[] } }
      )
    > {
      const parsed = parseWithSchema(gpuAvailabilityLogInputSchema, input ?? {}, "GPU availability log input");
      // BL-208 (§F, AC-SF-10): every read is under ONE CUDA minimum -- the input's, else the Settings' -- so two minimums read at the
      // same time are never counted as two snapshots. The answer echoes it and lists the minimums with snapshots in the range.
      const minimum = await readMinimum(parsed.minCudaVersion);
      const filter: GpuAvailabilityLogFilter = {
        ...(parsed.since ? { since: new Date(parsed.since) } : {}),
        ...(parsed.until ? { until: new Date(parsed.until) } : {}),
        ...(parsed.gpuTypeId ? { gpuTypeId: parsed.gpuTypeId } : {}),
        ...(parsed.dataCenterId ? { dataCenterId: parsed.dataCenterId } : {}),
        minCudaVersion: minimum,
      };
      const latest = await deps.store.latestAt(minimum);
      const present = deps.store.minimums ? await deps.store.minimums({ since: filter.since, until: filter.until }) : [];
      const head = {
        intervalHours: GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS / 3_600_000,
        retentionDays: GPU_AVAILABILITY_LOG_RETENTION_DAYS,
        lastSnapshotAt: latest ? latest.toISOString() : null,
        minCudaVersion: minimumOut(minimum),
        minCudaVersions: orderCudaMinimums(present).map(minimumOut),
      };
      if (parsed.summary) {
        const summary = await deps.store.summarize(filter);
        const gpuSnapshots = new Map(summary.gpuSnapshots.map((g) => [g.gpuTypeId, g.snapshots]));
        const entries = summarizeGpuAvailabilityGroups(summary.groups, gpuSnapshots);
        // BL-206: a GPU and datacenter named together that were NONE in every snapshot have no stored row; the entry is all NONE.
        const read = filter.gpuTypeId ? gpuSnapshots.get(filter.gpuTypeId) : undefined;
        if (filter.gpuTypeId && filter.dataCenterId && filter.dataCenterId !== GPU_AVAILABILITY_OVERALL && entries.length === 0 && read) {
          entries.push({ gpuTypeId: filter.gpuTypeId, dataCenterId: filter.dataCenterId, snapshots: read, stock: { [GPU_AVAILABILITY_NONE]: read } });
        }
        return {
          ...head,
          summary: {
            snapshots: summary.snapshots,
            firstAt: summary.firstAt ? summary.firstAt.toISOString() : null,
            lastAt: summary.lastAt ? summary.lastAt.toISOString() : null,
            entries,
          },
        };
      }
      const rows = await deps.store.list({ ...filter, limit: parsed.limit ?? GPU_AVAILABILITY_LOG_DEFAULT_LIMIT });
      return { ...head, rows: rows.map((row) => ({ at: row.at.toISOString(), gpuTypeId: row.gpuTypeId, dataCenterId: row.dataCenterId, stock: row.stock, pricePerHr: row.pricePerHr, minCudaVersion: row.minCudaVersion })) };
    },
  };
}
