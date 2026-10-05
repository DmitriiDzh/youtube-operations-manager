import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, type Authorize } from "./authorization";

// ---------------------------------------------------------------------------
// Phase 14 -- the single funnel for the ComfyUI server API on a pod
// (docs.comfy.org/development/comfyui-server/comms_routes, checked 2026-10-05): POST /prompt,
// GET /history/{id}, GET /queue, POST /interrupt, GET /system_stats, POST /upload/image. The base
// URL is built from the pod id (RunPod's HTTP proxy), never from operator input, and every call
// carries the per-session bearer token the pod's reverse proxy checks (PHASE_14_PLAN.md §2.5).
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

/** `https://<podId>-<port>.proxy.runpod.net` -- RunPod's HTTP proxy for an exposed `port/http`. */
export function comfyUiProxyBaseUrl(podId: string, port: number): string {
  if (!/^[a-z0-9]{6,32}$/i.test(podId)) {
    throw new DomainError({ code: "media_settings_invalid", message: `Not a RunPod pod id: ${podId}` });
  }
  return `https://${podId}-${port}.proxy.runpod.net`;
}

export type ComfyOutputFile = { filename: string; subfolder: string; type: string };

export type ComfyHistoryEntry = {
  promptId: string;
  /** `completed`, `error`, or `running` (still absent from history). */
  status: "completed" | "error" | "unknown";
  statusMessages: string[];
  /** Every output file across nodes, with the node id and the output kind (`images`, `audio`, `gifs`, ...). */
  outputs: Array<ComfyOutputFile & { nodeId: string; kind: string }>;
  raw: Record<string, unknown>;
};

export type ComfyUiClient = ReturnType<typeof createComfyUiClient>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function parseHistoryEntry(promptId: string, raw: unknown): ComfyHistoryEntry | null {
  const entry = asRecord(asRecord(raw)[promptId]);
  if (Object.keys(entry).length === 0) return null;
  const status = asRecord(entry.status);
  const statusStr = typeof status.status_str === "string" ? status.status_str : null;
  const messages: string[] = [];
  if (Array.isArray(status.messages)) {
    for (const m of status.messages) {
      if (Array.isArray(m) && typeof m[0] === "string") messages.push(m[0]);
    }
  }
  const outputs: ComfyHistoryEntry["outputs"] = [];
  for (const [nodeId, nodeOutputs] of Object.entries(asRecord(entry.outputs))) {
    for (const [kind, files] of Object.entries(asRecord(nodeOutputs))) {
      if (!Array.isArray(files)) continue;
      for (const f of files) {
        const file = asRecord(f);
        if (typeof file.filename !== "string") continue;
        outputs.push({
          nodeId,
          kind,
          filename: file.filename,
          subfolder: typeof file.subfolder === "string" ? file.subfolder : "",
          type: typeof file.type === "string" ? file.type : "output",
        });
      }
    }
  }
  return {
    promptId,
    status: statusStr === "success" ? "completed" : statusStr === "error" ? "error" : "unknown",
    statusMessages: messages,
    outputs,
    raw: entry,
  };
}

