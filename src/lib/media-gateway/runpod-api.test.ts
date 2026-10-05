import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createRunpodApiClient, extractList, toPod } from "./runpod-api";

// Expected request shapes come from docs.runpod.io/api-reference-v2/openapi.json (2026-10-05) and
// PHASE_14_PLAN.md (terminate = DELETE, never stop), not from this implementation.

type Call = { url: string; init: RequestInit };

function fakeFetch(responder: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = responder(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const noAuth = async () => {};

test("every call carries the bearer key, the v2 base URL, and passes the gateway authorization first", async () => {
  const authorized: string[] = [];
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { keys: [] } }));
  const client = createRunpodApiClient({
    apiKey: "rpa_secret",
    fetchImpl,
    authorize: async (category) => {
      authorized.push(category);
    },
  });
  await client.verifyKey();
  assert.equal(calls[0].url, "https://api.runpod.io/v2/account/ssh-keys");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer rpa_secret");
  assert.deepEqual(authorized, ["runpod_api"]);
});

test("a 401/403 from RunPod is media_credentials_invalid; another failure is runpod_api_unavailable with the status", async () => {
  const unauthorized = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 401, body: { title: "Unauthorized", status: 401, detail: "bad key" } })).fetchImpl });
  await assert.rejects(unauthorized.verifyKey(), (e: unknown) => isDomainError(e) && e.code === "media_credentials_invalid");

  const broken = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 500, body: { detail: "boom" } })).fetchImpl });
  await assert.rejects(broken.listPods(), (e: unknown) => isDomainError(e) && e.code === "runpod_api_unavailable" && (e.details as { status?: number }).status === 500);
});

test("a network failure is runpod_api_unavailable, never a bare throw", async () => {
  const client = createRunpodApiClient({
    apiKey: "k",
    authorize: noAuth,
    fetchImpl: (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch,
  });
  await assert.rejects(client.listPods(), (e: unknown) => isDomainError(e) && e.code === "runpod_api_unavailable");
});

test("a blocked gateway toggle never reaches the network", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const client = createRunpodApiClient({
    apiKey: "k",
    fetchImpl,
    authorize: async () => {
      throw new Error("blocked");
    },
  });
  await assert.rejects(client.listPods());
  assert.equal(calls.length, 0);
});

test("listGpuTypes asks the catalog for POD availability and maps price/availability fields", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      gpus: [
        {
          id: "NVIDIA GeForce RTX 4090",
          displayName: "RTX 4090",
          memoryInGb: 24,
          secureCloud: true,
          communityCloud: true,
          estimatedAvailability: "HIGH",
          lowestPrice: { minimumBidPrice: 0.34, uninterruptablePrice: 0.69 },
          dataCenters: [{ id: "EU-RO-1", countryCode: "RO", estimatedAvailability: "HIGH" }],
        },
      ],
    },
  }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const gpus = await client.listGpuTypes({ cloud: "SECURE" });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v2/catalog/gpus");
  assert.equal(url.searchParams.get("include"), "AVAILABILITY");
  assert.equal(url.searchParams.get("product"), "POD");
  assert.equal(url.searchParams.get("cloud"), "SECURE");
  assert.deepEqual(gpus, [
    {
      id: "NVIDIA GeForce RTX 4090",
      displayName: "RTX 4090",
      memoryInGb: 24,
      secureCloud: true,
      communityCloud: true,
      onDemandPricePerHr: 0.69,
      spotPricePerHr: 0.34,
      estimatedAvailability: "HIGH",
      dataCenters: [{ id: "EU-RO-1", countryCode: "RO", estimatedAvailability: "HIGH" }],
    },
  ]);
});

test("createNetworkVolume posts name/dataCenterId/size; the response maps size -> sizeGb", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { id: "vol1", name: "models", dataCenterId: "EU-RO-1", size: 150, usedSize: 0, createdAt: "2026-10-05T00:00:00Z" } }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const volume = await client.createNetworkVolume({ name: "models", dataCenterId: "EU-RO-1", sizeGb: 150 });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/v2/network-volumes");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { name: "models", dataCenterId: "EU-RO-1", size: 150 });
  assert.equal(volume.sizeGb, 150);
  assert.equal(volume.dataCenterId, "EU-RO-1");
});

