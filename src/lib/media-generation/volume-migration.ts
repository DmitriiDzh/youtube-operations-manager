import type { RunpodApiClient, RunpodS3Client, S3ObjectSummary } from "@/lib/media-gateway";
import { DomainError, type MediaSettings } from "./contracts";

// BL-136 (owner, Telegram 2026-10-06, msgs 1695/1704/1709; plan docs/roadmap/plans/VOLUME_MIGRATION_PLAN.md): moving the
// network volume's data to a smaller volume, since RunPod never shrinks one. This file holds step 0 -- the probe that decides
// how the copy is done: RunPod lists S3 CopyObject but documents neither a source on ANOTHER volume nor a size limit.

export type VolumeMigrationDeps = {
  base: {
    getSettings(): Promise<MediaSettings>;
    resolveRunpodClient(): Promise<RunpodApiClient>;
    s3(): Promise<RunpodS3Client>;
    s3ForVolume(volumeId: string): Promise<RunpodS3Client>;
  };
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
  log?: (line: string) => void;
};

/** The probe's test volume, deleted again at the end: 20 GB so a model of real size (up to 18 GB) can be copied. */
export const PROBE_VOLUME_SIZE_GB = 20;
/** The large copy must fit the test volume with room to spare. */
export const PROBE_LARGE_MAX_BYTES = 18 * 1024 ** 3;
/** A "large" object is one a single PUT could not upload (RunPod: objects over 500 MB need multipart). */
export const PROBE_LARGE_MIN_BYTES = 500 * 1024 * 1024;
const REACHABLE_ATTEMPTS = 18;
const REACHABLE_INTERVAL_MS = 10_000;

export type ProbeCopyResult = { key: string; bytes: number; ok: boolean; copiedBytes: number | null; ms: number; error: string | null };
export type VolumeCopyProbeReport = {
  sourceVolumeId: string;
  testVolumeId: string | null;
  reachableAfterMs: number | null;
  small: ProbeCopyResult | null;
  large: ProbeCopyResult | null;
  testVolumeDeleted: boolean;
  deleteError: string | null;
  /** "server-side" = both copies matched in size: plan variant A; "pods" = a copy failed: plan variant B; "inconclusive" otherwise. */
  verdict: "server-side" | "pods" | "inconclusive";
  notes: string[];
};

