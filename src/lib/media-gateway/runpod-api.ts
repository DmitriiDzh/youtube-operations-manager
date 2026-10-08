import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { jsonRequest } from "./http";
import { asNumber, asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// Phase 14 -- the single funnel for the RunPod REST API v2 (https://api.runpod.io/v2; v1 at
// rest.runpod.io retires 2026-11-15 per its own overview page, so v1 is not used). Shapes checked
// against docs.runpod.io/api-reference-v2/openapi.json on 2026-10-05. Everything here is a thin,
// typed request wrapper: no policy, no persistence. The API key is passed in by the caller
// (`src/lib/media-generation/` decrypts it immediately before the call) and never stored here.
// ---------------------------------------------------------------------------

export const RUNPOD_API_BASE_URL = "https://api.runpod.io/v2";
/**
 * RunPod's legacy GraphQL API -- the ONLY place the account balance is exposed (REST v2 has no balance endpoint;
 * confirmed live in slice 0, 2026-10-05). Same Bearer key, same host; used for that one read only (slice 6).
 */
export const RUNPOD_GRAPHQL_URL = "https://api.runpod.io/graphql";

/**
 * The account balance (slice 6, AC-P14-25). `graphql`: the live balance from the legacy API. `billing`: GraphQL failed,
 * so the v2 billing history's spend over its default window (pods + network volumes) stands in -- no balance figure.
 */
export type RunpodAccountBalance =
  | { source: "graphql"; balanceUsd: number; spendPerHrUsd: number | null; spendLimitUsd: number | null }
  | { source: "billing"; balanceUsd: null; spentUsd: number; podsUsd: number; networkVolumesUsd: number; from: string | null; to: string | null; balanceError: string };
const REQUEST_TIMEOUT_MS = 30_000;

export type RunpodGpuType = {
  id: string;
  displayName: string;
  memoryInGb: number | null;
  secureCloud: boolean;
  communityCloud: boolean;
  /** USD per hour for an uninterruptible (on-demand) pod, when the catalog reports one. */
  onDemandPricePerHr: number | null;
  spotPricePerHr: number | null;
  estimatedAvailability: string | null;
  dataCenters: Array<{ id: string; countryCode: string | null; estimatedAvailability: string | null }>;
};

export type RunpodDataCenter = {
  id: string;
  countryCode: string | null;
  region: string | null;
  /** Network-volume tiers offered there (`STANDARD`, `HIGH_PERFORMANCE`); empty = no network volumes in this datacenter. */
  networkVolumeTypes: string[];
};

export type RunpodNetworkVolume = {
  id: string;
  name: string;
  dataCenterId: string;
  sizeGb: number;
  usedSizeGb: number | null;
  createdAt: string | null;
};

export type RunpodPodStatus = "PROVISIONING" | "STARTING" | "RUNNING" | "EXITED" | "ERROR" | "TERMINATED" | string;

export type RunpodPod = {
  id: string;
  name: string;
  status: RunpodPodStatus;
  /** USD per hour. */
  costPerHr: number | null;
  dataCenterId: string | null;
  gpuTypeId: string | null;
  gpuCount: number | null;
  networkVolumeIds: string[];
  /** Public ports as the runtime reports them (`null` until the pod runs). */
  ports: Array<{ private: number; public: number | null; type: string; ip: string | null }> | null;
  /**
   * Whether the CONTAINER is actually up (slice 0, 2026-10-05): the live API reports `status: "RUNNING"` from the moment
   * the pod is scheduled -- while the image is still downloading -- and only `runtime` (null until then, then
   * `{ uptime, ports, ... }`) says the container started. Seconds since the container started, or `null` when it has not.
   */
  containerUptimeSec: number | null;
  env: Record<string, string>;
  createdAt: string | null;
  startedAt: string | null;
  /** The raw object, for fields this app does not model (never persisted as-is). */
  raw: Record<string, unknown>;
};

export type CreatePodInput = {
  name: string;
  image?: string;
  templateId?: string;
  gpu?: { id: string; count?: number; vcpuCount?: number; memory?: number; allowedCudaVersions?: string[] };
  cpu?: { id: string; vcpuCount: number };
  cloud?: "SECURE" | "COMMUNITY";
  dataCenterId?: string;
  disk?: number;
  env?: Record<string, string>;
  ports?: string[];
  mounts?: { network?: Array<{ volumeId: string; path: string }> | null; persistent?: { size: number; path: string } | null };
  cmd?: string[];
  entrypoint?: string[];
  startSsh?: boolean;
};

export type RunpodApiClient = ReturnType<typeof createRunpodApiClient>;

type Fetch = typeof fetch;


/**
 * v2 list responses wrap the array (`{ items, pagination }`, `{ gpus }`, `{ dataCenters }`, ...).
 * The exact wrapper key differs per endpoint, so take the array itself, or the first array-valued
 * property of a known name -- to be confirmed live in slice 0.
 */
export function extractList(body: unknown, preferredKeys: string[]): unknown[] {
  if (Array.isArray(body)) return body;
  const record = asRecord(body);
  for (const key of [...preferredKeys, "items", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

/**
 * One catalog GPU. The live v2 shape (observed in slice 0, 2026-10-05) is
 * `{ id, name, memory, secure, community, availability, price: { secure, community, serverless }, dataCenters: [{ id, availability }] }`
 * -- `price.<cloud>` is the on-demand USD/h for that cloud, 0 when the GPU is not offered there. The older field names
 * (`displayName`, `memoryInGb`, `secureCloud`, `lowestPrice.uninterruptablePrice`) are still read as a fallback.
 */
export function toGpuType(raw: unknown, cloud: "SECURE" | "COMMUNITY" = "SECURE"): RunpodGpuType {
  const r = asRecord(raw);
  const lowest = asRecord(r.lowestPrice);
  const price = asRecord(r.price);
  const positive = (n: number | null) => (n !== null && n > 0 ? n : null);
  const cloudPrice = positive(asNumber(cloud === "COMMUNITY" ? price.community : price.secure));
  return {
    id: asString(r.id) ?? "",
    displayName: asString(r.name) ?? asString(r.displayName) ?? asString(r.id) ?? "",
    memoryInGb: asNumber(r.memory) ?? asNumber(r.memoryInGb),
    secureCloud: r.secure === true || r.secureCloud === true,
    communityCloud: r.community === true || r.communityCloud === true,
    onDemandPricePerHr: cloudPrice ?? positive(asNumber(lowest.uninterruptablePrice)),
    spotPricePerHr: asNumber(lowest.minimumBidPrice),
    estimatedAvailability: asString(r.availability) ?? asString(r.estimatedAvailability),
    dataCenters: extractList(r.dataCenters, []).map((dc) => {
      const d = asRecord(dc);
      return { id: asString(d.id) ?? "", countryCode: asString(d.countryCode), estimatedAvailability: asString(d.availability) ?? asString(d.estimatedAvailability) };
    }),
  };
}

export function toNetworkVolume(raw: unknown): RunpodNetworkVolume {
  const r = asRecord(raw);
  return {
    id: asString(r.id) ?? "",
    name: asString(r.name) ?? "",
    // `dataCenterId` or -- as the create body names it -- `dataCenter` (a string or `{ id }`); confirmed per field in slice 0.
    dataCenterId: asString(r.dataCenterId) ?? asString(r.dataCenter) ?? asString(asRecord(r.dataCenter).id) ?? "",
    sizeGb: asNumber(r.size) ?? 0,
    usedSizeGb: asNumber(r.usedSize),
    createdAt: asString(r.createdAt),
  };
}

const SENSITIVE_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASS\b/i;

/** Pod env values that look like secrets (the per-session COMFY_TOKEN above all) never leave the gateway: callers see `[redacted]`. */
export function redactPodEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    out[name] = SENSITIVE_ENV_NAME.test(name) ? "[redacted]" : value;
  }
  return out;
}

export function toPod(raw: unknown): RunpodPod {
  const r = asRecord(raw);
  const gpu = asRecord(r.gpu);
  const runtime = asRecord(r.runtime);
  const mounts = asRecord(r.mounts);
  const env = asRecord(r.env);
  // `raw` keeps every field this app does not model EXCEPT the env block (it carries the proxy token).
  const { env: _rawEnv, ...rawWithoutEnv } = r;
  void _rawEnv;
  return {
    id: asString(r.id) ?? "",
    name: asString(r.name) ?? "",
    status: asString(r.status) ?? asString(r.desiredStatus) ?? "UNKNOWN",
    costPerHr: asNumber(r.cost) ?? asNumber(r.costPerHr),
    dataCenterId: asString(r.dataCenterId),
    gpuTypeId: asString(gpu.id),
    gpuCount: asNumber(gpu.count),
    networkVolumeIds: extractList(mounts.network, []).map((m) => asString(asRecord(m).volumeId) ?? "").filter(Boolean),
    containerUptimeSec: r.runtime && typeof r.runtime === "object" ? (asNumber(runtime.uptime) ?? 0) : null,
    ports: Array.isArray(runtime.ports)
      ? runtime.ports.map((p) => {
          const port = asRecord(p);
          return {
            private: asNumber(port.private) ?? 0,
            public: asNumber(port.public),
            type: asString(port.type) ?? "",
            ip: asString(port.ip),
          };
        })
      : null,
    env: redactPodEnv(env),
    createdAt: asString(r.createdAt),
    startedAt: asString(r.startedAt),
    raw: rawWithoutEnv,
  };
}

export function createRunpodApiClient(args: {
  apiKey: string;
  fetchImpl?: Fetch;
  authorize?: Authorize;
  baseUrl?: string;
  graphqlUrl?: string;
}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const graphqlUrl = args.graphqlUrl ?? RUNPOD_GRAPHQL_URL;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = (args.baseUrl ?? RUNPOD_API_BASE_URL).replace(/\/$/, "");

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    await authorize("runpod_api");
    const response = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method,
      headers: { authorization: `Bearer ${args.apiKey}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: REQUEST_TIMEOUT_MS,
      unavailable: (stage, detail, status) =>
        new DomainError({
          code: "runpod_api_unavailable",
          message: stage === "request" ? `RunPod API request failed: ${detail}` : `RunPod API response could not be read: ${detail}`,
          details: { method, path, ...(status !== undefined ? { status } : {}) },
        }),
    });
    const parsed = response.body;
    if (response.status === 401) {
      throw new DomainError({
        code: "media_credentials_invalid",
        message: `RunPod rejected the API key (HTTP 401).`,
        details: { method, path, status: response.status, detail: asString(asRecord(parsed).detail) },
      });
    }
    if (response.status === 403) {
      // Not a bad key (review round 20): the key lacks permission for THIS resource or operation (a pod or volume of another
      // account, a restricted key), so "re-enter the credentials" would be the wrong advice.
      throw new DomainError({
        code: "runpod_forbidden",
        message: `RunPod refused ${method} ${path} (HTTP 403): the key has no permission for this resource or operation (another account's pod/volume, or a restricted key)${asString(asRecord(parsed).detail) ? ` -- ${asString(asRecord(parsed).detail)}` : ""}.`,
        details: { method, path, status: response.status, detail: asString(asRecord(parsed).detail) },
      });
    }
    if (!response.ok) {
      throw new DomainError({
        code: "runpod_api_unavailable",
        message: `RunPod API returned HTTP ${response.status}${asString(asRecord(parsed).detail) ? `: ${asString(asRecord(parsed).detail)}` : ""}.`,
        details: { method, path, status: response.status, body: parsed },
      });
    }
    return { status: response.status, body: parsed };
  }

  /** The legacy-GraphQL reads (balance, account id, a pod's host CUDA version). Errors arrive as HTTP 200 + `errors[]` too; both become DomainErrors. */
  async function graphql(query: string): Promise<Record<string, unknown>> {
    await authorize("runpod_api");
    const response = await jsonRequest({
      fetchImpl,
      url: graphqlUrl,
      method: "POST",
      headers: { authorization: `Bearer ${args.apiKey}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ query }),
      timeoutMs: REQUEST_TIMEOUT_MS,
      unavailable: (stage, detail, status) =>
        new DomainError({ code: "runpod_api_unavailable", message: `RunPod GraphQL ${stage === "request" ? "request failed" : "response could not be read"}: ${detail}`, details: { path: "graphql", ...(status !== undefined ? { status } : {}) } }),
    });
    if (response.status === 401) throw new DomainError({ code: "media_credentials_invalid", message: "RunPod rejected the API key (HTTP 401).", details: { path: "graphql", status: 401 } });
    const body = asRecord(response.body);
    const errors = Array.isArray(body.errors) ? body.errors.map((e) => asString(asRecord(e).message) ?? "error").join("; ") : null;
    if (!response.ok || errors) {
      throw new DomainError({ code: "runpod_api_unavailable", message: `RunPod GraphQL returned ${response.ok ? "errors" : `HTTP ${response.status}`}${errors ? `: ${errors}` : ""}.`, details: { path: "graphql", status: response.status } });
    }
    return asRecord(body.data);
  }

  return {
    /**
     * Slice 6 (AC-P14-25): the account balance from the legacy GraphQL API; when that fails for any reason (a key without
     * GraphQL scope, the legacy API retired, a timeout), the v2 billing history's spend instead, tagged `billing`. A bad
     * key (401) is not degraded: it is the same answer every other call would give.
     */
    /**
     * BL-138: the RunPod account's id (legacy GraphQL `myself.id`), so devices can tell whether they share one account without
     * publishing anything derived from a key. `null` when the GraphQL API does not answer it (a key without that scope).
     */
    async getAccountId(): Promise<string | null> {
      try {
        return asString(asRecord((await graphql("query { myself { id } }")).myself).id);
      } catch (error) {
        if (error instanceof DomainError && error.code === "media_credentials_invalid") throw error;
        return null;
      }
    },

    /**
     * BL-155 (CUDA_HOSTS_PLAN.md AC-CU-02; graphql-spec.runpod.io): the CUDA version the pod's host driver supports, read over the
     * legacy GraphQL API (`pod { machine { machineSystem { cudaVersion } } }`). `null` whenever it cannot be told -- an id that is
     * not a plain RunPod id (never put into the query), a missing field, GraphQL errors, a timeout: an unknown host never blocks
     * a start. A rejected key (401) is not degraded, like every other call.
     */
    async getPodHostCudaVersion(podId: string): Promise<string | null> {
      if (!/^[a-z0-9]{6,32}$/i.test(podId)) return null;
      try {
        const pod = asRecord((await graphql(`query { pod(input: { podId: ${JSON.stringify(podId)} }) { machine { machineSystem { cudaVersion } } } }`)).pod);
        return asString(asRecord(asRecord(pod.machine).machineSystem).cudaVersion) || null;
      } catch (error) {
        if (error instanceof DomainError && error.code === "media_credentials_invalid") throw error;
        return null;
      }
    },

    async getAccountBalance(): Promise<RunpodAccountBalance> {
      let balanceError: string;
      try {
        const myself = asRecord((await graphql("query { myself { clientBalance currentSpendPerHr spendLimit } }")).myself);
        const balanceUsd = asNumber(myself.clientBalance);
        if (balanceUsd === null) throw new DomainError({ code: "runpod_api_unavailable", message: "RunPod GraphQL answered without myself.clientBalance." });
        return { source: "graphql", balanceUsd, spendPerHrUsd: asNumber(myself.currentSpendPerHr), spendLimitUsd: asNumber(myself.spendLimit) };
      } catch (error) {
        if (error instanceof DomainError && error.code === "media_credentials_invalid") throw error;
        if (error instanceof DomainError && error.code === "media_gateway_disabled") throw error;
        balanceError = error instanceof Error ? error.message : String(error);
      }
      const [pods, volumes] = await Promise.all([request("GET", "/billing/pods?bucketSize=day"), request("GET", "/billing/networkvolumes?bucketSize=day")]);
      const total = (body: unknown) => asNumber(asRecord(asRecord(asRecord(body).metadata).totals).totalAmount) ?? 0;
      const query = asRecord(asRecord(asRecord(pods.body).metadata).query);
      const podsUsd = total(pods.body);
      const networkVolumesUsd = total(volumes.body);
      return { source: "billing", balanceUsd: null, spentUsd: Math.round((podsUsd + networkVolumesUsd) * 100) / 100, podsUsd, networkVolumesUsd, from: asString(query.startTime), to: asString(query.endTime), balanceError };
    },

    /** One authenticated read with no side effect: 200 = the key works. */
    async verifyKey(): Promise<{ ok: true }> {
      // A read in the scope the app actually needs (pods), so a Restricted key for pods + storage -- what the Settings help
      // advises -- passes; an account-scope probe could 403 on it (review round 21; confirmed only by slice 0, RISK-107).
      await request("GET", "/pods?limit=1");
      return { ok: true };
    },

    async listGpuTypes(options: { cloud?: "SECURE" | "COMMUNITY" } = {}): Promise<RunpodGpuType[]> {
      const params = new URLSearchParams({ include: "AVAILABILITY", product: "POD" });
      if (options.cloud) params.set("cloud", options.cloud);
      const { body } = await request("GET", `/catalog/gpus?${params.toString()}`);
      return extractList(body, ["gpus"]).map((g) => toGpuType(g, options.cloud ?? "SECURE")).filter((g) => g.id);
    },

    async listDataCenters(): Promise<RunpodDataCenter[]> {
      // `/catalog/datacenters` (slice 0, 2026-10-05: `/catalog/data-centers` is a 404).
      const { body } = await request("GET", "/catalog/datacenters");
      return extractList(body, ["dataCenters"])
        .map((raw) => {
          const r = asRecord(raw);
          const types = Array.isArray(r.networkVolumeTypes) ? r.networkVolumeTypes.filter((t): t is string => typeof t === "string") : [];
          return { id: asString(r.id) ?? "", countryCode: asString(r.countryCode), region: asString(r.region), networkVolumeTypes: types };
        })
        .filter((dc) => dc.id);
    },

    async listNetworkVolumes(): Promise<RunpodNetworkVolume[]> {
      const { body } = await request("GET", "/network-volumes");
      return extractList(body, ["networkVolumes", "volumes"]).map(toNetworkVolume).filter((v) => v.id);
    },

    async getNetworkVolume(id: string): Promise<RunpodNetworkVolume | null> {
      try {
        const { body } = await request("GET", `/network-volumes/${encodeURIComponent(id)}`);
        return toNetworkVolume(body);
      } catch (error) {
        if (error instanceof DomainError && error.code === "runpod_api_unavailable" && asRecord(error.details).status === 404) return null;
        throw error;
      }
    },

    async createNetworkVolume(input: { name: string; dataCenterId: string; sizeGb: number }): Promise<RunpodNetworkVolume> {
      // The create body names the datacenter `dataCenter` (slice 0, 2026-10-05: `dataCenterId` is a 422 "additional property").
      const { body } = await request("POST", "/network-volumes", { name: input.name, dataCenter: input.dataCenterId, size: input.sizeGb });
      return toNetworkVolume(body);
    },

    /**
     * Grows a network volume (`PATCH /network-volumes/{id}` with `{ size }`). RunPod only ever increases a volume's size: "`size`
     * may only increase; attempts to reduce size will be rejected" (v2 API reference, update a network volume) -- the caller
     * checks the current size first; a reduction that slips through is RunPod's HTTP 400.
     */
    async resizeNetworkVolume(id: string, sizeGb: number): Promise<RunpodNetworkVolume> {
      const { body } = await request("PATCH", `/network-volumes/${encodeURIComponent(id)}`, { size: sizeGb });
      return toNetworkVolume(body);
    },

    /**
     * Permanently deletes a network volume and everything on it (`DELETE /network-volumes/{id}`, 204 with no body, v2 API
     * reference). A 404 means it is already gone. Destructive: callers confirm with the operator first.
     */
    async deleteNetworkVolume(id: string): Promise<{ deleted: true; alreadyGone: boolean }> {
      try {
        await request("DELETE", `/network-volumes/${encodeURIComponent(id)}`);
        return { deleted: true, alreadyGone: false };
      } catch (error) {
        if (error instanceof DomainError && error.code === "runpod_api_unavailable" && asRecord(error.details).status === 404) return { deleted: true, alreadyGone: true };
        throw error;
      }
    },

    /** Every pod of the account: v2 lists are paged (`{ items, pagination: { nextCursor, hasNextPage } }`), so the cursor is followed. */
    async listPods(): Promise<RunpodPod[]> {
      const pods: RunpodPod[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 100; page++) {
        const params = new URLSearchParams({ limit: "1000" });
        if (cursor) params.set("cursor", cursor);
        const { body } = await request("GET", `/pods?${params.toString()}`);
        pods.push(...extractList(body, ["pods"]).map(toPod).filter((p) => p.id));
        const pagination = asRecord(asRecord(body).pagination);
        cursor = pagination.hasNextPage === true && typeof pagination.nextCursor === "string" ? pagination.nextCursor : null;
        if (!cursor) break;
      }
      return pods;
    },

    async getPod(id: string): Promise<RunpodPod | null> {
      try {
        const { body } = await request("GET", `/pods/${encodeURIComponent(id)}`);
        return toPod(body);
      } catch (error) {
        if (error instanceof DomainError && error.code === "runpod_api_unavailable" && asRecord(error.details).status === 404) return null;
        throw error;
      }
    },

    async createPod(input: CreatePodInput): Promise<RunpodPod> {
      // The live API takes the datacenter as an ARRAY `dataCenterIds` (slice 0, 2026-10-05: both `dataCenterId` and
      // `dataCenter` are 422 "additional property"); callers keep passing the one datacenter they mean.
      const { dataCenterId, ...rest } = input;
      const { body } = await request("POST", "/pods", { ...rest, ...(dataCenterId ? { dataCenterIds: [dataCenterId] } : {}) });
      return toPod(body);
    },

    /** `DELETE /pods/{id}`: terminate (never stop -- a stopped pod's disk is billed at the doubled rate). 404 = already gone. */
    async terminatePod(id: string): Promise<{ terminated: true; alreadyGone: boolean }> {
      try {
        await request("DELETE", `/pods/${encodeURIComponent(id)}`);
        return { terminated: true, alreadyGone: false };
      } catch (error) {
        if (error instanceof DomainError && error.code === "runpod_api_unavailable" && asRecord(error.details).status === 404) {
          return { terminated: true, alreadyGone: true };
        }
        throw error;
      }
    },

    /** `GET /catalog/cpus` -- CPU flavors (for the model-pull pod, which needs no GPU). */
    async listCpuTypes(): Promise<Array<{ id: string; name: string; vcpuMin: number | null; vcpuMax: number | null; securePricePerVcpuHr: number | null }>> {
      const { body } = await request("GET", "/catalog/cpus?include=AVAILABILITY&product=POD");
      return extractList(body, ["cpus"])
        .map((raw) => {
          const r = asRecord(raw);
          const vcpu = asRecord(r.vcpu);
          const price = asRecord(r.price);
          return {
            id: asString(r.id) ?? "",
            name: asString(r.name) ?? asString(r.displayName) ?? "",
            vcpuMin: asNumber(vcpu.min),
            vcpuMax: asNumber(vcpu.max),
            securePricePerVcpuHr: asNumber(price.securePerVcpu),
          };
        })
        .filter((c) => c.id);
    },

    /** `POST /templates` with an operator-authored v2 body (name, image, ports, env, disk, mounts.persistent, ...). */
    async createTemplate(body: Record<string, unknown>): Promise<{ id: string; name: string; raw: Record<string, unknown> }> {
      const { body: created } = await request("POST", "/templates", body);
      const r = asRecord(created);
      return { id: asString(r.id) ?? "", name: asString(r.name) ?? "", raw: r };
    },

    async listTemplates(): Promise<Array<{ id: string; name: string; raw: Record<string, unknown> }>> {
      const { body } = await request("GET", "/templates");
      return extractList(body, ["templates"])
        .map((raw) => {
          const r = asRecord(raw);
          return { id: asString(r.id) ?? "", name: asString(r.name) ?? "", raw: r };
        })
        .filter((t) => t.id);
    },
  };
}
