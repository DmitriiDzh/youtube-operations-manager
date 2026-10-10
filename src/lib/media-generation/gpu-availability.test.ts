import assert from "node:assert/strict";
import test from "node:test";
import type { RunpodDataCenter, RunpodGpuType } from "@/lib/media-gateway";
import { buildGpuAvailability, gpuAvailabilityInputSchema } from "./gpu-availability";

// Expected values come from docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md §4 (AC-GA-01, -02, -09), written before this module, and
// RunPod's documented S3 endpoint list (docs.runpod.io, storage/s3-api, read 2026-10-10). Nothing here is read back from the code.

function gpu(over: Partial<RunpodGpuType> & Pick<RunpodGpuType, "id" | "displayName" | "memoryInGb">): RunpodGpuType {
  return { secureCloud: true, communityCloud: false, onDemandPricePerHr: null, spotPricePerHr: null, estimatedAvailability: null, dataCenters: [], cudaVersions: [], ...over };
}

// The AC-GA-01 stub. EU-SE-1 is on the L40S list so a datacenter without network volumes shows up in a GPU's list; EUR-IS-1 is on
// the 4090 list but not in the datacenter catalog (a datacenter the catalog does not describe has no network volume as far as we know).
const GPUS: RunpodGpuType[] = [
  gpu({
    id: "NVIDIA GeForce RTX 4090",
    displayName: "RTX 4090",
    memoryInGb: 24,
    onDemandPricePerHr: 0.89,
    estimatedAvailability: "HIGH",
    dataCenters: [
      { id: "EU-RO-1", countryCode: "RO", estimatedAvailability: "MEDIUM" },
      { id: "EUR-IS-1", countryCode: "IS", estimatedAvailability: "LOW" },
    ],
    cudaVersions: [{ version: "12.8", available: true }],
  }),
  gpu({
    id: "NVIDIA L40S",
    displayName: "L40S",
    memoryInGb: 48,
    onDemandPricePerHr: 1.09,
    estimatedAvailability: "HIGH",
    dataCenters: [
      { id: "US-IL-1", countryCode: "US", estimatedAvailability: "LOW" },
      { id: "EU-SE-1", countryCode: "SE", estimatedAvailability: "HIGH" },
    ],
    cudaVersions: [
      { version: "12.4", available: true },
      { version: "12.8", available: false },
    ],
  }),
  gpu({ id: "NVIDIA RTX 2000 Ada Generation", displayName: "RTX 2000 Ada", memoryInGb: 16, onDemandPricePerHr: 0.24, estimatedAvailability: "HIGH" }),
];

const DATA_CENTERS: RunpodDataCenter[] = [
  { id: "US-IL-1", countryCode: "US", region: "NORTH_AMERICA", networkVolumeTypes: ["STANDARD"] },
  { id: "EU-RO-1", countryCode: "RO", region: "EUROPE", networkVolumeTypes: ["STANDARD"] },
  { id: "EU-SE-1", countryCode: "SE", region: "EUROPE", networkVolumeTypes: [] },
];

type Settings = { cloudType: "SECURE" | "COMMUNITY"; datacenterId: string | null; gpuMinVramGb: number | null; minCudaVersion: string | null };
const SETTINGS: Settings = { cloudType: "SECURE", datacenterId: "EU-RO-1", gpuMinVramGb: null, minCudaVersion: "12.8" };
const NOW = new Date("2026-10-10T09:00:00Z");

function build(input: Record<string, unknown> = {}, settings: Partial<Settings> = {}) {
  return buildGpuAvailability({ gpus: GPUS, dataCenters: DATA_CENTERS, input: gpuAvailabilityInputSchema.parse(input), settings: { ...SETTINGS, ...settings }, now: NOW });
}

test("AC-GA-01 / AC-GA-09: defaults -- 24 GB and up, each GPU's datacenters with the network-volume and S3 facts, the volume's datacenter and the CUDA filter", () => {
  assert.deepEqual(build(), {
    checkedAt: "2026-10-10T09:00:00.000Z",
    cloud: "SECURE",
    volumeDataCenterId: "EU-RO-1",
    minVramGb: 24,
    minCudaVersion: "12.8",
    gpus: [
      {
        gpuTypeId: "NVIDIA GeForce RTX 4090",
        displayName: "RTX 4090",
        vramGb: 24,
        pricePerHr: 0.89,
        stock: "HIGH",
        cudaAvailable: true,
        dataCenters: [
          { dataCenterId: "EU-RO-1", stock: "MEDIUM", networkVolume: true, s3Api: true },
          { dataCenterId: "EUR-IS-1", stock: "LOW", networkVolume: false, s3Api: true },
        ],
      },
      {
        gpuTypeId: "NVIDIA L40S",
        displayName: "L40S",
        vramGb: 48,
        pricePerHr: 1.09,
        stock: "HIGH",
        // 12.4 has capacity, but 12.4 < 12.8; 12.8 has none.
        cudaAvailable: false,
        dataCenters: [
          { dataCenterId: "US-IL-1", stock: "LOW", networkVolume: true, s3Api: true },
          { dataCenterId: "EU-SE-1", stock: "HIGH", networkVolume: false, s3Api: false },
        ],
      },
    ],
    dataCenters: [
      { dataCenterId: "EU-RO-1", region: "EUROPE", countryCode: "RO", networkVolumeTypes: ["STANDARD"], s3Api: true },
      { dataCenterId: "EU-SE-1", region: "EUROPE", countryCode: "SE", networkVolumeTypes: [], s3Api: false },
      { dataCenterId: "US-IL-1", region: "NORTH_AMERICA", countryCode: "US", networkVolumeTypes: ["STANDARD"], s3Api: true },
    ],
  });
});

