import { MEDIA_CUDA_VERSIONS, type DomainErrorCode } from "./contracts";

// ---------------------------------------------------------------------------
// BL-155 (docs/roadmap/plans/CUDA_HOSTS_PLAN.md, FO-REQ-0007): pods landing on hosts whose CUDA driver is older than the image
// needs. Pure: which CUDA versions a createPod allows, whether a host or ComfyUI's device list is usable, and the error code a
// job's free-text error carries. RunPod reports a host's CUDA as the driver's maximum supported version ("12.4").
// ---------------------------------------------------------------------------

function parseCuda(version: string): [number, number] | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** -1 / 0 / 1 by major, then minor (numbers, so 12.10 > 12.9); null when either side is not a version. */
export function compareCudaVersions(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseCuda(a);
  const y = parseCuda(b);
  if (!x || !y) return null;
  if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  return 0;
}

/** createPod's `gpu.allowedCudaVersions`: every known version at or above the minimum; null (send nothing) without one. */
export function allowedCudaVersionsFor(minimum: string | null): string[] | null {
  if (minimum === null) return null;
  return MEDIA_CUDA_VERSIONS.filter((v) => (compareCudaVersions(v, minimum) ?? -1) >= 0);
}

/** True only when the host's version is known AND below the minimum: an unknown host never blocks a start. */
export function hostCudaTooOld(host: string | null, minimum: string | null): boolean {
  if (host === null || minimum === null) return false;
  return compareCudaVersions(host, minimum) === -1;
}

/**
 * ComfyUI's `GET /system_stats` lists `devices: [{ name, type, index, vram_total, vram_free, ... }]`; `type` is torch's device
 * type. `ok` = a `cuda` device with VRAM; `none` = a device list without one (ComfyUI fell back to the CPU); `unknown` = no
 * readable list (not blocked, like an unknown host version).
 */
export function comfyCudaDevice(stats: Record<string, unknown>): "ok" | "none" | "unknown" {
  const devices = stats.devices;
  if (!Array.isArray(devices)) return "unknown";
  const usable = devices.some((d) => {
    if (!d || typeof d !== "object") return false;
    const device = d as Record<string, unknown>;
    return device.type === "cuda" && typeof device.vram_total === "number" && device.vram_total > 0;
  });
  return usable ? "ok" : "none";
}

/**
 * What the CUDA runtime / PyTorch print when the host driver is older than the image's CUDA. Not "no kernel image is available
 * for execution on the device": that is a GPU architecture the image was not built for -- another host of the same GPU type
 * fails the same way, so it must not invite a new session on it (review round 2).
 */
const HOST_INCOMPATIBLE = [/CUDA driver version is insufficient/i, /NVIDIA driver on your system is too old/i];

/** AC-CU-04: a job's error code, derived from its error text (nothing stored); null for every other failure. */
export function jobErrorCode(error: string | null): Extract<DomainErrorCode, "media_gpu_host_incompatible"> | null {
  if (!error) return null;
  return HOST_INCOMPATIBLE.some((re) => re.test(error)) ? "media_gpu_host_incompatible" : null;
}

/** The factory's job view (Factory API 1.7.0): the job as it is, plus `errorCode`. */
export function withJobErrorCode<T extends { error: string | null }>(job: T): T & { errorCode: ReturnType<typeof jobErrorCode> } {
  return { ...job, errorCode: jobErrorCode(job.error) };
}
