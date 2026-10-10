import assert from "node:assert/strict";
import test from "node:test";
import { createRunpodApiClient } from "@/lib/media-gateway";
import { DEFAULT_MEDIA_SETTINGS, DomainError, type MediaCredentialsStatus, type MediaSettings } from "./contracts";
import type { GpuAvailabilityLogRow } from "./gpu-availability";
import { createGpuAvailabilityLogServices, type GpuAvailabilityLogStore } from "./gpu-availability-log";

// AC-GA-05 (docs/roadmap/plans/GPU_AVAILABILITY_PLAN.md §4, written before this module): a snapshot when none is younger than
// 3 h; with the gateway off or no credentials a skip without error and without a RunPod call; a RunPod failure logged, not thrown;
// two catalog reads per snapshot. The network is stubbed under the real gateway client, so the URLs are the ones RunPod would get.

const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-10-10T09:00:00Z");

function memoryLog(latest: Date | null = null) {
  const snapshots: Array<{ at: Date; rows: GpuAvailabilityLogRow[] }> = [];
  let failInsert = false;
  const store: GpuAvailabilityLogStore = {
    async latestAt() {
      return snapshots.length ? snapshots[snapshots.length - 1].at : latest;
    },
    async insertSnapshot(at, rows) {
      if (failInsert) throw new Error("SQLITE_BUSY: database is locked");
      snapshots.push({ at, rows });
    },
    async list() {
      return [];
    },
    async summarize() {
      return { snapshots: 0, firstAt: null, lastAt: null, groups: [] };
    },
  };
  return { store, snapshots, failInsertNext: () => (failInsert = true) };
}

function harness(options: { latest?: Date | null; gatewayOn?: boolean; configured?: boolean; status?: number; settings?: Partial<MediaSettings>; clientThrows?: Error } = {}) {
  const urls: string[] = [];
  const lines: string[] = [];
  let status = options.status ?? 200;
  let now = T0;
  let clientsResolved = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/catalog/datacenters")
      ? { dataCenters: [{ id: "EU-RO-1", region: "EUROPE", networkVolumeTypes: ["STANDARD"] }, { id: "EU-SE-1", region: "EUROPE", networkVolumeTypes: [] }] }
      : { gpus: [{ id: "NVIDIA L40S", name: "L40S", memory: 48, secure: true, availability: "LOW", price: { secure: 1.09 }, dataCenters: [{ id: "EU-SE-1", availability: "LOW" }] }] };
    return new Response(JSON.stringify(status === 200 ? body : { detail: "upstream" }), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const log = memoryLog(options.latest ?? null);
  const credentials: MediaCredentialsStatus =
    options.configured === false ? { configured: false, reason: "no_credentials" } : { configured: true, runpodKeyPrefix: "rpa_ABCD…", s3AccessKeyId: null, verifiedAt: null, updatedAt: T0.toISOString() };
  const services = createGpuAvailabilityLogServices({
    store: log.store,
    base: {
      getGatewayEnabled: async () => options.gatewayOn ?? true,
      getCredentialsStatus: async () => credentials,
      getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, datacenterId: "EU-RO-1", ...options.settings }),
      resolveRunpodClient: async () => {
        clientsResolved += 1;
        if (options.clientThrows) throw options.clientThrows;
        return createRunpodApiClient({ apiKey: "rpa_secret", fetchImpl, authorize: async () => {} });
      },
    },
    clock: { now: () => now },
    log: (line) => lines.push(line),
  });
  return {
    services,
    urls,
    lines,
    log,
    clientsResolved: () => clientsResolved,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    setStatus: (next: number) => (status = next),
  };
}

test("AC-GA-05: with no snapshot stored, one is taken -- two catalog reads, Secure Cloud and the Settings' CUDA minimum, every row at the same time", async () => {
  const h = harness({ settings: { cloudType: "COMMUNITY" } });
  assert.deepEqual(await h.services.snapshotGpuAvailabilityIfDue(), { status: "taken", at: T0.toISOString(), rows: 2 });
  assert.equal(h.urls.length, 2);
  const gpus = new URL(h.urls.find((u) => u.includes("/catalog/gpus")) ?? "");
  assert.equal(gpus.searchParams.get("cloud"), "SECURE", "network volumes exist only on Secure Cloud, whatever the Settings say");
  assert.equal(gpus.searchParams.get("minCudaVersion"), "12.8");
  assert.equal(h.log.snapshots.length, 1);
  assert.deepEqual(h.log.snapshots[0], {
    at: T0,
    rows: [
      { gpuTypeId: "NVIDIA L40S", pricePerHr: 1.09, minCudaVersion: "12.8", dataCenterId: "*", stock: "LOW" },
      { gpuTypeId: "NVIDIA L40S", pricePerHr: 1.09, minCudaVersion: "12.8", dataCenterId: "EU-RO-1", stock: "NONE" },
    ],
  });
});

test("AC-GA-05: a snapshot younger than 3 hours makes the tick skip without a RunPod call; at exactly 3 hours the next one is taken", async () => {
  const h = harness({ latest: new Date(T0.getTime() - 3 * HOUR + 1000) });
  assert.deepEqual(await h.services.snapshotGpuAvailabilityIfDue(), { status: "skipped", reason: "fresh" });
  assert.deepEqual(h.urls, []);
  h.advance(1000);
  assert.equal((await h.services.snapshotGpuAvailabilityIfDue()).status, "taken");
  assert.equal(h.urls.length, 2);
  h.advance(15 * 60 * 1000);
  assert.deepEqual(await h.services.snapshotGpuAvailabilityIfDue(), { status: "skipped", reason: "fresh" }, "the next tick after a snapshot");
  assert.equal(h.urls.length, 2);
});

