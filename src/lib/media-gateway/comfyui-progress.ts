import { asRecord } from "./json";

// ---------------------------------------------------------------------------
// BL-144 (owner, Telegram 2026-10-06, msgs 1885/1887: "real information, not estimates") -- ComfyUI's own execution
// events, read from its websocket (`GET /ws?clientId=...`, docs.comfy.org/development/comfyui-server/comms_messages).
// ComfyUI sends a prompt's execution messages to the websocket whose clientId matches the `client_id` the prompt was
// submitted with (this app submits `ytm-<jobId>`), so one socket per running job sees exactly that job. Read-only:
// nothing is ever sent on the socket. Binary messages (live previews) are ignored.
// ---------------------------------------------------------------------------

export type ComfyProgressEvent =
  | { type: "execution_start"; promptId: string }
  | { type: "execution_cached"; promptId: string; nodeIds: string[] }
  /** `nodeId: null` is ComfyUI's legacy "this prompt finished" signal. */
  | { type: "executing"; promptId: string; nodeId: string | null }
  | { type: "progress"; promptId: string; nodeId: string | null; value: number; max: number }
  | { type: "executed"; promptId: string; nodeId: string }
  /** Newer ComfyUI: the state of every node of the prompt at once. */
  | { type: "progress_state"; promptId: string; nodes: Array<{ nodeId: string; state: "pending" | "running" | "finished" | "error"; value: number; max: number }> }
  | { type: "execution_success"; promptId: string }
  | { type: "execution_error"; promptId: string; nodeId: string | null; nodeType: string | null; message: string | null }
  | { type: "execution_interrupted"; promptId: string };

const nodeIdOf = (value: unknown): string | null => (typeof value === "string" ? value : typeof value === "number" ? String(value) : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Parses one text message from ComfyUI's websocket; `null` for anything that is not a prompt-execution event. */
export function parseComfyProgressMessage(text: string): ComfyProgressEvent | null {
  let message: Record<string, unknown>;
  try {
    message = asRecord(JSON.parse(text));
  } catch {
    return null;
  }
  const data = asRecord(message.data);
  const promptId = typeof data.prompt_id === "string" ? data.prompt_id : null;
  if (!promptId) return null;
  switch (message.type) {
    case "execution_start":
      return { type: "execution_start", promptId };
    case "execution_cached":
      return { type: "execution_cached", promptId, nodeIds: Array.isArray(data.nodes) ? data.nodes.map(nodeIdOf).filter((n): n is string => n !== null) : [] };
    case "executing":
      return { type: "executing", promptId, nodeId: nodeIdOf(data.node) };
    case "progress": {
      const value = finite(data.value);
      const max = finite(data.max);
      if (value === null || max === null || max <= 0) return null;
      return { type: "progress", promptId, nodeId: nodeIdOf(data.node), value, max };
    }
    case "executed": {
      const nodeId = nodeIdOf(data.node);
      return nodeId ? { type: "executed", promptId, nodeId } : null;
    }
    case "progress_state": {
      const nodes = Object.entries(asRecord(data.nodes)).flatMap(([key, raw]) => {
        const node = asRecord(raw);
        const state = node.state;
        if (state !== "pending" && state !== "running" && state !== "finished" && state !== "error") return [];
        const nodeState: "pending" | "running" | "finished" | "error" = state;
        return [{ nodeId: nodeIdOf(node.display_node_id) ?? nodeIdOf(node.node_id) ?? key, state: nodeState, value: finite(node.value) ?? 0, max: finite(node.max) ?? 1 }];
      });
      return { type: "progress_state", promptId, nodes };
    }
    case "execution_success":
      return { type: "execution_success", promptId };
    case "execution_error":
      return {
        type: "execution_error",
        promptId,
        nodeId: nodeIdOf(data.node_id),
        nodeType: typeof data.node_type === "string" ? data.node_type : null,
        message: typeof data.exception_message === "string" ? data.exception_message : null,
      };
    case "execution_interrupted":
      return { type: "execution_interrupted", promptId };
    default:
      return null;
  }
}

/** `https://host` → `wss://host/ws?clientId=...` (and `http` → `ws` for tests). */
export function comfyProgressSocketUrl(baseUrl: string, clientId: string): string {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  return url.toString();
}

/** The subset of the WHATWG WebSocket this module uses, so tests can pass a fake. */
export type ProgressSocket = {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
};
export type ProgressSocketFactory = (url: string, init: { headers: Record<string, string> }) => ProgressSocket;

/** Node's built-in WebSocket (undici) accepts request headers as a non-standard init option; the token travels there. */
export const defaultProgressSocketFactory: ProgressSocketFactory = (url, init) =>
  new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => ProgressSocket)(url, init);

export type ProgressStream = { close(): void };
