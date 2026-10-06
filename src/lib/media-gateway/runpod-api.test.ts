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
  assert.equal(calls[0].url, "https://api.runpod.io/v2/pods?limit=1");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer rpa_secret");
  assert.deepEqual(authorized, ["runpod_api"]);
});

test("a 401 from RunPod is media_credentials_invalid; a 403 is runpod_forbidden (the key is fine, the resource is not ours -- review round 20); another failure is runpod_api_unavailable with the status", async () => {
  const unauthorized = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 401, body: { title: "Unauthorized", status: 401, detail: "bad key" } })).fetchImpl });
  await assert.rejects(unauthorized.verifyKey(), (e: unknown) => isDomainError(e) && e.code === "media_credentials_invalid");
  const foreign = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 403, body: { detail: "not your pod" } })).fetchImpl });
  await assert.rejects(foreign.terminatePod("someone-elses"), (e: unknown) => isDomainError(e) && e.code === "runpod_forbidden" && /not your pod/.test(e.message));

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

// Slice 0 (2026-10-05): the LIVE catalog shapes, recorded from the real RunPod v2 API (abridged to the fields read).
test("slice 0: the live GPU catalog shape -- name/memory/secure/community, price.<cloud> per cloud (0 = not offered), availability per datacenter", async () => {
  const live = {
    gpus: [
      { availability: "LOW", community: true, dataCenters: [{ availability: "LOW", id: "EU-RO-1", name: "EU-RO-1" }, { availability: "LOW", id: "EUR-IS-1", name: "EUR-IS-1" }], id: "NVIDIA GeForce RTX 4090", manufacturer: "NVIDIA", maxCount: { community: 8, secure: 8 }, memory: 24, name: "RTX 4090", pool: "ADA_24", price: { community: 0.34, secure: 0.74, serverless: 1.1 }, secure: true },
      { availability: "NONE", community: true, id: "NVIDIA A100-SXM4-40GB", manufacturer: "NVIDIA", maxCount: { community: 2, secure: 0 }, memory: 40, name: "A100 SXM 40GB", pool: null, price: { community: 1, secure: 0 }, secure: false },
    ],
  };
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 200, body: live })).fetchImpl });
  const secure = await client.listGpuTypes({ cloud: "SECURE" });
  assert.deepEqual(secure[0], {
    id: "NVIDIA GeForce RTX 4090",
    displayName: "RTX 4090",
    memoryInGb: 24,
    secureCloud: true,
    communityCloud: true,
    onDemandPricePerHr: 0.74,
    spotPricePerHr: null,
    estimatedAvailability: "LOW",
    dataCenters: [
      { id: "EU-RO-1", countryCode: null, estimatedAvailability: "LOW" },
      { id: "EUR-IS-1", countryCode: null, estimatedAvailability: "LOW" },
    ],
  });
  assert.equal(secure[1].onDemandPricePerHr, null, "price 0 = not offered on Secure Cloud");
  assert.equal(secure[1].secureCloud, false);
  const community = await client.listGpuTypes({ cloud: "COMMUNITY" });
  assert.equal(community[0].onDemandPricePerHr, 0.34);
});

test("slice 0: the datacenter catalog lives at /catalog/datacenters and carries the network-volume tiers", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({
    status: 200,
    body: { dataCenters: [{ compliance: [], globalNetwork: true, id: "EU-RO-1", name: "EU-RO-1", networkVolumeTypes: ["STANDARD"], region: "EUROPE" }, { compliance: [], globalNetwork: true, id: "EU-CZ-1", name: "EU-CZ-1", networkVolumeTypes: [], region: "EUROPE" }] },
  }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const dcs = await client.listDataCenters();
  assert.equal(new URL(calls[0].url).pathname, "/v2/catalog/datacenters");
  assert.deepEqual(dcs, [
    { id: "EU-RO-1", countryCode: null, region: "EUROPE", networkVolumeTypes: ["STANDARD"] },
    { id: "EU-CZ-1", countryCode: null, region: "EUROPE", networkVolumeTypes: [] },
  ]);
});