test("AC-GA-05: the gateway off or RunPod not configured skips without error and without reaching RunPod", async () => {
  const off = harness({ gatewayOn: false });
  assert.deepEqual(await off.services.snapshotGpuAvailabilityIfDue(), { status: "skipped", reason: "gateway_off" });
  assert.equal(off.clientsResolved(), 0);
  const none = harness({ configured: false });
  assert.deepEqual(await none.services.snapshotGpuAvailabilityIfDue(), { status: "skipped", reason: "not_configured" });
  assert.equal(none.clientsResolved(), 0);
  // A stored row whose device key file is gone resolves no client: still a quiet skip.
  const keyless = harness({ clientThrows: new DomainError({ code: "media_generation_not_configured", message: "The device key file is missing." }) });
  assert.deepEqual(await keyless.services.snapshotGpuAvailabilityIfDue(), { status: "skipped", reason: "not_configured" });
  for (const h of [off, none, keyless]) {
    assert.deepEqual(h.urls, []);
    assert.deepEqual(h.lines, []);
    assert.equal(h.log.snapshots.length, 0);
  }
});

test("AC-GA-05: a RunPod failure is logged and returned, never thrown; the next attempt waits an hour, then tries again", async () => {
  const h = harness({ status: 500 });
  const failed = await h.services.snapshotGpuAvailabilityIfDue();
  assert.equal(failed.status, "failed");
  assert.equal(failed.status === "failed" && failed.code, "runpod_api_unavailable");
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /GPU availability snapshot failed \(runpod_api_unavailable\)/);
  assert.ok(!h.lines[0].includes("rpa_secret"), "the key never reaches the log");
  assert.equal(h.log.snapshots.length, 0);
  const readsAfterFailure = h.urls.length;
  h.advance(HOUR - 1000);
  assert.deepEqual(await h.services.snapshotGpuAvailabilityIfDue(), { status: "skipped", reason: "backoff" });
  assert.equal(h.urls.length, readsAfterFailure);
  h.setStatus(200);
  h.advance(1000);
  assert.equal((await h.services.snapshotGpuAvailabilityIfDue()).status, "taken");
  assert.equal(h.urls.length, readsAfterFailure + 2);
});

test("AC-GA-05: a database failure on insert is logged as a failed snapshot, not thrown", async () => {
  const h = harness();
  h.log.failInsertNext();
  const outcome = await h.services.snapshotGpuAvailabilityIfDue();
  assert.equal(outcome.status, "failed");
  assert.match(h.lines[0] ?? "", /SQLITE_BUSY/);
});

// Review round 1: an empty datacenter catalog (or a renamed wrapper key) would store only the `*` rows and count as fresh.
test("AC-GA-05: a datacenter catalog with no network-volume tier anywhere stores nothing and counts as a failure, not as a snapshot", async () => {
  const h = harness();
  const services = createGpuAvailabilityLogServices({
    store: h.log.store,
    base: {
      getGatewayEnabled: async () => true,
      getCredentialsStatus: async () => ({ configured: true, runpodKeyPrefix: "rpa_ABCD…", s3AccessKeyId: null, verifiedAt: null, updatedAt: T0.toISOString() }),
      getSettings: async () => DEFAULT_MEDIA_SETTINGS,
      resolveRunpodClient: async () =>
        createRunpodApiClient({
          apiKey: "k",
          authorize: async () => {},
          fetchImpl: (async (input: string | URL | Request) =>
            new Response(
              JSON.stringify(String(input).includes("datacenters") ? { dataCenters: [{ id: "EU-SE-1", networkVolumeTypes: [] }] } : { gpus: [{ id: "NVIDIA L40S", name: "L40S", memory: 48, availability: "LOW" }] }),
              { status: 200 }
            )) as typeof fetch,
        }),
    },
    clock: { now: () => T0 },
    log: () => {},
  });
  const outcome = await services.snapshotGpuAvailabilityIfDue();
  assert.equal(outcome.status, "failed");
  assert.match(outcome.status === "failed" ? outcome.message : "", /no datacenter with network volumes/);
  assert.equal(h.log.snapshots.length, 0);
});

test("AC-GA-05: a catalog with no GPU of 24 GB or more stores nothing and counts as a failure (retried an hour later), not as a snapshot", async () => {
  const h = harness();
  const services = createGpuAvailabilityLogServices({
    store: h.log.store,
    base: {
      getGatewayEnabled: async () => true,
      getCredentialsStatus: async () => ({ configured: true, runpodKeyPrefix: "rpa_ABCD…", s3AccessKeyId: null, verifiedAt: null, updatedAt: T0.toISOString() }),
      getSettings: async () => DEFAULT_MEDIA_SETTINGS,
      resolveRunpodClient: async () =>
        createRunpodApiClient({
          apiKey: "k",
          authorize: async () => {},
          fetchImpl: (async (input: string | URL | Request) =>
            new Response(JSON.stringify(String(input).includes("datacenters") ? { dataCenters: [] } : { gpus: [{ id: "small", name: "small", memory: 16 }] }), { status: 200 })) as typeof fetch,
        }),
    },
    clock: { now: () => T0 },
    log: () => {},
  });
  assert.equal((await services.snapshotGpuAvailabilityIfDue()).status, "failed");
  assert.equal(h.log.snapshots.length, 0);
});