test("terminatePod is DELETE /pods/{id}; 404 means already gone; stop is never called", async () => {
  const { fetchImpl, calls } = fakeFetch((call) => ({ status: call.url.endsWith("/gone") ? 404 : 204 }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  assert.deepEqual(await client.terminatePod("abc123"), { terminated: true, alreadyGone: false });
  assert.deepEqual(await client.terminatePod("gone"), { terminated: true, alreadyGone: true });
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(new URL(calls[0].url).pathname, "/v2/pods/abc123");
  assert.ok(calls.every((c) => !c.url.includes("/stop")));
  const keys = Object.keys(client);
  assert.ok(!keys.includes("stopPod"), "no stop operation is exposed by the gateway");
});

test("getPod returns null on 404 and maps runtime ports, mounts and cost", async () => {
  const { fetchImpl } = fakeFetch((call) =>
    call.url.endsWith("/missing")
      ? { status: 404, body: { title: "Not Found", status: 404 } }
      : {
          status: 200,
          body: {
            id: "p1",
            name: "media",
            status: "RUNNING",
            cost: 0.69,
            dataCenterId: "EU-RO-1",
            gpu: { id: "NVIDIA GeForce RTX 4090", count: 1 },
            mounts: { network: [{ volumeId: "vol1", path: "/workspace" }] },
            runtime: { uptime: 10, ports: [{ private: 8189, public: 12345, type: "http", ip: "1.2.3.4" }] },
            env: { COMFY_TOKEN: "t" },
            createdAt: "2026-10-05T10:00:00Z",
            startedAt: "2026-10-05T10:01:00Z",
          },
        }
  );
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  assert.equal(await client.getPod("missing"), null);
  const pod = await client.getPod("p1");
  assert.ok(pod);
  assert.equal(pod.status, "RUNNING");
  assert.equal(pod.costPerHr, 0.69);
  assert.equal(pod.gpuTypeId, "NVIDIA GeForce RTX 4090");
  assert.deepEqual(pod.networkVolumeIds, ["vol1"]);
  assert.deepEqual(pod.ports, [{ private: 8189, public: 12345, type: "http", ip: "1.2.3.4" }]);
});

test("createTemplate posts the operator body to /templates; listCpuTypes reads the CPU catalog", async () => {
  const { fetchImpl, calls } = fakeFetch((call) =>
    call.url.includes("/catalog/cpus")
      ? { status: 200, body: { cpus: [{ id: "cpu3c", name: "Compute-Optimized", vcpu: { min: 2, max: 32 }, price: { securePerVcpu: 0.04 } }] } }
      : { status: 201, body: { id: "tpl1", name: "ytm-comfy", image: "x/y:z" } }
  );
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const template = await client.createTemplate({ name: "ytm-comfy", image: "x/y:z", ports: ["8189/http"] });
  assert.deepEqual({ id: template.id, name: template.name }, { id: "tpl1", name: "ytm-comfy" });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/v2/templates");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { name: "ytm-comfy", image: "x/y:z", ports: ["8189/http"] });
  const cpus = await client.listCpuTypes();
  assert.deepEqual(cpus, [{ id: "cpu3c", name: "Compute-Optimized", vcpuMin: 2, vcpuMax: 32, securePricePerVcpuHr: 0.04 }]);
  assert.equal(new URL(calls[1].url).searchParams.get("product"), "POD");
});

test("extractList accepts a bare array or any known wrapper key; toPod tolerates missing fields", () => {
  assert.deepEqual(extractList([1], []), [1]);
  assert.deepEqual(extractList({ items: [2] }, ["pods"]), [2]);
  assert.deepEqual(extractList({ pods: [3] }, ["pods"]), [3]);
  assert.deepEqual(extractList({ other: [4] }, ["pods"]), []);
  const pod = toPod({ id: "x" });
  assert.equal(pod.status, "UNKNOWN");
  assert.equal(pod.ports, null);
  assert.deepEqual(pod.networkVolumeIds, []);
});

test("review: a pod's env is redacted (the per-session COMFY_TOKEN never leaves the gateway) and raw carries no env block", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { id: "p1", status: "RUNNING", env: { COMFY_TOKEN: "tok-secret", HF_TOKEN: "hf_x", JUPYTER_PASSWORD: "p", PUBLIC_KEY: "ssh-ed25519 AAA", MODE: "fast" } } }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const pod = await client.getPod("p1");
  assert.ok(pod);
  assert.deepEqual(pod.env, { COMFY_TOKEN: "[redacted]", HF_TOKEN: "[redacted]", JUPYTER_PASSWORD: "[redacted]", PUBLIC_KEY: "[redacted]", MODE: "fast" });
  assert.ok(!JSON.stringify(pod).includes("tok-secret"));
  assert.equal("env" in pod.raw, false);
});
