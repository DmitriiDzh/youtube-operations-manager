import type { RunpodApiClient } from "@/lib/media-gateway";
import { GPU_AVAILABILITY_LOG_RETENTION_DAYS, isDomainError, parseWithSchema, type MediaCredentialsStatus, type MediaSettings } from "./contracts";
import {
  buildGpuAvailability,
  buildGpuAvailabilitySnapshotRows,
  DEFAULT_AVAILABILITY_MIN_VRAM_GB,
  GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS,
  gpuAvailabilityLogInputSchema,
  summarizeGpuAvailabilityGroups,
  type GpuAvailabilityLogRow,
  type GpuAvailabilitySummaryEntry,
} from "./gpu-availability";

/**
 * BL-172 (FO-REQ-0016 B, docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md): RunPod's GPU stock stored every 3 hours, so the Factory
 * Operator can see how often a GPU had stock in a datacenter before choosing where the media volume lives. Device-local; each
 * computer keeps its own log.
 */

export type GpuAvailabilityLogFilter = { since?: Date; until?: Date; gpuTypeId?: string; dataCenterId?: string };

export type GpuAvailabilityLogStore = {
  latestAt(): Promise<Date | null>;
  /** Every row gets `at`; rows older than the retention are pruned on the way. */
  insertSnapshot(at: Date, rows: GpuAvailabilityLogRow[]): Promise<void>;
  list(filter: GpuAvailabilityLogFilter & { limit: number }): Promise<Array<GpuAvailabilityLogRow & { at: Date }>>;
  summarize(filter: GpuAvailabilityLogFilter): Promise<{ snapshots: number; firstAt: Date | null; lastAt: Date | null; groups: Array<{ gpuTypeId: string; dataCenterId: string; stock: string | null; count: number }> }>;
};

export type GpuAvailabilitySnapshotOutcome =
  | { status: "taken"; at: string; rows: number }
  | { status: "skipped"; reason: "fresh" | "gateway_off" | "not_configured" | "backoff" }
  | { status: "failed"; code: string; message: string };

/** After a failed reading, the next attempt waits this long (the timer ticks more often than that). */
export const GPU_AVAILABILITY_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
export const GPU_AVAILABILITY_LOG_DEFAULT_LIMIT = 1000;

export function createGpuAvailabilityLogServices(deps: {
  store: GpuAvailabilityLogStore;
  base: {
    getGatewayEnabled(): Promise<boolean>;
    getCredentialsStatus(): Promise<MediaCredentialsStatus>;
    getSettings(): Promise<MediaSettings>;
    resolveRunpodClient(): Promise<RunpodApiClient>;
  };
  clock: { now(): Date };
  log?: (line: string) => void;
}) {
  let lastFailureAt: Date | null = null;

  return {
    /**
     * The timer's one call (every few minutes): a snapshot when the newest stored one is 3 hours old. Skips without any RunPod call
     * while the media gateway is off or RunPod is not configured, and never throws: a failed reading is logged and retried an hour
     * later. Two catalog reads per snapshot, Secure Cloud (network volumes exist only there), with the Settings' CUDA minimum.
     */
    async snapshotGpuAvailabilityIfDue(): Promise<GpuAvailabilitySnapshotOutcome> {
      try {
        const now = deps.clock.now();
        const latest = await deps.store.latestAt();
        if (latest && now.getTime() - latest.getTime() < GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS) return { status: "skipped", reason: "fresh" };
        if (lastFailureAt && now.getTime() - lastFailureAt.getTime() < GPU_AVAILABILITY_FAILURE_BACKOFF_MS) return { status: "skipped", reason: "backoff" };
        if (!(await deps.base.getGatewayEnabled())) return { status: "skipped", reason: "gateway_off" };
        if (!(await deps.base.getCredentialsStatus()).configured) return { status: "skipped", reason: "not_configured" };
        const settings = await deps.base.getSettings();
        const minCudaVersion = settings.minCudaVersion ?? undefined;
        const client = await deps.base.resolveRunpodClient();
        const [gpus, dataCenters] = await Promise.all([client.listGpuTypes({ cloud: "SECURE", ...(minCudaVersion ? { minCudaVersion } : {}) }), client.listDataCenters()]);
        const availability = buildGpuAvailability({
          gpus,
          dataCenters,
          input: { minVramGb: DEFAULT_AVAILABILITY_MIN_VRAM_GB },
          settings: { ...settings, cloudType: "SECURE" },
          now,
        });
        const rows = buildGpuAvailabilitySnapshotRows(availability);
        if (rows.length === 0) throw new Error("RunPod's catalog listed no GPU of 24 GB or more");
        await deps.store.insertSnapshot(now, rows);
        lastFailureAt = null;
        return { status: "taken", at: now.toISOString(), rows: rows.length };
      } catch (error) {
        if (isDomainError(error) && error.code === "media_generation_not_configured") return { status: "skipped", reason: "not_configured" };
        if (isDomainError(error) && error.code === "media_gateway_disabled") return { status: "skipped", reason: "gateway_off" };
        lastFailureAt = deps.clock.now();
        const code = isDomainError(error) ? error.code : "error";
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.(`[gpu-availability] the 3-hourly GPU availability snapshot failed (${code}): ${message}`);
        return { status: "failed", code, message };
      }
    },

    /** `factory_media_list_gpu_availability_log`: the stored rows newest first, or with `summary` the counts per stock level. */
    async listGpuAvailabilityLog(input: unknown = {}): Promise<
      {
        intervalHours: number;
        retentionDays: number;
        lastSnapshotAt: string | null;
      } & (
        | { rows: Array<GpuAvailabilityLogRow & { at: string }> }
        | { summary: { snapshots: number; firstAt: string | null; lastAt: string | null; entries: GpuAvailabilitySummaryEntry[] } }
      )
    > {
      const parsed = parseWithSchema(gpuAvailabilityLogInputSchema, input ?? {}, "GPU availability log input");
      const filter: GpuAvailabilityLogFilter = {
        ...(parsed.since ? { since: new Date(parsed.since) } : {}),
        ...(parsed.until ? { until: new Date(parsed.until) } : {}),
        ...(parsed.gpuTypeId ? { gpuTypeId: parsed.gpuTypeId } : {}),
        ...(parsed.dataCenterId ? { dataCenterId: parsed.dataCenterId } : {}),
      };
      const latest = await deps.store.latestAt();
      const head = { intervalHours: GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS / 3_600_000, retentionDays: GPU_AVAILABILITY_LOG_RETENTION_DAYS, lastSnapshotAt: latest ? latest.toISOString() : null };
      if (parsed.summary) {
        const summary = await deps.store.summarize(filter);
        return {
          ...head,
          summary: {
            snapshots: summary.snapshots,
            firstAt: summary.firstAt ? summary.firstAt.toISOString() : null,
            lastAt: summary.lastAt ? summary.lastAt.toISOString() : null,
            entries: summarizeGpuAvailabilityGroups(summary.groups),
          },
        };
      }
      const rows = await deps.store.list({ ...filter, limit: parsed.limit ?? GPU_AVAILABILITY_LOG_DEFAULT_LIMIT });
      return { ...head, rows: rows.map((row) => ({ at: row.at.toISOString(), gpuTypeId: row.gpuTypeId, dataCenterId: row.dataCenterId, stock: row.stock, pricePerHr: row.pricePerHr, minCudaVersion: row.minCudaVersion })) };
    },
  };
}
