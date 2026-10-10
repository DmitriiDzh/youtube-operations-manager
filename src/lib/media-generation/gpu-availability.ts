import { z } from "zod";
import { RUNPOD_S3_DATACENTERS, type RunpodDataCenter, type RunpodGpuType } from "@/lib/media-gateway";
import { MEDIA_CUDA_VERSIONS, type MediaCloudType } from "./contracts";

/**
 * BL-172 (FO-REQ-0016 A, docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md): RunPod's GPU stock and price per datacenter, as the catalog gives
 * them now, for the Factory Operator choosing where the media volume lives. Pure: the two catalog reads come in, the answer goes out.
 * The catalog's own limits are passed on, not hidden: stock can change before a pod start, the price is per GPU type (not per
 * datacenter), CUDA is known per GPU type only, and the S3 flag is RunPod's documented list.
 */

/** When Settings has no GPU memory minimum, the availability view starts at 24 GB (the smallest card the templates run on). */
export const DEFAULT_AVAILABILITY_MIN_VRAM_GB = 24;

export const gpuAvailabilityInputSchema = z
  .object({
    gpuTypeIds: z.array(z.string().min(1).max(128)).min(1).max(50).optional(),
    dataCenterIds: z.array(z.string().min(1).max(32)).min(1).max(50).optional(),
    minVramGb: z.number().int().min(0).max(1024).optional(),
    minCudaVersion: z.enum(MEDIA_CUDA_VERSIONS).optional(),
  })
  .strict();
export type GpuAvailabilityInput = z.infer<typeof gpuAvailabilityInputSchema>;

export type GpuAvailabilityDataCenter = {
  dataCenterId: string;
  region: string | null;
  countryCode: string | null;
  /** Network-volume tiers RunPod offers there; empty = no network volume possible. */
  networkVolumeTypes: string[];
  /** RunPod documents an S3 endpoint there (YT Manager reaches a volume only over S3). */
  s3Api: boolean;
};

export type GpuAvailability = {
  checkedAt: string;
  cloud: MediaCloudType;
  /** The datacenter of the configured volume (null when none is set). */
  volumeDataCenterId: string | null;
  minVramGb: number;
  minCudaVersion: string | null;
  gpus: Array<{
    gpuTypeId: string;
    displayName: string;
    vramGb: number | null;
    /** The cloud's on-demand USD/h for one GPU -- the price a session is checked against; null when the catalog gives none. */
    pricePerHr: number | null;
    /** RunPod's overall stock: NONE | LOW | MEDIUM | HIGH (null when it gives none). */
    stock: string | null;
    /**
     * Whether a CUDA version ≥ `minCudaVersion` has capacity now -- for the GPU type as a whole. With a minimum, RunPod lists only the
     * versions at or above it, so an empty list is `false` (no such host); without one an empty list is null (RunPod did not say).
     */
    cudaAvailable: boolean | null;
    dataCenters: Array<{ dataCenterId: string; stock: string | null; networkVolume: boolean; s3Api: boolean }>;
  }>;
  dataCenters: GpuAvailabilityDataCenter[];
};

/** `12.8` → [12, 8]. */
function cudaParts(version: string): [number, number] {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  return [Number.isFinite(major) ? major : 0, Number.isFinite(minor) ? minor : 0];
}

function cudaAtLeast(version: string, min: string): boolean {
  const [a, b] = cudaParts(version);
  const [c, d] = cudaParts(min);
  return a > c || (a === c && b >= d);
}

export function buildGpuAvailability(args: {
  gpus: RunpodGpuType[];
  dataCenters: RunpodDataCenter[];
  input: GpuAvailabilityInput;
  settings: { cloudType: MediaCloudType; datacenterId: string | null; gpuMinVramGb: number | null; minCudaVersion: string | null };
  now: Date;
  s3DataCenters?: readonly string[];
}): GpuAvailability {
  const { input, settings } = args;
  const s3 = new Set(args.s3DataCenters ?? RUNPOD_S3_DATACENTERS);
  const minVramGb = input.minVramGb ?? settings.gpuMinVramGb ?? DEFAULT_AVAILABILITY_MIN_VRAM_GB;
  const minCudaVersion = input.minCudaVersion ?? settings.minCudaVersion ?? null;
  const wantedGpus = input.gpuTypeIds ? new Set(input.gpuTypeIds) : null;
  const wantedDcs = input.dataCenterIds ? new Set(input.dataCenterIds) : null;
  const dcInfo = new Map(
    args.dataCenters.map((dc): [string, GpuAvailabilityDataCenter] => [
      dc.id,
      { dataCenterId: dc.id, region: dc.region, countryCode: dc.countryCode, networkVolumeTypes: dc.networkVolumeTypes, s3Api: s3.has(dc.id) },
    ])
  );
  const gpus = args.gpus
    .filter((gpu) => (gpu.memoryInGb ?? 0) >= minVramGb && (!wantedGpus || wantedGpus.has(gpu.id)))
    .map((gpu) => ({
      gpuTypeId: gpu.id,
      displayName: gpu.displayName,
      vramGb: gpu.memoryInGb,
      pricePerHr: gpu.onDemandPricePerHr,
      stock: gpu.estimatedAvailability,
      cudaAvailable:
        !minCudaVersion && gpu.cudaVersions.length === 0 ? null : gpu.cudaVersions.some((entry) => entry.available && (!minCudaVersion || cudaAtLeast(entry.version, minCudaVersion))),
      dataCenters: gpu.dataCenters
        .filter((dc) => !wantedDcs || wantedDcs.has(dc.id))
        .map((dc) => ({
          dataCenterId: dc.id,
          stock: dc.estimatedAvailability,
          networkVolume: (dcInfo.get(dc.id)?.networkVolumeTypes.length ?? 0) > 0,
          s3Api: s3.has(dc.id),
        })),
    }))
    .sort((a, b) => (a.vramGb ?? 0) - (b.vramGb ?? 0) || (a.pricePerHr ?? Number.POSITIVE_INFINITY) - (b.pricePerHr ?? Number.POSITIVE_INFINITY) || a.gpuTypeId.localeCompare(b.gpuTypeId));
  return {
    checkedAt: args.now.toISOString(),
    cloud: settings.cloudType,
    volumeDataCenterId: settings.datacenterId,
    minVramGb,
    minCudaVersion,
    gpus,
    dataCenters: [...dcInfo.values()].filter((dc) => !wantedDcs || wantedDcs.has(dc.dataCenterId)).sort((a, b) => a.dataCenterId.localeCompare(b.dataCenterId)),
  };
}