// Slice 0 (2026-10-05): the live API rejects `dataCenterId` in the create body with a 422 ("missing property 'dataCenter'",
// "additional properties 'dataCenterId' not allowed") -- the field is `dataCenter`. The earlier expectation was an assumption.
test("createNetworkVolume posts name/dataCenter/size (the live API's field names); the response maps size -> sizeGb and accepts dataCenterId or dataCenter", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { id: "vol1", name: "models", dataCenterId: "EU-RO-1", size: 150, usedSize: 0, createdAt: "2026-10-05T00:00:00Z" } }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const volume = await client.createNetworkVolume({ name: "models", dataCenterId: "EU-RO-1", sizeGb: 150 });
  assert.equal(calls[0].init.method, "POST");
  assert.equal(new URL(calls[0].url).pathname, "/v2/network-volumes");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { name: "models", dataCenter: "EU-RO-1", size: 150 });
  const named = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 201, body: { id: "vol2", name: "m", dataCenter: "EUR-IS-1", size: 50 } })).fetchImpl });
  assert.equal((await named.createNetworkVolume({ name: "m", dataCenterId: "EUR-IS-1", sizeGb: 50 })).dataCenterId, "EUR-IS-1");
  assert.equal(volume.sizeGb, 150);
  assert.equal(volume.dataCenterId, "EU-RO-1");
});

// RunPod v2 API reference, "Update a network volume": PATCH /v2/network-volumes/{id}, body example {"size": 200}; the 200 response
// is the NetworkVolume ({ id, name, size, dataCenter, type }); "size may only increase; attempts to reduce size will be rejected" (400).
test("resizeNetworkVolume is PATCH /network-volumes/{id} with only { size }; the response maps size -> sizeGb", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: "2q9m7x4c", name: "training-dataset", size: 200, dataCenter: "US-KS-2", type: "HIGH_PERFORMANCE" } }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const volume = await client.resizeNetworkVolume("2q9m7x4c", 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(new URL(calls[0].url).pathname, "/v2/network-volumes/2q9m7x4c");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { size: 200 });
  assert.equal(volume.id, "2q9m7x4c");
  assert.equal(volume.sizeGb, 200);
  assert.equal(volume.dataCenterId, "US-KS-2");
});

test("resizeNetworkVolume surfaces RunPod's 400 for a size decrease as an error, not a volume", async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 400, body: { title: "Bad Request", status: 400, detail: "size can only be increased" } }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  await assert.rejects(client.resizeNetworkVolume("vol1", 50));
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

test("review 5: listPods follows the v2 cursor pagination", async () => {
  const { fetchImpl, calls } = fakeFetch((call) =>
    call.url.includes("cursor=c2")
      ? { status: 200, body: { items: [{ id: "p2", status: "RUNNING" }], pagination: { nextCursor: null, hasNextPage: false } } }
      : { status: 200, body: { items: [{ id: "p1", status: "RUNNING" }], pagination: { nextCursor: "c2", hasNextPage: true } } }
  );
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  const pods = await client.listPods();
  assert.deepEqual(pods.map((p) => p.id), ["p1", "p2"]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("cursor"), "c2");
});

// Slice 0 (2026-10-05): the live API rejects `dataCenterId` and `dataCenter` in POST /pods (422 "additional property");
// with `dataCenterIds: [...]` the body passes validation (an unknown GPU id then fails as "Unknown GPU type").
test("slice 0: createPod sends the datacenter as dataCenterIds: [id] and never dataCenterId", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: { id: "pod1", name: "ytm-media-x", desiredStatus: "RUNNING" } }));
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl });
  await client.createPod({ name: "ytm-media-x", templateId: "tpl", gpu: { id: "NVIDIA GeForce RTX 4090", count: 1 }, cloud: "SECURE", dataCenterId: "EU-RO-1", mounts: { network: [{ volumeId: "vol", path: "/workspace" }] }, ports: ["8189/http"], env: { COMFY_TOKEN: "t" } });
  const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.deepEqual(sent.dataCenterIds, ["EU-RO-1"]);
  assert.equal("dataCenterId" in sent, false);
  await client.createPod({ name: "no-dc", image: "x" });
  assert.equal("dataCenterIds" in (JSON.parse(String(calls[1].init.body)) as Record<string, unknown>), false);
});