test("AC-GA-01: the Settings' GPU memory minimum replaces the 24 GB default, and an input minimum replaces both", () => {
  assert.deepEqual(build({}, { gpuMinVramGb: 48 }).gpus.map((g) => g.gpuTypeId), ["NVIDIA L40S"]);
  assert.equal(build({}, { gpuMinVramGb: 48 }).minVramGb, 48);
  assert.deepEqual(build({ minVramGb: 0 }, { gpuMinVramGb: 48 }).gpus.map((g) => g.gpuTypeId), ["NVIDIA RTX 2000 Ada Generation", "NVIDIA GeForce RTX 4090", "NVIDIA L40S"]);
});

test("AC-GA-01: CUDA -- an input version replaces the Settings' one; a newer available version counts; no list from RunPod is null; no filter at all counts any available version", () => {
  assert.equal(build({ minCudaVersion: "12.4" }).gpus.find((g) => g.gpuTypeId === "NVIDIA L40S")?.cudaAvailable, true);
  assert.equal(build({ minCudaVersion: "12.4" }).minCudaVersion, "12.4");
  const newer = buildGpuAvailability({
    gpus: [gpu({ id: "B", displayName: "B", memoryInGb: 32, cudaVersions: [{ version: "13.0", available: true }] }), gpu({ id: "C", displayName: "C", memoryInGb: 32 })],
    dataCenters: [],
    input: {},
    settings: SETTINGS,
    now: NOW,
  });
  assert.deepEqual(
    newer.gpus.map((g) => [g.gpuTypeId, g.cudaAvailable]),
    [
      ["B", true],
      ["C", null],
    ]
  );
  const unfiltered = build({}, { minCudaVersion: null });
  assert.equal(unfiltered.minCudaVersion, null);
  assert.equal(unfiltered.gpus.find((g) => g.gpuTypeId === "NVIDIA L40S")?.cudaAvailable, true);
});

test("AC-GA-02: gpuTypeIds, dataCenterIds and minVramGb narrow the answer", () => {
  assert.deepEqual(build({ gpuTypeIds: ["NVIDIA L40S"] }).gpus.map((g) => g.gpuTypeId), ["NVIDIA L40S"]);
  assert.deepEqual(build({ minVramGb: 40 }).gpus.map((g) => g.gpuTypeId), ["NVIDIA L40S"]);
  const inIllinois = build({ dataCenterIds: ["US-IL-1"] });
  assert.deepEqual(inIllinois.dataCenters.map((dc) => dc.dataCenterId), ["US-IL-1"]);
  // A GPU without stock there stays, with an empty list: "a datacenter missing from a GPU's list had no stock for it".
  assert.deepEqual(
    inIllinois.gpus.map((g) => [g.gpuTypeId, g.dataCenters.map((dc) => dc.dataCenterId)]),
    [
      ["NVIDIA GeForce RTX 4090", []],
      ["NVIDIA L40S", ["US-IL-1"]],
    ]
  );
});

test("AC-GA-02: an unknown filter value gives an empty list, not an error", () => {
  assert.deepEqual(build({ gpuTypeIds: ["NVIDIA H100 NVL-nonexistent"] }).gpus, []);
  const nowhere = build({ dataCenterIds: ["XX-ZZ-9"] });
  assert.deepEqual(nowhere.dataCenters, []);
  assert.ok(nowhere.gpus.every((g) => g.dataCenters.length === 0));
});

test("AC-GA-09: s3Api is true exactly for RunPod's documented S3 datacenters", () => {
  const all = build({ minVramGb: 0 });
  const flags = Object.fromEntries(all.gpus.flatMap((g) => g.dataCenters).map((dc) => [dc.dataCenterId, dc.s3Api]));
  assert.deepEqual(flags, { "EU-RO-1": true, "EUR-IS-1": true, "US-IL-1": true, "EU-SE-1": false });
  const custom = buildGpuAvailability({ gpus: GPUS, dataCenters: DATA_CENTERS, input: {}, settings: SETTINGS, now: NOW, s3DataCenters: ["EU-SE-1"] });
  assert.deepEqual(
    custom.dataCenters.map((dc) => [dc.dataCenterId, dc.s3Api]),
    [
      ["EU-RO-1", false],
      ["EU-SE-1", true],
      ["US-IL-1", false],
    ]
  );
});

test("the input is strict and bounded: unknown keys, an unlisted CUDA version, empty or oversized lists are refused", () => {
  for (const bad of [{ cloud: "COMMUNITY" }, { minCudaVersion: "12.10" }, { gpuTypeIds: [] }, { dataCenterIds: Array.from({ length: 51 }, (_, i) => `DC-${i}`) }, { minVramGb: -1 }, { minVramGb: 1.5 }]) {
    assert.equal(gpuAvailabilityInputSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(gpuAvailabilityInputSchema.safeParse({ gpuTypeIds: ["NVIDIA L40S"], dataCenterIds: ["US-IL-1"], minVramGb: 48, minCudaVersion: "13.0" }).success, true);
});