// -- BL-172 B: the stored log ------------------------------------------------------------------------------------------------------

/** A snapshot is due when the newest stored one is this old (FO-REQ-0016: every 3 hours). */
export const GPU_AVAILABILITY_SNAPSHOT_INTERVAL_MS = 3 * 60 * 60 * 1000;
/** The `dataCenterId` of a GPU's overall row (RunPod's stock across all datacenters). */
export const GPU_AVAILABILITY_OVERALL = "*";

export type GpuAvailabilityLogRow = { gpuTypeId: string; dataCenterId: string; stock: string | null; pricePerHr: number | null; minCudaVersion: string | null };

/**
 * One snapshot's rows from a reading built with `minVramGb` 24 (fixed, so the log does not shrink when the Settings minimum is
 * raised): per GPU an overall row, plus one row per datacenter that offers network volumes -- NONE where RunPod did not list that
 * datacenter for the GPU, so a count of "at least LOW" has its real zeros. Datacenters without network volumes are not stored.
 */
export function buildGpuAvailabilitySnapshotRows(availability: GpuAvailability): GpuAvailabilityLogRow[] {
  const volumeDcs = availability.dataCenters.filter((dc) => dc.networkVolumeTypes.length > 0).map((dc) => dc.dataCenterId);
  return availability.gpus.flatMap((gpu) => {
    const common = { gpuTypeId: gpu.gpuTypeId, pricePerHr: gpu.pricePerHr, minCudaVersion: availability.minCudaVersion };
    return [
      { ...common, dataCenterId: GPU_AVAILABILITY_OVERALL, stock: gpu.stock },
      ...volumeDcs.map((dataCenterId) => {
        const listed = gpu.dataCenters.find((dc) => dc.dataCenterId === dataCenterId);
        return { ...common, dataCenterId, stock: listed ? listed.stock : "NONE" };
      }),
    ];
  });
}

export const gpuAvailabilityLogInputSchema = z
  .object({
    since: z.string().datetime({ offset: true }).optional(),
    until: z.string().datetime({ offset: true }).optional(),
    gpuTypeId: z.string().min(1).max(128).optional(),
    dataCenterId: z.string().min(1).max(32).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
    summary: z.boolean().optional(),
  })
  .strict();
export type GpuAvailabilityLogInput = z.infer<typeof gpuAvailabilityLogInputSchema>;

/** Per GPU and datacenter: snapshots in the range and how many of them were at each stock level (`UNKNOWN` = no level given). */
export type GpuAvailabilitySummaryEntry = { gpuTypeId: string; dataCenterId: string; snapshots: number; stock: Record<string, number> };

export function summarizeGpuAvailabilityGroups(groups: Array<{ gpuTypeId: string; dataCenterId: string; stock: string | null; count: number }>): GpuAvailabilitySummaryEntry[] {
  const entries = new Map<string, GpuAvailabilitySummaryEntry>();
  for (const group of groups) {
    const key = `${group.gpuTypeId}\u0000${group.dataCenterId}`;
    const entry = entries.get(key) ?? { gpuTypeId: group.gpuTypeId, dataCenterId: group.dataCenterId, snapshots: 0, stock: {} };
    const level = group.stock ?? "UNKNOWN";
    entry.stock[level] = (entry.stock[level] ?? 0) + group.count;
    entry.snapshots += group.count;
    entries.set(key, entry);
  }
  // Code-unit order, the same as the database's: the overall `*` row before any datacenter.
  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...entries.values()].sort((a, b) => byCode(a.gpuTypeId, b.gpuTypeId) || byCode(a.dataCenterId, b.dataCenterId));
}
