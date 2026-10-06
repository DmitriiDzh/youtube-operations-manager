import { DomainError } from "@/lib/shared-domain";
import { assertMediaGatewayAuthorized, isMediaGatewayEnabled, type Authorize } from "./authorization";
import { isJsonBody, jsonRequest } from "./http";
import { asRecord } from "./json";
import {
  comfyProgressSocketUrl,
  defaultProgressSocketFactory,
  parseComfyProgressMessage,
  type ComfyProgressEvent,
  type ProgressSocketFactory,
  type ProgressStream,
} from "./comfyui-progress";

// ---------------------------------------------------------------------------
// Phase 14 -- the single funnel for the ComfyUI server API on a pod
// (docs.comfy.org/development/comfyui-server/comms_routes, checked 2026-10-05): POST /prompt,
// GET /history/{id}, GET /queue, POST /queue {delete}, POST /interrupt, GET /system_stats -- exactly
// the calls the job pipeline makes, nothing speculative (files travel over S3, never /view or
// /upload). The base URL is built from the pod id (RunPod's HTTP proxy), never from operator input,
// and every call carries the per-session bearer token the pod's reverse proxy checks (PHASE_14_PLAN.md §2.5).
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


/**
 * A history entry is `{ prompt, outputs, status? }`. The `status` block (`status_str`, `completed`,
 * `messages`) is what current ComfyUI writes; a build that omits it still lists `outputs` once the
 * prompt finished, so an entry with outputs and no error IS a completed prompt (review round 6 -- a
 * finished prompt must never be polled until the generation deadline and then failed).
 */