test("slice 0: toPod reads container uptime from runtime -- null while RUNNING with no runtime (image still downloading)", async () => {
  const { toPod } = await import("./runpod-api");
  const downloading = toPod({ id: "p", name: "n", status: "RUNNING", runtime: null, cost: 0.74 });
  assert.equal(downloading.status, "RUNNING");
  assert.equal(downloading.containerUptimeSec, null);
  const up = toPod({ id: "p", name: "n", status: "RUNNING", runtime: { uptime: 26, ports: [{ ip: "100.65.21.246", private: 8189, public: 60335, type: "http" }] } });
  assert.equal(up.containerUptimeSec, 26);
  assert.equal(up.ports?.[0].private, 8189);
});

// -- slice 6: account balance (AC-P14-25; PHASE_14_PLAN.md §5.2) --------------------------------------
// Expected shapes from the live slice-0/slice-6 probes (2026-10-05): GraphQL `myself { clientBalance currentSpendPerHr
// spendLimit }`; v2 `/billing/pods` and `/billing/networkvolumes` with `metadata.totals.totalAmount`.

test("AC-P14-25: the balance comes from RunPod's GraphQL API with the same bearer key, sent nowhere but api.runpod.io", async () => {
  const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { data: { myself: { clientBalance: 12.72, currentSpendPerHr: 0.005, spendLimit: 80 } } } }));
  const client = createRunpodApiClient({ apiKey: "rpa_secret", fetchImpl, authorize: noAuth });
  assert.deepEqual(await client.getAccountBalance(), { source: "graphql", balanceUsd: 12.72, spendPerHrUsd: 0.005, spendLimitUsd: 80 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.runpod.io/graphql");
  assert.equal(calls[0].init.method, "POST");
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer rpa_secret");
  assert.ok(!String(calls[0].init.body).includes("rpa_secret"), "the key travels only in the header");
  assert.match(String(calls[0].init.body), /clientBalance/);
});

test("AC-P14-25: when GraphQL fails (HTTP error or GraphQL errors), the panel degrades to the v2 billing spend, saying why", async () => {
  for (const graphqlAnswer of [{ status: 500, body: { message: "down" } }, { status: 200, body: { errors: [{ message: "Field 'myself' is not authorized" }] } }]) {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/graphql")) return graphqlAnswer;
      if (call.url.includes("/billing/pods")) return { status: 200, body: { metadata: { query: { startTime: "2026-09-05T00:00:00Z", endTime: "2026-10-06T00:00:00Z" }, totals: { totalAmount: 0.25 } }, records: [] } };
      if (call.url.includes("/billing/networkvolumes")) return { status: 200, body: { metadata: { totals: { totalAmount: 3.5 } }, records: [] } };
      return { status: 404 };
    });
    const client = createRunpodApiClient({ apiKey: "k", fetchImpl, authorize: noAuth });
    const balance = await client.getAccountBalance();
    assert.equal(balance.source, "billing");
    if (balance.source !== "billing") continue;
    assert.equal(balance.balanceUsd, null);
    assert.equal(balance.podsUsd, 0.25);
    assert.equal(balance.networkVolumesUsd, 3.5);
    assert.equal(balance.spentUsd, 3.75);
    assert.equal(balance.from, "2026-09-05T00:00:00Z");
    assert.ok(balance.balanceError.length > 0);
    assert.ok(calls.every((c) => c.url.startsWith("https://api.runpod.io/")));
  }
});

test("AC-P14-25: a rejected key is not degraded -- it is media_credentials_invalid like every other call", async () => {
  const client = createRunpodApiClient({ apiKey: "k", authorize: noAuth, fetchImpl: fakeFetch(() => ({ status: 401 })).fetchImpl });
  await assert.rejects(client.getAccountBalance(), (e: unknown) => isDomainError(e) && e.code === "media_credentials_invalid");
});
