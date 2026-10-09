import type { RunpodApiClient, RunpodPod, RunpodS3Client, S3ObjectSummary } from "@/lib/media-gateway";
import { z } from "zod";
import { DomainError, isDomainError, parseWithSchema, type MediaSettings } from "./contracts";

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

/** `timedOut`: the copy got no HTTP answer at all (timeout or dropped connection) -- RunPod may still be copying. */
export type ProbeCopyResult = { key: string; bytes: number; ok: boolean; copiedBytes: number | null; ms: number; error: string | null; timedOut: boolean };
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

export const deleteNetworkVolumeInputSchema = z.object({ volumeId: z.string().trim().min(1).max(64) }).strict();

/**
 * Whether a pod has (or may have) `volumeId` mounted -- fails closed (independent review): the pod list's mount data has not
 * been seen in a live response, so a pod whose mounts cannot be read at all counts as "may", unless it runs in another
 * datacenter (a network volume attaches only there). Also accepts a flat `networkVolumeId` field (the create body's name).
 */
export function podMayMountVolume(pod: RunpodPod, volumeId: string, volumeDataCenterId: string | null): "yes" | "unknown" | "no" {
  if (pod.networkVolumeIds.includes(volumeId) || pod.raw.networkVolumeId === volumeId) return "yes";
  const mounts = pod.raw.mounts;
  const hasMountInfo = (mounts && typeof mounts === "object" && "network" in mounts) || "networkVolumeId" in pod.raw;
  if (hasMountInfo) return "no";
  if (pod.dataCenterId && volumeDataCenterId && pod.dataCenterId !== volumeDataCenterId) return "no";
  return "unknown";
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
      return { key: object.key, bytes: object.size, ok, copiedBytes, ms: deps.clock.now().getTime() - started, error: ok ? null : `the copy has ${copiedBytes ?? "no"} bytes, the source ${object.size}`, timedOut: false };
    } catch (error) {
      // The S3 client reports an HTTP answer with `details.status`; a request that never got one has none.
      const timedOut = isDomainError(error) && error.code === "runpod_s3_unavailable" && (error.details as { status?: number } | undefined)?.status === undefined;
      return { key: object.key, bytes: object.size, ok: false, copiedBytes: null, ms: deps.clock.now().getTime() - started, error: message(error), timedOut };
    }
  }

  return {
    /**
     * BL-136 step 6 (and the cleanup of a failed migration's new volume): permanently deletes a network volume. Refused for
     * the volume the app is configured to use, for an unknown volume, and while any pod of the account has it mounted (a
     * deletion under a running pod is undocumented). Destructive: the Web UI confirms with the operator first.
     */
    async deleteUnusedNetworkVolume(input: unknown): Promise<{ deleted: string; alreadyGone: boolean }> {
      const { volumeId } = parseWithSchema(deleteNetworkVolumeInputSchema, input, "delete network volume");
      const settings = await deps.base.getSettings();
      if (settings.networkVolumeId === volumeId) {
        throw new DomainError({ code: "validation_failed", message: "This is the volume the app uses; switch to another volume first (Servers → Setup).", details: { volumeId } });
      }
      const client = await deps.base.resolveRunpodClient();
      const volume = await client.getNetworkVolume(volumeId);
      if (!volume) throw new DomainError({ code: "not_found", message: "No network volume with this id on the RunPod account", details: { volumeId } });
      const pods = await client.listPods();
      const mountedBy = pods.filter((pod) => podMayMountVolume(pod, volumeId, volume.dataCenterId) === "yes").map((pod) => pod.id);
      if (mountedBy.length > 0) {
        throw new DomainError({ code: "media_session_conflict", message: `Pod${mountedBy.length === 1 ? "" : "s"} ${mountedBy.join(", ")} still ${mountedBy.length === 1 ? "has" : "have"} this volume mounted; terminate ${mountedBy.length === 1 ? "it" : "them"} first.`, details: { volumeId, pods: mountedBy } });
      }
      const unknown = pods.filter((pod) => podMayMountVolume(pod, volumeId, volume.dataCenterId) === "unknown").map((pod) => pod.id);
      if (unknown.length > 0) {
        throw new DomainError({ code: "media_session_conflict", message: `RunPod does not say which volume pod${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "has" : "have"} mounted; terminate ${unknown.length === 1 ? "it" : "them"} before deleting a volume.`, details: { volumeId, pods: unknown } });
      }
      // A concurrent Setup save may have switched the app to this volume since the check above (independent review).
      if ((await deps.base.getSettings()).networkVolumeId === volumeId) {
        throw new DomainError({ code: "validation_failed", message: "This volume has just become the one the app uses; it is not deleted.", details: { volumeId } });
      }
      const outcome = await client.deleteNetworkVolume(volumeId);
      log(`[media] deleted network volume ${volumeId} (${volume.name}, ${volume.sizeGb} GB)`);
      return { deleted: volumeId, alreadyGone: outcome.alreadyGone };
    },

    /**
     * Step 0 of BL-136, run by the operator from the CLI (billable: a 20 GB volume for a few minutes). Creates a test volume in
     * the configured datacenter, copies the smallest file and the largest file of 0.5-18 GB from the current volume into it with
     * S3 CopyObject, checks each copy's size, and always deletes the test volume. Reads the current volume only, never writes it.
     */
    async probeCrossVolumeCopy(): Promise<VolumeCopyProbeReport> {
      const settings = await deps.base.getSettings();
      if (!settings.datacenterId || !settings.networkVolumeId) {
        throw new DomainError({ code: "media_generation_not_configured", message: "Choose the datacenter and the network volume first (Servers → Setup)." });
      }
      const sourceVolumeId = settings.networkVolumeId;
      const notes: string[] = [];
      const { small, large } = pickProbeObjects(await (await deps.base.s3()).listAllObjects(""));
      if (!small) throw new DomainError({ code: "validation_failed", message: "The current volume has no file to copy; the probe needs at least one." });
      if (!large) notes.push(`No file between ${PROBE_LARGE_MIN_BYTES / 1024 ** 2} MB and ${PROBE_LARGE_MAX_BYTES / 1024 ** 3} GB on the volume: only the small copy is tested.`);

      const client = await deps.base.resolveRunpodClient();
      const stamp = deps.clock.now().toISOString().replace(/[-:]/g, "").slice(0, 13);
      const report: VolumeCopyProbeReport = { sourceVolumeId, testVolumeId: null, reachableAfterMs: null, small: null, large: null, testVolumeDeleted: false, deleteError: null, verdict: "inconclusive", notes };
      const probeName = `ytm-copy-probe-${stamp}`;
      let volume;
      try {
        volume = await client.createNetworkVolume({ name: probeName, dataCenterId: settings.datacenterId, sizeGb: PROBE_VOLUME_SIZE_GB });
      } catch (error) {
        // The call can fail AFTER RunPod created the volume (timeout, unreadable answer): find it by its name and delete it.
        const orphan = (await client.listNetworkVolumes().catch(() => [])).find((v) => v.name === probeName);
        if (orphan) await client.deleteNetworkVolume(orphan.id).catch(() => undefined);
        throw new DomainError({
          code: "runpod_api_unavailable",
          message: `Could not create the probe's test volume: ${message(error)}${orphan ? ` (a volume ${orphan.id} of that name was found and a delete was sent; check for leftover ${probeName} volumes)` : ""}`,
        });
      }
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
        // A copy RunPod refused or got wrong means variant B; one that only ran out of time (no HTTP answer) proves nothing.
        const refused = (r: ProbeCopyResult | null) => r !== null && !r.ok && !r.timedOut;
        const timedOut = (r: ProbeCopyResult | null) => r !== null && r.timedOut;
        if (refused(report.small) || refused(report.large)) report.verdict = "pods";
        else if (timedOut(report.small) || timedOut(report.large)) report.verdict = "inconclusive";
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