/** The smallest non-empty object, and the largest one between PROBE_LARGE_MIN_BYTES and PROBE_LARGE_MAX_BYTES (staging excluded). */
export function pickProbeObjects(objects: S3ObjectSummary[]): { small: S3ObjectSummary | null; large: S3ObjectSummary | null } {
  const usable = objects.filter((o) => o.size > 0 && !o.key.startsWith(".s3compat_uploads/") && !o.key.endsWith("/"));
  const small = [...usable].sort((a, b) => a.size - b.size || a.key.localeCompare(b.key))[0] ?? null;
  const large =
    [...usable].filter((o) => o.size >= PROBE_LARGE_MIN_BYTES && o.size <= PROBE_LARGE_MAX_BYTES).sort((a, b) => b.size - a.size || a.key.localeCompare(b.key))[0] ?? null;
  return { small, large };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createVolumeMigrationServices(deps: VolumeMigrationDeps) {
  const log = deps.log ?? (() => {});

  async function copyOne(target: RunpodS3Client, sourceVolumeId: string, object: S3ObjectSummary, destinationKey: string): Promise<ProbeCopyResult> {
    const started = deps.clock.now().getTime();
    try {
      await target.copyObjectFrom(sourceVolumeId, object.key, destinationKey);
      const head = await target.headObject(destinationKey);
      const copiedBytes = head?.size ?? null;
      const ok = copiedBytes === object.size;
      return { key: object.key, bytes: object.size, ok, copiedBytes, ms: deps.clock.now().getTime() - started, error: ok ? null : `the copy has ${copiedBytes ?? "no"} bytes, the source ${object.size}` };
    } catch (error) {
      return { key: object.key, bytes: object.size, ok: false, copiedBytes: null, ms: deps.clock.now().getTime() - started, error: message(error) };
    }
  }

  return {
    /**
     * Step 0 of BL-136, run by the operator from the CLI (billable: a 20 GB volume for a few minutes). Creates a test volume in
     * the configured datacenter, copies the smallest file and the largest file of 0.5-18 GB from the current volume into it with
     * S3 CopyObject, checks each copy's size, and always deletes the test volume. Reads the current volume only, never writes it.
     */
    async probeCrossVolumeCopy(): Promise<VolumeCopyProbeReport> {
      const settings = await deps.base.getSettings();
      if (!settings.datacenterId || !settings.networkVolumeId) {
        throw new DomainError({ code: "media_generation_not_configured", message: "Choose the datacenter and the network volume first (Production → Setup)." });
      }
      const sourceVolumeId = settings.networkVolumeId;
      const notes: string[] = [];
      const { small, large } = pickProbeObjects(await (await deps.base.s3()).listAllObjects(""));
      if (!small) throw new DomainError({ code: "validation_failed", message: "The current volume has no file to copy; the probe needs at least one." });
      if (!large) notes.push(`No file between ${PROBE_LARGE_MIN_BYTES / 1024 ** 2} MB and ${PROBE_LARGE_MAX_BYTES / 1024 ** 3} GB on the volume: only the small copy is tested.`);

      const client = await deps.base.resolveRunpodClient();
      const stamp = deps.clock.now().toISOString().replace(/[-:]/g, "").slice(0, 13);
      const report: VolumeCopyProbeReport = { sourceVolumeId, testVolumeId: null, reachableAfterMs: null, small: null, large: null, testVolumeDeleted: false, deleteError: null, verdict: "inconclusive", notes };
      const volume = await client.createNetworkVolume({ name: `ytm-copy-probe-${stamp}`, dataCenterId: settings.datacenterId, sizeGb: PROBE_VOLUME_SIZE_GB });
      report.testVolumeId = volume.id;
      log(`[media] BL-136 probe: created test volume ${volume.id}`);
      try {
        const target = await deps.base.s3ForVolume(volume.id);
        const started = deps.clock.now().getTime();
        let lastError = "";
        for (let attempt = 0; attempt < REACHABLE_ATTEMPTS; attempt++) {
          try {
            await target.listObjects({ maxKeys: 1 });
            report.reachableAfterMs = deps.clock.now().getTime() - started;
            break;
          } catch (error) {
            lastError = message(error);
            if (attempt < REACHABLE_ATTEMPTS - 1) await deps.sleep(REACHABLE_INTERVAL_MS);
          }
        }
        if (report.reachableAfterMs === null) {
          notes.push(`The new volume was not reachable over S3 within ${(REACHABLE_ATTEMPTS * REACHABLE_INTERVAL_MS) / 60_000} minutes: ${lastError}`);
          return report;
        }
        report.small = await copyOne(target, sourceVolumeId, small, `ytm-probe/${small.key}`);
        if (large && report.small.ok) report.large = await copyOne(target, sourceVolumeId, large, `ytm-probe/${large.key}`);
        if (!report.small.ok || (report.large && !report.large.ok)) report.verdict = "pods";
        else if (report.small.ok && report.large?.ok) report.verdict = "server-side";
        return report;
      } finally {
        try {
          await client.deleteNetworkVolume(volume.id);
          report.testVolumeDeleted = true;
          log(`[media] BL-136 probe: deleted test volume ${volume.id}`);
        } catch (error) {
          report.deleteError = `${message(error)} -- delete volume ${volume.id} in the RunPod console`;
          log(`[media] BL-136 probe: could not delete test volume ${volume.id}: ${message(error)}`);
        }
      }
    },
  };
}

export type VolumeMigrationServices = ReturnType<typeof createVolumeMigrationServices>;
