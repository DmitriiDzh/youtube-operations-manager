import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";
import { asNumber, asRecord, asString } from "./json";

// ---------------------------------------------------------------------------
// Phase 14 -- the single funnel for the RunPod REST API v2 (https://api.runpod.io/v2; v1 at
// rest.runpod.io retires 2026-11-15 per its own overview page, so v1 is not used). Shapes checked
// against docs.runpod.io/api-reference-v2/openapi.json on 2026-10-05. Everything here is a thin,
// typed request wrapper: no policy, no persistence. The API key is passed in by the caller
// (`src/lib/media-generation/` decrypts it immediately before the call) and never stored here.
// ---------------------------------------------------------------------------

export const RUNPOD_API_BASE_URL = "https://api.runpod.io/v2";
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

export type RunpodDataCenter = { id: string; countryCode: string | null; region: string | null };

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

export function toGpuType(raw: unknown): RunpodGpuType {
  const r = asRecord(raw);
  const lowest = asRecord(r.lowestPrice);
  return {
    id: asString(r.id) ?? "",
    displayName: asString(r.displayName) ?? asString(r.id) ?? "",
    memoryInGb: asNumber(r.memoryInGb),
    secureCloud: r.secureCloud === true,
    communityCloud: r.communityCloud === true,
    onDemandPricePerHr: asNumber(lowest.uninterruptablePrice),
    spotPricePerHr: asNumber(lowest.minimumBidPrice),
    estimatedAvailability: asString(r.estimatedAvailability),
    dataCenters: extractList(r.dataCenters, []).map((dc) => {
      const d = asRecord(dc);
      return { id: asString(d.id) ?? "", countryCode: asString(d.countryCode), estimatedAvailability: asString(d.estimatedAvailability) };
    }),
  };
}

export function toNetworkVolume(raw: unknown): RunpodNetworkVolume {
  const r = asRecord(raw);
  return {
    id: asString(r.id) ?? "",
    name: asString(r.name) ?? "",
    dataCenterId: asString(r.dataCenterId) ?? "",
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
}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = (args.baseUrl ?? RUNPOD_API_BASE_URL).replace(/\/$/, "");

  async function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    await authorize("runpod_api");
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${args.apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DomainError({
        code: "runpod_api_unavailable",
        message: `RunPod API request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { method, path },
      });
    }
    let text: string;
    try {
      text = await response.text(); // the 30 s signal can also fire while the body streams
    } catch (error) {
      throw new DomainError({
        code: "runpod_api_unavailable",
        message: `RunPod API response could not be read: ${error instanceof Error ? error.message : String(error)}`,
        details: { method, path, status: response.status },
      });
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }
    if (response.status === 401 || response.status === 403) {
      throw new DomainError({
        code: "media_credentials_invalid",
        message: `RunPod rejected the API key (HTTP ${response.status}).`,
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

  return {
    /** One authenticated read with no side effect: 200 = the key works. */
    async verifyKey(): Promise<{ ok: true }> {
      await request("GET", "/account/ssh-keys");
      return { ok: true };
    },

    async listGpuTypes(options: { cloud?: "SECURE" | "COMMUNITY" } = {}): Promise<RunpodGpuType[]> {
      const params = new URLSearchParams({ include: "AVAILABILITY", product: "POD" });
      if (options.cloud) params.set("cloud", options.cloud);
      const { body } = await request("GET", `/catalog/gpus?${params.toString()}`);
      return extractList(body, ["gpus"]).map(toGpuType).filter((g) => g.id);
    },

    async listDataCenters(): Promise<RunpodDataCenter[]> {
      const { body } = await request("GET", "/catalog/data-centers");
      return extractList(body, ["dataCenters"])
        .map((raw) => {
          const r = asRecord(raw);
          return { id: asString(r.id) ?? "", countryCode: asString(r.countryCode), region: asString(r.region) };
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
      const { body } = await request("POST", "/network-volumes", { name: input.name, dataCenterId: input.dataCenterId, size: input.sizeGb });
      return toNetworkVolume(body);
    },

    async listPods(): Promise<RunpodPod[]> {
      const { body } = await request("GET", "/pods");
      return extractList(body, ["pods"]).map(toPod).filter((p) => p.id);
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
      const { body } = await request("POST", "/pods", input);
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
