import type { RunpodGpuType } from "@/lib/media-gateway";
import { DomainError, type MediaGpuPlan, type MediaSettings } from "./contracts";

// ---------------------------------------------------------------------------
// BL-133 (docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md §2.3) -- which GPU types a session start tries, in which order,
// and how a failed createPod is read. Pure: the catalog is passed in. RunPod's REST v2 create-pod takes ONE gpu id (no
// list, no priority, no price cap), so the fallback is a client-side loop over these candidates; "no capacity" is HTTP 400
// "This GPU and data center combination could not be placed" (no machine code -- the message is matched).
// ---------------------------------------------------------------------------

export type GpuCandidate = { gpuTypeId: string; pricePerHr: number | null; memoryInGb: number | null };

/**
 * The candidates to try, in order. The session's own plan (a request's or a template's) wins; without one, the device's
 * GPU followed by its fallback list. Filtered by minimum VRAM, price cap and -- when the catalog knows -- whether the
 * GPU is offered in the volume's datacenter. Without a catalog (it could not be read) nothing can be checked: every
 * candidate is tried as listed, except that a price cap then admits only the device GPU with its saved price.
 */
export function resolveGpuCandidates(args: {
  plan: MediaGpuPlan | null;
  settings: Pick<MediaSettings, "gpuTypeId" | "gpuFallbackIds" | "gpuMinVramGb" | "gpuMaxPricePerHr" | "gpuOnDemandPricePerHr" | "datacenterId">;
  catalog: RunpodGpuType[] | null;
}): { candidates: GpuCandidate[]; skipped: Array<{ gpuTypeId: string; reason: string }> } {
  const { plan, settings, catalog } = args;
  const ordered = plan && plan.candidates.length > 0 ? plan.candidates : [settings.gpuTypeId, ...settings.gpuFallbackIds].filter((id): id is string => Boolean(id));
  const ids = [...new Set(ordered)];
  // The owner's floor and cap are HARD bounds (independent review): a plan may only tighten them, never loosen them.
  const minVram = [plan?.minVramGb ?? null, settings.gpuMinVramGb].reduce<number | null>((acc, v) => (v === null ? acc : acc === null ? v : Math.max(acc, v)), null);
  const maxPrice = [plan?.maxPricePerHr ?? null, settings.gpuMaxPricePerHr].reduce<number | null>((acc, v) => (v === null ? acc : acc === null ? v : Math.min(acc, v)), null);
  const candidates: GpuCandidate[] = [];
  const skipped: Array<{ gpuTypeId: string; reason: string }> = [];
  for (const id of ids) {
    if (!catalog) {
      const price = id === settings.gpuTypeId ? settings.gpuOnDemandPricePerHr : null;
      if (maxPrice !== null && (price === null || price > maxPrice)) {
        skipped.push({ gpuTypeId: id, reason: price === null ? "price unknown (catalog unavailable) under a price cap" : `$${price}/h is over the $${maxPrice}/h cap` });
        continue;
      }
      candidates.push({ gpuTypeId: id, pricePerHr: price, memoryInGb: null });
      continue;
    }
    const entry = catalog.find((g) => g.id === id);
    if (!entry) {
      skipped.push({ gpuTypeId: id, reason: "not in RunPod's GPU catalog" });
      continue;
    }
    if (minVram !== null && (entry.memoryInGb === null || entry.memoryInGb < minVram)) {
      skipped.push({ gpuTypeId: id, reason: `${entry.memoryInGb ?? "?"} GB VRAM is under the ${minVram} GB minimum` });
      continue;
    }
    const price = entry.onDemandPricePerHr;
    if (maxPrice !== null && (price === null || price > maxPrice)) {
      skipped.push({ gpuTypeId: id, reason: price === null ? "no on-demand price" : `$${price}/h is over the $${maxPrice}/h cap` });
      continue;
    }
    if (settings.datacenterId && entry.dataCenters.length > 0 && !entry.dataCenters.some((dc) => dc.id === settings.datacenterId)) {
      skipped.push({ gpuTypeId: id, reason: `not offered in ${settings.datacenterId} (the volume's datacenter)` });
      continue;
    }
    candidates.push({ gpuTypeId: id, pricePerHr: price, memoryInGb: entry.memoryInGb });
  }
  return { candidates, skipped };
}

/** The highest price a plan may run at -- what a factory start's limits are checked against (worst case). */
export function worstCasePricePerHr(candidates: GpuCandidate[], fallback: number | null): number | null {
  const prices = candidates.map((c) => c.pricePerHr).filter((p): p is number => p !== null);
  return prices.length > 0 ? Math.max(...prices) : fallback;
}

const NO_CAPACITY = /could not be placed|no longer any instances|no instances|not enough (gpu|capacity)|insufficient capacity|out of stock|no available/i;

/**
 * How a failed createPod is read: `no_capacity` (try the next candidate / wait), `transient` (RunPod or the network
 * hiccuped: retried like no capacity, logged as an error), `fatal` (balance, permissions, a bad request: the start ends).
 */
export function classifyCreatePodFailure(error: unknown): "no_capacity" | "transient" | "fatal" {
  if (!(error instanceof DomainError)) return "transient";
  if (error.code === "media_credentials_invalid" || error.code === "runpod_forbidden" || error.code === "media_gateway_disabled") return "fatal";
  if (error.code !== "runpod_api_unavailable") return "fatal";
  const status = (error.details as { status?: unknown } | undefined)?.status;
  if (typeof status !== "number") return "transient"; // no response at all
  // The text may sit in the message (`detail`) or only in the body (`error`): both are read (independent review).
  if (status === 400) return NO_CAPACITY.test(`${error.message} ${JSON.stringify((error.details as { body?: unknown } | undefined)?.body ?? "")}`) ? "no_capacity" : "fatal";
  if (status === 429 || status >= 500) return "transient";
  return "fatal"; // 402 balance, 404, 409, 422 ...
}