export function createComfyUiClient(args: { baseUrl: string; token: string | null; fetchImpl?: typeof fetch; authorize?: Authorize }) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = args.baseUrl.replace(/\/$/, "");

  async function request(method: string, path: string, options: { json?: unknown; form?: FormData } = {}): Promise<{ status: number; body: unknown }> {
    await authorize("comfyui_api");
    const headers: Record<string, string> = { accept: "application/json" };
    if (args.token) headers.authorization = `Bearer ${args.token}`;
    if (options.json !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.form ?? (options.json === undefined ? undefined : JSON.stringify(options.json)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new DomainError({
        code: "comfyui_unavailable",
        message: `ComfyUI request failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { method, path },
      });
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      throw new DomainError({
        code: "comfyui_unavailable",
        message: `ComfyUI returned HTTP ${response.status} for ${method} ${path}.`,
        details: { method, path, status: response.status, body },
      });
    }
    return { status: response.status, body };
  }

  return {
    baseUrl,

    /** Readiness probe: 200 with device info once ComfyUI is up behind the proxy. */
    async getSystemStats(): Promise<Record<string, unknown>> {
      const { body } = await request("GET", "/system_stats");
      return asRecord(body);
    },

    /**
     * Queues an API-format workflow. ComfyUI validates it first: a validation failure comes back
     * as `node_errors` (HTTP 400) and is surfaced as `comfyui_unavailable` with the node errors in
     * `details`, so the caller can mark the job failed without a second call.
     */
    async submitPrompt(input: { prompt: Record<string, unknown>; clientId?: string }): Promise<{ promptId: string; queueNumber: number | null }> {
      const { body } = await request("POST", "/prompt", { json: { prompt: input.prompt, ...(input.clientId ? { client_id: input.clientId } : {}) } });
      const record = asRecord(body);
      if (typeof record.prompt_id !== "string") {
        throw new DomainError({
          code: "comfyui_unavailable",
          message: "ComfyUI did not return a prompt_id.",
          details: { error: record.error ?? null, nodeErrors: record.node_errors ?? null },
        });
      }
      return { promptId: record.prompt_id, queueNumber: typeof record.number === "number" ? record.number : null };
    },

    /** `null` while the prompt is still queued/running (not yet in history). */
    async getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
      const { body } = await request("GET", `/history/${encodeURIComponent(promptId)}`);
      return parseHistoryEntry(promptId, body);
    },

    /** Queue entries are `[number, prompt_id, prompt, extra, outputs]` tuples; the ids are what a cancel needs. */
    async getQueue(): Promise<{ running: number; pending: number; runningPromptIds: string[]; pendingPromptIds: string[] }> {
      const { body } = await request("GET", "/queue");
      const record = asRecord(body);
      const ids = (entries: unknown): string[] =>
        Array.isArray(entries) ? entries.map((e) => (Array.isArray(e) && typeof e[1] === "string" ? e[1] : null)).filter((id): id is string => id !== null) : [];
      const runningPromptIds = ids(record.queue_running);
      const pendingPromptIds = ids(record.queue_pending);
      return { running: runningPromptIds.length, pending: pendingPromptIds.length, runningPromptIds, pendingPromptIds };
    },

    /** Interrupts whatever ComfyUI is executing RIGHT NOW -- only correct for a job known to be the running one. */
    async interrupt(): Promise<void> {
      await request("POST", "/interrupt");
    },

    /** Removes not-yet-started prompts from the queue (`POST /queue {delete: [...]}`); the running one is untouched. */
    async deleteQueued(promptIds: string[]): Promise<void> {
      if (promptIds.length === 0) return;
      await request("POST", "/queue", { json: { delete: promptIds } });
    },

    async uploadImage(input: { filename: string; bytes: Uint8Array; subfolder?: string; overwrite?: boolean }): Promise<{ name: string; subfolder: string }> {
      const form = new FormData();
      const bytes = new Uint8Array(input.bytes.byteLength);
      bytes.set(input.bytes);
      form.set("image", new Blob([bytes]), input.filename);
      if (input.subfolder) form.set("subfolder", input.subfolder);
      form.set("overwrite", input.overwrite ? "true" : "false");
      form.set("type", "input");
      const { body } = await request("POST", "/upload/image", { form });
      const record = asRecord(body);
      return { name: typeof record.name === "string" ? record.name : input.filename, subfolder: typeof record.subfolder === "string" ? record.subfolder : "" };
    },

    /** The `/view` URL for an output -- used only for previews; files themselves travel over S3. */
    viewUrl(file: ComfyOutputFile): string {
      const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
      return `${baseUrl}/view?${params.toString()}`;
    },
  };
}