export function parseHistoryEntry(promptId: string, raw: unknown): ComfyHistoryEntry | null {
  const entry = asRecord(asRecord(raw)[promptId]);
  if (Object.keys(entry).length === 0) return null;
  const hasStatusBlock = entry.status !== undefined && entry.status !== null;
  const status = asRecord(entry.status);
  const statusStr = typeof status.status_str === "string" ? status.status_str : null;
  const messages: string[] = [];
  if (Array.isArray(status.messages)) {
    for (const m of status.messages) {
      if (!Array.isArray(m) || typeof m[0] !== "string") continue;
      // `["execution_error", { node_id, node_type, exception_message, ... }]`: keep the detail an agent can act on.
      const payload = asRecord(m[1]);
      const detail = [
        typeof payload.exception_message === "string" ? payload.exception_message : null,
        typeof payload.node_type === "string" || typeof payload.node_id === "string" ? `node ${payload.node_type ?? ""}${payload.node_id ? ` #${payload.node_id}` : ""}`.trim() : null,
      ]
        .filter(Boolean)
        .join(" @ ");
      messages.push(detail ? `${m[0]}: ${detail}` : m[0]);
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
  const resolved: ComfyHistoryEntry["status"] =
    statusStr === "error"
      ? "error"
      : statusStr === "success" || status.completed === true || (!hasStatusBlock && outputs.length > 0)
        ? "completed"
        : "unknown";
  return { promptId, status: resolved, statusMessages: messages, outputs, raw: entry };
}

export function createComfyUiClient(args: {
  baseUrl: string;
  token: string | null;
  fetchImpl?: typeof fetch;
  authorize?: Authorize;
  socketFactory?: ProgressSocketFactory;
  /** BL-144: re-checked while a progress stream is open; switching the gateway off closes the stream. */
  gatewayEnabled?: () => Promise<boolean>;
  /** How often an open progress stream re-checks the gateway toggle (ms). */
  gatewayRecheckMs?: number;
}) {
  const fetchImpl = args.fetchImpl ?? fetch;
  const authorize = args.authorize ?? assertMediaGatewayAuthorized;
  const baseUrl = args.baseUrl.replace(/\/$/, "");

  async function request(method: string, path: string, options: { json?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    await authorize("comfyui_api");
    const headers: Record<string, string> = { accept: "application/json" };
    if (args.token) headers.authorization = `Bearer ${args.token}`;
    if (options.json !== undefined) headers["content-type"] = "application/json";
    const response = await jsonRequest({
      fetchImpl,
      url: `${baseUrl}${path}`,
      method,
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      timeoutMs: REQUEST_TIMEOUT_MS,
      unavailable: (stage, detail, status) =>
        new DomainError({
          code: "comfyui_unavailable",
          message: stage === "request" ? `ComfyUI request failed: ${detail}` : `ComfyUI response could not be read: ${detail}`,
          details: { method, path, ...(status !== undefined ? { status } : {}) },
        }),
    });
    const body = response.body;
    if (!response.ok) {
      // A 4xx WITH a JSON body is ComfyUI's own verdict (a prompt that failed validation): definitive, `comfyui_rejected`
      // -- definitive for POST /prompt only; a poll's caller folds it into its failure counter, since /history never
      // answers 4xx from ComfyUI itself (review rounds 12 and 15). Anything else (5xx, a proxy's HTML/plain-text 4xx,
      // a timeout) is `comfyui_unavailable`.
      const definitive = response.status >= 400 && response.status < 500 && isJsonBody(body);
      throw new DomainError({
        code: definitive ? "comfyui_rejected" : "comfyui_unavailable",
        message: `ComfyUI ${definitive ? "rejected" : "returned HTTP"} ${definitive ? `${method} ${path} (HTTP ${response.status})` : `${response.status} for ${method} ${path}`}.`,
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
      const stats = asRecord(body);
      // A 200 is not "ComfyUI is up": RunPod's proxy or the pod's reverse proxy can answer a placeholder page while ComfyUI
      // still boots (review round 11). The documented shape has `system` and `devices`.
      if (!("system" in stats) || !("devices" in stats)) {
        throw new DomainError({ code: "comfyui_unavailable", message: "GET /system_stats did not return ComfyUI's system stats (still booting, or another server answered).", details: { keys: Object.keys(stats).slice(0, 10) } });
      }
      return stats;
    },

    /**
     * Queues an API-format workflow. ComfyUI validates it first: a validation failure comes back as
     * `node_errors` (HTTP 400) and is surfaced by `request()` as `comfyui_rejected` (definitive, never
     * retried) with the body in `details`, so the caller can mark the job failed without a second call;
     * a 200 without a `prompt_id` (not a documented shape) is `comfyui_unavailable`.
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
    async getQueue(): Promise<{ running: number; pending: number; runningPromptIds: string[]; pendingPromptIds: string[]; entries: Array<{ promptId: string; clientId: string | null; state: "running" | "pending" }> }> {
      const { body } = await request("GET", "/queue");
      const record = asRecord(body);
      // Each entry is `[number, prompt_id, prompt, extra_data, outputs_to_execute]`; `extra_data.client_id` is what a
      // submit sent, so a prompt whose POST /prompt response was lost can still be found (review round 17).
      const parse = (entries: unknown, state: "running" | "pending") =>
        Array.isArray(entries)
          ? entries
              .map((e) => (Array.isArray(e) && typeof e[1] === "string" ? { promptId: e[1] as string, clientId: typeof asRecord(e[3]).client_id === "string" ? (asRecord(e[3]).client_id as string) : null, state } : null))
              .filter((entry): entry is { promptId: string; clientId: string | null; state: "running" | "pending" } => entry !== null)
          : [];
      const entries = [...parse(record.queue_running, "running"), ...parse(record.queue_pending, "pending")];
      const runningPromptIds = entries.filter((e) => e.state === "running").map((e) => e.promptId);
      const pendingPromptIds = entries.filter((e) => e.state === "pending").map((e) => e.promptId);
      return { running: runningPromptIds.length, pending: pendingPromptIds.length, runningPromptIds, pendingPromptIds, entries };
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

    /**
     * BL-144: ComfyUI's live execution events for prompts submitted with this `clientId` (comfyui-progress.ts). Read-only;
     * the bearer token goes in the upgrade request's header, never in the URL. Checks the media gateway toggle and
     * records a traffic event like every other call. `onClosed` fires once, however the socket ends; a closed stream is
     * never reopened here -- the caller decides.
     */
    async openProgressStream(input: {
      clientId: string;
      onEvent: (event: ComfyProgressEvent) => void;
      onClosed: (reason: string) => void;
      onOpened?: () => void;
    }): Promise<ProgressStream> {
      await authorize("comfyui_api");
      const headers: Record<string, string> = {};
      if (args.token) headers.authorization = `Bearer ${args.token}`;
      const socket = (args.socketFactory ?? defaultProgressSocketFactory)(comfyProgressSocketUrl(baseUrl, input.clientId), { headers });
      let closed = false;
      // Every other gateway call checks the toggle per request; an open socket re-checks it on a timer instead.
      const gatewayEnabled = args.gatewayEnabled ?? isMediaGatewayEnabled;
      const recheck = setInterval(() => {
        void gatewayEnabled().then(
          (enabled) => {
            if (!enabled) closeSocket("media gateway switched off");
          },
          () => {}
        );
      }, args.gatewayRecheckMs ?? 15_000);
      (recheck as { unref?: () => void }).unref?.();
      const finish = (reason: string) => {
        if (closed) return;
        closed = true;
        clearInterval(recheck);
        input.onClosed(reason);
      };
      const closeSocket = (reason: string) => {
        finish(reason);
        try {
          socket.close(1000, "done");
        } catch {
          // Already closed.
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return; // binary previews
        const parsed = parseComfyProgressMessage(event.data);
        if (parsed) input.onEvent(parsed);
      };
      socket.onopen = () => input.onOpened?.();
      socket.onerror = () => finish("error");
      socket.onclose = (event) => finish(`closed (${event.code})`);
      return {
        close() {
          closeSocket("closed by the app");
        },
      };
    },
  };
}
