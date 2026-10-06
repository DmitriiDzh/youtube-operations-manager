import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodGpuType } from "@/lib/media-gateway";
import { DomainError, DEFAULT_MEDIA_SETTINGS } from "./contracts";
import { classifyCreatePodFailure, resolveGpuCandidates, worstCasePricePerHr } from "./gpu-plan";

// BL-133 (FACTORY_GPU_SESSIONS_PLAN.md §2.3, AC-FG-04/06). Expected from the plan and from RunPod's v2 create-pod contract
// (HTTP 400 "This GPU and data center combination could not be placed" = no capacity; 402 balance; 403 permission; 422 body).

const gpu = (id: string, memoryInGb: number, price: number | null, dcs: string[]): RunpodGpuType => ({
  id,
  displayName: id,
  memoryInGb,
  secureCloud: true,
  communityCloud: true,
  onDemandPricePerHr: price,
  spotPricePerHr: null,
  estimatedAvailability: null,
  dataCenters: dcs.map((d) => ({ id: d, countryCode: null, estimatedAvailability: null })),
});

const CATALOG = [
  gpu("NVIDIA GeForce RTX 4090", 24, 0.74, ["EU-RO-1", "US-TX-3"]),
  gpu("NVIDIA GeForce RTX 5090", 32, 0.94, ["EU-RO-1"]),
  gpu("NVIDIA L40S", 48, 0.86, ["US-TX-3"]),
  gpu("NVIDIA A100 80GB PCIe", 80, 1.64, ["EU-RO-1"]),
  gpu("NVIDIA RTX A4000", 16, 0.25, ["EU-RO-1"]),
];
const SETTINGS = { ...DEFAULT_MEDIA_SETTINGS, gpuTypeId: "NVIDIA GeForce RTX 4090", gpuOnDemandPricePerHr: 0.74, datacenterId: "EU-RO-1", gpuFallbackIds: ["NVIDIA GeForce RTX 5090", "NVIDIA A100 80GB PCIe"] };

test("AC-FG-04: without a plan the device GPU then its fallback list is tried, in order, with catalog prices", () => {
  const { candidates } = resolveGpuCandidates({ plan: null, settings: SETTINGS, catalog: CATALOG });
  assert.deepEqual(candidates.map((c) => [c.gpuTypeId, c.pricePerHr]), [["NVIDIA GeForce RTX 4090", 0.74], ["NVIDIA GeForce RTX 5090", 0.94], ["NVIDIA A100 80GB PCIe", 1.64]]);
});

test("AC-FG-04: a plan's own list wins; a GPU under the VRAM minimum, over the price cap, not in the volume's datacenter, or unknown is never tried", () => {
  const { candidates, skipped } = resolveGpuCandidates({
    plan: { candidates: ["NVIDIA RTX A4000", "NVIDIA L40S", "NVIDIA A100 80GB PCIe", "NVIDIA GeForce RTX 5090", "NVIDIA H200 (made up)"], minVramGb: 20, maxPricePerHr: 1.0 },
    settings: SETTINGS,
    catalog: CATALOG,
  });
  assert.deepEqual(candidates.map((c) => c.gpuTypeId), ["NVIDIA GeForce RTX 5090"]);
  assert.deepEqual(skipped.map((s) => s.gpuTypeId), ["NVIDIA RTX A4000", "NVIDIA L40S", "NVIDIA A100 80GB PCIe", "NVIDIA H200 (made up)"]);
  assert.match(skipped[0].reason, /16 GB VRAM is under the 20 GB/);
  assert.match(skipped[1].reason, /not offered in EU-RO-1/);
  assert.match(skipped[2].reason, /\$1.64\/h is over the \$1\/h cap/);
  assert.match(skipped[3].reason, /not in RunPod's GPU catalog/);
});

test("without a catalog every listed GPU is tried; under a price cap only the device GPU with its saved price qualifies", () => {
  assert.deepEqual(resolveGpuCandidates({ plan: null, settings: SETTINGS, catalog: null }).candidates.map((c) => c.gpuTypeId), ["NVIDIA GeForce RTX 4090", "NVIDIA GeForce RTX 5090", "NVIDIA A100 80GB PCIe"]);
  const capped = resolveGpuCandidates({ plan: null, settings: { ...SETTINGS, gpuMaxPricePerHr: 1 }, catalog: null });
  assert.deepEqual(capped.candidates.map((c) => c.gpuTypeId), ["NVIDIA GeForce RTX 4090"]);
  assert.equal(worstCasePricePerHr(resolveGpuCandidates({ plan: null, settings: SETTINGS, catalog: CATALOG }).candidates, 0.74), 1.64);
});

test("AC-FG-04/06: a 400 'could not be placed' is no capacity; 429/5xx/no response are transient; 400 otherwise, 402, 403, 422, a bad key are fatal", () => {
  const api = (status: number | undefined, message: string) => new DomainError({ code: "runpod_api_unavailable", message, details: status === undefined ? {} : { status } });
  assert.equal(classifyCreatePodFailure(api(400, "RunPod API returned HTTP 400: This GPU and data center combination could not be placed.")), "no_capacity");
  assert.equal(classifyCreatePodFailure(api(400, "RunPod API returned HTTP 400: There are no longer any instances available with the requested specifications.")), "no_capacity");
  assert.equal(classifyCreatePodFailure(api(400, "RunPod API returned HTTP 400: gpuCount must be at least 1")), "fatal");
  assert.equal(classifyCreatePodFailure(api(402, "RunPod API returned HTTP 402: insufficient balance")), "fatal");
  assert.equal(classifyCreatePodFailure(api(422, "RunPod API returned HTTP 422")), "fatal");
  assert.equal(classifyCreatePodFailure(api(429, "RunPod API returned HTTP 429")), "transient");
  assert.equal(classifyCreatePodFailure(api(503, "RunPod API returned HTTP 503")), "transient");
  assert.equal(classifyCreatePodFailure(api(undefined, "RunPod API request failed: ECONNRESET")), "transient");
  assert.equal(classifyCreatePodFailure(new DomainError({ code: "runpod_forbidden", message: "no" })), "fatal");
  assert.equal(classifyCreatePodFailure(new DomainError({ code: "media_credentials_invalid", message: "no" })), "fatal");
});
